import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, readFile, rm } from "node:fs/promises";
import { resolve, join } from "node:path";
import { fileURLToPath } from "node:url";

import { appendAssetCandidateReview, registerAssetCandidate } from "../asset-candidate-store.js";
import { openDatabase } from "../database.js";
import { createJob, getJob } from "../job-store.js";
import { JobWorker } from "../job-worker.js";
import { changeScriptApproval } from "../script-approval-store.js";
import { createTtsTimelineJobHandler, TTS_TIMELINE_JOB_TYPE } from "../tts-timeline-job.js";
import {
  assertVisualPlanReady,
  listVisualSegments,
  putVisualSegment,
  type VisualMotionKind,
} from "../visual-segment-store.js";

const EPISODE_ID = "p5_visual_episode";
const ASSET_ID = "p5_visual_scene";
const narration = [
  "故事从一块顽石写起。甄士隐在梦中看见通灵之物，也看见它将从天地之间进入人世。这个神异开端并非装饰，它提醒观众，眼前即将展开的日常生活背后，还牵着一条更长的因缘线。镜头先停在梦境与现实交界处，让观众记住这件通灵之物的来历。此刻不急着解释它未来属于谁，只确认这条线索已经进入故事，并将在人物相遇以后重新显出意义。",
  "梦醒之后，人间故事由一个极小的动作推动。原文写到，人物因为偶然一顾，便引出后续事来。一次看似轻微的回望，把原本陌生的道路接在一起。改编不夸大巧合，只保留已经写明的动作和因果，让命运的转向显得具体而可信。观众看到的不是凭空降下的奇迹，而是一个普通选择如何改变后来的人生。",
  "个人因果刚刚启动，贾府的命运也被提前放到读者面前。旁观者提出关于兴衰的疑问，却没有抢先宣布答案。繁华仍在，变化的征兆已经出现。我们只把这句提醒留在观众心里，等待后面的生活细节慢慢回答。镜头不需要制造灾难，只需让安静的院落、规整的门第和人物的谈话共同留下若有若无的不安。",
  "与此同时，黛玉的生活来到转折处。她要依傍外祖母和舅氏姊妹，离开原来的环境，前往一个熟悉于名声、陌生于日常的家族。这是现实处境下的投亲，不是追逐虚构目标。她既期待亲人，也要面对规矩和未知。一路上的车马、舟行与停靠，都让这次迁移拥有真实重量，也让她的谨慎显得合乎处境。",
  "车马继续向前，真正的空间边界终于出现。黛玉确认眼前就是荣国府。梦中的通灵线索、人间的一次回望、旁观者关于兴衰的提醒，在府门前逐渐汇合。她即将走进去，也将成为观众观察这个家族的一双眼睛。画面停留在高门、匾额和来往仆从，不急着展示所有人物，让初见的陌生感保持完整。",
  "进入府中以后，礼数先于亲近出现。黛玉留心众人的称呼、座次和神情，时时提醒自己不要轻易多说一句话、多走一步路。这份克制不是软弱，而是她面对陌生环境时的判断。观众随着她的目光看见屋内陈设和人物关系，也逐渐理解这个家族如何用细密规矩维持表面的秩序与体面。",
  "亲人相见带来悲喜交集，新的关系也在问候中建立。黛玉被接纳，却不能立刻消除寄居的敏感；众人表达怜爱，也各自站在家族既有的位置上。镜头让拥抱、落泪和短暂沉默自然发生，不替人物补写原文没有给出的冲突。温情与拘束可以同时存在，这正是她初入荣国府时最真实的感受。",
  "随后归来的宝玉打破了室内原有的节奏。两位少年第一次相见，竟都生出似曾相识之感。这个瞬间回应了开篇留下的通灵线索，却仍然只通过眼神、停顿和简短问答呈现。观众不需要提前知道全部命运，只要意识到两个人的相遇并非普通会面，前面的梦境从此有了落在人间的具体人物。",
  "这一集并不是几段互不相关的旧事。它讲的是一条逐渐收紧的路径：从顽石入世，到梦中识得通灵；从偶然回望，到因果真正发生；从旁观者提出兴衰之问，到黛玉投亲并抵达荣国府。每一步都能回到已有的人物、动作和地点，也都为宝黛相见保留了清楚的来处。",
  "结尾再次回望已经建立的支点：梦幻中出现的通灵之物，一次改变人物道路的偶然回望，一句关于家族兴衰的冷眼提醒，以及一个走进荣国府的少女。它们已经在同一条叙事线上相遇，下一集将从府门之内继续。观众带着已经出现的证据和仍未回答的问题越过这道门槛，后续变化才不会凭空发生。",
];

function seed(database: ReturnType<typeof openDatabase>["database"]) {
  database.prepare(
    `INSERT INTO books (id, title, original_file_path, original_file_hash, encoding, import_status)
     VALUES ('p5_visual_book', '红楼梦', 'source.txt', ?, 'utf-8', 'ready')`,
  ).run("1".repeat(64));
  database.prepare(
    `INSERT INTO series_projects (id, book_id, title, created_at, updated_at)
     VALUES ('p5_visual_series', 'p5_visual_book', '黛玉初入荣国府', 1, 1)`,
  ).run();
  database.prepare(
    `INSERT INTO episodes (
      id, series_project_id, episode_index, title, story_arc, target_duration_seconds, created_at, updated_at
    ) VALUES (?, 'p5_visual_series', 1, '第一集', '从顽石入世到宝黛初见', 240, 1, 1)`,
  ).run(EPISODE_ID);
  const content = JSON.stringify({ paragraphs: narration.map((text) => ({ text, sourceIndexes: [0] })) });
  database.prepare(
    `INSERT INTO script_versions (
      id, episode_id, kind, version, parent_version_id, content_json, content_hash, created_at
    ) VALUES ('p5_visual_script', ?, 'packaged', 1, NULL, ?, ?, 1)`,
  ).run(EPISODE_ID, content, createHash("sha256").update(content).digest("hex"));
  changeScriptApproval(database, EPISODE_ID, {
    action: "approve", expectedRevision: 0, scriptVersionId: "p5_visual_script",
  });
  database.prepare(
    `INSERT INTO assets (
      id, series_project_id, asset_type, asset_role, canonical_name, normalized_name, created_at
    ) VALUES (?, 'p5_visual_series', 'scene', 'master', '荣国府', '荣国府', 1)`,
  ).run(ASSET_ID);
}

