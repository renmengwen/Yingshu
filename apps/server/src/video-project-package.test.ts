import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import { openDatabase } from "./database.js";
import { createVideoProjectPackage, restoreVideoProjectPackage } from "./video-project-package.js";

const H = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
const X = (char: string) => char.repeat(64);

async function put(root: string, path: string, content: string) {
  const absolute = join(root, ...path.split("/"));
  await mkdir(dirname(absolute), { recursive: true });
  await writeFile(absolute, content);
  return { path, bytes: Buffer.byteLength(content), hash: H(content) };
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "yingshu-video-package-"));
  const dataRoot = join(root, "data");
  const connection = openDatabase(dataRoot);
  const db = connection.database;
  db.prepare("INSERT INTO projects(id,name,created_at,updated_at) VALUES ('project','项目',1,1),('other','其他',1,1)").run();
  db.prepare("INSERT INTO videos(id,project_id,title,status,created_at,updated_at) VALUES ('video','project','视频','completed',1,1),('other-video','other','其他','draft',1,1)").run();
  db.prepare(`INSERT INTO video_plan_snapshots(id,video_id,idempotency_key,input_json,prompt_json,model_json,system_contract_version,
    web_capability,canonical_json,snapshot_hash,created_at) VALUES ('plan','video','key','{}','{}','{}','v1','disabled','{}',?,1)`).run(X("1"));
  db.prepare(`INSERT INTO video_script_revisions(id,video_id,snapshot_id,revision,content_json,content_hash,provider_id,model_id,
    prompt_version,prompt_hash,created_at) VALUES ('script','video','plan',1,'{}',?,'provider','model','v1',?,1)`).run(X("2"), X("3"));
  db.prepare(`INSERT INTO video_visual_revisions(id,video_id,snapshot_id,script_revision_id,script_content_hash,revision,content_json,
    content_hash,created_at) VALUES ('visual-revision','video','plan','script',?,1,'{}',?,1)`).run(X("2"), X("4"));
  db.prepare(`INSERT INTO video_plan_approvals(id,video_id,snapshot_id,revision,script_revision_id,visual_revision_id,script_content_hash,
    visual_content_hash,created_at) VALUES ('plan-approval','video','plan',1,'script','visual-revision',?,?,1)`).run(X("2"), X("4"));
  const image = await put(dataRoot, "projects/project/videos/video/images/image.png", "png");
  db.prepare(`INSERT INTO video_image_candidates(id,project_id,video_id,plan_snapshot_id,plan_snapshot_hash,script_revision_id,
    script_content_hash,visual_revision_id,visual_content_hash,visual_id,prompt,negative_prompt,style_snapshot_json,prompt_hash,
    provider_id,model_id,params_json,request_identity,attempt,checkpoint_scope,status,origin,relative_path,mime,bytes,width,height,file_hash,created_at)
    VALUES ('candidate','project','video','plan',?,'script',?,'visual-revision',?,'shot','画面','','{}',?,'provider','model','{}',
    'request',1,'shot','succeeded','generated',?,'image/png',?,1080,1920,?,1)`).run(
      X("1"), X("2"), X("4"), X("5"), image.path, image.bytes, image.hash);
  db.prepare(`INSERT INTO video_image_approval_events(id,project_id,video_id,gate_revision,visual_id,candidate_id,plan_snapshot_id,
    plan_snapshot_hash,script_revision_id,script_content_hash,visual_revision_id,visual_content_hash,prompt_hash,candidate_hash,created_at)
    VALUES ('image-approval','project','video',1,'shot','candidate','plan',?,'script',?,'visual-revision',?,?,?,1)`).run(
      X("1"), X("2"), X("4"), X("5"), image.hash);
  db.prepare("INSERT INTO jobs(id,type,payload_json,status,run_after,created_at,updated_at) VALUES ('tts-job','tts','{\"secret\":\"remove\"}','succeeded',1,1,1),('render-job','render','{}','succeeded',1,1,1)").run();
  db.prepare(`INSERT INTO video_tts_snapshots(id,project_id,video_id,plan_snapshot_id,plan_snapshot_hash,script_revision_id,
    script_content_hash,paragraphs_json,provider_id,provider_name,provider_kind,protocol,base_url,model_id,voice_id,rate,language,
    params_json,target_duration_seconds,system_contract_version,canonical_json,snapshot_hash,created_at)
    VALUES ('tts','project','video','plan',?,'script',?,'[]','provider','Provider','openai','openai','','model','voice',0,'zh','{}',60,'v1','{}',?,1)`).run(
      X("1"), X("2"), X("6"));
  db.prepare("INSERT INTO video_tts_jobs(job_id,video_id,snapshot_id,created_at) VALUES ('tts-job','video','tts',1)").run();
  const audio = await put(dataRoot, "projects/project/videos/video/tts/audio.wav", "wav");
  const srt = await put(dataRoot, "projects/project/videos/video/tts/subtitles.srt", "srt");
  const ass = await put(dataRoot, "projects/project/videos/video/tts/subtitles.ass", "ass");
  db.prepare(`INSERT INTO video_tts_artifacts(id,project_id,video_id,snapshot_id,snapshot_hash,job_id,audio_relative_path,audio_mime,
    audio_codec,sample_rate,channels,audio_bytes,duration_ms,audio_hash,cues_hash,srt_relative_path,srt_bytes,srt_hash,
    ass_relative_path,ass_bytes,ass_hash,created_at) VALUES ('artifact','project','video','tts',?,'tts-job',?,'audio/wav','pcm_s16le',
    24000,1,?,1000,?,?,?, ?,?, ?,?,?,1)`).run(X("6"), audio.path, audio.bytes, audio.hash, X("7"),
      srt.path, srt.bytes, srt.hash, ass.path, ass.bytes, ass.hash);
  db.prepare(`INSERT INTO video_tts_cues(artifact_id,video_id,cue_index,paragraph_id,text,start_ms,end_ms,cue_hash)
    VALUES ('artifact','video',0,'p','旁白',0,1000,?)`).run(X("8"));
  db.prepare(`INSERT INTO video_audio_review_events(id,project_id,video_id,revision,snapshot_id,snapshot_hash,artifact_id,action,notes,
    duration_decision,script_revision_id,script_content_hash,provider_id,model_id,voice_id,rate,language,audio_hash,cues_hash,srt_hash,
    ass_hash,deviation_ratio,created_at) VALUES ('audio-review','project','video',1,'tts',?,'artifact','approve','','within_target',
    'script',?,'provider','model','voice',0,'zh',?,?,?,?,0,1)`).run(X("6"), X("2"), audio.hash, X("7"), srt.hash, ass.hash);
  db.prepare(`INSERT INTO video_visual_timelines(id,project_id,video_id,revision,identity_hash,plan_snapshot_id,plan_snapshot_hash,
    script_revision_id,script_content_hash,visual_revision_id,visual_content_hash,image_gate_revision,tts_snapshot_id,tts_snapshot_hash,
    tts_artifact_id,audio_hash,cues_hash,srt_hash,ass_hash,audio_duration_ms,timeline_hash,created_at)
    VALUES ('timeline','project','video',1,?,'plan',?,'script',?,'visual-revision',?,1,'tts',?,'artifact',?,?,?,?,1000,?,1)`).run(
      X("9"), X("1"), X("2"), X("4"), X("6"), audio.hash, X("7"), srt.hash, ass.hash, X("a"));
  db.prepare(`INSERT INTO video_visual_segments(id,stable_segment_id,project_id,timeline_id,video_id,segment_index,cue_start_index,
    cue_end_index,cue_start_hash,cue_end_hash,start_ms,end_ms,visual_id,candidate_id,candidate_hash,candidate_relative_path,
    motion_kind,motion_amount_ppm,fade_in_ms,fade_out_ms,segment_hash,created_at)
    VALUES ('segment','stable','project','timeline','video',0,0,0,?,?,0,1000,'shot','candidate',?,?,'still',0,0,0,?,1)`).run(
      X("8"), X("8"), image.hash, image.path, X("b"));
  db.prepare(`INSERT INTO video_visual_review_events(id,project_id,video_id,revision,timeline_id,timeline_revision,timeline_hash,
    identity_hash,action,notes,created_at) VALUES ('visual-review','project','video',1,'timeline',1,?,?,'approve','',1)`).run(X("a"), X("c"));
  db.prepare(`INSERT INTO video_render_runs(id,project_id,video_id,timeline_id,timeline_hash,visual_review_id,identity_hash,job_id,status,
    params_json,params_hash,created_at,updated_at) VALUES ('run','project','video','timeline',?,'visual-review',?,'render-job','succeeded','{}',?,1,1)`).run(
      X("a"), X("d"), X("e"));
  const chunk = await put(dataRoot, "projects/project/videos/video/renders/chunk.mp4", "chunk");
  db.prepare(`INSERT INTO video_render_chunks(id,run_id,video_id,timeline_id,chunk_index,segment_id,segment_hash,identity_hash,status,
    relative_path,bytes,file_hash,media_info_json,checkpoint_at,created_at,updated_at)
    VALUES ('chunk','run','video','timeline',0,'segment',?,?, 'succeeded',?,?,?,'{}',1,1,1)`).run(X("b"), X("f"), chunk.path, chunk.bytes, chunk.hash);
  const final = await put(dataRoot, "projects/project/videos/video/final/video.mp4", "video");
  const manifest = await put(dataRoot, "projects/project/videos/video/final/manifest.json", "{}");
  db.prepare(`INSERT INTO video_final_videos(id,run_id,project_id,video_id,identity_hash,relative_path,bytes,file_hash,media_info_json,
    manifest_relative_path,manifest_bytes,manifest_hash,ffmpeg_version,created_at)
    VALUES ('final','run','project','video',?,?,?,?,'{}',?,?,?,'ffmpeg',1)`).run(X("d"), final.path, final.bytes, final.hash,
      manifest.path, manifest.bytes, manifest.hash);
  const metadata = await put(dataRoot, "douyin/analyses/video/snapshot/metadata.json", "{\"awemeId\":\"12345\"}");
  const transcript = await put(dataRoot, "douyin/analyses/video/snapshot/transcript.json", "{\"text\":\"转写\"}");
  const comments = await put(dataRoot, "douyin/analyses/video/snapshot/comments.json", "{\"interpretationOnly\":true}");
  const report = await put(dataRoot, "douyin/analyses/video/snapshot/report.json", "{\"version\":\"yingshu-douyin-analysis-v1\"}");
  const artifacts = [metadata, transcript, comments, report].map((item) => ({
    id: item.path.split("/").at(-1)!,
    kind: item.path.includes("metadata") ? "metadata" : item.path.includes("transcript") ? "transcript" :
      item.path.includes("comments") ? "comments" : "report",
    relativePath: item.path, bytes: item.bytes, sha256: item.hash, status: "succeeded",
  }));
  const evidenceHash = X("0");
  const reportHash = X("1");
  db.prepare(`INSERT INTO video_douyin_analysis_snapshots
    (id,video_id,aweme_id,source_url,source_text,config_json,config_hash,evidence_hash,report_json,report_hash,status,completeness,
     artifact_manifest_json,model_snapshot_json,prompt_version,created_at,completed_at)
    VALUES ('snapshot','video','12345','https://www.douyin.com/video/12345','https://v.douyin.com/test/', '{}',?,?,?,?,
      'succeeded','complete',?,'{\"provider\":\"fixture\",\"model\":\"fixture\"}','v1',2,3)`)
    .run(X("2"), evidenceHash, JSON.stringify({ version: "yingshu-douyin-analysis-v1" }), reportHash,
      JSON.stringify({ version: "yingshu-douyin-evidence-v1", evidenceHash, artifacts }));
  db.prepare(`INSERT INTO video_douyin_analysis_selections
    (video_id,snapshot_id,usage_role,creative_angle,rights_confirmed,updated_at)
    VALUES ('video','snapshot','method_only','',0,3)`).run();
  return { root, dataRoot, connection, artifacts, evidenceHash };
}

