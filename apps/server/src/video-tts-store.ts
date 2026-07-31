import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, realpath } from "node:fs/promises";
import { resolve, sep } from "node:path";
import type { DatabaseSync } from "node:sqlite";

import { createJob, getJob, type JobRecord } from "./job-store.js";
import type { RuntimeModelConfig } from "./model-config.js";
import { getVideo } from "./project-video-store.js";
import { canonical, planText, sha256 } from "./video-plan-contract.js";
import { getVideoPlan, getVideoPlanSnapshot } from "./video-plan-store.js";

export const VIDEO_TTS_JOB_TYPE = "video_tts";
export const VIDEO_TTS_SYSTEM_CONTRACT_VERSION = "video-tts-v1";

export class VideoTtsStoreError extends Error {
  constructor(readonly statusCode: number, message: string) { super(message); }
}

export interface VideoTtsProviderIdentity {
  providerId: string;
  providerName: string;
  providerKind: RuntimeModelConfig["providerKind"];
  protocol: RuntimeModelConfig["protocol"];
  baseUrl: string;
  modelId: string;
  voiceId: string;
  rate: number;
  language: string;
  params?: Record<string, unknown>;
}

export interface VideoTtsSnapshot {
  id: string;
  projectId: string;
  videoId: string;
  planSnapshotId: string;
  planSnapshotHash: string;
  scriptRevisionId: string;
  scriptContentHash: string;
  paragraphs: Array<{ id: string; text: string }>;
  providerId: string;
  providerName: string;
  providerKind: RuntimeModelConfig["providerKind"];
  protocol: RuntimeModelConfig["protocol"];
  baseUrl: string;
  modelId: string;
  voiceId: string;
  rate: number;
  language: string;
  params: Record<string, unknown>;
  targetDurationSeconds: number;
  systemContractVersion: string;
  canonicalJson: string;
  snapshotHash: string;
  createdAt: number;
  invalidatedAt: number | null;
}

export interface VideoTtsCue {
  index: number;
  paragraphId: string;
  text: string;
  startMs: number;
  endMs: number;
  hash: string;
}

export interface VideoTtsArtifact {
  id: string;
  projectId: string;
  videoId: string;
  snapshotId: string;
  snapshotHash: string;
  jobId: string;
  providerRequestId: string | null;
  audio: { relativePath: string; mime: string; codec: string; sampleRate: number; channels: number; bytes: number; durationMs: number; hash: string };
  cuesHash: string;
  subtitles: {
    srt: { relativePath: string; bytes: number; hash: string };
    ass: { relativePath: string; bytes: number; hash: string };
  };
  cues: VideoTtsCue[];
  createdAt: number;
  deviationRatio: number;
}

interface SnapshotRow {
  id: string; project_id: string; video_id: string; plan_snapshot_id: string; plan_snapshot_hash: string;
  script_revision_id: string; script_content_hash: string; paragraphs_json: string; provider_id: string;
  provider_name: string; provider_kind: RuntimeModelConfig["providerKind"]; protocol: RuntimeModelConfig["protocol"];
  base_url: string; model_id: string; voice_id: string; rate: number; language: string; params_json: string;
  target_duration_seconds: number; system_contract_version: string; canonical_json: string; snapshot_hash: string;
  created_at: number; invalidated_at: number | null;
}

interface ArtifactRow {
  id: string; project_id: string; video_id: string; snapshot_id: string; snapshot_hash: string; job_id: string;
  provider_request_id: string | null; audio_relative_path: string; audio_mime: string; audio_codec: string;
  sample_rate: number; channels: number; audio_bytes: number; duration_ms: number; audio_hash: string; cues_hash: string;
  srt_relative_path: string; srt_bytes: number; srt_hash: string; ass_relative_path: string; ass_bytes: number;
  ass_hash: string; created_at: number;
}

function snapshotRecord(row: SnapshotRow): VideoTtsSnapshot {
  return {
    id: row.id, projectId: row.project_id, videoId: row.video_id, planSnapshotId: row.plan_snapshot_id,
    planSnapshotHash: row.plan_snapshot_hash, scriptRevisionId: row.script_revision_id,
    scriptContentHash: row.script_content_hash, paragraphs: JSON.parse(row.paragraphs_json) as VideoTtsSnapshot["paragraphs"],
    providerId: row.provider_id, providerName: row.provider_name, providerKind: row.provider_kind, protocol: row.protocol,
    baseUrl: row.base_url, modelId: row.model_id, voiceId: row.voice_id, rate: row.rate, language: row.language,
    params: JSON.parse(row.params_json) as Record<string, unknown>, targetDurationSeconds: row.target_duration_seconds,
    systemContractVersion: row.system_contract_version, canonicalJson: row.canonical_json, snapshotHash: row.snapshot_hash,
    createdAt: row.created_at, invalidatedAt: row.invalidated_at,
  };
}

