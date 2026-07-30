import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

import { limitedResponseText, textModelRequest, type ChapterTextModelConfig } from "./chapter-event-analyzer.js";
import { getBookPromptProfileRevision, getOrCreateBookPromptProfile, bookPromptInstructions } from "./book-prompt-profile-store.js";
import { getBookStoryBible } from "./book-story-bible-store.js";
import { getEpisode } from "./episode-store.js";
import { createJob, getJob, type CreateJobInput, type JobRecord } from "./job-store.js";
import { PRODUCT_PROMPTS, PRODUCT_PROMPT_VERSIONS, layeredPrompt } from "./product-prompts.js";
import { requireApprovedScriptForProduction } from "./script-approval-store.js";
import { getScriptVersion } from "./script-version-store.js";
import {
  completedTextModelEvidence,
  rememberTextModelEvidence,
  streamedText,
  textModelCallError,
  textModelResultError,
  TextModelStreamError,
  type TextModelStreamStatistics,
} from "./text-model-stream.js";
import { textModelConcurrencyGate } from "./text-model-concurrency.js";
import { JobCancelledError, type JobHandler } from "./job-worker.js";

export const ASSET_PROMPT_DRAFT_JOB_TYPE = "asset_prompt_draft_generate";
export const ASSET_PROMPT_DRAFT_CONTRACT_VERSION = "asset-prompt-draft-v1";

export interface AssetPromptDraft {
  evidence: string;
  sceneIntent: string;
  subjectAction: string;
  environment: string;
  lightingComposition: string;
  styleConstraints: string;
  prompt: string;
}

export interface GenerateAssetPromptDraftInput {
  prompt: string;
  stage: string;
  signal: AbortSignal;
  onActivity: () => void;
}

export type GenerateAssetPromptDraft = (input: GenerateAssetPromptDraftInput) => Promise<unknown>;

type DraftKind = "character" | "scene" | "prop" | "story";

interface FrozenPayload {
  contractVersion: typeof ASSET_PROMPT_DRAFT_CONTRACT_VERSION;
  episodeId: string;
  seriesId: string;
  bookId: string;
  assetId: string;
  assetType: "character" | "scene" | "prop";
  assetName: string;
  assetState: string | null;
  assetAliases: string[];
  draftKind: DraftKind;
  scriptVersionId: string;
  scriptContentHash: string;
  approvalRevision: number;
  narration: Array<{ text: string; sourceIndexes: number[] }>;
  sources: Array<{ sourceIndex: number; chapterId: string; sourceEventId: string; sourceHash: string; text: string }>;
  storyBible: { id: string; contentHash: string; content: unknown } | null;
  approvedReferenceAssets: Array<{ assetId: string; candidateId: string; name: string; stateLabel: string | null }>;
  productPromptVersion: typeof PRODUCT_PROMPT_VERSIONS.assetPromptDraft;
  bookPromptProfileRevision: number;
  bookPromptProfileHash: string;
  bookPromptInstructions: string;
  providerId: string;
  model: string;
  requestHash: string;
}

const HASH = /^[0-9a-f]{64}$/u;
const OUTPUT_FIELDS = ["evidence", "sceneIntent", "subjectAction", "environment", "lightingComposition", "styleConstraints", "prompt"] as const;

function hash(value: string) { return createHash("sha256").update(value).digest("hex"); }

function text(value: unknown, label: string, maximum = 255) {
  if (typeof value !== "string") throw new Error(`${label}无效`);
  const normalized = value.replace(/\r\n?/gu, "\n").trim();
  if (!normalized || normalized.length > maximum) throw new Error(`${label}无效`);
  return normalized;
}

function parseDraft(value: unknown): AssetPromptDraft {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("资产 Prompt 草稿输出无效");
  const row = value as Record<string, unknown>;
  if (Object.keys(row).some((key) => !OUTPUT_FIELDS.includes(key as typeof OUTPUT_FIELDS[number])) ||
      OUTPUT_FIELDS.some((key) => !(key in row))) throw new Error("资产 Prompt 草稿字段无效");
  return Object.fromEntries(OUTPUT_FIELDS.map((key) => [key, text(row[key], `资产 Prompt 草稿 ${key}`, 20_000)])) as unknown as AssetPromptDraft;
}