test("v26 Video 项目包恢复当前抖音证据且排除缓存和秘密", async () => {
  const value = await fixture();
  try {
    const packagePath = join(value.root, "package");
    await put(value.dataRoot, "douyin/cache/12345/video.mp4", "cache");
    await put(value.dataRoot, "douyin/cookies.json", "secret-cookie");
    const originalManifest = JSON.parse((value.connection.database.prepare(
      "SELECT artifact_manifest_json FROM video_douyin_analysis_snapshots WHERE id='snapshot'",
    ).get() as { artifact_manifest_json: string }).artifact_manifest_json) as Record<string, unknown>;
    value.connection.database.prepare(
      "UPDATE video_douyin_analysis_snapshots SET artifact_manifest_json=? WHERE id='snapshot'",
    ).run(JSON.stringify({ ...originalManifest, cookie: "secret-cookie" }));
    await assert.rejects(createVideoProjectPackage(value.connection.database, value.dataRoot, {
      packagePath, projectId: "project", videoId: "video", finalVideoId: "final",
    }), /证据清单合同无效|秘密/u);
    value.connection.database.prepare(
      "UPDATE video_douyin_analysis_snapshots SET artifact_manifest_json=? WHERE id='snapshot'",
    ).run(JSON.stringify(originalManifest));
    const metadataPath = join(value.dataRoot, "douyin/analyses/video/snapshot/metadata.json");
    const secretMetadata = JSON.stringify({ downloadUrl: "https://secret.invalid/video" });
    await writeFile(metadataPath, secretMetadata);
    const secretArtifacts = (originalManifest.artifacts as Array<Record<string, unknown>>).map((artifact) =>
      artifact.kind === "metadata" ? { ...artifact, bytes: Buffer.byteLength(secretMetadata), sha256: H(secretMetadata) } : artifact);
    value.connection.database.prepare(
      "UPDATE video_douyin_analysis_snapshots SET artifact_manifest_json=? WHERE id='snapshot'",
    ).run(JSON.stringify({ ...originalManifest, artifacts: secretArtifacts }));
    await assert.rejects(createVideoProjectPackage(value.connection.database, value.dataRoot, {
      packagePath, projectId: "project", videoId: "video", finalVideoId: "final",
    }), /秘密字段/u);
    await writeFile(metadataPath, "{\"awemeId\":\"12345\"}");
    value.connection.database.prepare(
      "UPDATE video_douyin_analysis_snapshots SET artifact_manifest_json=? WHERE id='snapshot'",
    ).run(JSON.stringify(originalManifest));
    const created = await createVideoProjectPackage(value.connection.database, value.dataRoot, {
      packagePath, projectId: "project", videoId: "video", finalVideoId: "final",
    });
    assert.deepEqual(new Set(created.manifest.files.map((file) => file.role)), new Set([
      "database", "approved-image", "tts-audio", "subtitle-srt", "subtitle-ass", "render-chunk", "final-video", "final-manifest",
      "douyin-metadata", "douyin-transcript", "douyin-comments", "douyin-report",
    ]));
    assert.equal(created.manifest.schemaVersion, 26);
    assert.equal(created.manifest.files.some((file) => file.path.includes("cache") || file.path.includes("cookie")), false);
    const restored = join(value.root, "restored");
    await restoreVideoProjectPackage(packagePath, restored);
    const database = new DatabaseSync(join(restored, "yingshu.sqlite3"), { readOnly: true });
    try {
      assert.deepEqual(database.prepare("SELECT id FROM projects").all().map((row) => ({ ...row })), [{ id: "project" }]);
      assert.deepEqual(database.prepare("SELECT id FROM videos").all().map((row) => ({ ...row })), [{ id: "video" }]);
      assert.equal(database.prepare("PRAGMA foreign_key_check").all().length, 0);
      assert.equal((database.prepare("SELECT payload_json FROM jobs WHERE id='tts-job'").get() as { payload_json: string }).payload_json, "{}");
      assert.deepEqual({ ...database.prepare(
        "SELECT snapshot_id,usage_role FROM video_douyin_analysis_selections WHERE video_id='video'",
      ).get() }, { snapshot_id: "snapshot", usage_role: "method_only" });
      assert.deepEqual({ ...database.prepare(
        "SELECT evidence_hash,report_hash FROM video_douyin_analysis_snapshots WHERE id='snapshot'",
      ).get() }, { evidence_hash: value.evidenceHash, report_hash: X("1") });
    } finally { database.close(); }
    for (const artifact of value.artifacts) {
      assert.equal(H(await readFile(join(restored, ...artifact.relativePath.split("/")))), artifact.sha256);
    }
    await assert.rejects(readFile(join(restored, "douyin/cache/12345/video.mp4")), { code: "ENOENT" });
    await assert.rejects(readFile(join(restored, "douyin/cookies.json")), { code: "ENOENT" });
    assert.equal(await readFile(join(restored, "projects/project/videos/video/final/video.mp4"), "utf8"), "video");
    await writeFile(join(packagePath, "payload/projects/project/videos/video/final/video.mp4"), "tampered");
    await assert.rejects(restoreVideoProjectPackage(packagePath, join(value.root, "tampered")), /哈希不一致|大小受限/u);
  } finally {
    value.connection.close();
    await rm(value.root, { recursive: true, force: true });
  }
});