function requireSnapshot(database: DatabaseSync, snapshotId: string) {
  const row = database.prepare("SELECT * FROM video_tts_snapshots WHERE id = ?").get(snapshotId) as SnapshotRow | undefined;
  if (!row) throw new VideoTtsStoreError(404, "配音快照不存在");
  return snapshotRecord(row);
}

export function getVideoTtsArtifact(database: DatabaseSync, projectId: string, videoId: string, artifactId: string): VideoTtsArtifact {
  getVideo(database, projectId, videoId);
  const row = database.prepare(
    "SELECT * FROM video_tts_artifacts WHERE id = ? AND project_id = ? AND video_id = ?",
  ).get(artifactId, projectId, videoId) as ArtifactRow | undefined;
  if (!row) throw new VideoTtsStoreError(404, "配音产物不存在或不属于当前视频");
  const cues = (database.prepare(
    "SELECT cue_index,paragraph_id,text,start_ms,end_ms,cue_hash FROM video_tts_cues WHERE artifact_id = ? AND video_id = ? ORDER BY cue_index",
  ).all(row.id, videoId) as unknown as Array<{ cue_index: number; paragraph_id: string; text: string; start_ms: number; end_ms: number; cue_hash: string }>)
    .map((cue) => ({ index: cue.cue_index, paragraphId: cue.paragraph_id, text: cue.text,
      startMs: cue.start_ms, endMs: cue.end_ms, hash: cue.cue_hash }));
  if (sha256(JSON.stringify(cues)) !== row.cues_hash) {
    throw new VideoTtsStoreError(409, "字幕 cue 身份校验失败");
  }
  const target = requireSnapshot(database, row.snapshot_id).targetDurationSeconds * 1_000;
  return {
    id: row.id, projectId: row.project_id, videoId: row.video_id, snapshotId: row.snapshot_id,
    snapshotHash: row.snapshot_hash, jobId: row.job_id, providerRequestId: row.provider_request_id,
    audio: { relativePath: row.audio_relative_path, mime: row.audio_mime, codec: row.audio_codec,
      sampleRate: row.sample_rate, channels: row.channels, bytes: row.audio_bytes, durationMs: row.duration_ms, hash: row.audio_hash },
    cuesHash: row.cues_hash,
    subtitles: {
      srt: { relativePath: row.srt_relative_path, bytes: row.srt_bytes, hash: row.srt_hash },
      ass: { relativePath: row.ass_relative_path, bytes: row.ass_bytes, hash: row.ass_hash },
    },
    cues, createdAt: row.created_at, deviationRatio: Math.abs(row.duration_ms - target) / target,
  };
}

export function getVideoTtsState(database: DatabaseSync, projectId: string, videoId: string) {
  getVideo(database, projectId, videoId);
  const row = database.prepare(
    "SELECT * FROM video_tts_snapshots WHERE project_id = ? AND video_id = ? ORDER BY created_at DESC,rowid DESC LIMIT 1",
  ).get(projectId, videoId) as SnapshotRow | undefined;
  if (!row) return null;
  const snapshot = snapshotRecord(row);
  const mapping = database.prepare("SELECT job_id FROM video_tts_jobs WHERE snapshot_id = ? ORDER BY created_at DESC LIMIT 1")
    .get(snapshot.id) as { job_id: string } | undefined;
  const artifactRow = database.prepare("SELECT id FROM video_tts_artifacts WHERE snapshot_id = ?")
    .get(snapshot.id) as { id: string } | undefined;
  return {
    snapshot,
    job: mapping ? getJob(database, mapping.job_id) ?? null : null,
    artifact: artifactRow ? getVideoTtsArtifact(database, projectId, videoId, artifactRow.id) : null,
    stale: !isVideoTtsSnapshotCurrent(database, snapshot),
  };
}

export function isVideoTtsSnapshotCurrent(database: DatabaseSync, snapshot: VideoTtsSnapshot) {
  if (snapshot.invalidatedAt !== null) return false;
  const plan = getVideoPlan(database, snapshot.projectId, snapshot.videoId);
  if (!plan?.approval?.valid || plan.snapshotId !== snapshot.planSnapshotId || plan.snapshotHash !== snapshot.planSnapshotHash ||
      plan.script.id !== snapshot.scriptRevisionId || plan.script.contentHash !== snapshot.scriptContentHash) return false;
  const latest = database.prepare(
    "SELECT id FROM video_tts_snapshots WHERE video_id = ? ORDER BY created_at DESC,rowid DESC LIMIT 1",
  ).get(snapshot.videoId) as { id: string } | undefined;
  return latest?.id === snapshot.id;
}

