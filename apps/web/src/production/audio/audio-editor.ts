import type { JobRecord, TtsCalibrationSelection, TtsTimeline } from "../types";

export const AUDIO_SEGMENTS_PER_PAGE = 24;
export const REPRESENTATIVE_AUDIO_SEGMENTS = [0, 1, 2, 60, 100, 140, 180, 200, 220, 261] as const;

export interface TtsListeningReviewIdentity {
  episodeId: string; scriptVersionId: string; contentHash: string; approvalRevision: number;
  timelineHash: string; providerId: string; voice: string; rate: number; storyBibleId: string | null;
  storyBibleContentHash: string; properNounsHash: string; representativeHash: string;
}

export interface TtsListeningReviewWorkspace {
  identity: TtsListeningReviewIdentity;
  segments: Array<{ index: number; text: string; durationMs: number }>;
  requiredSegmentIndexes: number[];
  requiredProperNouns: Array<{ term: string; pronunciation: string; matchedText: string; segmentIndex: number }>;
  latestReview: null | {
    action: "approve" | "reject"; checkedSegmentIndexes: number[]; checkedProperNouns: string[]; notes: string | null;
  };
}

const HASH = /^[0-9a-f]{64}$/u;

function record(value: unknown, label: string) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label}格式无效`);
  return value as Record<string, unknown>;
}

function integer(value: unknown, label: string) {
  if (!Number.isSafeInteger(value) || Number(value) < 0) throw new Error(`${label}无效`);
  return Number(value);
}

function strings(value: unknown, label: string) {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || !item)) throw new Error(`${label}无效`);
  return value as string[];
}

function indexes(value: unknown, label: string) {
  if (!Array.isArray(value)) throw new Error(`${label}无效`);
  const parsed = value.map((item) => integer(item, label));
  if (new Set(parsed).size !== parsed.length) throw new Error(`${label}重复`);
  return parsed;
}

export function listeningReviewUrl(episodeId: string, timelineHash: string) {
  return `/api/episodes/${encodeURIComponent(episodeId)}/tts-timelines/${encodeURIComponent(timelineHash)}/listening-review`;
}

export function listeningIdentityKey(identity: TtsListeningReviewIdentity) {
  return JSON.stringify(identity);
}

export function parseListeningReviewWorkspace(
  value: unknown, expected: { episodeId: string; timelineHash: string },
): TtsListeningReviewWorkspace {
  const root = record(value, "人工听审响应");
  if (root.ok !== true) throw new Error("人工听审响应格式无效");
  const input = record(root.workspace, "人工听审工作区");
  const rawIdentity = record(input.identity, "人工听审身份");
  const identity = {
    episodeId: String(rawIdentity.episodeId ?? ""), scriptVersionId: String(rawIdentity.scriptVersionId ?? ""),
    contentHash: String(rawIdentity.contentHash ?? ""), approvalRevision: integer(rawIdentity.approvalRevision, "批准版本"),
    timelineHash: String(rawIdentity.timelineHash ?? ""), providerId: String(rawIdentity.providerId ?? ""),
    voice: String(rawIdentity.voice ?? ""), rate: Number(rawIdentity.rate),
    storyBibleId: rawIdentity.storyBibleId === null ? null : String(rawIdentity.storyBibleId ?? ""),
    storyBibleContentHash: String(rawIdentity.storyBibleContentHash ?? ""), properNounsHash: String(rawIdentity.properNounsHash ?? ""),
    representativeHash: String(rawIdentity.representativeHash ?? ""),
  };
  if (identity.episodeId !== expected.episodeId || identity.timelineHash !== expected.timelineHash ||
      !identity.scriptVersionId || !HASH.test(identity.contentHash) || !identity.providerId || !identity.voice ||
      !Number.isInteger(identity.rate) || identity.rate < -10 || identity.rate > 10 || identity.storyBibleId === "" ||
      !HASH.test(identity.storyBibleContentHash) || !HASH.test(identity.properNounsHash) || !HASH.test(identity.representativeHash)) {
    throw new Error("人工听审响应不属于当前分集或时间轴");
  }
  if (!Array.isArray(input.segments) || !Array.isArray(input.requiredProperNouns)) throw new Error("人工听审清单格式无效");
  const segments = input.segments.map((value) => {
    const segment = record(value, "听审片段");
    return { index: integer(segment.index, "听审片段序号"), text: String(segment.text ?? ""), durationMs: integer(segment.durationMs, "听审片段时长") };
  });
  if (segments.some((segment, index) => segment.index !== index || !segment.text)) throw new Error("听审片段序列无效");
  const requiredSegmentIndexes = indexes(input.requiredSegmentIndexes, "必听片段");
  if (requiredSegmentIndexes.some((index) => !segments[index])) throw new Error("必听片段不在当前时间轴");
  const requiredProperNouns = input.requiredProperNouns.map((value) => {
    const item = record(value, "专名听审项");
    const segmentIndex = integer(item.segmentIndex, "专名命中片段");
    if (typeof item.term !== "string" || !item.term || typeof item.pronunciation !== "string" || !item.pronunciation ||
        typeof item.matchedText !== "string" || !item.matchedText || !requiredSegmentIndexes.includes(segmentIndex)) {
      throw new Error("专名听审项格式无效");
    }
    return { term: item.term, pronunciation: item.pronunciation, matchedText: item.matchedText, segmentIndex };
  });
  if (new Set(requiredProperNouns.map((item) => item.term)).size !== requiredProperNouns.length) throw new Error("专名听审项重复");
  let latestReview: TtsListeningReviewWorkspace["latestReview"] = null;
  if (input.latestReview !== null) {
    const latest = record(input.latestReview, "最新听审结果");
    const latestIdentity = record(latest.identity, "最新听审身份");
    if ((latest.action !== "approve" && latest.action !== "reject") || latest.contract !== "tts-listening-review-v1" ||
        typeof latest.jobId !== "string" || !latest.jobId ||
        Object.entries(identity).some(([key, expected]) => latestIdentity[key] !== expected)) throw new Error("最新听审结果无效");
    const checkedSegmentIndexes = indexes(latest.checkedSegmentIndexes, "已听片段");
    const checkedProperNouns = strings(latest.checkedProperNouns, "已核对专名");
    const requiredTerms = requiredProperNouns.map((item) => item.term);
    if (checkedSegmentIndexes.some((index) => !requiredSegmentIndexes.includes(index)) ||
        checkedProperNouns.some((term) => !requiredTerms.includes(term)) ||
        (latest.notes !== null && (typeof latest.notes !== "string" || !latest.notes))) throw new Error("最新听审结果无效");
    latestReview = {
      action: latest.action,
      checkedSegmentIndexes,
      checkedProperNouns,
      notes: latest.notes,
    };
  }
  return { identity, segments, requiredSegmentIndexes, requiredProperNouns, latestReview };
}

export function listeningReviewPayload(
  action: "approve" | "reject", checkedSegmentIndexes: Iterable<number>, checkedProperNouns: Iterable<string>, notes: string,
) {
  return {
    action,
    checkedSegmentIndexes: [...checkedSegmentIndexes].sort((a, b) => a - b),
    checkedProperNouns: [...checkedProperNouns].sort(),
    notes: notes.trim() || null,
  };
}

export function completedTtsTimelineHash(job: JobRecord | undefined, episodeId: string) {
  if (!job || job.type !== "tts_timeline" || job.status !== "succeeded" ||
      job.result?.episodeId !== episodeId || typeof job.result.timelineHash !== "string" ||
      !/^[0-9a-f]{64}$/.test(job.result.timelineHash)) return undefined;
  return job.result.timelineHash;
}

export function completedTtsCalibrationMode(job: JobRecord | undefined, episodeId: string) {
  if (!job || job.type !== "tts_calibration" || job.status !== "succeeded" ||
      job.result?.episodeId !== episodeId || (job.result.mode !== "generate" && job.result.mode !== "select")) return undefined;
  return job.result.mode;
}

export function ttsTimelinePayload(
  episodeId: string,
  voice: string,
  rate: number,
  selection?: TtsCalibrationSelection,
) {
  return {
    episodeId,
    voice: selection?.voice ?? voice.trim(),
    rate: selection?.rate ?? rate,
  };
}

export function audioPageCount(segmentCount: number, pageSize = AUDIO_SEGMENTS_PER_PAGE) {
  return Math.max(1, Math.ceil(Math.max(0, segmentCount) / pageSize));
}

export function clampAudioPage(page: number, segmentCount: number, pageSize = AUDIO_SEGMENTS_PER_PAGE) {
  return Math.min(Math.max(0, page), audioPageCount(segmentCount, pageSize) - 1);
}

export function audioSegmentsForPage<T>(segments: T[], page: number, pageSize = AUDIO_SEGMENTS_PER_PAGE) {
  const current = clampAudioPage(page, segments.length, pageSize);
  return segments.slice(current * pageSize, current * pageSize + pageSize);
}

export function audioSegmentUrl(timeline: Pick<TtsTimeline, "episodeId" | "timelineHash">, index: number) {
  return `/api/episodes/${encodeURIComponent(timeline.episodeId)}/tts-timelines/${encodeURIComponent(timeline.timelineHash)}/audio/${index}`;
}