function request(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("资产 Prompt 草稿任务参数无效");
  const input = value as { episodeId?: unknown; assetId?: unknown; draftKind?: unknown };
  const episodeId = text(input.episodeId, "分集 ID");
  const assetId = text(input.assetId, "资产 ID");
  if (!/^[A-Za-z0-9_-]+$/u.test(episodeId) || !/^[A-Za-z0-9_-]+$/u.test(assetId)) throw new Error("分集或资产 ID 无效");
  const draftKind = input.draftKind === undefined ? undefined : text(input.draftKind, "草稿类型", 20);
  if (draftKind !== undefined && !["character", "scene", "prop", "story"].includes(draftKind)) throw new Error("资产 Prompt 草稿类型无效");
  return { episodeId, assetId, draftKind: draftKind as DraftKind | undefined };
}

function latestWorldview(database: DatabaseSync, seriesId: string, bookId: string) {
  const run = database.prepare(
    `SELECT story_bible_id FROM series_pipeline_runs WHERE series_project_id = ?
     ORDER BY created_at DESC, id DESC LIMIT 1`,
  ).get(seriesId) as { story_bible_id: string | null } | undefined;
  if (!run?.story_bible_id) return null;
  const bible = getBookStoryBible(database, run.story_bible_id);
  if (bible.bookId !== bookId || bible.scope !== "final" || bible.invalidatedAt !== null) {
    throw new Error("当前全书世界观身份已失效，不能生成资产 Prompt 草稿");
  }
  return { id: bible.id, contentHash: bible.contentHash, content: bible.content };
}

function approvedReferences(database: DatabaseSync, seriesId: string) {
  return database.prepare(
    `SELECT asset.id AS assetId, candidate.id AS candidateId, asset.canonical_name AS name, asset.state_label AS stateLabel
     FROM asset_candidates candidate JOIN assets asset ON asset.id = candidate.asset_id
     WHERE asset.series_project_id = ? AND (
       SELECT event.action FROM asset_candidate_review_events event WHERE event.candidate_id = candidate.id
       AND event.action IN ('approve', 'reject') ORDER BY event.revision DESC LIMIT 1
     ) = 'approve' ORDER BY asset.id, candidate.id`,
  ).all(seriesId) as unknown as FrozenPayload["approvedReferenceAssets"];
}

async function frozenPayload(database: DatabaseSync, dataRoot: string, config: ChapterTextModelConfig, raw: unknown) {
  const input = request(raw);
  const asset = database.prepare(
    `SELECT asset.series_project_id, asset.asset_type, asset.canonical_name, asset.state_label, project.book_id
     FROM assets asset JOIN series_projects project ON project.id = asset.series_project_id WHERE asset.id = ?`,
  ).get(input.assetId) as { series_project_id: string; asset_type: "character" | "scene" | "prop"; canonical_name: string; state_label: string | null; book_id: string } | undefined;
  if (!asset) throw new Error("资产不存在");
  const episodeRow = database.prepare("SELECT series_project_id, episode_index FROM episodes WHERE id = ?").get(input.episodeId) as { series_project_id: string; episode_index: number } | undefined;
  if (!episodeRow || episodeRow.series_project_id !== asset.series_project_id) throw new Error("资产与分集不属于同一系列");
  const approval = requireApprovedScriptForProduction(database, input.episodeId, "image");
  const script = getScriptVersion(database, approval.scriptVersionId);
  if (!script || script.kind !== "packaged" || script.contentHash !== approval.contentHash) throw new Error("批准成片旁白稿身份无效");
  const episode = await getEpisode(database, dataRoot, asset.series_project_id, episodeRow.episode_index);
  const used = [...new Set(script.paragraphs.flatMap((paragraph) => paragraph.sources.map((source) => source.episodeSourceIndex)))].sort((a, b) => a - b);
  const sourceMap = new Map(episode.sources.map((source) => [source.sourceIndex, source]));
  if (used.some((index) => !sourceMap.has(index))) throw new Error("批准旁白引用的原文来源已失效");
  const profile = getOrCreateBookPromptProfile(database, asset.book_id);
  const aliases = database.prepare("SELECT alias FROM asset_aliases WHERE asset_id = ? ORDER BY is_primary DESC, normalized_alias")
    .all(input.assetId).map((row) => String(row.alias));
  const withoutHash: Omit<FrozenPayload, "requestHash"> = {
    contractVersion: ASSET_PROMPT_DRAFT_CONTRACT_VERSION,
    episodeId: input.episodeId, seriesId: asset.series_project_id, bookId: asset.book_id,
    assetId: input.assetId, assetType: asset.asset_type, assetName: asset.canonical_name,
    assetState: asset.state_label, assetAliases: aliases,
    draftKind: input.draftKind ?? asset.asset_type,
    scriptVersionId: approval.scriptVersionId, scriptContentHash: approval.contentHash,
    approvalRevision: approval.approvalRevision,
    narration: script.paragraphs.map((paragraph) => ({ text: paragraph.text, sourceIndexes: paragraph.sources.map((source) => source.episodeSourceIndex) })),
    sources: used.map((index) => {
      const source = sourceMap.get(index)!;
      return { sourceIndex: index, chapterId: source.chapterId, sourceEventId: source.sourceEventId, sourceHash: source.sourceHash, text: source.sourceText };
    }),
    storyBible: latestWorldview(database, asset.series_project_id, asset.book_id),
    approvedReferenceAssets: approvedReferences(database, asset.series_project_id),
    productPromptVersion: PRODUCT_PROMPT_VERSIONS.assetPromptDraft,
    bookPromptProfileRevision: profile.revision, bookPromptProfileHash: profile.profileHash,
    bookPromptInstructions: bookPromptInstructions(profile, "assetInstructions"),
    providerId: text(config.providerId, "模型提供方", 100), model: text(config.model, "模型", 150),
  };
  return { ...withoutHash, requestHash: hash(JSON.stringify(withoutHash)) } satisfies FrozenPayload;
}