async function createTimeline(
  database: ReturnType<typeof openDatabase>["database"],
  dataRoot: string,
) {
  const job = createJob(database, {
    type: TTS_TIMELINE_JOB_TYPE, payload: { episodeId: EPISODE_ID, rate: 2 }, maxAttempts: 1,
  });
  const worker = new JobWorker(database, {
    [TTS_TIMELINE_JOB_TYPE]: createTtsTimelineJobHandler(database, dataRoot),
  }, { workerId: "p5-visual-real-tts", leaseMs: 900_000, heartbeatMs: 10_000 });
  assert.equal(await worker.runOne(), true);
  const completed = getJob(database, job.id)!;
  assert.equal(completed.status, "succeeded", completed.errorMessage ?? "真实 TTS 时间轴失败");
  return completed.result as { timelineHash: string; durationMs: number; cueCount: number };
}

const repositoryRoot = fileURLToPath(new URL("../../../../", import.meta.url));
const dataRoot = resolve(repositoryRoot, "data/gates/p5-visual-segments");
assert.equal(dataRoot.startsWith(resolve(repositoryRoot, "data/gates")), true);
await rm(dataRoot, { recursive: true, force: true });
await mkdir(dataRoot, { recursive: true });

let connection = openDatabase(dataRoot);
try {
  seed(connection.database);
  const timeline = await createTimeline(connection.database, dataRoot);
  assert.equal(timeline.cueCount, narration.length);
  assert.ok(timeline.durationMs >= 180_000 && timeline.durationMs <= 300_000,
    `真实旁白时长不在 3～5 分钟：${timeline.durationMs}ms`);

  const fixturePath = join(dataRoot, "荣国府竖屏底图.png");
  const fixture = spawnSync("ffmpeg", [
    "-v", "error", "-f", "lavfi", "-i", "color=c=0x8d8073:s=900x1600",
    "-frames:v", "1", "-y", fixturePath,
  ], { windowsHide: true, encoding: "utf8" });
  assert.equal(fixture.status, 0, fixture.stderr);
  const candidate = await registerAssetCandidate(connection.database, dataRoot, {
    assetId: ASSET_ID,
    source: { kind: "upload", originalName: "荣国府竖屏底图.png" },
    raw: createReadStream(fixturePath),
  });
  appendAssetCandidateReview(connection.database, candidate.id, {
    expectedRevision: 0, action: "approve", note: "P5-03 本地真实门禁批准",
  });

  const motions: VisualMotionKind[] = ["none", "zoom-in", "pan-left", "zoom-out", "pan-right"];
  for (let index = 0; index < timeline.cueCount; index += 1) {
    putVisualSegment(connection.database, EPISODE_ID, index, {
      timelineHash: timeline.timelineHash,
      cueStartIndex: index,
      cueEndIndex: index,
      motionKind: motions[index % motions.length]!,
      motionAmountPpm: motions[index % motions.length] === "none" ? 0 : 30_000,
      fadeMs: 350,
      expectedRevision: 0,
      assets: [{ assetId: ASSET_ID, selectedCandidateId: candidate.id }],
    });
  }
  assertVisualPlanReady(connection.database, EPISODE_ID, timeline.timelineHash);
  const beforeRestart = listVisualSegments(connection.database, EPISODE_ID, timeline.timelineHash);
  assert.equal(beforeRestart.length, narration.length);

  connection.close();
  connection = openDatabase(dataRoot);
  const afterRestart = listVisualSegments(connection.database, EPISODE_ID, timeline.timelineHash);
  assert.deepEqual(afterRestart, beforeRestart);
  assertVisualPlanReady(connection.database, EPISODE_ID, timeline.timelineHash);

  appendAssetCandidateReview(connection.database, candidate.id, {
    expectedRevision: 1, action: "reject", note: "验证审核变化立即阻断生产",
  });
  assert.throws(
    () => assertVisualPlanReady(connection.database, EPISODE_ID, timeline.timelineHash),
    /候选|批准|审核|生产/,
  );

  const candidatePath = join(dataRoot, ...candidate.relativePath.split("/"));
  const candidateBytes = await readFile(candidatePath);
  assert.equal(createHash("sha256").update(candidateBytes).digest("hex"), candidate.fileHash);
  console.log("P5-03 真实视觉段显式绑定门禁通过");
  console.log(`timeline_hash=${timeline.timelineHash}`);
  console.log(`duration_ms=${timeline.durationMs}`);
  console.log(`visual_segments=${beforeRestart.length}`);
  console.log(`candidate_id=${candidate.id}`);
  console.log(`candidate_hash=${candidate.fileHash}`);
  console.log(`candidate_path=${candidatePath}`);
  console.log("restart_stable=true");
  console.log("reject_blocks_production=true");
} finally {
  connection.close();
}
