import type { DatabaseSync } from "node:sqlite";

export const ASPECT_RATIOS = ["9:16", "16:9"] as const;

export type AspectRatio = typeof ASPECT_RATIOS[number];

export interface VideoOutputProfile {
  aspectRatio: AspectRatio;
  width: number;
  height: number;
}

export interface ImageOutputProfile extends VideoOutputProfile {
  size: string;
}

const VIDEO_OUTPUT_PROFILES: Record<AspectRatio, VideoOutputProfile> = {
  "9:16": { aspectRatio: "9:16", width: 1080, height: 1920 },
  "16:9": { aspectRatio: "16:9", width: 1920, height: 1080 },
};

const IMAGE_OUTPUT_PROFILES: Record<AspectRatio, ImageOutputProfile> = {
  "9:16": { aspectRatio: "9:16", width: 1600, height: 2848, size: "1600x2848" },
  "16:9": { aspectRatio: "16:9", width: 2848, height: 1600, size: "2848x1600" },
};

export function parseAspectRatio(value: unknown, fallback: AspectRatio = "9:16"): AspectRatio {
  if (value === undefined || value === null || value === "") return fallback;
  if (typeof value !== "string" || !ASPECT_RATIOS.includes(value as AspectRatio)) {
    throw new Error("aspectRatio invalid");
  }
  return value as AspectRatio;
}

export function getVideoOutputProfile(aspectRatio: AspectRatio): VideoOutputProfile {
  return VIDEO_OUTPUT_PROFILES[aspectRatio];
}

export function getImageOutputProfile(aspectRatio: AspectRatio): ImageOutputProfile {
  return IMAGE_OUTPUT_PROFILES[aspectRatio];
}

export function getVideoOutputProfileForVideo(database: DatabaseSync, projectId: string, videoId: string) {
  const row = database.prepare("SELECT aspect_ratio FROM videos WHERE id = ? AND project_id = ?")
    .get(videoId, projectId) as { aspect_ratio?: unknown } | undefined;
  if (!row) throw new Error("video missing");
  return getVideoOutputProfile(parseAspectRatio(row.aspect_ratio));
}
