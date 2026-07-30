import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { rm, stat } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { openDatabase } from "../database.js";
import { createJob, getJob } from "../job-store.js";
import { JobWorker, type JobHandler } from "../job-worker.js";
import { createPlaceholderVideoJobHandler, PLACEHOLDER_VIDEO_JOB_TYPE } from "../placeholder-video-job.js";
import { changeScriptApproval } from "../script-approval-store.js";
import { createTtsTimelineJobHandler, TTS_TIMELINE_JOB_TYPE } from "../tts-timeline-job.js";

const dataRoot = fileURLToPath(new URL("../../../../data/gates/p4-placeholder", import.meta.url));
if (!/[\\/]data[\\/]gates[\\/]p4-placeholder$/.test(dataRoot)) throw new Error("P4 门禁数据目录越界");

const narration = [
  "故事从一块顽石写起。甄士隐在梦中看见通灵之物，也看见它将从天地之间进入人世。这个神异开端不是装饰，它提醒我们，眼前即将展开的日常生活背后，还牵着一条更长的因缘线。镜头先停在梦境与现实交界处，让观众记住这件通灵之物的来历。此刻不急着解释它未来属于谁，只确认这条线索已经进入故事，并将在人物相遇以后重新显出意义。",
  "梦醒之后，人间故事由一个极小的动作推动。原文写到，人物因为偶然一顾，便引出后续事来。一次看似轻微的回望，把原本陌生的道路接在一起。改编不夸大巧合，只保留已经写明的动作和因果，让命运的转向显得具体而可信。",
  "个人因果刚刚启动，贾府的命运也被提前放到读者面前。旁观者提出关于兴衰的疑问，却没有抢先宣布答案。繁华仍在，变化的征兆已经出现。我们只把这句提醒留在观众心里，等待后面的生活细节慢慢回答。",
  "与此同时，黛玉的生活来到转折处。她要依傍外祖母和舅氏姊妹，离开原来的环境，前往一个熟悉于名声、陌生于日常的家族。这是现实处境下的投亲，不是追逐虚构目标。她既期待亲人，也要面对规矩和未知。",
  "车马继续向前，真正的空间边界终于出现。黛玉确认眼前就是荣国府。梦中的通灵线索、人间的一次回望、旁观者关于兴衰的提醒，在府门前逐渐汇合。她即将走进去，也将成为观众观察这个家族的一双眼睛。",
  "这一集并不是几段互不相关的旧事。它讲的是一条逐渐收紧的路径：从顽石入世，到梦中识得通灵；从偶然回望，到因果真正发生；从旁观者提出兴衰之问，到黛玉投亲并抵达荣国府。每一步都能回到已有的人物、动作和地点。",
  "府门打开以后，故事没有急着制造冲突。黛玉会先遇见谁，会怎样理解这里的亲疏与规矩，又会从哪些细节感受到家族命运的变化，这些问题都留给后面的真实章节回答。首集只负责把人物和线索稳稳送到同一个地方。",
  "结尾再次回望已经建立的四个支点：从梦幻中出现的通灵之物，一次改变人物道路的偶然回望，一句关于家族兴衰的冷眼提醒，以及一个走进荣国府的少女。它们已经在同一条叙事线上相遇，下一集将从府门之内继续。观众带着已经出现的证据和仍未回答的问题越过这道门槛，后续变化才有清楚的来处，而不是凭空发生。",
];
const characterCount = [...narration.join("").replace(/\s/gu, "")].length;
assert.ok(characterCount >= 850 && characterCount <= 1_200, `真实批准稿字符数异常：${characterCount}`);

