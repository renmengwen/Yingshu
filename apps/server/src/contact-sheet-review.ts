import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

import {
  verifyCurrentContactSheetArtifact,
  type ContactSheetExportResult,
  type ContactSheetIdentity,
} from "./contact-sheet.js";
import { createJob, getJob, type JobRecord } from "./job-store.js";
import type { JobExecutionContext, JobHandler } from "./job-worker.js";

export const CONTACT_SHEET_REVIEW_JOB_TYPE = "contact_sheet_review";
const CONTRACT = "contact-sheet-review-v1";
const HASH = /^[0-9a-f]{64}$/u;
const MAX_NOTES_LENGTH = 2_000;

export type ContactSheetReviewAction = "approve" | "reject";

interface ContactSheetReviewPayload {
  contract: typeof CONTRACT;
  identity: ContactSheetIdentity;
  identityHash: string;
  action: ContactSheetReviewAction;
  notes: string | null;
}

export interface ContactSheetReviewCredential extends ContactSheetReviewPayload {
  jobId: string;
}

export interface ContactSheetReviewWorkspace {
  identity: ContactSheetIdentity;
  identityHash: string;
  contactSheet: ContactSheetExportResult;
  latestReview: ContactSheetReviewCredential | null;
  hasStaleReview: boolean;
}

export class ContactSheetReviewError extends Error {
  constructor(readonly statusCode: number, message: string) { super(message); }
}