function providerIdentity(input: VideoTtsProviderIdentity) {
  const providerId = planText(input.providerId, "TTS provider", 100);
  const providerName = planText(input.providerName, "TTS provider 名称", 200);
  const modelId = planText(input.modelId, "TTS 模型", 200);
  const voiceId = planText(input.voiceId, "TTS 音色", 200);
  const language = planText(input.language, "TTS 语言", 50);
  const baseUrl = typeof input.baseUrl === "string" ? input.baseUrl.trim().replace(/\/+$/u, "") : "";
  if (!Number.isInteger(input.rate) || input.rate < -10 || input.rate > 10) throw new VideoTtsStoreError(400, "语速必须在 -10～10 之间");
  if (!["edge-tts", "minimax", "mimo", "openai-compatible"].includes(input.providerKind) ||
      !["openai-response", "anthropic-message"].includes(input.protocol)) throw new VideoTtsStoreError(400, "TTS provider 能力无效");
  const params = input.params ?? {};
  if (!params || Array.isArray(params) || typeof params !== "object") throw new VideoTtsStoreError(400, "TTS 非秘密参数无效");
  const containsSecret = (value: unknown): boolean => !!value && typeof value === "object" &&
    Object.entries(value as Record<string, unknown>).some(([key, item]) =>
      /^(?:api[_-]?key|token|secret|authorization|password|credential)$/iu.test(key) || containsSecret(item));
  // 快照可用于恢复和导出，任何层级的凭据都不能进入持久 JSON。
  if (containsSecret(params)) throw new VideoTtsStoreError(400, "TTS 快照参数不得包含密钥或凭据");
  if (baseUrl) {
    let url: URL;
    try { url = new URL(baseUrl); } catch { throw new VideoTtsStoreError(400, "TTS 模型地址无效"); }
    if (url.username || url.password) throw new VideoTtsStoreError(400, "TTS 模型地址不得包含凭据");
  }
  return { providerId, providerName, providerKind: input.providerKind, protocol: input.protocol, baseUrl,
    modelId, voiceId, rate: input.rate, language, params };
}

