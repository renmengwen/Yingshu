import { createHash, randomUUID } from "node:crypto";
import { constants, createReadStream } from "node:fs";
import { lstat, mkdir, open, realpath, rm, writeFile } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { basename, dirname, isAbsolute, relative, resolve, sep } from "node:path";
import type { DatabaseSync } from "node:sqlite";

import { resolveVerifiedCandidateFile } from "./contact-sheet.js";
import { probeNineSixteenVideo, runVideoProcess } from "./ffmpeg-video.js";
import { type JobExecutionContext, type JobHandler } from "./job-worker.js";
import { renderNineSixteenTemplate, type NineSixteenScene } from "./nine-sixteen-template.js";
import { requireApprovedScriptForProduction } from "./script-approval-store.js";
import { renderAss } from "./subtitle-timeline.js";
import { getVideoOutputProfile, parseAspectRatio } from "./video-output-profile.js";
import { assertVisualPlanReady, type VisualSegmentRecord } from "./visual-segment-store.js";

export const RENDER_CHUNKS_JOB_TYPE = "render_chunks";
export const RENDER_CONTRACT = {
  template: "nine-sixteen-template-v1",
  video: "h264:1080x1920:25:yuv420p",
  audio: "aac",
  container: "mp4:faststart:shortest",
} as const;
const MIN_CHUNK_MS = 60_000;
const MAX_CHUNK_MS = 180_000;
const MAX_DURATION_DRIFT_MS = 1_000;
const MAX_CHUNK_AUDIO_BYTES = 64 * 1024 * 1024;

interface AudioRow {
  segment_index: number;
  input_hash: string;
  relative_path: string;
  file_hash: string;
  bytes: number;
  duration_ms: number;
}

interface CueRow {
  cue_index: number;
  segment_index: number;
  start_ms: number;
  end_ms: number;
  text: string;
}

interface CandidateRow {
  candidate_id: string;
  review_revision: number;
  file_hash: string;
}

export interface RenderChunkPlan {
  index: number;
  startMs: number;
  endMs: number;
  segments: VisualSegmentRecord[];
}

export interface ExpectedRenderChunk {
  index: number;
  startMs: number;
  endMs: number;
  renderHash: string;
}

export interface RenderPlanSnapshot {
  episodeId: string;
  scriptVersionId: string;
  approvalRevision: number;
  timelineHash: string;
  profile: { aspectRatio: "9:16" | "16:9"; width: number; height: number };
  chunks: ExpectedRenderChunk[];
}

interface RenderChunkDependencies {
  render: typeof renderNineSixteenTemplate;
  probe: typeof probeNineSixteenVideo;
  concatAudio(paths: string[], outputPath: string, signal: AbortSignal): Promise<void>;
}

function renderContract(profile: { width: number; height: number }) {
  return {
    template: "nine-sixteen-template-v1",
    video: `h264:${profile.width}x${profile.height}:25:yuv420p`,
    audio: "aac",
    container: "mp4:faststart:shortest",
  } as const;
}

function sha256(content: string | Buffer) {
  return createHash("sha256").update(content).digest("hex");
}

function sha256File(path: string) {
  return new Promise<string>((resolvePromise, reject) => {
    const hash = createHash("sha256");
    createReadStream(path).on("data", (chunk) => hash.update(chunk)).once("error", reject)
      .once("end", () => resolvePromise(hash.digest("hex")));
  });
}

function artifactPath(dataRoot: string, relativePath: string) {
  if (!relativePath || /[\0\r\n]/u.test(relativePath)) throw new Error("产物相对路径无效");
  const root = resolve(dataRoot);
  const absolute = resolve(root, ...relativePath.split("/"));
  if (absolute === root || !absolute.startsWith(`${root}${sep}`)) throw new Error("产物路径越界");
  return absolute;
}

function isInside(root: string, path: string) {
  const value = relative(root, path);
  return value !== "" && value !== ".." && !value.startsWith(`..${sep}`) && !isAbsolute(value);
}