function parseFrozenPayload(value: unknown): FrozenPayload {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("资产 Prompt 草稿冻结参数无效");
  const payload = value as FrozenPayload;
  const { requestHash, ...withoutHash } = payload;
  if (payload.contractVersion !== ASSET_PROMPT_DRAFT_CONTRACT_VERSION ||
      payload.productPromptVersion !== PRODUCT_PROMPT_VERSIONS.assetPromptDraft ||
      !HASH.test(requestHash) || hash(JSON.stringify(withoutHash)) !== requestHash) throw new Error("资产 Prompt 草稿冻结身份无效");
  return payload;
}

export async function enqueueAssetPromptDraftJob(
  database: DatabaseSync, dataRoot: string, config: ChapterTextModelConfig,
  input: Omit<CreateJobInput, "id" | "type">,
): Promise<{ job: JobRecord; created: boolean }> {
  const payload = await frozenPayload(database, dataRoot, config, input.payload);
  const id = `job_asset_prompt_${payload.requestHash}`;
  const existing = getJob(database, id);
  if (existing) {
    if (existing.type !== ASSET_PROMPT_DRAFT_JOB_TYPE || JSON.stringify(existing.payload) !== JSON.stringify(payload)) throw new Error("资产 Prompt 草稿任务身份冲突");
    return { job: existing, created: false };
  }
  return { job: createJob(database, { ...input, id, type: ASSET_PROMPT_DRAFT_JOB_TYPE, payload }), created: true };
}

async function currentIdentity(database: DatabaseSync, dataRoot: string, task: FrozenPayload) {
  if (!database.prepare("SELECT 1 FROM assets WHERE id = ? AND series_project_id = ?").get(task.assetId, task.seriesId)) {
    throw new Error("资产 Prompt 草稿目标资产已失效");
  }
  const approval = requireApprovedScriptForProduction(database, task.episodeId, "image");
  if (approval.scriptVersionId !== task.scriptVersionId || approval.contentHash !== task.scriptContentHash || approval.approvalRevision !== task.approvalRevision) {
    throw new Error("批准成片旁白稿已变化，请重新生成资产 Prompt 草稿");
  }
  const profile = getBookPromptProfileRevision(database, task.bookId, task.bookPromptProfileRevision);
  if (!profile || profile.profileHash !== task.bookPromptProfileHash) throw new Error("本书专属提示词冻结身份不可用");
  const episodeIndex = (database.prepare("SELECT episode_index FROM episodes WHERE id = ?").get(task.episodeId) as { episode_index: number } | undefined)?.episode_index;
  if (!episodeIndex) throw new Error("资产 Prompt 草稿分集已失效");
  const episode = await getEpisode(database, dataRoot, task.seriesId, episodeIndex);
  const currentSources = new Map(episode.sources.map((source) => [source.sourceIndex, source]));
  if (task.sources.some((source) => {
    const current = currentSources.get(source.sourceIndex);
    return !current || current.chapterId !== source.chapterId || current.sourceEventId !== source.sourceEventId ||
      current.sourceHash !== source.sourceHash || current.sourceText !== source.text;
  })) throw new Error("资产 Prompt 草稿对应原文来源已变化，请重新生成");
  const approved = new Set(approvedReferences(database, task.seriesId).map((reference) => reference.candidateId));
  if (task.approvedReferenceAssets.some((reference) => !approved.has(reference.candidateId))) {
    throw new Error("资产 Prompt 草稿引用的参考资产已不再批准，请重新生成");
  }
  const worldview = latestWorldview(database, task.seriesId, task.bookId);
  if (JSON.stringify(worldview && { id: worldview.id, contentHash: worldview.contentHash }) !==
      JSON.stringify(task.storyBible && { id: task.storyBible.id, contentHash: task.storyBible.contentHash })) {
    throw new Error("当前全书世界观已变化，请重新生成资产 Prompt 草稿");
  }
}