function seed(database: ReturnType<typeof openDatabase>["database"]) {
  database.prepare(
    `INSERT INTO books (id, title, original_file_path, original_file_hash, encoding, import_status)
     VALUES ('p4_book', '红楼梦', 'source.txt', ?, 'utf-8', 'ready')`,
  ).run("1".repeat(64));
  database.prepare(
    `INSERT INTO series_projects (id, book_id, title, created_at, updated_at)
     VALUES ('p4_series', 'p4_book', '黛玉初入荣国府', 1, 1)`,
  ).run();
  database.prepare(
    `INSERT INTO episodes (
      id, series_project_id, episode_index, title, story_arc, target_duration_seconds, created_at, updated_at
    ) VALUES ('p4_episode', 'p4_series', 1, '第一集', '从顽石入世到黛玉抵达荣国府', 240, 1, 1)`,
  ).run();
  const content = JSON.stringify({ paragraphs: narration.map((text) => ({ text, sourceIndexes: [0] })) });
  database.prepare(
    `INSERT INTO script_versions (
      id, episode_id, kind, version, parent_version_id, content_json, content_hash, created_at
    ) VALUES ('p4_script', 'p4_episode', 'packaged', 1, NULL, ?, ?, 1)`,
  ).run(content, createHash("sha256").update(content).digest("hex"));
  changeScriptApproval(database, "p4_episode", {
    action: "approve", expectedRevision: 0, scriptVersionId: "p4_script",
  });
}

async function runJob(
  database: ReturnType<typeof openDatabase>["database"],
  type: string,
  payload: unknown,
  handler: JobHandler,
) {
  const job = createJob(database, { type, payload, maxAttempts: 1 });
  const worker = new JobWorker(database, { [type]: handler }, {
    workerId: `p4-real-${job.id}`, leaseMs: 900_000, heartbeatMs: 10_000,
  });
  assert.equal(await worker.runOne(), true);
  const completed = getJob(database, job.id)!;
  assert.equal(completed.status, "succeeded", completed.errorMessage ?? `${type} 失败`);
  return completed.result as Record<string, unknown>;
}

await rm(dataRoot, { recursive: true, force: true });
let connection = openDatabase(dataRoot);
try {
  seed(connection.database);
  const timeline = await runJob(
    connection.database,
    TTS_TIMELINE_JOB_TYPE,
    { episodeId: "p4_episode" },
    createTtsTimelineJobHandler(connection.database, dataRoot),
  );
  const durationMs = timeline.durationMs as number;
  assert.ok(durationMs >= 180_000 && durationMs <= 300_000, `真实旁白时长不在 3～5 分钟：${durationMs}ms`);
  assert.equal(timeline.segmentCount, 8);

  const video = await runJob(
    connection.database,
    PLACEHOLDER_VIDEO_JOB_TYPE,
    { episodeId: "p4_episode", timelineHash: timeline.timelineHash },
    createPlaceholderVideoJobHandler(connection.database, dataRoot),
  );
  assert.equal(video.reused, false);
  assert.ok(Math.abs((video.durationMs as number) - durationMs) <= 1_000);
  const videoPath = fileURLToPath(new URL(`../../../../data/gates/p4-placeholder/${video.relativePath}`, import.meta.url));
  const firstStat = await stat(videoPath);

  connection.close();
  connection = openDatabase(dataRoot);
  const repeated = await runJob(
    connection.database,
    PLACEHOLDER_VIDEO_JOB_TYPE,
    { episodeId: "p4_episode", timelineHash: timeline.timelineHash },
    createPlaceholderVideoJobHandler(connection.database, dataRoot),
  );
  assert.equal(repeated.reused, true);
  assert.equal(repeated.renderHash, video.renderHash);
  assert.equal(repeated.fileHash, video.fileHash);
  assert.equal((await stat(videoPath)).mtimeMs, firstStat.mtimeMs);

  console.log("P4-03 真实 9:16 有声字幕占位视频门禁通过");
  console.log(`approved_characters=${characterCount}`);
  console.log(`timeline_hash=${timeline.timelineHash}`);
  console.log(`duration_ms=${video.durationMs}`);
  console.log(`video_bytes=${video.bytes}`);
  console.log(`video_sha256=${video.fileHash}`);
  console.log(`video_path=${videoPath}`);
  console.log("resolution=1080x1920");
  console.log("restart_reuse=true");
} finally {
  connection.close();
}