export async function ensureSafeOutputDirectory(dataRoot: string, directory: string) {
  const root = resolve(dataRoot);
  const controlled = relative(root, directory);
  if (!controlled || controlled === ".." || controlled.startsWith(`..${sep}`) || isAbsolute(controlled)) {
    throw new Error("分片输出目录越界");
  }
  const rootRealPath = await realpath(root);
  let cursor = root;
  for (const part of controlled.split(sep)) {
    cursor = resolve(cursor, part);
    try { await mkdir(cursor); } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    const [cursorRealPath, info] = await Promise.all([realpath(cursor), lstat(cursor)]);
    if (!isInside(rootRealPath, cursorRealPath) || !info.isDirectory() || info.isSymbolicLink()) {
      throw new Error("分片输出目录必须是数据目录内的真实目录");
    }
  }
}

async function verifiedAudioContent(dataRoot: string, path: string, row: AudioRow) {
  if (!Number.isSafeInteger(row.bytes) || row.bytes < 1 || row.bytes > MAX_CHUNK_AUDIO_BYTES) {
    throw new Error("音频文件大小超出分片读取限制");
  }
  const root = resolve(dataRoot);
  const [rootRealPath, fileRealPath, before] = await Promise.all([realpath(root), realpath(path), lstat(path)]);
  if (!isInside(rootRealPath, fileRealPath) || !before.isFile() || before.isSymbolicLink()) {
    throw new Error("音频必须是数据目录内的普通文件");
  }
  const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || opened.nlink !== 1 || opened.dev !== before.dev || opened.ino !== before.ino || opened.size !== row.bytes) {
      throw new Error("音频文件在校验期间发生变化");
    }
    const bounded = Buffer.allocUnsafe(row.bytes + 1);
    let bytesRead = 0;
    while (bytesRead < bounded.length) {
      const result = await handle.read(bounded, bytesRead, bounded.length - bytesRead, bytesRead);
      if (result.bytesRead === 0) break;
      bytesRead += result.bytesRead;
    }
    const content = bounded.subarray(0, bytesRead);
    if (content.length !== row.bytes || sha256(content) !== row.file_hash) {
      throw new Error("音频文件与登记信息不一致");
    }
    return Buffer.from(content);
  } finally {
    await handle.close();
  }
}

type SnapshotFileHandle = Pick<FileHandle, "writeFile" | "sync" | "close">;

export async function writeSnapshot(
  path: string,
  content: string | Buffer,
  openFile: (path: string, flags: string) => Promise<SnapshotFileHandle> = open,
) {
  let file: SnapshotFileHandle | undefined;
  let opened = false;
  try {
    file = await openFile(path, "wx");
    opened = true;
    let failure: unknown;
    try { await file.writeFile(content); await file.sync(); } catch (error) { failure = error; }
    let closed = false;
    try { await file.close(); closed = true; } catch (error) { failure ??= error; }
    if (closed) file = undefined;
    if (failure) throw failure;
  } catch (error) {
    if (opened) {
      await file?.close().catch(() => undefined);
      await rm(path, { force: true }).catch(() => undefined);
    }
    throw error;
  }
}

function taskPayload(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("分片渲染任务参数无效");
  const input = value as { episodeId?: unknown; timelineHash?: unknown };
  if (typeof input.episodeId !== "string" || !/^[A-Za-z0-9_-]+$/u.test(input.episodeId)) {
    throw new Error("分片渲染任务缺少有效分集 ID");
  }
  if (typeof input.timelineHash !== "string" || !/^[0-9a-f]{64}$/u.test(input.timelineHash)) {
    throw new Error("分片渲染任务缺少有效时间轴哈希");
  }
  return { episodeId: input.episodeId, timelineHash: input.timelineHash };
}

export function planRenderChunks(segments: VisualSegmentRecord[]): RenderChunkPlan[] {
  if (!segments.length || segments[0]!.startMs !== 0) throw new Error("视觉计划不能为空且必须从零开始");
  for (let index = 0; index < segments.length; index += 1) {
    if (segments[index]!.startMs !== (index === 0 ? 0 : segments[index - 1]!.endMs)) {
      throw new Error("视觉计划时间轴不连续");
    }
  }
  const memo = new Map<number, Array<[number, number]> | null>();
  const solve = (first: number): Array<[number, number]> | null => {
    if (first === segments.length) return [];
    if (memo.has(first)) return memo.get(first)!;
    const startMs = segments[first]!.startMs;
    for (let last = segments.length - 1; last >= first; last -= 1) {
      const duration = segments[last]!.endMs - startMs;
      if (duration < MIN_CHUNK_MS || duration > MAX_CHUNK_MS) continue;
      const rest = solve(last + 1);
      if (rest) {
        const result: Array<[number, number]> = [[first, last], ...rest];
        memo.set(first, result);
        return result;
      }
    }
    memo.set(first, null);
    return null;
  };
  const boundaries = solve(0);
  if (!boundaries) throw new Error("无法仅按视觉段/cue 边界生成 1～3 分钟分片");
  return boundaries.map(([first, last], index) => ({
    index, startMs: segments[first]!.startMs, endMs: segments[last]!.endMs,
    segments: segments.slice(first, last + 1),
  }));
}

