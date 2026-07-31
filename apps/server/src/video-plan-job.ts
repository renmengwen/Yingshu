import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

import type { ChapterTextModelConfig } from "./chapter-event-analyzer.js";
import { getGlobalPromptSettings, getProjectSettings, getVideoInput } from "./creative-input-store.js";
import { createJob, getJob } from "./job-store.js";
import { JobCancelledError, type JobExecutionContext, type JobHandler } from "./job-worker.js";
import { getProject, getVideo } from "./project-video-store.js";
import { textModelCallError, textModelResultError } from "./text-model-stream.js";
import {
  canonical, createVideoPlanModelSnapshot, type FrozenVideoPlanSnapshot, type GenerateVideoPlan,
  parseGeneratedScript, parseGeneratedVisual, planObject, planText, scriptPrompt, sha256, VideoPlanError,
  type VideoScriptContent, type VideoVisualContent, VIDEO_PLAN_ID, VIDEO_PLAN_JOB_TYPE, VIDEO_PLAN_PROMPT_VERSION,
  VIDEO_PLAN_SYSTEM_CONTRACT_VERSION, VIDEO_PLAN_WEB_CAPABILITY, visualPrompt,
} from "./video-plan-contract.js";
import {
  getVideoPlanSnapshot, isLatestValidVideoPlanSnapshot, latestVideoScript, latestVideoVisual,
  nextVideoScriptRevision, nextVideoVisualRevision,
} from "./video-plan-store.js";

export type CreateVideoPlanGenerator = (config: ChapterTextModelConfig) => GenerateVideoPlan;
export type VideoPlanGeneratorSource = GenerateVideoPlan | { create: CreateVideoPlanGenerator };
export type ResolveVideoPlanModel = (providerId: string) =>
  ChapterTextModelConfig | null | Promise<ChapterTextModelConfig | null>;

