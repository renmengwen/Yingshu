import { createReadStream, lstatSync, readFileSync, realpathSync } from "node:fs";
import { lstat, open, realpath, stat, unlink } from "node:fs/promises";
import { basename, join, resolve, sep } from "node:path";
import { randomUUID } from "node:crypto";
import type { DatabaseSync, SQLInputValue } from "node:sqlite";

import { publishAssetCandidate, type PublishedAssetCandidate } from "./asset-candidate-store.js";
import { withDataFileMutationLock } from "./data-file-mutation-lock.js";
import { createJob, getJob, requestJobCancellation } from "./job-store.js";
import { getVideo } from "./project-video-store.js";
import { getVideoInput } from "./creative-input-store.js";
import { getVideoPlan } from "./video-plan-store.js";
import {
  VIDEO_IMAGE_JOB_TYPE,
  VideoImageError, type VideoImageBatchMode, type VideoImageJobPayload, type VideoImageOrigin,
  type VideoImagePermit, videoImageParameters, videoImageRequestIdentity, videoImageSha256, videoImageText,
} from "./video-image-contract.js";
import { getImageOutputProfile, parseAspectRatio } from "./video-output-profile.js";

interface CandidateRow {
  id: string; project_id: string; video_id: string; plan_snapshot_id: string; plan_snapshot_hash: string;
  script_revision_id: string; script_content_hash: string; visual_revision_id: string; visual_content_hash: string;
  visual_id: string; prompt: string; negative_prompt: string; style_snapshot_json: string; prompt_hash: string;
  provider_id: string | null; model_id: string | null; params_json: string; request_identity: string;
  job_id: string | null; attempt: number; checkpoint_scope: string | null; provider_request_id: string | null;
  status: "succeeded" | "failed"; error_category: string | null; error_summary: string | null;
  origin: VideoImageOrigin; original_file_name: string | null; relative_path: string | null; mime: string | null; bytes: number | null;
  width: number | null; height: number | null; file_hash: string | null; created_at: number;
}

function candidate(row: CandidateRow, compatible: boolean) {
  const parameters = JSON.parse(row.params_json) as { aspectRatio?: unknown; size?: unknown; candidates?: unknown };
  const aspectRatio = parseAspectRatio(parameters.aspectRatio);
  return {
    id: row.id, projectId: row.project_id, videoId: row.video_id, visualId: row.visual_id,
    aspectRatio,
    planSnapshotId: row.plan_snapshot_id, planSnapshotHash: row.plan_snapshot_hash,
    scriptRevisionId: row.script_revision_id, scriptContentHash: row.script_content_hash,
    visualRevisionId: row.visual_revision_id, visualContentHash: row.visual_content_hash,
    prompt: row.prompt, negativePrompt: row.negative_prompt, styleSnapshot: JSON.parse(row.style_snapshot_json),
    promptHash: row.prompt_hash, providerId: row.provider_id, model: row.model_id,
    parameters: { ...parameters, aspectRatio, size: getImageOutputProfile(aspectRatio).size, candidates: 1 },
    requestIdentity: row.request_identity, jobId: row.job_id,
    attempt: row.attempt, checkpointScope: row.checkpoint_scope, providerRequestId: row.provider_request_id,
    origin: row.origin, originalFileName: row.original_file_name, relativePath: row.relative_path,
    mime: row.mime, bytes: row.bytes, width: row.width, height: row.height, fileHash: row.file_hash,
    status: row.status, errorCategory: row.error_category, errorSummary: row.error_summary,
    createdAt: row.created_at, currentCompatible: compatible && row.status === "succeeded",
  };
}