export function renderChunkIdentity(input: {
  episodeId: string;
  scriptVersionId: string;
  approvalRevision: number;
  timelineHash: string;
  profile: { width: number; height: number };
  chunk: RenderChunkPlan;
  candidates: Map<string, CandidateRow>;
  audio: AudioRow[];
  assHash: string;
}) {
  const identity = {
    contract: renderContract(input.profile),
    episodeId: input.episodeId,
    scriptVersionId: input.scriptVersionId,
    approvalRevision: input.approvalRevision,
    timelineHash: input.timelineHash,
    startMs: input.chunk.startMs,
    endMs: input.chunk.endMs,
    visualSegments: input.chunk.segments.map((segment) => {
      const selected = segment.assets.find((asset) => asset.selectedCandidateId !== null)!;
      const candidate = input.candidates.get(selected.selectedCandidateId!)!;
      return {
        id: segment.id, revision: segment.revision, startMs: segment.startMs, endMs: segment.endMs,
        motionKind: segment.motionKind, motionAmountPpm: segment.motionAmountPpm, fadeMs: segment.fadeMs,
        selectedCandidate: {
          id: candidate.candidate_id, reviewRevision: candidate.review_revision, fileHash: candidate.file_hash,
        },
      };
    }),
    audioSegments: input.audio.map((segment) => ({
      inputHash: segment.input_hash, fileHash: segment.file_hash, durationMs: segment.duration_ms,
    })),
    assHash: input.assHash,
  };
  return { identity, renderHash: sha256(JSON.stringify(identity)) };
}

function localAss(cues: CueRow[], startMs: number) {
  return renderAss(cues.map((cue) => ({
    index: cue.cue_index, startMs: cue.start_ms, endMs: cue.end_ms, text: cue.text,
  })), startMs);
}

async function concatAudio(paths: string[], outputPath: string, signal: AbortSignal) {
  const listPath = `${outputPath}.ffconcat`;
  const directory = dirname(listPath);
  const lines = paths.map((path) => {
    const controlled = relative(directory, path).split(sep).join("/");
    if (!controlled || controlled.includes("'") || /[\0\r\n]/u.test(controlled)) throw new Error("音频路径不能写入 ffconcat");
    return `file '${controlled}'`;
  });
  await writeFile(listPath, `ffconcat version 1.0\n${lines.join("\n")}\n`, { encoding: "utf8", flag: "wx" });
  try {
    await runVideoProcess("ffmpeg", ["-v", "error", "-y", "-f", "concat", "-safe", "0", "-i", basename(listPath), "-c", "copy", basename(outputPath)], { cwd: directory, signal });
  } finally {
    await rm(listPath, { force: true });
  }
}

function selectedCandidates(database: DatabaseSync, segments: VisualSegmentRecord[]) {
  const result = new Map<string, CandidateRow>();
  for (const segment of segments) {
    const id = segment.assets.find((asset) => asset.selectedCandidateId !== null)?.selectedCandidateId;
    if (!id) throw new Error("视觉段没有唯一选中候选图");
    const row = database.prepare(
      `SELECT candidate.id AS candidate_id, relation.candidate_review_revision AS review_revision,
              candidate.file_hash
       FROM visual_segment_assets relation
       JOIN asset_candidates candidate ON candidate.id = relation.selected_candidate_id
       WHERE relation.visual_segment_id = ? AND relation.selected_candidate_id = ?`,
    ).get(segment.id, id) as CandidateRow | undefined;
    if (!row) throw new Error("视觉段候选图关系不存在");
    result.set(id, row);
  }
  return result;
}

