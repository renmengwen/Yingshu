import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

import { createJob } from "./job-store.js";
import type { JobExecutionContext, JobHandler } from "./job-worker.js";
import { requireApprovedScriptForProduction } from "./script-approval-store.js";

export const TTS_LISTENING_REVIEW_JOB_TYPE = "tts_listening_review";
const CONTRACT = "tts-listening-review-v1";
const HASH = /^[0-9a-f]{64}$/;

export type TtsListeningReviewAction = "approve" | "reject";

export interface TtsListeningReviewIdentity {
  episodeId: string;
  scriptVersionId: string;
  contentHash: string;
  approvalRevision: number;
  timelineHash: string;
  providerId: string;
  voice: string;
  rate: number;
  storyBibleId: string | null;
  storyBibleContentHash: string;
  properNounsHash: string;
  representativeHash: string;
}

export interface RequiredProperNounReview {
  term: string;
  pronunciation: string;
  matchedText: string;
  segmentIndex: number;
}

export interface TtsListeningReviewWorkspace {
  identity: TtsListeningReviewIdentity;
  segments: Array<{ index: number; text: string; durationMs: number }>;
  requiredSegmentIndexes: number[];
  requiredProperNouns: RequiredProperNounReview[];
  latestReview: TtsListeningReviewCredential | null;
}

interface ReviewPayload {
  contract: typeof CONTRACT;
  identity: TtsListeningReviewIdentity;
  action: TtsListeningReviewAction;
  checkedSegmentIndexes: number[];
  checkedProperNouns: string[];
  notes: string | null;
}

export interface TtsListeningReviewCredential extends ReviewPayload {
  jobId: string;
}

export class TtsListeningReviewError extends Error {
  constructor(readonly statusCode: number, message: string) { super(message); }
}

