import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { cp, lstat, mkdir, readFile, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";

import { listAssetCandidateReviewEvents, listAssetCandidates } from "../asset-candidate-store.js";
import { listChapterEvents } from "../chapter-event-store.js";
import { openDatabase } from "../database.js";
import { getEpisode } from "../episode-store.js";
import { exportFinalVideo, type FinalVideoManifest } from "../final-video.js";
import { probeNineSixteenVideo, runVideoProcess } from "../ffmpeg-video.js";
import { createProjectPackage, PROJECT_PACKAGE_VERSION, restoreProjectPackage } from "../project-package.js";
import { loadRenderPlanSnapshot } from "../render-chunk-job.js";
import { requireApprovedScriptForProduction } from "../script-approval-store.js";
import { getScriptVersion } from "../script-version-store.js";
import { assertVisualPlanReady } from "../visual-segment-store.js";

const SOURCE_ROOT = resolve("D:/code3/Narralume/data/gates/p7-real-sample");
const PACKAGE_ROOT = resolve("D:/code3/Narralume/data/gates/p7-project-package");
const RESTORE_ROOT = resolve("D:/code3/Narralume/data/gates/p7-project-restore");
const SCRATCH_ROOT = resolve("D:/code3/Narralume/data/gates/p7-project-recovery-scratch");
const EXPECTED_FINAL_HASH = "af9dea5e5edb7673575bc9260f3f3e9b9ed4d3ae54f0d6260f00652278a9b2db";
const EXPECTED_VIDEO_HASH = "82b6e2941e6366ccf039c1c71215bc8e92de178944f92ff92853bee46d99c3b6";
const sha256 = (value: Uint8Array | string) => createHash("sha256").update(value).digest("hex");
const startedAt = Date.now();

interface StoredFinalManifest extends FinalVideoManifest {
  finalVideo: FinalVideoManifest["finalVideo"];
}

function assertKnownRoot(path: string, leaf: string) {
  assert.equal(path, resolve("D:/code3/Narralume/data/gates", leaf), `Gate 根目录越界：${path}`);
}

function controlled(root: string, relativePath: string) {
  assert(relativePath && !relativePath.includes("\\") && !relativePath.startsWith("/") && !/^[A-Za-z]:/u.test(relativePath));
  assert.equal(relativePath.split("/").some((part) => !part || part === "." || part === ".."), false);
  const path = resolve(root, ...relativePath.split("/"));
  assert(relative(root, path) && !relative(root, path).startsWith(`..${sep}`) && !relative(root, path).startsWith(".."));
  return path;
}

async function hashFile(path: string) {
  return sha256(await readFile(path));
}

async function expectRejected(action: () => Promise<unknown>, message: string) {
  await assert.rejects(action, message);
}

async function loadFinalManifest(dataRoot: string, relativePath: string) {
  const bytes = await readFile(controlled(dataRoot, relativePath));
  return { bytes, manifest: JSON.parse(bytes.toString("utf8")) as StoredFinalManifest };
}

async function assertRealDirectory(path: string, parent: string) {
  const info = await lstat(path);
  assert(info.isDirectory() && !info.isSymbolicLink());
  assert.equal(await realpath(path), path);
  assert.equal(relative(parent, path).startsWith(".."), false);
}

async function verifyPackageFiles(packagePath: string, manifest: Awaited<ReturnType<typeof createProjectPackage>>["manifest"]) {
  assert.equal(manifest.version, PROJECT_PACKAGE_VERSION);
  assert.equal(manifest.packageHash.length, 64);
  assert.equal(manifest.files.length > 0, true);
  assert.deepEqual([...manifest.files].sort((a, b) => a.path.localeCompare(b.path)), manifest.files);
  const requiredRoles = [
    "database", "original-text", "audio-segment", "subtitle-srt", "subtitle-ass", "selected-image",
    "render-chunk", "final-video", "final-manifest",
  ];
  const roles = new Set(manifest.files.flatMap((file) => file.roles));
  requiredRoles.forEach((role) => assert(roles.has(role), `项目包缺少 ${role}`));
  for (const file of manifest.files) {
    assert(!file.path.toLowerCase().includes("musedock") && !file.path.toLowerCase().includes("p5-candidates"));
    const path = controlled(join(packagePath, "payload"), file.path);
    const info = await stat(path);
    assert.equal(info.size, file.bytes);
    assert.equal(await hashFile(path), file.sha256);
    if (file.roles.includes("database")) {
      const bytes = await readFile(path);
      assert.equal(bytes.includes(Buffer.from("D:\\code3\\MuseDock", "utf8")), false);
      assert.equal(bytes.includes(Buffer.from("p5-candidates", "utf8")), false);
    }
  }
  return {
    fileCount: manifest.files.length,
    totalBytes: manifest.files.reduce((sum, file) => sum + file.bytes, 0),
    roleCounts: Object.fromEntries(requiredRoles.map((role) => [role, manifest.files.filter((file) => file.roles.includes(role)).length])),
  };
}

async function verifyRestoredProject(dataRoot: string, manifest: Awaited<ReturnType<typeof createProjectPackage>>["manifest"]) {
  const connection = openDatabase(dataRoot);
  try {
    const { database } = connection;
    const episodeRow = database.prepare(
      "SELECT id, series_project_id, episode_index FROM episodes WHERE id = ?",
    ).get(manifest.project.episodeId) as { id: string; series_project_id: string; episode_index: number } | undefined;
    assert(episodeRow);
    assert.equal(episodeRow.series_project_id, manifest.project.seriesProjectId);
    const episode = await getEpisode(database, dataRoot, episodeRow.series_project_id, episodeRow.episode_index);
    assert.equal(episode.id, manifest.project.episodeId);
    assert(episode.sources.length > 0);

    const eventCounts: Record<string, number> = {};
    for (const source of episode.sources) {
      const listed = await listChapterEvents(database, dataRoot, manifest.project.bookId, source.chapterId, 100, 0);
      assert(listed.items.some((event) => event.id === source.sourceEventId));
      assert.equal(sha256(Buffer.from(source.sourceText, "utf8")), source.sourceHash);
      eventCounts[source.chapterId] = listed.items.length;
    }

    const permit = requireApprovedScriptForProduction(database, manifest.project.episodeId, "video");
    assert.equal(permit.scriptVersionId, manifest.project.scriptVersionId);
    assert.equal(permit.approvalRevision, manifest.project.approvalRevision);
    const script = getScriptVersion(database, permit.scriptVersionId);
    assert(script && script.kind === "packaged" && script.paragraphs.length > 0);
    assert.equal(script.contentHash, permit.contentHash);

    const audio = database.prepare(
      `SELECT segment_index, relative_path, file_hash, bytes, duration_ms FROM audio_segments
       WHERE episode_id = ? AND timeline_hash = ? ORDER BY segment_index`,
    ).all(manifest.project.episodeId, manifest.project.timelineHash) as unknown as Array<{
      segment_index: number; relative_path: string; file_hash: string; bytes: number; duration_ms: number;
    }>;
    const cues = database.prepare(
      `SELECT cue_index, segment_index, start_ms, end_ms, text FROM subtitle_cues
       WHERE episode_id = ? AND timeline_hash = ? ORDER BY cue_index`,
    ).all(manifest.project.episodeId, manifest.project.timelineHash) as unknown as Array<{
      cue_index: number; segment_index: number; start_ms: number; end_ms: number; text: string;
    }>;
    assert(audio.length > 0 && cues.length === audio.length);
    for (const [index, row] of audio.entries()) {
      assert.equal(row.segment_index, index);
      const bytes = await readFile(controlled(dataRoot, row.relative_path));
      assert.equal(bytes.byteLength, row.bytes);
      assert.equal(sha256(bytes), row.file_hash);
      assert(row.duration_ms > 0);
    }
    cues.forEach((cue, index) => {
      assert.equal(cue.cue_index, index);
      assert.equal(cue.segment_index, index);
      assert(cue.end_ms > cue.start_ms && cue.text.length > 0);
    });
    for (const extension of ["srt", "ass"] as const) {
      const text = await readFile(controlled(dataRoot,
        `episodes/${manifest.project.episodeId}/audio/${manifest.project.timelineHash}.${extension}`), "utf8");
      assert(extension === "srt" ? text.includes("-->") : text.includes("PlayResX: 1080"));
    }

    const visuals = assertVisualPlanReady(database, manifest.project.episodeId, manifest.project.timelineHash);
    assert.equal(visuals.length, cues.length);
    const selected = new Map<string, string>();
    visuals.flatMap((visual) => visual.assets).forEach((asset) => {
      assert(asset.selectedCandidateId);
      selected.set(asset.assetId, asset.selectedCandidateId);
    });
    for (const [assetId, candidateId] of selected) {
      const candidate = listAssetCandidates(database, assetId).find((item) => item.id === candidateId);
      assert(candidate && candidate.source.kind === "generation" && candidate.reviewStatus === "approved");
      assert(listAssetCandidateReviewEvents(database, candidate.id).some((event) => event.action === "approve"));
      const bytes = await readFile(controlled(dataRoot, candidate.relativePath));
      assert.equal(bytes.byteLength, candidate.bytes);
      assert.equal(sha256(bytes), candidate.fileHash);
    }

    const snapshot = loadRenderPlanSnapshot(database, manifest.project.episodeId, manifest.project.timelineHash);
    assert.equal(snapshot.scriptVersionId, manifest.project.scriptVersionId);
    assert.equal(snapshot.approvalRevision, manifest.project.approvalRevision);
    const chunks = database.prepare(
      `SELECT render_hash, chunk_index, relative_path, file_hash, bytes, duration_ms FROM render_chunks
       WHERE episode_id = ? AND timeline_hash = ? ORDER BY chunk_index`,
    ).all(manifest.project.episodeId, manifest.project.timelineHash) as unknown as Array<{
      render_hash: string; chunk_index: number; relative_path: string; file_hash: string; bytes: number; duration_ms: number;
    }>;
    assert.equal(chunks.length, snapshot.chunks.length);
    for (const [index, row] of chunks.entries()) {
      assert.equal(row.chunk_index, index);
      assert.equal(row.render_hash, snapshot.chunks[index]!.renderHash);
      const bytes = await readFile(controlled(dataRoot, row.relative_path));
      assert.equal(bytes.byteLength, row.bytes);
      assert.equal(sha256(bytes), row.file_hash);
    }

    const storedFinal = await loadFinalManifest(dataRoot, manifest.project.finalManifestPath);
    assert.equal(storedFinal.manifest.exportHash, manifest.project.finalExportHash);
    assert.equal(storedFinal.manifest.finalVideo.fileHash, EXPECTED_VIDEO_HASH);
    return { connection, episode, eventCounts, permit, script, audio, cues, visuals, chunks, storedFinal };
  } catch (error) {
    connection.close();
    throw error;
  }
}

assertKnownRoot(PACKAGE_ROOT, "p7-project-package");
assertKnownRoot(RESTORE_ROOT, "p7-project-restore");
assertKnownRoot(SCRATCH_ROOT, "p7-project-recovery-scratch");
await assertRealDirectory(SOURCE_ROOT, resolve("D:/code3/Narralume/data/gates"));
await Promise.all([
  rm(PACKAGE_ROOT, { recursive: true, force: true }),
  rm(RESTORE_ROOT, { recursive: true, force: true }),
  rm(SCRATCH_ROOT, { recursive: true, force: true }),
]);
await Promise.all([mkdir(PACKAGE_ROOT, { recursive: true }), mkdir(SCRATCH_ROOT, { recursive: true })]);

const source = openDatabase(SOURCE_ROOT);
let canonicalPackagePath = "";
let finalManifestRelativePath = "";
try {
  const episode = source.database.prepare("SELECT id FROM episodes ORDER BY id").all() as Array<{ id: string }>;
  assert.equal(episode.length, 1);
  finalManifestRelativePath = `episodes/${episode[0]!.id}/exports/${EXPECTED_FINAL_HASH.slice(0, 2)}/${EXPECTED_FINAL_HASH}/manifest.json`;
  const sourceFinal = await loadFinalManifest(SOURCE_ROOT, finalManifestRelativePath);
  assert.equal(sourceFinal.manifest.exportHash, EXPECTED_FINAL_HASH);
  assert.equal(sourceFinal.manifest.finalVideo.fileHash, EXPECTED_VIDEO_HASH);
  const sourceVideo = await readFile(controlled(SOURCE_ROOT, sourceFinal.manifest.finalVideo.relativePath));
  assert.equal(sha256(sourceVideo), EXPECTED_VIDEO_HASH);

  const candidatePath = join(PACKAGE_ROOT, "candidate");
  const candidate = await createProjectPackage(source.database, SOURCE_ROOT, {
    packagePath: candidatePath, finalManifestRelativePath,
  });
  canonicalPackagePath = join(PACKAGE_ROOT, candidate.manifest.packageHash);
  const packaged = await createProjectPackage(source.database, SOURCE_ROOT, {
    packagePath: canonicalPackagePath, finalManifestRelativePath,
  });
  assert.deepEqual(packaged.manifest, candidate.manifest);
  await rm(candidatePath, { recursive: true });
} finally {
  source.close();
}

const packageManifest = JSON.parse(await readFile(join(canonicalPackagePath, "manifest.json"), "utf8")) as
  Awaited<ReturnType<typeof createProjectPackage>>["manifest"];
assert.equal(packageManifest.packageHash, canonicalPackagePath.split(sep).at(-1));
assert.equal(packageManifest.project.finalExportHash, EXPECTED_FINAL_HASH);
const packageStats = await verifyPackageFiles(canonicalPackagePath, packageManifest);

const restored = await restoreProjectPackage(canonicalPackagePath, RESTORE_ROOT);
assert.deepEqual(restored.manifest, packageManifest);
await assertRealDirectory(RESTORE_ROOT, resolve("D:/code3/Narralume/data/gates"));
const verified = await verifyRestoredProject(RESTORE_ROOT, packageManifest);
const oldVideoPath = controlled(RESTORE_ROOT, verified.storedFinal.manifest.finalVideo.relativePath);
const oldVideo = await readFile(oldVideoPath);
const oldManifest = verified.storedFinal.bytes;
const finalDirectory = dirname(oldVideoPath);
await assertRealDirectory(finalDirectory, RESTORE_ROOT);
assert.equal(finalDirectory, controlled(RESTORE_ROOT, dirname(packageManifest.project.finalManifestPath).split(sep).join("/")));
await rm(finalDirectory, { recursive: true });

const rebuilt = await exportFinalVideo(verified.connection.database, RESTORE_ROOT, {
  episodeId: packageManifest.project.episodeId,
  timelineHash: packageManifest.project.timelineHash,
});
assert.equal(rebuilt.reused, false);
assert.equal(rebuilt.manifest.exportHash, EXPECTED_FINAL_HASH);
assert.equal(rebuilt.manifest.finalVideo.fileHash, EXPECTED_VIDEO_HASH);
assert.deepEqual(await readFile(rebuilt.finalPath), oldVideo);
assert.deepEqual(await readFile(rebuilt.manifestPath), oldManifest);
const probe = await probeNineSixteenVideo(rebuilt.finalPath);
assert(probe.durationMs >= 180_000 && probe.durationMs <= 300_000);
await runVideoProcess("ffmpeg", ["-v", "error", "-i", rebuilt.finalPath, "-map", "0:v:0", "-map", "0:a:0", "-f", "null", "-"]);
verified.connection.close();

const restarted = await verifyRestoredProject(RESTORE_ROOT, packageManifest);
try {
  const reused = await exportFinalVideo(restarted.connection.database, RESTORE_ROOT, {
    episodeId: packageManifest.project.episodeId,
    timelineHash: packageManifest.project.timelineHash,
  });
  assert.equal(reused.reused, true);
  assert.equal(reused.manifest.exportHash, EXPECTED_FINAL_HASH);
  assert.deepEqual(await readFile(reused.finalPath), oldVideo);
} finally {
  restarted.connection.close();
}

const packageManifestHashBeforeNegatives = await hashFile(join(canonicalPackagePath, "manifest.json"));
const payloadChoice = packageManifest.files.find((file) => file.roles.includes("subtitle-srt"))!;
for (const kind of ["tampered", "missing", "extra"] as const) {
  const badPackage = join(SCRATCH_ROOT, `package-${kind}`);
  const badTarget = join(SCRATCH_ROOT, `restore-${kind}`);
  await cp(canonicalPackagePath, badPackage, { recursive: true, errorOnExist: true, force: false });
  if (kind === "tampered") await writeFile(controlled(join(badPackage, "payload"), payloadChoice.path), "tampered", { flag: "a" });
  if (kind === "missing") await rm(controlled(join(badPackage, "payload"), payloadChoice.path));
  if (kind === "extra") await writeFile(join(badPackage, "payload", "unexpected.txt"), "unexpected");
  await expectRejected(() => restoreProjectPackage(badPackage, badTarget), `${kind} 项目包必须被拒绝`);
  await assert.rejects(lstat(badTarget), (error: NodeJS.ErrnoException) => error.code === "ENOENT");
}

const restoredVideoHashBeforeExistingTarget = await hashFile(controlled(RESTORE_ROOT,
  (await loadFinalManifest(RESTORE_ROOT, packageManifest.project.finalManifestPath)).manifest.finalVideo.relativePath));
await expectRejected(() => restoreProjectPackage(canonicalPackagePath, RESTORE_ROOT), "已存在恢复目标必须被拒绝");
assert.equal(await hashFile(join(canonicalPackagePath, "manifest.json")), packageManifestHashBeforeNegatives);
assert.equal(await hashFile(controlled(RESTORE_ROOT,
  (await loadFinalManifest(RESTORE_ROOT, packageManifest.project.finalManifestPath)).manifest.finalVideo.relativePath)),
restoredVideoHashBeforeExistingTarget);
await verifyPackageFiles(canonicalPackagePath, packageManifest);
const afterNegatives = await verifyRestoredProject(RESTORE_ROOT, packageManifest);
afterNegatives.connection.close();
await rm(SCRATCH_ROOT, { recursive: true });

process.stdout.write(`${JSON.stringify({
  ok: true,
  source_data_root: SOURCE_ROOT,
  package_path: canonicalPackagePath,
  package_version: packageManifest.version,
  package_hash: packageManifest.packageHash,
  package_file_count: packageStats.fileCount,
  package_total_bytes: packageStats.totalBytes,
  package_role_counts: packageStats.roleCounts,
  restored_data_root: RESTORE_ROOT,
  episode_id: packageManifest.project.episodeId,
  evidence_sources: verified.episode.sources.length,
  chapter_event_counts: verified.eventCounts,
  script_version_id: verified.script.id,
  script_kind: verified.script.kind,
  approval_revision: verified.permit.approvalRevision,
  timeline_hash: packageManifest.project.timelineHash,
  audio_segments: verified.audio.length,
  subtitle_cues: verified.cues.length,
  visual_segments: verified.visuals.length,
  render_chunks: verified.chunks.length,
  final_hash: EXPECTED_FINAL_HASH,
  final_video_path: controlled(RESTORE_ROOT, rebuilt.manifest.finalVideo.relativePath),
  final_video_sha256: rebuilt.manifest.finalVideo.fileHash,
  final_video_bytes: rebuilt.manifest.finalVideo.bytes,
  final_video_duration_ms: rebuilt.manifest.finalVideo.durationMs,
  video_contract: rebuilt.manifest.finalVideo.streams,
  byte_identical_reexport: true,
  full_decode: true,
  restart_query: true,
  restart_reexport_reused: true,
  expected_negative_rejections: 4,
  unexpected_failures: 0,
  retries: 0,
  manual_actions: 0,
  manual_elapsed_ms: 0,
  external_model_calls: 0,
  incremental_cost: 0,
  elapsed_ms: Date.now() - startedAt,
}, null, 2)}\n`);