export function loadRenderPlanSnapshot(
  database: DatabaseSync,
  episodeId: string,
  timelineHash: string,
): RenderPlanSnapshot {
  const permit = requireApprovedScriptForProduction(database, episodeId, "video");
  const profile = getVideoOutputProfile(parseAspectRatio("9:16"));
  const segments = assertVisualPlanReady(database, episodeId, timelineHash);
  if (segments.some((segment) => segment.scriptVersionId !== permit.scriptVersionId ||
      segment.approvalRevision !== permit.approvalRevision)) throw new Error("视觉计划与当前批准稿不一致");
  const candidates = selectedCandidates(database, segments);
  const audio = database.prepare(
    `SELECT segment_index, input_hash, relative_path, file_hash, bytes, duration_ms
     FROM audio_segments WHERE episode_id = ? AND timeline_hash = ? ORDER BY segment_index`,
  ).all(episodeId, timelineHash) as unknown as AudioRow[];
  const cues = database.prepare(
    `SELECT cue_index, segment_index, start_ms, end_ms, text
     FROM subtitle_cues WHERE episode_id = ? AND timeline_hash = ? ORDER BY cue_index`,
  ).all(episodeId, timelineHash) as unknown as CueRow[];
  if (!audio.length || cues.length !== audio.length || cues[0]!.start_ms !== 0 ||
      cues.some((cue, index) => cue.cue_index !== index || cue.segment_index !== index ||
        cue.end_ms - cue.start_ms !== audio[index]!.duration_ms ||
        (index > 0 && cue.start_ms !== cues[index - 1]!.end_ms))) throw new Error("音频时间轴不连续");
  const chunks = planRenderChunks(segments).map((chunk) => {
    const chunkCues = cues.filter((cue) => cue.start_ms >= chunk.startMs && cue.end_ms <= chunk.endMs);
    if (!chunkCues.length || chunkCues[0]!.start_ms !== chunk.startMs || chunkCues.at(-1)!.end_ms !== chunk.endMs) {
      throw new Error("分片边界不是完整 cue 边界");
    }
    const chunkAudio = chunkCues.map((cue) => audio[cue.segment_index]!);
    return {
      index: chunk.index,
      startMs: chunk.startMs,
      endMs: chunk.endMs,
      renderHash: renderChunkIdentity({
        episodeId, scriptVersionId: permit.scriptVersionId, approvalRevision: permit.approvalRevision,
        timelineHash, profile, chunk, candidates, audio: chunkAudio, assHash: sha256(localAss(chunkCues, chunk.startMs)),
      }).renderHash,
    };
  });
  return { episodeId, scriptVersionId: permit.scriptVersionId, approvalRevision: permit.approvalRevision,
    timelineHash, profile, chunks };
}