function sha256(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

function uniqueSortedNumbers(values: readonly number[]) {
  return [...new Set(values)].sort((left, right) => left - right);
}

function reviewChecks(
  segmentIndexes: unknown, properNounTerms: unknown,
): { checkedSegmentIndexes: number[]; checkedProperNouns: string[] } {
  if (!Array.isArray(segmentIndexes) || !Array.isArray(properNounTerms) ||
      segmentIndexes.some((index) => !Number.isSafeInteger(index)) ||
      properNounTerms.some((term) => typeof term !== "string" || !term)) {
    throw new TtsListeningReviewError(400, "听审核对项无效");
  }
  return {
    checkedSegmentIndexes: uniqueSortedNumbers(segmentIndexes as number[]),
    checkedProperNouns: [...new Set(properNounTerms as string[])].sort(),
  };
}

export function representativeSegmentIndexes(segmentCount: number) {
  if (!Number.isSafeInteger(segmentCount) || segmentCount < 1) {
    throw new TtsListeningReviewError(409, "当前语音时间轴没有可听审片段");
  }
  const last = segmentCount - 1;
  return uniqueSortedNumbers([0, Math.floor(last * 0.25), Math.floor(last * 0.5), Math.floor(last * 0.75), last]);
}

function sameIdentity(left: TtsListeningReviewIdentity, right: TtsListeningReviewIdentity) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function listeningProperNouns(database: DatabaseSync, storyBibleId: string | null, seriesId: string) {
  if (!storyBibleId) {
    const rows = database.prepare(
      `SELECT asset.id, asset.canonical_name, alias.alias
       FROM assets asset LEFT JOIN asset_aliases alias ON alias.asset_id = asset.id
       WHERE asset.series_project_id = ?
       ORDER BY asset.canonical_name, asset.id, alias.is_primary DESC, alias.normalized_alias`,
    ).all(seriesId) as unknown as Array<{ id: string; canonical_name: string; alias: string | null }>;
    const nouns = new Map<string, { term: string; pronunciation: string; aliases: string[] }>();
    for (const row of rows) {
      const current = nouns.get(row.id) ?? {
        term: row.canonical_name.normalize("NFKC"), pronunciation: "请人工确认", aliases: [],
      };
      if (row.alias) current.aliases.push(row.alias.normalize("NFKC"));
      nouns.set(row.id, current);
    }
    const properNouns = [...nouns.values()].map((noun) => ({
      ...noun, aliases: [...new Set(noun.aliases)].sort(),
    }));
    return { contentHash: sha256(JSON.stringify(properNouns)), properNouns };
  }
  try {
    const finalBible = database.prepare(
      `SELECT book_id, scope, parent_bible_ids_json, content_json, content_hash, invalidated_at
       FROM book_story_bibles WHERE id = ?`,
    ).get(storyBibleId) as {
      book_id: string; scope: string; parent_bible_ids_json: string; content_json: string;
      content_hash: string; invalidated_at: number | null;
    } | undefined;
    if (!finalBible || finalBible.scope !== "final" || finalBible.invalidated_at !== null ||
        sha256(finalBible.content_json) !== finalBible.content_hash) throw new Error();
    const frozenParents = JSON.parse(finalBible.parent_bible_ids_json) as unknown;
    if (!Array.isArray(frozenParents)) throw new Error();
    const parentRows = frozenParents.map((item) => {
      if (!item || typeof item !== "object" || Array.isArray(item)) throw new Error();
      const snapshot = item as Record<string, unknown>;
      if (Object.keys(snapshot).sort().join(",") !== "contentHash,id" || typeof snapshot.id !== "string" ||
          typeof snapshot.contentHash !== "string" || !HASH.test(snapshot.contentHash)) throw new Error();
      const parent = database.prepare(
        `SELECT book_id, scope, content_json, content_hash, invalidated_at
         FROM book_story_bibles WHERE id = ?`,
      ).get(snapshot.id) as {
        book_id: string; scope: string; content_json: string; content_hash: string; invalidated_at: number | null;
      } | undefined;
      if (!parent || parent.book_id !== finalBible.book_id || parent.scope !== "interval" || parent.invalidated_at !== null ||
          parent.content_hash !== snapshot.contentHash || sha256(parent.content_json) !== parent.content_hash) throw new Error();
      return parent;
    });

    const unique = new Map<string, { term: string; pronunciation: string; aliases: string[] }>();
    for (const bible of [finalBible, ...parentRows]) {
      const content = JSON.parse(bible.content_json) as { properNouns?: unknown };
      if (!Array.isArray(content.properNouns)) throw new Error();
      for (const item of content.properNouns) {
        const noun = item as Record<string, unknown>;
        if (typeof noun.term !== "string" || typeof noun.pronunciation !== "string" || !Array.isArray(noun.aliases) ||
            noun.aliases.some((alias) => typeof alias !== "string")) throw new Error();
        const normalized = {
          term: noun.term.normalize("NFKC"),
          pronunciation: noun.pronunciation,
          aliases: [...new Set((noun.aliases as string[]).map((alias) => alias.normalize("NFKC")))].sort(),
        };
        unique.set(JSON.stringify(normalized), normalized);
      }
    }
    return {
      contentHash: finalBible.content_hash,
      properNouns: [...unique.values()].sort((left, right) =>
        left.term.localeCompare(right.term) || left.pronunciation.localeCompare(right.pronunciation) ||
        JSON.stringify(left.aliases).localeCompare(JSON.stringify(right.aliases))),
    };
  } catch {
    throw new TtsListeningReviewError(409, "当前全书世界观专名及冻结父层合同无效");
  }
}

function currentWorkspace(database: DatabaseSync, episodeId: string, timelineHash: string) {
  if (!episodeId || !HASH.test(timelineHash)) throw new TtsListeningReviewError(400, "听审目标无效");
  const approved = requireApprovedScriptForProduction(database, episodeId, "tts");
  const episode = database.prepare(
    "SELECT series_project_id FROM episodes WHERE id = ?",
  ).get(episodeId) as { series_project_id: string } | undefined;
  if (!episode) throw new TtsListeningReviewError(404, "分集不存在");
  const rows = database.prepare(
    `SELECT segment_index, text, provider_id, voice, rate, duration_ms, script_version_id
     FROM audio_segments WHERE episode_id = ? AND timeline_hash = ? ORDER BY segment_index`,
  ).all(episodeId, timelineHash) as unknown as Array<{
    segment_index: number; text: string; provider_id: string; voice: string; rate: number;
    duration_ms: number; script_version_id: string;
  }>;
  if (!rows.length || rows.some((row, index) => row.segment_index !== index ||
      row.script_version_id !== approved.scriptVersionId || row.provider_id !== rows[0]!.provider_id ||
      row.voice !== rows[0]!.voice || row.rate !== rows[0]!.rate)) {
    throw new TtsListeningReviewError(409, "语音时间轴与当前批准稿件或配音设置不一致");
  }

  const run = database.prepare(
    `SELECT status, story_bible_id FROM series_pipeline_runs
     WHERE series_project_id = ? ORDER BY created_at DESC, id DESC LIMIT 1`,
  ).get(episode.series_project_id) as { status: string; story_bible_id: string | null } | undefined;
  if (!run || run.status === "cancelled") throw new TtsListeningReviewError(409, "当前系列流水线不可用于听审");
  const bible = listeningProperNouns(database, run.story_bible_id, episode.series_project_id);
  const properNouns = bible.properNouns;

  const requiredProperNouns: RequiredProperNounReview[] = [];
  for (const noun of properNouns) {
    const names = [noun.term, ...noun.aliases].filter(Boolean);
    const match = rows.flatMap((row) => names.map((name) => ({ row, name })))
      .find(({ row, name }) => row.text.normalize("NFKC").includes(name));
    if (match) requiredProperNouns.push({
      term: noun.term, pronunciation: noun.pronunciation, matchedText: match.name, segmentIndex: match.row.segment_index,
    });
  }
  const baseIndexes = representativeSegmentIndexes(rows.length);
  const requiredSegmentIndexes = uniqueSortedNumbers([
    ...baseIndexes, ...requiredProperNouns.map((item) => item.segmentIndex),
  ]);
  const properNounsHash = sha256(JSON.stringify(properNouns));
  const representativeHash = sha256(JSON.stringify({ requiredSegmentIndexes, requiredProperNouns }));
  const identity: TtsListeningReviewIdentity = {
    ...approved, timelineHash, providerId: rows[0]!.provider_id, voice: rows[0]!.voice, rate: rows[0]!.rate,
    storyBibleId: run.story_bible_id, storyBibleContentHash: bible.contentHash, properNounsHash, representativeHash,
  };
  return {
    identity,
    segments: rows.map((row) => ({ index: row.segment_index, text: row.text, durationMs: row.duration_ms })),
    requiredSegmentIndexes,
    requiredProperNouns,
  };
}

function latestMatchingReview(database: DatabaseSync, identity: TtsListeningReviewIdentity) {
  const rows = database.prepare(
    `SELECT id, payload_json, result_json FROM jobs
     WHERE type = ? AND status = 'succeeded' AND result_json IS NOT NULL
     ORDER BY finished_at DESC, created_at DESC, id DESC`,
  ).all(TTS_LISTENING_REVIEW_JOB_TYPE) as unknown as Array<{ id: string; payload_json: string; result_json: string }>;
  for (const row of rows) {
    try {
      const payload = JSON.parse(row.payload_json) as ReviewPayload;
      const result = JSON.parse(row.result_json) as TtsListeningReviewCredential;
      if (payload.contract === CONTRACT && result.jobId === row.id && sameIdentity(payload.identity, identity) &&
          sameIdentity(result.identity, identity) && result.contract === payload.contract && result.action === payload.action &&
          JSON.stringify(result.checkedSegmentIndexes) === JSON.stringify(payload.checkedSegmentIndexes) &&
          JSON.stringify(result.checkedProperNouns) === JSON.stringify(payload.checkedProperNouns) && result.notes === payload.notes) return result;
    } catch { /* 忽略旧版或损坏的任务结果。 */ }
  }
  return null;
}

export function getTtsListeningReviewWorkspace(
  database: DatabaseSync, episodeId: string, timelineHash: string,
): TtsListeningReviewWorkspace {
  const workspace = currentWorkspace(database, episodeId, timelineHash);
  return { ...workspace, latestReview: latestMatchingReview(database, workspace.identity) };
}

export function enqueueTtsListeningReview(
  database: DatabaseSync,
  input: {
    episodeId: string; timelineHash: string; action: TtsListeningReviewAction;
    checkedSegmentIndexes: number[]; checkedProperNouns: string[]; notes?: string | null;
  },
  now = Date.now(),
) {
  if (input.action !== "approve" && input.action !== "reject") {
    throw new TtsListeningReviewError(400, "听审操作无效");
  }
  const workspace = currentWorkspace(database, input.episodeId, input.timelineHash);
  const { checkedSegmentIndexes, checkedProperNouns } = reviewChecks(
    input.checkedSegmentIndexes, input.checkedProperNouns,
  );
  const requiredTerms = workspace.requiredProperNouns.map((item) => item.term);
  if (checkedSegmentIndexes.some((index) => !workspace.requiredSegmentIndexes.includes(index)) ||
      checkedProperNouns.some((term) => !requiredTerms.includes(term))) {
    throw new TtsListeningReviewError(400, "听审核对项无效");
  }
  if (input.action === "approve" && (
    workspace.requiredSegmentIndexes.some((index) => !checkedSegmentIndexes.includes(index)) ||
    workspace.requiredProperNouns.some((item) => !checkedProperNouns.includes(item.term))
  )) throw new TtsListeningReviewError(409, "批准前必须完成全部代表段和专名听审");
  const notes = input.notes == null ? null : input.notes.trim();
  if (notes !== null && (!notes || notes.length > 2_000)) throw new TtsListeningReviewError(400, "听审备注长度无效");
  return createJob(database, {
    type: TTS_LISTENING_REVIEW_JOB_TYPE,
    payload: { contract: CONTRACT, identity: workspace.identity, action: input.action, checkedSegmentIndexes, checkedProperNouns, notes } satisfies ReviewPayload,
    maxAttempts: 1,
  }, now);
}

export function createTtsListeningReviewJobHandler(database: DatabaseSync): JobHandler {
  return async (context: JobExecutionContext) => {
    const payload = context.job.payload as ReviewPayload;
    if (payload?.contract !== CONTRACT || (payload.action !== "approve" && payload.action !== "reject")) {
      throw new TtsListeningReviewError(400, "人工听审任务合同无效");
    }
    const checks = reviewChecks(payload.checkedSegmentIndexes, payload.checkedProperNouns);
    if (JSON.stringify(checks.checkedSegmentIndexes) !== JSON.stringify(payload.checkedSegmentIndexes) ||
        JSON.stringify(checks.checkedProperNouns) !== JSON.stringify(payload.checkedProperNouns) ||
        (payload.notes !== null && (typeof payload.notes !== "string" || !payload.notes || payload.notes.length > 2_000))) {
      throw new TtsListeningReviewError(400, "人工听审任务合同无效");
    }
    context.throwIfCancellationRequested();
    const current = currentWorkspace(database, payload.identity.episodeId, payload.identity.timelineHash);
    if (!sameIdentity(current.identity, payload.identity)) {
      throw new TtsListeningReviewError(409, "人工听审身份已变化，请重新听审");
    }
    const requiredTerms = current.requiredProperNouns.map((item) => item.term);
    if (payload.checkedSegmentIndexes.some((index) => !current.requiredSegmentIndexes.includes(index)) ||
        payload.checkedProperNouns.some((term) => !requiredTerms.includes(term))) {
      throw new TtsListeningReviewError(409, "人工听审核对项与当前要求不一致");
    }
    if (payload.action === "approve" && (
      current.requiredSegmentIndexes.some((index) => !payload.checkedSegmentIndexes.includes(index)) ||
      current.requiredProperNouns.some((item) => !payload.checkedProperNouns.includes(item.term))
    )) throw new TtsListeningReviewError(409, "人工听审覆盖不完整");
    context.reportProgress(1);
    return { ...payload, jobId: context.job.id } satisfies TtsListeningReviewCredential;
  };
}