export function createAssetPromptDraftJobHandler(
  database: DatabaseSync, dataRoot: string, config: ChapterTextModelConfig, generate: GenerateAssetPromptDraft,
): JobHandler {
  return async (context) => {
    const task = parseFrozenPayload(context.job.payload);
    if (context.job.id !== `job_asset_prompt_${task.requestHash}` || task.providerId !== config.providerId.trim() || task.model !== config.model.trim()) {
      throw new Error("资产 Prompt 草稿任务或模型冻结身份不一致");
    }
    await currentIdentity(database, dataRoot, task);
    const previous = context.getCheckpoint("asset-prompt-draft", task.assetId);
    if (previous?.inputHash === task.requestHash && previous.output) return parseDraft(previous.output);
    context.throwIfCancellationRequested();
    const controller = new AbortController();
    const poll = setInterval(() => { if (context.isCancellationRequested()) controller.abort(); }, 50);
    let raw: unknown;
    try {
      raw = await generate({
        stage: `asset-prompt:${task.assetId}`,
        signal: controller.signal,
        onActivity: () => undefined,
        prompt: layeredPrompt(PRODUCT_PROMPTS.assetPromptDraft, task.bookPromptInstructions, JSON.stringify({
          contractVersion: task.contractVersion,
          outputSchema: Object.fromEntries(OUTPUT_FIELDS.map((field) => [field, "非空字符串"])),
          target: { assetId: task.assetId, type: task.assetType, draftKind: task.draftKind, name: task.assetName, state: task.assetState, aliases: task.assetAliases },
          approvedNarration: task.narration, sourceTexts: task.sources, fullBookWorldview: task.storyBible?.content ?? null,
          approvedReferenceAssets: task.approvedReferenceAssets,
        })),
      });
    } catch (error) {
      if (controller.signal.aborted || context.isCancellationRequested()) throw new JobCancelledError();
      throw error;
    } finally { clearInterval(poll); }
    let draft: AssetPromptDraft;
    try {
      draft = parseDraft(raw);
    } catch (error) {
      throw raw && typeof raw === "object"
        ? textModelResultError(error, `asset-prompt:${task.assetId}`, raw)
        : textModelCallError(error, `asset-prompt:${task.assetId}`);
    }
    await currentIdentity(database, dataRoot, task);
    context.commitCheckpoint("asset-prompt-draft", task.assetId, task.requestHash, () => undefined, draft);
    return draft;
  };
}

export function createOpenAiAssetPromptDraftGenerator(config: ChapterTextModelConfig, fetchImpl: typeof fetch = fetch): GenerateAssetPromptDraft {
  return async ({ prompt, stage, signal, onActivity }) => {
    const request = textModelRequest(config, `${prompt}\n\n只输出符合 outputSchema �� JSON 对象，不得增加字段或 Markdown。`, 8192, true);
    let statistics: TextModelStreamStatistics | undefined;
    let raw: string;
    try {
      raw = await textModelConcurrencyGate.run(signal, async () => {
        const response = await fetchImpl(request.endpoint, {
          method: "POST", signal, redirect: "error", headers: request.headers, body: request.body,
        });
        if (!response.ok) { await response.body?.cancel(); throw new Error(`资产 Prompt 草稿模型请求失败（HTTP ${response.status}）`); }
        return response.headers.get("content-type")?.toLowerCase().includes("text/event-stream")
          ? streamedText(response, config.protocol ?? "openai-response", {
              signal,
              onActivity,
              onStatistics: (value) => { statistics = value; },
            })
          : limitedResponseText(response, {
            protocol: config.protocol ?? "openai-response", signal, onActivity,
            onStatistics: (value) => { statistics = value; },
          });
      });
    } catch (error) {
      throw error instanceof TextModelStreamError
        ? textModelCallError(error, stage, {
            statistics: error.statistics,
            partialText: error.partialText,
            partialTextTruncated: error.partialTextTruncated,
          })
        : textModelCallError(error, stage);
    }
    const evidence = completedTextModelEvidence(raw, statistics);
    try { return rememberTextModelEvidence(JSON.parse(raw) as object, evidence); }
    catch (error) { throw textModelCallError(new Error("资产 Prompt 草稿模型返回了无效 JSON", { cause: error }), stage, evidence); }
  };
}