export function createRenderChunksJobHandler(
  database: DatabaseSync,
  dataRoot: string,
  dependencies: Partial<RenderChunkDependencies> = {},
): JobHandler {
  const render = dependencies.render ?? renderNineSixteenTemplate;
  const probe = dependencies.probe ?? probeNineSixteenVideo;
  const joinAudio = dependencies.concatAudio ?? concatAudio;
  const profile = getVideoOutputProfile(parseAspectRatio("9:16"));
  return async (context: JobExecutionContext) => {
    const { episodeId, timelineHash } = taskPayload(context.job.payload);
    const permit = requireApprovedScriptForProduction(database, episodeId, "video");
    const segments = assertVisualPlanReady(database, episodeId, timelineHash);
    if (segments.some((segment) => segment.scriptVersionId !== permit.scriptVersionId ||
        segment.approvalRevision !== permit.approvalRevision)) throw new Error("视觉计划与当前批准稿不一致");
    const candidates = selectedCandidates(database, segments);
    const plans = planRenderChunks(segments);
    const audio = database.prepare(
      `SELECT segment_index, input_hash, relative_path, file_hash, bytes, duration_ms
       FROM audio_segments WHERE episode_id = ? AND timeline_hash = ? ORDER BY segment_index`,
    ).all(episodeId, timelineHash) as unknown as AudioRow[];
    const cues = database.prepare(
      `SELECT cue_index, segment_index, start_ms, end_ms, text
       FROM subtitle_cues WHERE episode_id = ? AND timeline_hash = ? ORDER BY cue_index`,
    ).all(episodeId, timelineHash) as unknown as CueRow[];
    if (!audio.length || cues.length !== audio.length || cues[0]!.start_ms !== 0 ||
        cues.some((cue, index) => cue.cue_index !== index || cue.segment_index !== index ||
          cue.end_ms - cue.start_ms !== audio[index]!.duration_ms ||
          (index > 0 && cue.start_ms !== cues[index - 1]!.end_ms))) throw new Error("音频时间轴不连续");

    const results = [];
    for (const chunk of plans) {
      context.throwIfCancellationRequested();
      const chunkCues = cues.filter((cue) => cue.start_ms >= chunk.startMs && cue.end_ms <= chunk.endMs);
      if (!chunkCues.length || chunkCues[0]!.start_ms !== chunk.startMs || chunkCues.at(-1)!.end_ms !== chunk.endMs) {
        throw new Error("分片边界不是完整 cue 边界");
      }
      const chunkAudio = chunkCues.map((cue) => audio[cue.segment_index]!);
      const audioContents: Buffer[] = [];
      let audioBytes = 0;
      for (const row of chunkAudio) {
        const expected = `episodes/${episodeId}/audio/segments/${row.input_hash}.wav`;
        if (row.relative_path !== expected) throw new Error("音频未使用规范内容寻址路径");
        const path = artifactPath(dataRoot, row.relative_path);
        audioBytes += row.bytes;
        if (audioBytes > MAX_CHUNK_AUDIO_BYTES) throw new Error("分片音频总量超过 64 MiB 限制");
        audioContents.push(await verifiedAudioContent(dataRoot, path, row));
      }
      const ass = localAss(chunkCues, chunk.startMs);
      const assHash = sha256(ass);
      const { renderHash } = renderChunkIdentity({
        episodeId, scriptVersionId: permit.scriptVersionId, approvalRevision: permit.approvalRevision,
        timelineHash, profile, chunk, candidates, audio: chunkAudio, assHash,
      });
      const relativePath = `episodes/${episodeId}/renders/chunks/${renderHash.slice(0, 2)}/${renderHash}.mp4`;
      const outputPath = artifactPath(dataRoot, relativePath);
      const outputDirectory = dirname(outputPath);
      await ensureSafeOutputDirectory(dataRoot, outputDirectory);
      const stored = database.prepare("SELECT file_hash, bytes, duration_ms, relative_path FROM render_chunks WHERE render_hash = ?")
        .get(renderHash) as { file_hash: string; bytes: number; duration_ms: number; relative_path: string } | undefined;
      let reused = false;
      if (stored) {
        if (stored.relative_path !== relativePath) throw new Error("分片记录不是规范内容寻址路径");
        try {
          const measured = await probe(outputPath);
          if (measured.bytes !== stored.bytes || measured.durationMs !== stored.duration_ms ||
              Math.abs(measured.durationMs - (chunk.endMs - chunk.startMs)) > MAX_DURATION_DRIFT_MS ||
              await sha256File(outputPath) !== stored.file_hash) throw new Error("已登记分片文件已损坏");
          reused = true;
        } catch {
          await rm(outputPath, { force: true });
        }
      } else {
        await rm(outputPath, { force: true });
      }

      const temporaryAudio = resolve(outputDirectory, `${renderHash}.${randomUUID()}.tmp.wav`);
      const temporaryAss = resolve(outputDirectory, `${renderHash}.${randomUUID()}.tmp.ass`);
      const temporaryAudioParts: string[] = [];
      const temporaryImages: string[] = [];
      const controller = new AbortController();
      const poll = setInterval(() => { if (context.isCancellationRequested()) controller.abort(); }, 50);
      try {
        if (!reused) {
          await writeSnapshot(temporaryAss, ass);
          for (const [index, content] of audioContents.entries()) {
            const snapshot = resolve(outputDirectory, `${renderHash}.${randomUUID()}.${index}.tmp.wav`);
            await writeSnapshot(snapshot, content);
            temporaryAudioParts.push(snapshot);
          }
          await joinAudio(temporaryAudioParts, temporaryAudio, controller.signal);
          const scenes: NineSixteenScene[] = [];
          for (const segment of chunk.segments) {
            const candidateId = segment.assets.find((asset) => asset.selectedCandidateId !== null)!.selectedCandidateId!;
            const verified = await resolveVerifiedCandidateFile(database, dataRoot, candidateId);
            const extension = verified.mime === "image/jpeg" ? "jpg" : verified.mime.split("/")[1]!;
            const snapshot = resolve(outputDirectory, `${renderHash}.${randomUUID()}.tmp.${extension}`);
            await writeSnapshot(snapshot, verified.content);
            temporaryImages.push(snapshot);
            scenes.push({ imagePath: snapshot, durationMs: segment.endMs - segment.startMs,
              motionKind: segment.motionKind, motionAmountPpm: segment.motionAmountPpm, fadeMs: segment.fadeMs });
          }
          await render({ scenes, audioPath: temporaryAudio, assPath: temporaryAss, outputPath,
            aspectRatio: profile.aspectRatio, signal: controller.signal });
        }
      } finally {
        clearInterval(poll);
        await rm(temporaryAudio, { force: true });
        await rm(temporaryAss, { force: true });
        await Promise.all(temporaryAudioParts.map((path) => rm(path, { force: true })));
        await Promise.all(temporaryImages.map((path) => rm(path, { force: true })));
      }
      context.throwIfCancellationRequested();
      const measured = await probe(outputPath);
      if (Math.abs(measured.durationMs - (chunk.endMs - chunk.startMs)) > MAX_DURATION_DRIFT_MS) {
        throw new Error("分片视频时长与分片时间轴不一致");
      }
      const fileHash = await sha256File(outputPath);
      context.commitCheckpoint("render-chunk", String(chunk.index), renderHash, (transaction) => {
        const current = requireApprovedScriptForProduction(database, episodeId, "video");
        if (current.scriptVersionId !== permit.scriptVersionId || current.approvalRevision !== permit.approvalRevision) {
          throw new Error("分片渲染期间批准稿已变化，本次结果不登记");
        }
        const currentSegments = assertVisualPlanReady(database, episodeId, timelineHash);
        const currentChunk = planRenderChunks(currentSegments)[chunk.index];
        if (!currentChunk || currentChunk.startMs !== chunk.startMs || currentChunk.endMs !== chunk.endMs) {
          throw new Error("分片渲染期间边界已变化，本次结果不登记");
        }
        const currentCandidates = selectedCandidates(database, currentSegments);
        const currentAudio = database.prepare(
          `SELECT segment_index, input_hash, relative_path, file_hash, bytes, duration_ms
           FROM audio_segments WHERE episode_id = ? AND timeline_hash = ? ORDER BY segment_index`,
        ).all(episodeId, timelineHash) as unknown as AudioRow[];
        const currentCues = database.prepare(
          `SELECT cue_index, segment_index, start_ms, end_ms, text
           FROM subtitle_cues WHERE episode_id = ? AND timeline_hash = ? ORDER BY cue_index`,
        ).all(episodeId, timelineHash) as unknown as CueRow[];
        const currentChunkCues = currentCues.filter((cue) => cue.start_ms >= chunk.startMs && cue.end_ms <= chunk.endMs);
        const currentHash = renderChunkIdentity({
          episodeId, scriptVersionId: current.scriptVersionId, approvalRevision: current.approvalRevision,
          timelineHash, profile, chunk: currentChunk, candidates: currentCandidates,
          audio: currentChunkCues.map((cue) => currentAudio[cue.segment_index]!),
          assHash: sha256(localAss(currentChunkCues, currentChunk.startMs)),
        }).renderHash;
        if (currentHash !== renderHash) throw new Error("分片渲染期间输入身份已变化，本次结果不登记");
        transaction.run("DELETE FROM render_chunks WHERE episode_id = ? AND timeline_hash = ? AND chunk_index = ? AND render_hash <> ?",
          episodeId, timelineHash, chunk.index, renderHash);
        transaction.run(
          `INSERT INTO render_chunks (render_hash, episode_id, timeline_hash, chunk_index,
             script_version_id, approval_revision, start_ms, end_ms, relative_path, file_hash, bytes, duration_ms, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(render_hash) DO UPDATE SET relative_path=excluded.relative_path, file_hash=excluded.file_hash,
             bytes=excluded.bytes, duration_ms=excluded.duration_ms`,
          renderHash, episodeId, timelineHash, chunk.index, permit.scriptVersionId, permit.approvalRevision,
          chunk.startMs, chunk.endMs, relativePath, fileHash, measured.bytes, measured.durationMs, Date.now());
        return undefined;
      });
      results.push({ chunkIndex: chunk.index, renderHash, startMs: chunk.startMs, endMs: chunk.endMs,
        durationMs: measured.durationMs, bytes: measured.bytes, fileHash, relativePath, reused });
      context.reportProgress(results.length / plans.length);
    }
    return { episodeId, scriptVersionId: permit.scriptVersionId, approvalRevision: permit.approvalRevision,
      timelineHash, chunks: results };
  };
}