export function requireVideoImagePermit(database: DatabaseSync, projectId: string, videoId: string, visualId?: string) {
  getVideo(database, projectId, videoId);
  const input = getVideoInput(database, projectId, videoId);
  const plan = getVideoPlan(database, projectId, videoId);
  if (!plan || plan.stale || !plan.approval?.valid) {
    throw new VideoImageError(409, "当前方案尚未有效批准，不能生产配图");
  }
  const visuals = visualId ? plan.visual.visuals.filter((item) => item.id === visualId) : plan.visual.visuals;
  if (visualId && visuals.length === 0) throw new VideoImageError(404, "画面不存在或不属于当前视频");
  return visuals.map((visual): VideoImagePermit => {
    const styleSnapshot = {
      purpose: visual.purpose,
      description: visual.description,
      weight: visual.weight,
    };
    return {
      projectId, videoId, aspectRatio: input.aspectRatio,
      planSnapshotId: plan.snapshotId, planSnapshotHash: plan.snapshotHash,
      scriptRevisionId: plan.script.id, scriptContentHash: plan.script.contentHash,
      visualRevisionId: plan.visual.id, visualContentHash: plan.visual.contentHash,
      visualId: visual.id, prompt: videoImageText(visual.prompt, "画面提示词", 20_000),
      negativePrompt: visual.negativePrompt.trim(), styleSnapshot,
      promptHash: videoImageSha256(JSON.stringify({ prompt: visual.prompt.trim(), negativePrompt: visual.negativePrompt.trim(), styleSnapshot })),
    };
  });
}

export function permitStillCurrent(database: DatabaseSync, permit: VideoImagePermit) {
  try {
    const current = requireVideoImagePermit(database, permit.projectId, permit.videoId, permit.visualId)[0];
    return !!current && current.planSnapshotId === permit.planSnapshotId && current.planSnapshotHash === permit.planSnapshotHash &&
      current.aspectRatio === permit.aspectRatio &&
      current.scriptRevisionId === permit.scriptRevisionId && current.scriptContentHash === permit.scriptContentHash &&
      current.visualRevisionId === permit.visualRevisionId && current.visualContentHash === permit.visualContentHash &&
      current.promptHash === permit.promptHash;
  } catch { return false; }
}

function compatibleCandidateExists(database: DatabaseSync, permit: VideoImagePermit) {
  const parameters = videoImageParameters(permit.aspectRatio);
  return !!database.prepare(
    `SELECT 1 FROM video_image_candidates WHERE video_id=? AND visual_id=? AND plan_snapshot_id=?
     AND script_revision_id=? AND visual_revision_id=? AND prompt_hash=? AND params_json=? AND status='succeeded' LIMIT 1`,
  ).get(permit.videoId, permit.visualId, permit.planSnapshotId, permit.scriptRevisionId, permit.visualRevisionId,
    permit.promptHash, JSON.stringify(parameters));
}

export function syncVideoImageStatus(database: DatabaseSync, videoId: string, now = Date.now()) {
  const active = (database.prepare(
    `SELECT COUNT(*) AS count FROM video_image_batch_items
     WHERE video_id = ? AND status IN ('queued', 'running')`,
  ).get(videoId) as { count: number }).count;
  database.prepare(
    `UPDATE videos SET status = ?, updated_at = MAX(updated_at, ?)
     WHERE id = ? AND status IN ('awaiting_review', 'producing_media', 'awaiting_media_review')`,
  ).run(active ? "producing_media" : "awaiting_media_review", now, videoId);
}

