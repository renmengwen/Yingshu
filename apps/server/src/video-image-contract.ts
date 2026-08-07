import { createHash } from "node:crypto";

import type { OpenAiImageConfig } from "./image-provider.js";
import { getImageOutputProfile, parseAspectRatio, type AspectRatio } from "./video-output-profile.js";

export const VIDEO_IMAGE_JOB_TYPE = "video_image_generate";
export const VIDEO_IMAGE_ID = /^[A-Za-z0-9_-]+$/u;

export type VideoImageBatchMode = "missing" | "single" | "retry_failed" | "regenerate";
export type VideoImageOrigin = "generated" | "upload";

export class VideoImageError extends Error {
  constructor(readonly statusCode: number, message: string) { super(message); }
}

export interface VideoImagePermit {
  projectId: string;
  videoId: string;
  aspectRatio: AspectRatio;
  planSnapshotId: string;
  planSnapshotHash: string;
  scriptRevisionId: string;
  scriptContentHash: string;
  visualRevisionId: string;
  visualContentHash: string;
  visualId: string;
  prompt: string;
  negativePrompt: string;
  styleSnapshot: unknown;
  promptHash: string;
}

export interface VideoImageParameters {
  aspectRatio: AspectRatio;
  size: string;
  candidates: 1;
}

export interface VideoImageJobPayload extends VideoImagePermit {
  batchId: string;
  requestIdentity: string;
  providerId: string;
  model: string;
  parameters: VideoImageParameters;
  attempt: number;
}

export type ResolveVideoImageProvider = (
  identity?: { providerId: string; modelId: string },
) => Promise<OpenAiImageConfig | null>;

export const videoImageSha256 = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");

export function videoImageParameters(aspectRatio: unknown): VideoImageParameters {
  const normalized = parseAspectRatio(aspectRatio);
  return { aspectRatio: normalized, size: getImageOutputProfile(normalized).size, candidates: 1 };
}

export function videoImageText(value: unknown, label: string, maximum = 255) {
  if (typeof value !== "string") throw new VideoImageError(422, `${label}无效`);
  const text = value.normalize("NFKC").trim();
  if (!text || [...text].length > maximum) throw new VideoImageError(422, `${label}无效`);
  return text;
}

export function videoImageId(value: unknown, label: string) {
  const id = videoImageText(value, label, 200);
  if (!VIDEO_IMAGE_ID.test(id)) throw new VideoImageError(422, `${label}无效`);
  return id;
}

export function videoImageRequestIdentity(
  permit: VideoImagePermit,
  providerId: string,
  model: string,
  idempotencyKey: string,
) {
  return videoImageSha256(JSON.stringify({
    contract: "video-image-request-v1",
    projectId: permit.projectId, videoId: permit.videoId, aspectRatio: permit.aspectRatio,
    planSnapshotId: permit.planSnapshotId, planSnapshotHash: permit.planSnapshotHash,
    scriptRevisionId: permit.scriptRevisionId, scriptContentHash: permit.scriptContentHash,
    visualRevisionId: permit.visualRevisionId, visualContentHash: permit.visualContentHash,
    visualId: permit.visualId, prompt: permit.prompt, negativePrompt: permit.negativePrompt,
    styleSnapshot: permit.styleSnapshot, promptHash: permit.promptHash,
    providerId,
    model,
    parameters: videoImageParameters(permit.aspectRatio),
    idempotencyKey,
  }));
}
