import type { JobRecord } from "../types";
import type { AssetGapCounts, AssetRecord, CandidateRecord, PromptParts } from "./types";

const ALLOWED_UPLOAD_TYPES = new Set(["image/png", "image/jpeg", "image/webp"]);

export function assetGapCounts(assets: AssetRecord[], candidatesByAsset: Record<string, CandidateRecord[]>): AssetGapCounts {
  return assets.reduce<AssetGapCounts>((counts, asset) => {
    const candidates = candidatesByAsset[asset.id] ?? [];
    if (!candidates.length) counts.noCandidates += 1;
    else if (candidates.some((candidate) => candidate.reviewStatus === "approved")) counts.approved += 1;
    else counts.awaitingApproval += 1;
    return counts;
  }, { noCandidates: 0, awaitingApproval: 0, approved: 0 });
}

export function candidateUploadRequest(file: File): RequestInit {
  if (!ALLOWED_UPLOAD_TYPES.has(file.type)) throw new Error("只支持 PNG、JPEG 或 WebP 图片");
  return {
    method: "POST",
    headers: { "content-type": "application/octet-stream", "x-file-name": encodeURIComponent(file.name) },
    body: file,
  };
}

export function generatedCandidateAssetId(job: JobRecord | undefined) {
  if (job?.type !== "image_candidate_generate" || job.status !== "succeeded" || !job.result || typeof job.result !== "object") return undefined;
  const candidate = (job.result as { candidate?: unknown }).candidate;
  if (!candidate || typeof candidate !== "object") return undefined;
  const assetId = (candidate as { assetId?: unknown }).assetId;
  return typeof assetId === "string" && assetId ? assetId : undefined;
}

export function canApplyCandidateRefresh(requestedAssetId: string, currentEpoch: number, responseEpoch: number, candidates: CandidateRecord[]) {
  return currentEpoch === responseEpoch && candidates.every((candidate) => candidate.assetId === requestedAssetId);
}

export function candidatePromptJobId(candidate: CandidateRecord) {
  return candidate.source.kind === "generation" && candidate.source.requestHash
    ? `job_image_${candidate.source.requestHash}`
    : undefined;
}

export function promptFromCandidateJob(candidate: CandidateRecord, job: JobRecord) {
  const jobId = candidatePromptJobId(candidate);
  if (!jobId || job.id !== jobId || job.type !== "image_candidate_generate" ||
      !job.payload || typeof job.payload !== "object") return undefined;
  const payload = job.payload as { assetId?: unknown; requestHash?: unknown; prompt?: unknown };
  if (payload.assetId !== candidate.assetId || payload.requestHash !== candidate.source.requestHash ||
      typeof payload.prompt !== "string" || !payload.prompt.trim()) return undefined;
  return payload.prompt;
}

export function assetPromptDraftFromJob(job: JobRecord | undefined, assetId: string) {
  if (job?.type !== "asset_prompt_draft_generate" || job.status !== "succeeded" ||
      !job.payload || typeof job.payload !== "object" || (job.payload as { assetId?: unknown }).assetId !== assetId ||
      !job.result || typeof job.result !== "object") return undefined;
  const result = job.result as Partial<PromptParts> & { prompt?: unknown };
  const fields: Array<keyof PromptParts> = ["evidence", "sceneIntent", "subjectAction", "environment", "lightingComposition", "styleConstraints"];
  if (fields.some((field) => typeof result[field] !== "string" || !result[field]!.trim()) ||
      typeof result.prompt !== "string" || !result.prompt.trim()) return undefined;
  return {
    parts: Object.fromEntries(fields.map((field) => [field, result[field]])) as unknown as PromptParts,
    prompt: result.prompt,
  };
}