export function enqueueVideoImageBatch(database: DatabaseSync, input: {
  projectId: string; videoId: string; mode: VideoImageBatchMode; visualId?: string;
  idempotencyKey: string; providerId: string; model: string; now?: number;
}) {
  const now = input.now ?? Date.now();
  const idempotencyKey = videoImageText(input.idempotencyKey, "幂等键", 200);
  const providerId = videoImageText(input.providerId, "图片服务", 100);
  const model = videoImageText(input.model, "图片模型", 150);
  if (!(["missing", "single", "retry_failed", "regenerate"] as const).includes(input.mode)) {
    throw new VideoImageError(422, "图片生产方式无效");
  }
  const existing = database.prepare("SELECT id FROM video_image_batches WHERE video_id=? AND idempotency_key=?")
    .get(input.videoId, idempotencyKey) as { id: string } | undefined;
  if (existing) return { batch: getVideoImageBatch(database, input.projectId, input.videoId, existing.id), created: false };
  let permits = requireVideoImagePermit(database, input.projectId, input.videoId, input.visualId);
  if (input.mode === "missing") permits = permits.filter((permit) => !compatibleCandidateExists(database, permit));
  if (input.mode === "retry_failed") permits = permits.filter((permit) => !compatibleCandidateExists(database, permit) &&
    database.prepare(
      `SELECT 1 FROM video_image_candidates
       WHERE video_id=? AND visual_id=? AND plan_snapshot_id=? AND script_revision_id=?
         AND visual_revision_id=? AND prompt_hash=? AND status='failed' LIMIT 1`,
    ).get(input.videoId, permit.visualId, permit.planSnapshotId, permit.scriptRevisionId,
      permit.visualRevisionId, permit.promptHash));
  if (permits.length === 0) {
    const latest = getVideoImageBatch(database, input.projectId, input.videoId);
    if (latest) return { batch: latest, created: false };
    throw new VideoImageError(409, "当前没有需要生成的画面");
  }
  const batchId = `vib_${randomUUID()}`;
  const frozen = permits[0] ?? requireVideoImagePermit(database, input.projectId, input.videoId)[0];
  if (!frozen) throw new VideoImageError(409, "当前方案没有正式画面");
  database.exec("BEGIN IMMEDIATE");
  try {
    database.prepare(
      `INSERT INTO video_image_batches (id,project_id,video_id,plan_snapshot_id,plan_snapshot_hash,
       script_revision_id,script_content_hash,visual_revision_id,visual_content_hash,mode,idempotency_key,
       provider_id,model_id,planned_count,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    ).run(batchId, input.projectId, input.videoId, frozen.planSnapshotId, frozen.planSnapshotHash,
      frozen.scriptRevisionId, frozen.scriptContentHash, frozen.visualRevisionId, frozen.visualContentHash,
      input.mode === "missing" ? "batch" : input.mode === "regenerate" ? "single" : input.mode,
      idempotencyKey, providerId, model, permits.length, now);
    for (const permit of permits) {
      const requestIdentity = videoImageRequestIdentity(permit, providerId, model, idempotencyKey);
      const jobId = `job_video_image_${requestIdentity}`;
      const payload: VideoImageJobPayload = {
        ...permit, batchId, requestIdentity, providerId, model,
        parameters: videoImageParameters(permit.aspectRatio), attempt: 1,
      };
      createJob(database, { id: jobId, type: VIDEO_IMAGE_JOB_TYPE, payload, maxAttempts: 1 }, now);
      database.prepare(
        `INSERT INTO video_image_batch_items (batch_id,video_id,visual_id,job_id,request_identity,status,created_at,updated_at)
         VALUES (?,?,?,?,?, 'queued',?,?)`,
      ).run(batchId, input.videoId, permit.visualId, jobId, requestIdentity, now, now);
    }
    syncVideoImageStatus(database, input.videoId, now);
    database.exec("COMMIT");
  } catch (error) {
    try { database.exec("ROLLBACK"); } catch { /* 保留原始错误。 */ }
    const raced = database.prepare("SELECT id FROM video_image_batches WHERE video_id=? AND idempotency_key=?")
      .get(input.videoId, idempotencyKey) as { id: string } | undefined;
    if (!raced) {
      if (/video_image_items_one_active_visual|video_image_batch_items\.video_id/iu.test(String(error))) {
        throw new VideoImageError(409, "该画面已有图片任务正在排队或运行");
      }
      throw error;
    }
    return { batch: getVideoImageBatch(database, input.projectId, input.videoId, raced.id), created: false };
  }
  return { batch: getVideoImageBatch(database, input.projectId, input.videoId, batchId), created: true };
}

export function getVideoImageBatch(database: DatabaseSync, projectId: string, videoId: string, batchId?: string) {
  getVideo(database, projectId, videoId);
  const row = database.prepare(
    `SELECT * FROM video_image_batches WHERE project_id=? AND video_id=? ${batchId ? "AND id=?" : "ORDER BY created_at DESC,id DESC LIMIT 1"}`,
  ).get(projectId, videoId, ...(batchId ? [batchId] : [])) as Record<string, SQLInputValue> | undefined;
  if (!row) return null;
  const items = database.prepare(
    `SELECT item.visual_id AS visualId,item.job_id AS jobId,item.request_identity AS requestIdentity,
     jobs.status,jobs.error_code AS errorCode,jobs.error_message AS errorMessage,jobs.cancel_requested AS cancelRequested,
     jobs.created_at AS createdAt,jobs.updated_at AS updatedAt
     FROM video_image_batch_items item JOIN jobs ON jobs.id=item.job_id WHERE item.batch_id=? ORDER BY item.created_at,item.visual_id`,
  ).all(row.id as string) as unknown as Array<Record<string, unknown>>;
  const counts = { queued: 0, running: 0, succeeded: 0, failed: 0, cancelled: 0 };
  for (const item of items) counts[item.status as keyof typeof counts] += 1;
  return {
    id: row.id, projectId: row.project_id, videoId: row.video_id, mode: row.mode,
    providerId: row.provider_id, model: row.model_id, plannedCount: row.planned_count,
    createdAt: row.created_at, counts, items, complete: counts.queued + counts.running === 0,
  };
}

export function cancelVideoImageBatch(database: DatabaseSync, projectId: string, videoId: string, batchId: string, now = Date.now()) {
  const batch = getVideoImageBatch(database, projectId, videoId, batchId);
  if (!batch) throw new VideoImageError(404, "图片批次不存在");
  for (const item of batch.items) requestJobCancellation(database, item.jobId as string, now);
  database.prepare("UPDATE video_image_batch_items SET status='cancelled',updated_at=? WHERE batch_id=? AND status='queued'")
    .run(now, batchId);
  syncVideoImageStatus(database, videoId, now);
  return getVideoImageBatch(database, projectId, videoId, batchId);
}

export function insertVideoImageCandidate(writer: { run(sql: string, ...values: SQLInputValue[]): unknown },
  payload: VideoImageJobPayload, published: PublishedAssetCandidate, origin: VideoImageOrigin,
  options: { originalFileName?: string; providerRequestId?: string; id?: string; now?: number } = {}) {
  const id = options.id ?? `vic_${randomUUID()}`;
  writer.run(
    `INSERT INTO video_image_candidates (id,project_id,video_id,plan_snapshot_id,plan_snapshot_hash,
     script_revision_id,script_content_hash,visual_revision_id,visual_content_hash,visual_id,prompt,negative_prompt,
    style_snapshot_json,prompt_hash,provider_id,model_id,params_json,request_identity,job_id,attempt,checkpoint_scope,
     provider_request_id,status,error_category,error_summary,origin,original_file_name,relative_path,mime,bytes,width,height,file_hash,created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    id,payload.projectId,payload.videoId,payload.planSnapshotId,payload.planSnapshotHash,payload.scriptRevisionId,
    payload.scriptContentHash,payload.visualRevisionId,payload.visualContentHash,payload.visualId,payload.prompt,
    payload.negativePrompt,JSON.stringify(payload.styleSnapshot),payload.promptHash,
    origin === "generated" ? payload.providerId : null,origin === "generated" ? payload.model : null,
    JSON.stringify(payload.parameters),payload.requestIdentity,origin === "generated" ? `job_video_image_${payload.requestIdentity}` : null,
    payload.attempt,origin === "generated" ? payload.visualId : "upload",options.providerRequestId ?? null,
    "succeeded",null,null,origin,
    options.originalFileName ? basename(options.originalFileName) : null,published.relativePath,published.mime,published.bytes,
    published.width,published.height,published.fileHash,options.now ?? published.createdAt);
  return id;
}

export function insertVideoImageFailure(database: DatabaseSync, payload: VideoImageJobPayload, summary: string, now = Date.now()) {
  const existing = database.prepare("SELECT id FROM video_image_candidates WHERE request_identity=?").get(payload.requestIdentity) as
    { id: string } | undefined;
  if (existing) return existing.id;
  const id = `vic_${randomUUID()}`;
  database.prepare(
    `INSERT INTO video_image_candidates (id,project_id,video_id,plan_snapshot_id,plan_snapshot_hash,
     script_revision_id,script_content_hash,visual_revision_id,visual_content_hash,visual_id,prompt,negative_prompt,
     style_snapshot_json,prompt_hash,provider_id,model_id,params_json,request_identity,job_id,attempt,checkpoint_scope,
     provider_request_id,status,error_category,error_summary,origin,original_file_name,relative_path,mime,bytes,width,height,file_hash,created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,NULL,'failed','provider_error',?,'generated',NULL,NULL,NULL,NULL,NULL,NULL,NULL,?)`,
  ).run(id,payload.projectId,payload.videoId,payload.planSnapshotId,payload.planSnapshotHash,payload.scriptRevisionId,
    payload.scriptContentHash,payload.visualRevisionId,payload.visualContentHash,payload.visualId,payload.prompt,
    payload.negativePrompt,JSON.stringify(payload.styleSnapshot),payload.promptHash,payload.providerId,payload.model,
    JSON.stringify(payload.parameters),payload.requestIdentity,`job_video_image_${payload.requestIdentity}`,payload.attempt,
    payload.visualId,summary,now);
  return id;
}

export function listVideoImageCandidates(database: DatabaseSync, projectId: string, videoId: string) {
  getVideo(database, projectId, videoId);
  let permits: VideoImagePermit[] = [];
  try { permits = requireVideoImagePermit(database, projectId, videoId); } catch { /* 历史候选在方案失效后仍须可见。 */ }
  const identities = new Map(permits.map((permit) => [permit.visualId, permit]));
  return (database.prepare("SELECT * FROM video_image_candidates WHERE project_id=? AND video_id=? ORDER BY created_at DESC,id DESC")
    .all(projectId, videoId) as unknown as CandidateRow[]).map((row) => {
      const permit = identities.get(row.visual_id);
      return candidate(row, row.status === "succeeded" && !!permit && permit.planSnapshotId === row.plan_snapshot_id &&
        permit.scriptRevisionId === row.script_revision_id && permit.visualRevisionId === row.visual_revision_id &&
        permit.promptHash === row.prompt_hash && permit.planSnapshotHash === row.plan_snapshot_hash &&
        permit.scriptContentHash === row.script_content_hash && permit.visualContentHash === row.visual_content_hash);
    });
}

export async function uploadVideoImageCandidate(database: DatabaseSync, dataRoot: string, input: {
  projectId: string; videoId: string; visualId: string; originalFileName: string; raw: AsyncIterable<Uint8Array>;
}) {
  const permit = requireVideoImagePermit(database, input.projectId, input.videoId, input.visualId)[0]!;
  const uploadIdentity = `upload_${randomUUID()}`;
  const payload: VideoImageJobPayload = {
    ...permit, batchId: "upload", requestIdentity: uploadIdentity, providerId: "upload", model: "upload",
    parameters: videoImageParameters(permit.aspectRatio), attempt: 1,
  };
  const id = await withDataFileMutationLock(dataRoot, async () => {
    if (!permitStillCurrent(database, permit)) {
      throw new VideoImageError(409, "方案已更新，不能上传图片候选");
    }
    const published = await publishAssetCandidate(dataRoot, {
      assetId: `${input.videoId}_${input.visualId}`, source: { kind: "upload", originalName: input.originalFileName }, raw: input.raw,
    });
    try {
      return insertVideoImageCandidate({ run: (sql, ...values) => { database.prepare(sql).run(...values); } }, payload, published, "upload", {
        originalFileName: input.originalFileName,
      });
    } catch (error) {
      await cleanupUnreferencedVideoImageFiles(database, dataRoot, [published]);
      throw error;
    }
  });
  return listVideoImageCandidates(database, input.projectId, input.videoId).find((item) => item.id === id)!;
}

function verifyCandidateFile(dataRoot: string, row: CandidateRow) {
  if (!row.relative_path || !row.file_hash || row.bytes === null) {
    throw new VideoImageError(409, "候选图片缺少受控文件身份");
  }
  const root = realpathSync(resolve(dataRoot));
  const path = resolve(join(dataRoot, ...row.relative_path.split("/")));
  if (!path.startsWith(`${root}${sep}`)) throw new VideoImageError(500, "候选图存储路径无效");
  const entry = lstatSync(path);
  if (!entry.isFile() || entry.isSymbolicLink()) throw new VideoImageError(409, "候选图文件类型无效");
  const actual = realpathSync(path);
  if (!actual.startsWith(`${root}${sep}`)) throw new VideoImageError(500, "候选图存储路径无效");
  const bytes = readFileSync(actual);
  if (bytes.byteLength !== row.bytes || videoImageSha256(bytes) !== row.file_hash) {
    throw new VideoImageError(409, "候选图文件已丢失或损坏，不能批准");
  }
}

export function approveVideoImageCandidate(database: DatabaseSync, dataRoot: string, input: {
  projectId: string; videoId: string; visualId: string; candidateId: string; expectedGateRevision: number; now?: number;
}) {
  database.exec("BEGIN IMMEDIATE");
  try {
    const permit = requireVideoImagePermit(database, input.projectId, input.videoId, input.visualId)[0]!;
    const currentRevision = (database.prepare("SELECT MAX(gate_revision) AS revision FROM video_image_approval_events WHERE video_id=?")
      .get(input.videoId) as { revision: number | null }).revision ?? 0;
    if (input.expectedGateRevision !== currentRevision) throw new VideoImageError(409, "图片审核已更新，请刷新后重试");
    const row = database.prepare("SELECT * FROM video_image_candidates WHERE id=? AND project_id=? AND video_id=? AND visual_id=?")
      .get(input.candidateId, input.projectId, input.videoId, input.visualId) as CandidateRow | undefined;
    if (!row) throw new VideoImageError(404, "图片候选不存在或不属于当前画面");
    if (row.status !== "succeeded" || !row.file_hash) throw new VideoImageError(409, "失败候选不能批准为当前配图");
    try { verifyCandidateFile(dataRoot, row); }
    catch (error) {
      if (error instanceof VideoImageError) throw error;
      throw new VideoImageError(409, "候选图文件已丢失或损坏，不能批准");
    }
    const current = candidate(row, true);
    if (current.planSnapshotId !== permit.planSnapshotId || current.scriptRevisionId !== permit.scriptRevisionId ||
        current.visualRevisionId !== permit.visualRevisionId || current.promptHash !== permit.promptHash ||
        current.planSnapshotHash !== permit.planSnapshotHash || current.scriptContentHash !== permit.scriptContentHash ||
        current.visualContentHash !== permit.visualContentHash) throw new VideoImageError(409, "历史候选不能批准为当前配图");
    const gateRevision = currentRevision + 1;
    database.prepare(
    `INSERT INTO video_image_approval_events (id,project_id,video_id,gate_revision,visual_id,candidate_id,
     plan_snapshot_id,plan_snapshot_hash,script_revision_id,script_content_hash,visual_revision_id,visual_content_hash,
     prompt_hash,candidate_hash,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    ).run(`via_${randomUUID()}`,input.projectId,input.videoId,gateRevision,input.visualId,input.candidateId,
      permit.planSnapshotId,permit.planSnapshotHash,permit.scriptRevisionId,permit.scriptContentHash,
      permit.visualRevisionId,permit.visualContentHash,permit.promptHash,row.file_hash,input.now ?? Date.now());
    database.exec("COMMIT");
  } catch (error) {
    try { database.exec("ROLLBACK"); } catch { /* 保留原始错误。 */ }
    throw error;
  }
  return getVideoImageWorkspace(database, input.projectId, input.videoId);
}

export function getVideoImageWorkspace(database: DatabaseSync, projectId: string, videoId: string) {
  getVideo(database, projectId, videoId);
  let permits: VideoImagePermit[] = [];
  try { permits = requireVideoImagePermit(database, projectId, videoId); } catch { /* 失效时继续返回历史候选。 */ }
  const candidates = listVideoImageCandidates(database, projectId, videoId);
  const revision = (database.prepare("SELECT MAX(gate_revision) AS revision FROM video_image_approval_events WHERE video_id=?")
    .get(videoId) as { revision: number | null }).revision ?? 0;
  const approvals = database.prepare(
    `SELECT event.visual_id AS visualId,event.candidate_id AS candidateId,event.gate_revision AS gateRevision
     FROM video_image_approval_events event WHERE event.video_id=? AND event.gate_revision=(
       SELECT MAX(latest.gate_revision) FROM video_image_approval_events latest
       WHERE latest.video_id=event.video_id AND latest.visual_id=event.visual_id)`,
  ).all(videoId) as unknown as Array<{ visualId: string; candidateId: string; gateRevision: number }>;
  const valid = approvals.filter((approval) => candidates.some((item) => item.id === approval.candidateId && item.currentCompatible));
  return {
    permitValid: permits.length > 0, visualCount: permits.length, gateRevision: revision,
    gateComplete: permits.length > 0 && valid.length === permits.length,
    candidates, approvals, batch: getVideoImageBatch(database, projectId, videoId),
  };
}

export async function openVideoImagePreview(database: DatabaseSync, dataRoot: string, projectId: string, videoId: string, candidateId: string) {
  getVideo(database, projectId, videoId);
  const row = database.prepare("SELECT * FROM video_image_candidates WHERE id=? AND project_id=? AND video_id=?")
    .get(candidateId, projectId, videoId) as CandidateRow | undefined;
  if (!row) throw new VideoImageError(404, "图片候选不存在");
  const root = resolve(dataRoot);
  if (row.status !== "succeeded" || !row.relative_path || !row.file_hash || !row.mime || row.bytes === null) {
    throw new VideoImageError(409, "失败候选没有可预览图片");
  }
  const path = resolve(join(dataRoot, ...row.relative_path.split("/")));
  if (!path.startsWith(`${root}${sep}`)) throw new VideoImageError(500, "候选图存储路径无效");
  const entry = await lstat(path);
  if (!entry.isFile() || entry.isSymbolicLink()) throw new VideoImageError(409, "候选图文件类型无效");
  const actual = await realpath(path);
  if (!actual.startsWith(`${root}${sep}`)) throw new VideoImageError(500, "候选图存储路径无效");
  const info = await stat(actual);
  if (info.size !== row.bytes) throw new VideoImageError(409, "候选图文件已损坏");
  const handle = await open(actual, "r");
  const hash = videoImageSha256(await handle.readFile());
  await handle.close();
  if (hash !== row.file_hash) throw new VideoImageError(409, "候选图文件已损坏");
  return { stream: createReadStream(actual), mime: row.mime, bytes: row.bytes, fileHash: row.file_hash };
}

export async function cleanupUnreferencedVideoImageFiles(
  database: DatabaseSync,
  dataRoot: string,
  files: Array<{ relativePath: string; fileHash: string }>,
) {
  const root = await realpath(resolve(dataRoot));
  for (const file of files) {
    const referenced = database.prepare(
      `SELECT 1 FROM video_image_candidates WHERE relative_path = ? AND file_hash = ?
       UNION ALL
       SELECT 1 FROM asset_candidates WHERE relative_path = ? AND file_hash = ? LIMIT 1`,
    ).get(file.relativePath, file.fileHash, file.relativePath, file.fileHash);
    if (referenced) continue;
    const path = resolve(join(dataRoot, ...file.relativePath.split("/")));
    if (!path.startsWith(`${root}${sep}`)) continue;
    try {
      const info = await lstat(path);
      if (!info.isFile() || info.isSymbolicLink() || !(await realpath(path)).startsWith(`${root}${sep}`)) continue;
      await unlink(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
}