export function createVideoTtsJob(
  database: DatabaseSync,
  projectId: string,
  videoId: string,
  input: VideoTtsProviderIdentity,
  now = Date.now(),
) {
  getVideo(database, projectId, videoId);
  const plan = getVideoPlan(database, projectId, videoId);
  if (!plan?.approval?.valid || plan.stale) throw new VideoTtsStoreError(409, "请先批准当前旁白与画面方案，再生成配音");
  const sourceSnapshot = getVideoPlanSnapshot(database, plan.snapshotId);
  const provider = providerIdentity(input);
  const identity = {
    projectId, videoId, planSnapshotId: plan.snapshotId, planSnapshotHash: plan.snapshotHash,
    scriptRevisionId: plan.script.id, scriptContentHash: plan.script.contentHash, paragraphs: plan.script.paragraphs,
    provider, targetDurationSeconds: sourceSnapshot.input.targetDurationSeconds,
    systemContractVersion: VIDEO_TTS_SYSTEM_CONTRACT_VERSION,
  };
  const canonicalJson = canonical(identity);
  const snapshotHash = sha256(canonicalJson);

  database.exec("BEGIN IMMEDIATE");
  try {
    const existing = database.prepare("SELECT * FROM video_tts_snapshots WHERE video_id = ? AND snapshot_hash = ?")
      .get(videoId, snapshotHash) as SnapshotRow | undefined;
    if (existing) {
      const snapshot = snapshotRecord(existing);
      const mapping = database.prepare("SELECT job_id FROM video_tts_jobs WHERE snapshot_id = ? ORDER BY created_at DESC,job_id DESC LIMIT 1")
        .get(snapshot.id) as { job_id: string } | undefined;
      const artifactRow = database.prepare("SELECT id FROM video_tts_artifacts WHERE snapshot_id = ?")
        .get(snapshot.id) as { id: string } | undefined;
      const previousJob = mapping ? getJob(database, mapping.job_id)! : null;
      if (artifactRow || previousJob?.status === "queued" || previousJob?.status === "running") {
        database.exec("COMMIT");
        return { snapshot, job: previousJob,
          artifact: artifactRow ? getVideoTtsArtifact(database, projectId, videoId, artifactRow.id) : null, reused: true };
      }
      const active = database.prepare(
        `SELECT jobs.id FROM video_tts_jobs map JOIN jobs ON jobs.id=map.job_id
         WHERE map.video_id=? AND jobs.status IN ('queued','running') LIMIT 1`,
      ).get(videoId) as { id: string } | undefined;
      if (active) throw new VideoTtsStoreError(409, "当前视频已有配音任务，请勿重复提交");
      const job = createJob(database, { id: `job_video_tts_${snapshotHash}_${randomUUID()}`, type: VIDEO_TTS_JOB_TYPE,
        payload: { projectId, videoId, snapshotId: snapshot.id, snapshotHash }, maxAttempts: 3 }, now);
      database.prepare("INSERT INTO video_tts_jobs (job_id,video_id,snapshot_id,created_at) VALUES (?,?,?,?)")
        .run(job.id, videoId, snapshot.id, now);
      database.exec("COMMIT");
      return { snapshot, job, artifact: null, reused: false };
    }
    const active = database.prepare(
      `SELECT jobs.id FROM video_tts_jobs map JOIN jobs ON jobs.id=map.job_id
       WHERE map.video_id=? AND jobs.status IN ('queued','running') LIMIT 1`,
    ).get(videoId) as { id: string } | undefined;
    if (active) throw new VideoTtsStoreError(409, "当前视频已有配音任务，请勿重复提交");
    const snapshotId = `vtts_${randomUUID()}`;
    database.prepare(
      `INSERT INTO video_tts_snapshots (id,project_id,video_id,plan_snapshot_id,plan_snapshot_hash,script_revision_id,
       script_content_hash,paragraphs_json,provider_id,provider_name,provider_kind,protocol,base_url,model_id,voice_id,rate,
       language,params_json,target_duration_seconds,system_contract_version,canonical_json,snapshot_hash,created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    ).run(snapshotId, projectId, videoId, plan.snapshotId, plan.snapshotHash, plan.script.id, plan.script.contentHash,
      JSON.stringify(plan.script.paragraphs), provider.providerId, provider.providerName, provider.providerKind, provider.protocol,
      provider.baseUrl, provider.modelId, provider.voiceId, provider.rate, provider.language, JSON.stringify(provider.params),
      sourceSnapshot.input.targetDurationSeconds, VIDEO_TTS_SYSTEM_CONTRACT_VERSION, canonicalJson, snapshotHash, now);
    const job = createJob(database, { id: `job_video_tts_${snapshotHash}`, type: VIDEO_TTS_JOB_TYPE,
      payload: { projectId, videoId, snapshotId, snapshotHash }, maxAttempts: 3 }, now);
    database.prepare("INSERT INTO video_tts_jobs (job_id,video_id,snapshot_id,created_at) VALUES (?,?,?,?)")
      .run(job.id, videoId, snapshotId, now);
    database.exec("COMMIT");
    return { snapshot: requireSnapshot(database, snapshotId), job, artifact: null, reused: false };
  } catch (error) {
    try { database.exec("ROLLBACK"); } catch { /* 保留原始错误。 */ }
    throw error;
  }
}

export function getVideoTtsSnapshotForJob(database: DatabaseSync, jobId: string) {
  const row = database.prepare(
    "SELECT snapshot.* FROM video_tts_jobs map JOIN video_tts_snapshots snapshot ON snapshot.id=map.snapshot_id WHERE map.job_id=?",
  ).get(jobId) as SnapshotRow | undefined;
  if (!row) throw new VideoTtsStoreError(404, "配音任务快照不存在");
  return snapshotRecord(row);
}

export async function openVideoTtsMedia(
  database: DatabaseSync,
  dataRoot: string,
  projectId: string,
  videoId: string,
  kind: "audio" | "srt" | "ass",
  artifactId?: string,
) {
  const state = getVideoTtsState(database, projectId, videoId);
  const artifact = artifactId
    ? getVideoTtsArtifact(database, projectId, videoId, artifactId)
    : state?.artifact;
  if (!artifact) throw new VideoTtsStoreError(404, "当前视频还没有可读取的配音产物");
  const expected = kind === "audio"
    ? { relativePath: artifact.audio.relativePath, bytes: artifact.audio.bytes, hash: artifact.audio.hash, mime: artifact.audio.mime }
    : { ...artifact.subtitles[kind], mime: kind === "srt" ? "application/x-subrip; charset=utf-8" : "text/plain; charset=utf-8" };
  if (!expected.relativePath || expected.relativePath.startsWith("/") || expected.relativePath.includes("\\") ||
      expected.relativePath.split("/").some((part) => !part || part === "." || part === "..")) {
    throw new VideoTtsStoreError(409, "配音产物路径无效");
  }
  const root = await realpath(resolve(dataRoot));
  const path = await realpath(resolve(root, ...expected.relativePath.split("/")));
  if (!path.startsWith(`${root}${sep}`)) throw new VideoTtsStoreError(409, "配音产物路径越界");
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink() || info.size !== expected.bytes) {
    throw new VideoTtsStoreError(409, "配音产物不是登记的普通文件");
  }
  const digest = createHash("sha256");
  for await (const chunk of createReadStream(path)) digest.update(chunk as Buffer);
  if (digest.digest("hex") !== expected.hash) throw new VideoTtsStoreError(409, "配音产物身份校验失败");
  return { ...expected, stream: createReadStream(path) };
}