export function enqueueVideoPlanJob(database: DatabaseSync, input: {
  projectId: string; videoId: string; idempotencyKey: unknown; config: ChapterTextModelConfig; now?: number;
}) {
  const now = input.now ?? Date.now();
  getProject(database, input.projectId);
  getVideo(database, input.projectId, input.videoId);
  const idempotencyKey = planText(input.idempotencyKey, "幂等键", 200);
  if (!VIDEO_PLAN_ID.test(idempotencyKey)) throw new VideoPlanError(400, "幂等键只能包含字母、数字、下划线或连字符");
  const draft = getVideoInput(database, input.projectId, input.videoId);
  if (draft.webEnabled) {
    throw new VideoPlanError(409, "当前文本模型没有受支持的真实联网路径。请关闭联网核验后重试，或切换到后续支持联网的模型");
  }
  const model = createVideoPlanModelSnapshot(input.config);
  const prompts = {
    global: getGlobalPromptSettings(database), project: getProjectSettings(database, input.projectId),
    video: { scriptInstructions: draft.scriptInstructions, visualInstructions: draft.visualInstructions },
  };
  const frozen = { videoId: input.videoId, input: draft, prompts, model,
    systemContractVersion: VIDEO_PLAN_SYSTEM_CONTRACT_VERSION, webCapability: VIDEO_PLAN_WEB_CAPABILITY, createdAt: now };
  const canonicalJson = canonical(frozen);
  const snapshotHash = sha256(canonicalJson);
  const snapshotId = `vps_${sha256(`${snapshotHash}\0${idempotencyKey}`).slice(0, 32)}`;
  const jobId = `job_video_plan_${sha256(`${input.videoId}\0${idempotencyKey}`).slice(0, 32)}`;

  database.exec("BEGIN IMMEDIATE");
  try {
    const existingMapping = database.prepare(
      `SELECT map.job_id FROM video_plan_snapshots snapshot JOIN video_plan_jobs map ON map.snapshot_id = snapshot.id
       WHERE snapshot.video_id = ? AND snapshot.idempotency_key = ?`,
    ).get(input.videoId, idempotencyKey) as { job_id: string } | undefined;
    if (existingMapping) {
      const existing = getJob(database, existingMapping.job_id);
      if (!existing) throw new VideoPlanError(500, "方案任务映射已损坏");
      database.exec("COMMIT");
      return { job: existing, created: false };
    }
    const active = database.prepare(
      `SELECT jobs.id FROM video_plan_jobs map JOIN jobs ON jobs.id = map.job_id
       WHERE map.video_id = ? AND jobs.status IN ('queued','running') LIMIT 1`,
    ).get(input.videoId) as { id: string } | undefined;
    if (active) throw new VideoPlanError(409, "当前视频已有正在执行的方案任务，请勿重复启动");
    database.prepare(
      `INSERT INTO video_plan_snapshots (id,video_id,idempotency_key,input_json,prompt_json,model_json,
       system_contract_version,web_capability,canonical_json,snapshot_hash,created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
    ).run(snapshotId, input.videoId, idempotencyKey, JSON.stringify(draft), JSON.stringify(prompts), JSON.stringify(model),
      VIDEO_PLAN_SYSTEM_CONTRACT_VERSION, VIDEO_PLAN_WEB_CAPABILITY, canonicalJson, snapshotHash, now);
    const job = createJob(database, { id: jobId, type: VIDEO_PLAN_JOB_TYPE,
      payload: { snapshotId, videoId: input.videoId, providerId: model.providerId, model: model.modelId }, maxAttempts: 2 }, now);
    database.prepare("INSERT INTO video_plan_jobs (job_id,video_id,snapshot_id,created_at) VALUES (?,?,?,?)")
      .run(job.id, input.videoId, snapshotId, now);
    database.prepare("UPDATE videos SET status = 'preparing_sources', updated_at = ? WHERE id = ? AND project_id = ?")
      .run(now, input.videoId, input.projectId);
    database.exec("COMMIT");
    return { job, created: true };
  } catch (error) {
    try { database.exec("ROLLBACK"); } catch { /* 保留原始错误。 */ }
    throw error;
  }
}

async function callWithCancellation(context: JobExecutionContext, stage: "script" | "visual", prompt: string, generate: GenerateVideoPlan) {
  context.throwIfCancellationRequested();
  const controller = new AbortController();
  const poll = setInterval(() => { if (context.isCancellationRequested()) controller.abort(); }, 50);
  try { return await generate({ stage, prompt, signal: controller.signal, onActivity: () => undefined }); }
  catch (error) {
    if (controller.signal.aborted || context.isCancellationRequested()) throw new JobCancelledError();
    throw error;
  } finally { clearInterval(poll); }
}

export function createVideoPlanJobHandler(
  database: DatabaseSync, configOrResolver: ChapterTextModelConfig | ResolveVideoPlanModel,
  generatorSource: VideoPlanGeneratorSource,
): JobHandler {
  return async (context) => {
    let snapshot: FrozenVideoPlanSnapshot | undefined;
    try {
      const payload = planObject(context.job.payload, "方案任务参数");
      const fields = ["snapshotId", "videoId", "providerId", "model"];
      if (Object.keys(payload).some((key) => !fields.includes(key)) || fields.some((key) => !(key in payload))) {
        throw new VideoPlanError(422, "方案任务参数字段无效");
      }
      snapshot = getVideoPlanSnapshot(database, planText(payload.snapshotId, "生成快照 ID", 100));
      const currentConfig = typeof configOrResolver === "function"
        ? await configOrResolver(snapshot.model.providerId) : configOrResolver;
      // 当前设置只提供同 provider 的授权；请求身份始终取冻结快照，不能因设置后来变化而漂移。
      if (snapshot.invalidatedAt !== null || snapshot.systemContractVersion !== VIDEO_PLAN_SYSTEM_CONTRACT_VERSION ||
          snapshot.webCapability !== VIDEO_PLAN_WEB_CAPABILITY || !currentConfig || !currentConfig.apiKey.trim() ||
          currentConfig.providerId !== snapshot.model.providerId ||
          payload.videoId !== snapshot.videoId || payload.providerId !== snapshot.model.providerId || payload.model !== snapshot.model.modelId) {
        throw new VideoPlanError(409, "方案任务冻结身份已失效，请重新生成");
      }
      const generate = typeof generatorSource === "function" ? generatorSource : generatorSource.create({
        ...currentConfig, providerId: snapshot.model.providerId, model: snapshot.model.modelId,
        protocol: snapshot.model.protocol, baseUrl: snapshot.model.baseUrl,
      });
      database.prepare("UPDATE videos SET status = 'generating_script', updated_at = ? WHERE id = ?")
        .run(Date.now(), snapshot.videoId);

      let script = latestVideoScript(database, snapshot.videoId, snapshot.id);
      const scriptInputHash = sha256(`${snapshot.snapshotHash}\0script\0${VIDEO_PLAN_PROMPT_VERSION}`);
      const scriptCheckpoint = context.getCheckpoint("video-plan-script", snapshot.id);
      if (!script || scriptCheckpoint?.inputHash !== scriptInputHash) {
        const raw = await callWithCancellation(context, "script", scriptPrompt(snapshot), generate);
        let content: VideoScriptContent;
        try { content = parseGeneratedScript(raw, snapshot); }
        catch (error) { throw raw && typeof raw === "object" ? textModelResultError(error, "video-plan:script", raw) : textModelCallError(error, "video-plan:script"); }
        const contentHash = sha256(canonical(content));
        const id = `vsr_${randomUUID()}`;
        const createdAt = Date.now();
        context.commitCheckpoint("video-plan-script", snapshot.id, scriptInputHash, (transaction) => {
          transaction.run(
            `INSERT INTO video_script_revisions (id,video_id,snapshot_id,revision,content_json,content_hash,
             provider_id,model_id,prompt_version,prompt_hash,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
            id, snapshot!.videoId, snapshot!.id, nextVideoScriptRevision(database, snapshot!.videoId), JSON.stringify(content), contentHash,
            snapshot!.model.providerId, snapshot!.model.modelId, VIDEO_PLAN_PROMPT_VERSION, sha256(scriptPrompt(snapshot!)), createdAt,
          );
        }, { id, contentHash });
        script = latestVideoScript(database, snapshot.videoId, snapshot.id)!;
      }
      context.reportProgress(0.55);
      context.throwIfCancellationRequested();

      let visual = latestVideoVisual(database, snapshot.videoId, snapshot.id);
      const visualInputHash = sha256(`${snapshot.snapshotHash}\0visual\0${script.contentHash}\0${VIDEO_PLAN_PROMPT_VERSION}`);
      const visualCheckpoint = context.getCheckpoint("video-plan-visual", snapshot.id);
      if (!visual || visualCheckpoint?.inputHash !== visualInputHash) {
        database.prepare("UPDATE videos SET status = 'planning_visuals', updated_at = ? WHERE id = ?")
          .run(Date.now(), snapshot.videoId);
        const raw = await callWithCancellation(context, "visual", visualPrompt(snapshot, script), generate);
        let content: VideoVisualContent;
        try { content = parseGeneratedVisual(raw, snapshot, script); }
        catch (error) { throw raw && typeof raw === "object" ? textModelResultError(error, "video-plan:visual", raw) : textModelCallError(error, "video-plan:visual"); }
        const contentHash = sha256(canonical(content));
        const id = `vvr_${randomUUID()}`;
        const createdAt = Date.now();
        context.commitCheckpoint("video-plan-visual", snapshot.id, visualInputHash, (transaction) => {
          transaction.run(
            `INSERT INTO video_visual_revisions (id,video_id,snapshot_id,script_revision_id,script_content_hash,
             revision,content_json,content_hash,created_at) VALUES (?,?,?,?,?,?,?,?,?)`,
            id, snapshot!.videoId, snapshot!.id, script!.id, script!.contentHash,
            nextVideoVisualRevision(database, snapshot!.videoId), JSON.stringify(content), contentHash, createdAt,
          );
        }, { id, contentHash });
        visual = latestVideoVisual(database, snapshot.videoId, snapshot.id)!;
      }
      context.throwIfCancellationRequested();
      if (!isLatestValidVideoPlanSnapshot(database, snapshot.videoId, snapshot.id)) {
        throw new VideoPlanError(409, "方案已被更新的生成任务取代，当前结果不能进入审核");
      }
      database.prepare("UPDATE videos SET status = 'awaiting_review', updated_at = ? WHERE id = ?")
        .run(Date.now(), snapshot.videoId);
      return { snapshotId: snapshot.id, scriptRevisionId: script.id, visualRevisionId: visual.id };
    } catch (error) {
      // 输入变更已把视频恢复为 draft；旧快照的迟到异常不能覆盖新的用户状态。
      if (snapshot && isLatestValidVideoPlanSnapshot(database, snapshot.videoId, snapshot.id)) {
        const status = error instanceof JobCancelledError ? "cancelled" : "failed";
        database.prepare("UPDATE videos SET status = ?, updated_at = ? WHERE id = ?").run(status, Date.now(), snapshot.videoId);
      }
      throw error;
    }
  };
}
