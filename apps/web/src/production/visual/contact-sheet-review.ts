import type { ContactSheetResult } from "./types";

const HASH = /^[0-9a-f]{64}$/u;
const CONTRACT = "contact-sheet-review-v1" as const;

export interface ContactSheetReviewIdentity {
  contract: typeof CONTRACT;
  episodeId: string;
  scriptVersionId: string;
  approvalRevision: number;
  timelineHash: string;
  visualPlanHash: string;
  jsonHash: string;
  htmlHash: string;
}

export interface ContactSheetReviewWorkspace {
  identity: ContactSheetReviewIdentity;
  identityHash: string;
  contactSheet: ContactSheetResult;
  latestReview: null | {
    contract: typeof CONTRACT;
    identity: ContactSheetReviewIdentity;
    identityHash: string;
    action: "approve" | "reject";
    notes: string | null;
    jobId: string;
  };
  hasStaleReview: boolean;
}

function record(value: unknown, label: string) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label}格式无效`);
  return value as Record<string, unknown>;
}

function exactKeys(value: Record<string, unknown>, keys: string[], label: string) {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) throw new Error(`${label}字段无效`);
}

function nonEmpty(value: unknown, label: string) {
  if (typeof value !== "string" || !value) throw new Error(`${label}无效`);
  return value;
}

function hash(value: unknown, label: string) {
  const parsed = nonEmpty(value, label);
  if (!HASH.test(parsed)) throw new Error(`${label}无效`);
  return parsed;
}

function identity(value: unknown) {
  const input = record(value, "联系表审核身份");
  exactKeys(input, ["contract", "episodeId", "scriptVersionId", "approvalRevision", "timelineHash", "visualPlanHash", "jsonHash", "htmlHash"], "联系表审核身份");
  const approvalRevision = Number(input.approvalRevision);
  const parsed: ContactSheetReviewIdentity = {
    contract: input.contract as typeof CONTRACT,
    episodeId: nonEmpty(input.episodeId, "分集身份"),
    scriptVersionId: nonEmpty(input.scriptVersionId, "稿件身份"),
    approvalRevision,
    timelineHash: hash(input.timelineHash, "时间轴哈希"),
    visualPlanHash: hash(input.visualPlanHash, "视觉计划哈希"),
    jsonHash: hash(input.jsonHash, "联系表 JSON 哈希"),
    htmlHash: hash(input.htmlHash, "联系表 HTML 哈希"),
  };
  if (parsed.contract !== CONTRACT || !Number.isSafeInteger(approvalRevision) || approvalRevision < 0) throw new Error("联系表审核身份无效");
  return parsed;
}

function contactSheet(value: unknown) {
  const input = record(value, "联系表");
  exactKeys(input, ["episodeId", "timelineHash", "directoryPath", "jsonPath", "htmlPath", "jsonHash", "htmlHash"], "联系表");
  return {
    episodeId: nonEmpty(input.episodeId, "联系表分集"),
    timelineHash: hash(input.timelineHash, "联系表时间轴哈希"),
    directoryPath: nonEmpty(input.directoryPath, "联系表目录"),
    jsonPath: nonEmpty(input.jsonPath, "联系表 JSON 路径"),
    htmlPath: nonEmpty(input.htmlPath, "联系表 HTML 路径"),
    jsonHash: hash(input.jsonHash, "联系表 JSON 哈希"),
    htmlHash: hash(input.htmlHash, "联系表 HTML 哈希"),
  };
}

export function contactSheetReviewUrl(episodeId: string, timelineHash: string) {
  return `/api/episodes/${encodeURIComponent(episodeId)}/contact-sheet/review?timelineHash=${encodeURIComponent(timelineHash)}`;
}

export function parseContactSheetReviewWorkspace(
  value: unknown,
  expected: { episodeId: string; timelineHash: string },
): ContactSheetReviewWorkspace {
  const root = record(value, "联系表审核响应");
  exactKeys(root, ["ok", "workspace"], "联系表审核响应");
  if (root.ok !== true) throw new Error("联系表审核响应格式无效");
  const input = record(root.workspace, "联系表审核工作区");
  exactKeys(input, ["identity", "identityHash", "contactSheet", "latestReview", "hasStaleReview"], "联系表审核工作区");
  const currentIdentity = identity(input.identity);
  const currentIdentityHash = hash(input.identityHash, "联系表审核身份哈希");
  const currentContactSheet = contactSheet(input.contactSheet);
  if (currentIdentity.episodeId !== expected.episodeId || currentIdentity.timelineHash !== expected.timelineHash ||
      currentContactSheet.episodeId !== expected.episodeId || currentContactSheet.timelineHash !== expected.timelineHash ||
      currentContactSheet.jsonHash !== currentIdentity.jsonHash || currentContactSheet.htmlHash !== currentIdentity.htmlHash) {
    throw new Error("联系表审核响应不属于当前分集或时间轴");
  }
  if (typeof input.hasStaleReview !== "boolean") throw new Error("联系表历史审核状态无效");
  let latestReview: ContactSheetReviewWorkspace["latestReview"] = null;
  if (input.latestReview !== null) {
    const latest = record(input.latestReview, "最新联系表审核");
    exactKeys(latest, ["contract", "identity", "identityHash", "action", "notes", "jobId"], "最新联系表审核");
    const latestIdentity = identity(latest.identity);
    if (latest.contract !== CONTRACT || (latest.action !== "approve" && latest.action !== "reject") ||
        hash(latest.identityHash, "最新审核身份哈希") !== currentIdentityHash ||
        JSON.stringify(latestIdentity) !== JSON.stringify(currentIdentity) ||
        typeof latest.jobId !== "string" || !latest.jobId ||
        (latest.notes !== null && (typeof latest.notes !== "string" || !latest.notes))) {
      throw new Error("最新联系表审核记录无效");
    }
    latestReview = {
      contract: CONTRACT,
      identity: latestIdentity,
      identityHash: currentIdentityHash,
      action: latest.action,
      notes: latest.notes as string | null,
      jobId: latest.jobId,
    };
  }
  return { identity: currentIdentity, identityHash: currentIdentityHash, contactSheet: currentContactSheet, latestReview, hasStaleReview: input.hasStaleReview };
}

export function contactSheetReviewPayload(action: "approve" | "reject", expectedIdentityHash: string, notes: string) {
  if (action !== "approve" && action !== "reject") throw new Error("联系表审核动作无效");
  if (!HASH.test(expectedIdentityHash)) throw new Error("联系表审核身份哈希无效");
  const normalizedNotes = notes.trim();
  if (normalizedNotes.length > 2000) throw new Error("联系表审核备注不能超过 2000 字符");
  return { action, expectedIdentityHash, notes: normalizedNotes || null };
}

export function isCurrentContactSheetReviewOperation(
  expected: { epoch: number; identityHash: string },
  current: { epoch: number; identityHash: string },
) {
  return expected.epoch === current.epoch && expected.identityHash === current.identityHash;
}