function sha256(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

function sameIdentity(left: ContactSheetIdentity, right: ContactSheetIdentity) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function exactKeys(value: object, keys: readonly string[]) {
  return Object.keys(value).sort().join(",") === [...keys].sort().join(",");
}

function validIdentity(identity: ContactSheetIdentity) {
  return Boolean(identity && exactKeys(identity, [
    "contract", "episodeId", "scriptVersionId", "approvalRevision", "timelineHash",
    "visualPlanHash", "jsonHash", "htmlHash",
  ]) && identity.contract === CONTRACT && identity.episodeId && identity.scriptVersionId &&
    Number.isSafeInteger(identity.approvalRevision) && identity.approvalRevision > 0 &&
    HASH.test(identity.timelineHash) && HASH.test(identity.visualPlanHash) &&
    HASH.test(identity.jsonHash) && HASH.test(identity.htmlHash));
}

function normalizedNotes(value: string | null | undefined) {
  if (value == null) return null;
  if (typeof value !== "string") throw new ContactSheetReviewError(400, "联系表审核备注无效");
  const notes = value.trim();
  if (!notes || notes.length > MAX_NOTES_LENGTH) {
    throw new ContactSheetReviewError(400, "联系表审核备注长度无效");
  }
  return notes;
}

function isAction(value: unknown): value is ContactSheetReviewAction {
  return value === "approve" || value === "reject";
}

function parsedCredential(row: { id: string; payload_json: string; result_json: string }) {
  try {
    const payload = JSON.parse(row.payload_json) as ContactSheetReviewPayload;
    const result = JSON.parse(row.result_json) as ContactSheetReviewCredential;
    if (!payload || !result || !exactKeys(payload, ["contract", "identity", "identityHash", "action", "notes"]) ||
        !exactKeys(result, ["contract", "identity", "identityHash", "action", "notes", "jobId"]) ||
        payload.contract !== CONTRACT || result.contract !== CONTRACT || result.jobId !== row.id ||
        !isAction(payload.action) || result.action !== payload.action || payload.notes !== result.notes ||
        payload.notes !== normalizedNotes(payload.notes) || !validIdentity(payload.identity) ||
        payload.identityHash !== result.identityHash || !HASH.test(payload.identityHash) ||
        payload.identityHash !== sha256(JSON.stringify(payload.identity)) ||
        !sameIdentity(payload.identity, result.identity)) return null;
    return result;
  } catch {
    return null;
  }
}

function successfulReviews(database: DatabaseSync, episodeId: string, timelineHash: string) {
  const rows = database.prepare(
    `SELECT id, payload_json, result_json FROM jobs
     WHERE type = ? AND status = 'succeeded' AND result_json IS NOT NULL
     ORDER BY finished_at DESC, created_at DESC, id DESC`,
  ).all(CONTACT_SHEET_REVIEW_JOB_TYPE) as unknown as Array<{
    id: string; payload_json: string; result_json: string;
  }>;
  return rows.flatMap((row) => {
    const review = parsedCredential(row);
    return review?.identity.episodeId === episodeId && review.identity.timelineHash === timelineHash ? [review] : [];
  });
}

export async function getContactSheetReviewWorkspace(
  database: DatabaseSync,
  dataRoot: string,
  episodeId: string,
  timelineHash: string,
): Promise<ContactSheetReviewWorkspace> {
  const contactSheet = await verifyCurrentContactSheetArtifact(database, dataRoot, episodeId, timelineHash);
  const reviews = successfulReviews(database, episodeId, timelineHash);
  const latestReview = reviews.find((review) => review.identityHash === contactSheet.identityHash &&
    sameIdentity(review.identity, contactSheet.identity)) ?? null;
  return {
    identity: contactSheet.identity,
    identityHash: contactSheet.identityHash,
    contactSheet: {
      episodeId: contactSheet.episodeId,
      timelineHash: contactSheet.timelineHash,
      directoryPath: contactSheet.directoryPath,
      jsonPath: contactSheet.jsonPath,
      htmlPath: contactSheet.htmlPath,
      jsonHash: contactSheet.jsonHash,
      htmlHash: contactSheet.htmlHash,
    },
    latestReview,
    hasStaleReview: reviews.some((review) => review.identityHash !== contactSheet.identityHash ||
      !sameIdentity(review.identity, contactSheet.identity)),
  };
}

export async function enqueueContactSheetReview(
  database: DatabaseSync,
  dataRoot: string,
  input: {
    episodeId: string;
    timelineHash: string;
    action: ContactSheetReviewAction;
    expectedIdentityHash: string;
    notes?: string | null;
  },
): Promise<JobRecord> {
  if (!isAction(input.action)) throw new ContactSheetReviewError(400, "联系表审核操作无效");
  if (!HASH.test(input.expectedIdentityHash)) throw new ContactSheetReviewError(400, "联系表审核身份无效");
  const notes = normalizedNotes(input.notes);
  const workspace = await getContactSheetReviewWorkspace(database, dataRoot, input.episodeId, input.timelineHash);
  if (workspace.identityHash !== input.expectedIdentityHash) {
    throw new ContactSheetReviewError(409, "联系表身份已变化，请刷新后重新审核");
  }
  const payload: ContactSheetReviewPayload = {
    contract: CONTRACT,
    identity: workspace.identity,
    identityHash: workspace.identityHash,
    action: input.action,
    notes,
  };
  const requestHash = sha256(JSON.stringify(payload));
  const id = `job_contact_sheet_review_${requestHash}`;
  const existing = getJob(database, id);
  if (existing) {
    if (existing.type !== CONTACT_SHEET_REVIEW_JOB_TYPE || JSON.stringify(existing.payload) !== JSON.stringify(payload)) {
      throw new ContactSheetReviewError(409, "联系表审核任务身份冲突");
    }
    return existing;
  }
  try {
    return createJob(database, { id, type: CONTACT_SHEET_REVIEW_JOB_TYPE, payload, maxAttempts: 1 });
  } catch (error) {
    const concurrent = getJob(database, id);
    if (concurrent?.type === CONTACT_SHEET_REVIEW_JOB_TYPE &&
        JSON.stringify(concurrent.payload) === JSON.stringify(payload)) return concurrent;
    throw error;
  }
}

export function createContactSheetReviewHandler(database: DatabaseSync, dataRoot: string): JobHandler {
  return async (context: JobExecutionContext) => {
    const payload = context.job.payload as ContactSheetReviewPayload;
    if (!payload || !exactKeys(payload, ["contract", "identity", "identityHash", "action", "notes"]) ||
        payload.contract !== CONTRACT || !isAction(payload.action) || !HASH.test(payload.identityHash) ||
        !validIdentity(payload.identity) || payload.identityHash !== sha256(JSON.stringify(payload.identity)) ||
        payload.notes !== normalizedNotes(payload.notes)) {
      throw new ContactSheetReviewError(400, "人工联系表审核任务合同无效");
    }
    context.throwIfCancellationRequested();
    const current = await verifyCurrentContactSheetArtifact(
      database,
      dataRoot,
      payload.identity.episodeId,
      payload.identity.timelineHash,
    );
    if (current.identityHash !== payload.identityHash || !sameIdentity(current.identity, payload.identity)) {
      throw new ContactSheetReviewError(409, "联系表审核身份已变化，请重新审核");
    }
    context.reportProgress(1);
    return { ...payload, jobId: context.job.id } satisfies ContactSheetReviewCredential;
  };
}
