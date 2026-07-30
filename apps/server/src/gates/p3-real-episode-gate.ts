import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

import { buildApp } from "../app.js";
import type { ChapterEventInput } from "../chapter-event-store.js";
import { openDatabase } from "../database.js";
import {
  requireApprovedScriptForProduction,
  ScriptApprovalStoreError,
} from "../script-approval-store.js";

const SOURCE_URL = "https://www.gutenberg.org/cache/epub/24264/pg24264.txt";
const SOURCE_SHA256 = "ff1526996bf4b81807651921a85e5c1c0f1d1d123c9fa4553057ba6a3ec72011";

interface ChapterRow {
  id: string;
  chapter_index: number;
  byte_start: number;
  byte_end: number;
}

interface EventTask {
  chapter: ChapterRow;
  events: ChapterEventInput[];
}

interface EpisodeSource {
  sourceIndex: number;
  chapterId: string;
  sourceEventId: string;
  byteStart: number;
  byteEnd: number;
  sourceHash: string;
  sourceText: string;
}

interface ScriptSource {
  episodeSourceIndex: number;
  chapterId: string;
  sourceEventId: string;
  byteStart: number;
  byteEnd: number;
  sourceHash: string;
}

interface ScriptVersion {
  id: string;
  episodeId: string;
  kind: "faithful" | "packaged";
  versionNumber: number;
  parentVersionId: string | null;
  contentHash: string;
  paragraphs: Array<{ text: string; sources: ScriptSource[] }>;
}

function expectProductionBlocked(fn: () => unknown) {
  assert.throws(fn, (error) => {
    assert(error instanceof ScriptApprovalStoreError);
    assert.equal(error.statusCode, 409);
    assert.match(error.message, /未人工批准/);
    return true;
  });
}

function hash(bytes: Buffer) {
  return createHash("sha256").update(bytes).digest("hex");
}

function narrationCharacters(paragraphs: ReadonlyArray<{ text: string }>) {
  return [...paragraphs.map((paragraph) => paragraph.text).join("").replace(/\s/gu, "")].length;
}

function evidence(source: Buffer, chapter: ChapterRow, phrase: string) {
  const needle = Buffer.from(phrase, "utf8");
  const chapterBytes = source.subarray(chapter.byte_start, chapter.byte_end);
  const relativeStart = chapterBytes.indexOf(needle);
  assert(relativeStart >= 0, `第 ${chapter.chapter_index} 章缺少冻结证据：${phrase}`);
  assert.equal(chapterBytes.indexOf(needle, relativeStart + 1), -1, `冻结证据在章节内不唯一：${phrase}`);
  const byteStart = chapter.byte_start + relativeStart;
  return { byteStart, byteEnd: byteStart + needle.length };
}

function eventTasks(source: Buffer, chapters: ChapterRow[]): EventTask[] {
  const chapter = (index: number) => {
    const found = chapters.find((item) => item.chapter_index === index);
    assert(found, `真实输入缺少 chapter_index=${index}`);
    return found;
  };
  const first = chapter(1);
  const second = chapter(2);
  const third = chapter(3);
  return [
    {
      chapter: first,
      events: [
        {
          type: "character",
          payload: { name: "甄士隱" },
          sources: [evidence(source, first, "甄士隱夢幻識通靈")],
        },
        {
          type: "prop",
          payload: { name: "頑石" },
          sources: [evidence(source, first, "頑石三万六千五百零一塊")],
        },
      ],
    },
    {
      chapter: second,
      events: [
        {
          type: "causality",
          payload: { cause: "偶然一顧", effect: "弄出這段事來" },
          sources: [evidence(source, second, "因偶然一顧，便弄出這段事來")],
        },
        {
          type: "suspense",
          payload: { question: "賈府目下興衰如何" },
          sources: [evidence(source, second, "欲知目下興衰兆，須問旁觀冷眼人")],
        },
      ],
    },
    {
      chapter: third,
      events: [
        {
          type: "revelation",
          payload: { fact: "黛玉依傍外祖母及舅氏姊妹" },
          sources: [evidence(source, third, "今依傍外祖母及舅氏姊妹去")],
        },
        {
          type: "location",
          payload: { name: "榮國府" },
          sources: [evidence(source, third, "方是榮國府了")],
        },
      ],
    },
  ];
}

async function downloadSource(path: string) {
  const response = await fetch(SOURCE_URL);
  assert(response.ok && response.body, `真实原文下载失败：HTTP ${response.status}`);
  await pipeline(
    Readable.fromWeb(response.body as import("node:stream/web").ReadableStream),
    createWriteStream(path, { flush: true }),
  );
}

const root = await mkdtemp(join(tmpdir(), "narralume-p3-real-"));
const dataRoot = process.env.YINGSHU_P3_GATE_DATA_ROOT
  ? resolve(process.env.YINGSHU_P3_GATE_DATA_ROOT)
  : join(root, "data");
const sourcePath = process.env.YINGSHU_LONG_TEXT_PATH ?? join(root, "pg24264.txt");
let app: ReturnType<typeof buildApp> | undefined;

try {
  if (!process.env.YINGSHU_LONG_TEXT_PATH) await downloadSource(sourcePath);
  const source = await readFile(sourcePath);
  assert.equal(source.length, 2_663_455, "真实原文大小与冻结值不一致");
  assert.equal(hash(source), SOURCE_SHA256, "真实原文 SHA-256 与冻结值不一致");

  app = buildApp({ dataRoot, logger: false });
  const imported = await app.inject({
    method: "POST",
    url: "/api/books/import",
    headers: { "content-type": "text/plain", "x-file-name": encodeURIComponent("红楼梦.txt") },
    payload: createReadStream(sourcePath),
  });
  assert.equal(imported.statusCode, 201, `真实原文导入失败：${imported.body}`);
  const bookId = imported.json().book.id as string;

  const chaptersResponse = await app.inject({
    method: "GET",
    url: `/api/books/${bookId}/chapters?limit=100&offset=0`,
  });
  assert.equal(chaptersResponse.statusCode, 200, `章节查询失败：${chaptersResponse.body}`);
  const tasks = eventTasks(source, chaptersResponse.json().items as ChapterRow[]);
  const sourceEventIds: string[] = [];
  for (const task of tasks) {
    const response: { statusCode: number; body: string; json(): any } = await app.inject({
      method: "PUT",
      url: `/api/books/${bookId}/chapters/${task.chapter.id}/events`,
      payload: { events: task.events },
    });
    assert.equal(response.statusCode, 200, `真实章节事件写入失败：${response.body}`);
    sourceEventIds.push(...(response.json().items as Array<{ id: string }>).map((item) => item.id));
  }
  assert.equal(new Set(sourceEventIds).size, 6, "三章必须形成六个不重复事件");

  const seriesResponse = await app.inject({
    method: "POST",
    url: `/api/books/${bookId}/series`,
    payload: { title: "红楼梦视觉说书" },
  });
  assert.equal(seriesResponse.statusCode, 201, `系列建立失败：${seriesResponse.body}`);
  const seriesId = seriesResponse.json().series.id as string;
  const episodeBody = {
    title: "甄士隐梦幻识通灵",
    storyArc: "从通灵宝玉降世到黛玉初入荣国府，建立人物、因果与家族悬念。",
    targetDurationSeconds: 240,
    recap: "顽石入世，甄士隐与贾雨村的命运由此展开。",
    nextHook: "黛玉进入荣国府后，将遇见怎样的贾府众人？",
    sourceEventIds,
  };
  const episodeResponse = await app.inject({
    method: "PUT",
    url: `/api/series/${seriesId}/episodes/1`,
    payload: episodeBody,
  });
  assert.equal(episodeResponse.statusCode, 200, `分集建立失败：${episodeResponse.body}`);

  await app.close();
  app = buildApp({ dataRoot, logger: false });

  const seriesList = await app.inject({ method: "GET", url: `/api/books/${bookId}/series` });
  assert.equal(seriesList.statusCode, 200, `重启后系列查询失败：${seriesList.body}`);
  assert.equal(seriesList.json().items.length, 1, "重启后必须只存在一个系列");

  const getEpisode = async () => {
    const response = await app!.inject({ method: "GET", url: `/api/series/${seriesId}/episodes/1` });
    assert.equal(response.statusCode, 200, `重启后分集查询失败：${response.body}`);
    return response.json().episode as { index: number; sources: EpisodeSource[] };
  };
  const episode = await getEpisode() as { id: string; index: number; sources: EpisodeSource[] };
  assert.equal(episode.index, 1);
  assert.equal(episode.sources.length, 6, "分集必须保存六份独立证据快照");
  assert.deepEqual(new Set(episode.sources.map((item) => item.sourceEventId)), new Set(sourceEventIds));
  assert.deepEqual(
    new Set(episode.sources.map((item) => item.chapterId)),
    new Set(tasks.map((task) => task.chapter.id)),
    "证据快照必须归属选定的三章",
  );
  for (const item of episode.sources) {
    const bytes = source.subarray(item.byteStart, item.byteEnd);
    assert.equal(hash(bytes), item.sourceHash, `证据快照哈希不一致：${item.sourceEventId}`);
    assert.equal(bytes.toString("utf8"), item.sourceText, `证据快照文本不一致：${item.sourceEventId}`);
  }

  const beforeRepeat = JSON.stringify(episode.sources);
  const repeated = await app.inject({
    method: "PUT",
    url: `/api/series/${seriesId}/episodes/1`,
    payload: episodeBody,
  });
  assert.equal(repeated.statusCode, 200, `重复保存分集失败：${repeated.body}`);
  assert.equal(JSON.stringify((await getEpisode()).sources), beforeRepeat, "重复 PUT 不得复制或改写证据快照");

  const scriptsUrl = `/api/series/${seriesId}/episodes/1/scripts`;
  const faithfulV1Body = {
    kind: "faithful",
    paragraphs: [
      {
        text: "故事先从甄士隱的梦境说起。梦中出现的通灵之物并非寻常器物，它来自一块经历漫长岁月的顽石。原文用梦幻识通灵打开叙事，也把这块顽石的来历写得明确：它本在天地之间，后来才有机会进入人世。甄士隱的所见不是孤立奇谈，而是整段故事的入口，提醒读者此后人物的相遇、离散与家族的盛衰，都和这段超尘因缘相连。", sourceIndexes: [0, 1],
      },
      {
        text: "顽石的数量与来历在原文中留下了清楚标记，这让梦境并不只是模糊象征。甄士隱识得通灵，也等于替读者第一次看见故事背后的线索。首章把神异的开端放在人间生活之前，使后来发生的每一次偶遇都带有因缘色彩。忠实讲述这一段时，不能把顽石改成别的宝物，也不能省掉甄士隱梦中识得它的事实，因为这正是后续人物命运能够被串起的起点。", sourceIndexes: [0, 1],
      },
      {
        text: "故事进入人间后，一次看似偶然的回望带来了真正的因果。原文直说，正因为偶然一顾，才弄出后面这段事来。这里没有把变化归结为凭空出现的巧合，而是给出了可以追溯的原因和结果：一个短暂动作触发了一连串关系。人物当时未必知道后果，读者却已经被告知，这次相遇会改变他们接下来的路，也会把个人遭际逐渐牵引到更大的家族故事中。", sourceIndexes: [2],
      },
      {
        text: "与此同时，关于贾府的悬念已经被提前提出。原文没有直接宣布它将兴或将衰，而是留下欲知目下兴衰、须问旁观冷眼人的提示。这个提示把叙事视角拉远：府中人身处繁华，旁观者却可能更早看见变化。因果线和兴衰线在这里并行，一边是人物偶然一顾造成的具体事件，一边是整个家族尚未揭开的命运，两条线共同把读者带向荣国府。", sourceIndexes: [2, 3],
      },
      {
        text: "第三章把目光转向黛玉。她不是随意游历，而是在现实处境中前往外祖母家，依傍外祖母以及舅氏姊妹。原文给出的去向很具体，因此改编不能把这次出发说成主动追求富贵，也不能凭空增加别的动机。对黛玉而言，这既是一次投亲，也是生活环境的彻底变化；对整个故事而言，她将从原来的生活进入贾府中心，与此前铺下的兴衰悬念发生联系。", sourceIndexes: [4],
      },
      {
        text: "抵达之后，黛玉面对的不是一个抽象的大家族名称，而是可以辨认的荣国府。原文以行进中的观察确认方是荣国府了，让空间转换真正落地。门第、规矩和陌生亲族都在这道边界之后等待她。镜头如果停在府门之前，观众应当明白：甄士隱梦中出现的通灵线索、偶然一顾造成的因果、旁观者提示的家族兴衰，如今都将随着黛玉踏入荣国府而汇到同一处。", sourceIndexes: [3, 4, 5],
      },
      {
        text: "把三章连在一起，可以得到一条不越过原文证据的故事弧：顽石以通灵之物的身份进入叙事，甄士隱在梦中首先识得它；人间的一次偶然回望引出后续因果；贾府的兴衰被冷眼旁观者预先设问；黛玉则因投亲来到荣国府。每一步都有原文范围作支点，没有把尚未发生的情节提前当成事实，也没有改变人物此时已经明确的行动与去向。", sourceIndexes: [0, 1, 2, 3, 4, 5],
      },
      {
        text: "这一集的结尾停在黛玉进入荣国府的门槛上最为合适。前面的神异开端告诉我们，故事并非只有眼前生活；中间的因果与兴衰提示又说明，繁华之下已经存在值得追问的线索；最后，黛玉的到来把一个新的观察者送进家族内部。下一步要看的，不是凭空编造的冲突，而是她在荣国府中将遇见哪些人，又会怎样亲眼看见这个家族的日常与命运。", sourceIndexes: [0, 2, 3, 4, 5],
      },
    ],
  } as const;
  const createScript = async (body: object) => {
    const response = await app!.inject({ method: "POST", url: scriptsUrl, payload: body });
    assert.equal(response.statusCode, 201, `稿件版本创建失败：${response.body}`);
    return response.json().script as ScriptVersion;
  };
  const faithfulV1 = await createScript(faithfulV1Body);
  const packagedV1 = await createScript({
    kind: "packaged",
    parentVersionId: faithfulV1.id,
    paragraphs: [
      {
        text: "一块顽石，为什么会和荣国府里无数人的命运连在一起？故事没有从高门大宅直接讲起，而是先让甄士隱做了一场梦。梦中，他识得通灵之物，也看见那块经历漫长岁月的顽石获得入世的机会。这个开端不是可以随意替换的奇观，它告诉我们：眼前即将展开的人间故事，背后还藏着一条更长的因缘线。", sourceIndexes: [0, 1],
      },
      {
        text: "甄士隱梦幻识通灵，是读者第一次接触这条线索。顽石并非突然从荣国府中出现，它有被原文明确标记的来历。包装讲述可以加快节奏，却不能改变这个事实。于是我们先记住两件事：甄士隱在梦中看见了它，它也将从天地之间走入人世。等人物真正相遇时，这场梦就不再只是开篇的神异插曲，而会成为回看一切的起点。", sourceIndexes: [0, 1],
      },
      {
        text: "真正推动人间故事的，却可能只是一个极小的动作。原文说，因为偶然一顾，便弄出这段事来。一次回望看起来轻得不能再轻，结果却把陌生人的道路接在一起。这里最重要的不是夸大巧合，而是看清已经写明的因果：人物做出了动作，后续事件由此发生。命运并不是从天而降，它常常借一个当时无人重视的瞬间悄悄转向。", sourceIndexes: [2],
      },
      {
        text: "当个人因果刚刚启动，贾府的命运也被提前放在读者面前。原文留下了一句耐人寻味的提醒：若要知道目下兴衰，要去问旁观的冷眼人。府里也许仍是盛景，旁观者却可能已经看见不同的征兆。为什么要由旁观者回答？因为身在繁华中的人，往往最难察觉变化。这道悬念没有给出结论，却让我们带着问题走向荣国府。", sourceIndexes: [2, 3],
      },
      {
        text: "就在这时，黛玉的人生也来到转折处。她要依傍外祖母和舅氏姊妹，离开原来的生活，前往一个熟悉于名声、陌生于日常的家族。她的动机在原文中非常清楚：这是投亲，是现实处境下的去向，不是为了追逐虚构出来的目标。对黛玉来说，前方既有亲人，也有规矩和未知；对观众来说，她将成为我们进入贾府内部的一双眼睛。", sourceIndexes: [4],
      },
      {
        text: "车马继续向前，真正的空间边界终于出现。黛玉确认，眼前方是荣国府。直到这一刻，前面三条线才开始汇合：梦中的通灵顽石，为故事留下超越日常的来历；偶然一顾，引出具体的人间因果；冷眼旁观者，则让贾府的兴衰成为尚待回答的问题。如今黛玉站在府门之前，她即将走进去，也即将亲身进入这些线索交织的地方。", sourceIndexes: [0, 2, 3, 4, 5],
      },
      {
        text: "所以，这一集讲的并不是几段彼此无关的旧事。它讲的是一条逐渐收紧的路径：从顽石入世，到甄士隱梦中识得通灵；从一次偶然回望，到因果真正发生；从旁观者提出兴衰之问，到黛玉投亲并抵达荣国府。每一步都能回到原文中的人物、动作、地点或提示。我们没有提前宣布贾府的结局，只知道关于它的疑问已经出现。", sourceIndexes: [0, 1, 2, 3, 4, 5],
      },
      {
        text: "府门已经打开，但黛玉尚未看清门内的一切。她会先遇见谁，会怎样理解这里的亲疏与规矩，又会从哪些细节感受到旁观者所说的兴衰征兆？这些问题要留给下一段故事回答。此刻只需记住：一个从梦幻中出现的通灵线索，一次改变人物道路的偶然回望，一句关于家族命运的冷眼提醒，以及一个走进荣国府的少女，已经在同一条叙事线上相遇。", sourceIndexes: [0, 2, 3, 4, 5],
      },
    ],
  });
  const approvedNarrationCharacters = narrationCharacters(packagedV1.paragraphs);
  const estimatedNarrationSeconds = approvedNarrationCharacters / 4;
  assert(
    estimatedNarrationSeconds >= 180 && estimatedNarrationSeconds <= 300,
    `批准稿按每秒 4 字估算必须落在 3～5 分钟，实际 ${estimatedNarrationSeconds.toFixed(2)} 秒`,
  );
  const faithfulV2 = await createScript({
    kind: "faithful",
    paragraphs: [
      { text: "甄士隱梦遇通灵顽石，顽石入世的因缘由此显现。", sourceIndexes: [0, 1] },
      { text: "贾府的兴衰藏在因果与冷眼旁观者的预言之中。", sourceIndexes: [2, 3] },
      { text: "黛玉依傍外祖母，来到荣国府，走入家族命运的中心。", sourceIndexes: [4, 5] },
    ],
  });
  const repeatedFaithfulV1 = await createScript(faithfulV1Body);
  assert.equal(repeatedFaithfulV1.id, faithfulV1.id, "重复 POST 忠实稿 v1 必须幂等复用原版本");
  assert.equal(repeatedFaithfulV1.contentHash, faithfulV1.contentHash, "幂等稿件的内容哈希不得变化");

  assert.equal(faithfulV1.versionNumber, 1);
  assert.equal(packagedV1.versionNumber, 1);
  assert.equal(faithfulV2.versionNumber, 2);
  assert.equal(faithfulV1.parentVersionId, null);
  assert.equal(packagedV1.parentVersionId, faithfulV1.id);
  assert.equal(faithfulV2.parentVersionId, null);
  const createdScripts = new Map([faithfulV1, packagedV1, faithfulV2].map((script) => [script.id, script]));

  let productionSideEffects = 0;
  const probeProduction = (purpose: "tts" | "image") => {
    const connection = openDatabase(dataRoot);
    try {
      const permit = requireApprovedScriptForProduction(connection.database, episode.id, purpose);
      productionSideEffects += 1;
      return permit;
    } finally {
      connection.close();
    }
  };
  expectProductionBlocked(() => probeProduction("tts"));
  expectProductionBlocked(() => probeProduction("image"));
  assert.equal(productionSideEffects, 0, "未批准时不得触发任何生产副作用");

  const approvalUrl = `/api/series/${seriesId}/episodes/1/approval`;
  const approvedResponse = await app.inject({
    method: "PUT",
    url: approvalUrl,
    payload: { action: "approve", expectedRevision: 0, scriptVersionId: packagedV1.id },
  });
  assert.equal(approvedResponse.statusCode, 200, `人工批准失败：${approvedResponse.body}`);
  const ttsPermit = probeProduction("tts");
  const imagePermit = probeProduction("image");
  assert.equal(ttsPermit.scriptVersionId, packagedV1.id);
  assert.equal(ttsPermit.contentHash, packagedV1.contentHash);
  assert.deepEqual(imagePermit, ttsPermit);
  assert.equal(productionSideEffects, 2, "批准后语音与图片生产探针应各通过一次");

  const withdrawnResponse = await app.inject({
    method: "PUT",
    url: approvalUrl,
    payload: { action: "withdraw", expectedRevision: 1 },
  });
  assert.equal(withdrawnResponse.statusCode, 200, `撤回批准失败：${withdrawnResponse.body}`);
  expectProductionBlocked(() => probeProduction("tts"));
  expectProductionBlocked(() => probeProduction("image"));
  assert.equal(productionSideEffects, 2, "撤回后不得继续触发生产副作用");
  const reapprovedResponse = await app.inject({
    method: "PUT",
    url: approvalUrl,
    payload: { action: "approve", expectedRevision: 2, scriptVersionId: packagedV1.id },
  });
  assert.equal(reapprovedResponse.statusCode, 200, `重新批准失败：${reapprovedResponse.body}`);
  assert.equal(reapprovedResponse.json().approval.revision, 3);

  await app.close();
  app = buildApp({ dataRoot, logger: false });
  const scriptsResponse = await app.inject({ method: "GET", url: scriptsUrl });
  assert.equal(scriptsResponse.statusCode, 200, `重启后稿件版本查询失败：${scriptsResponse.body}`);
  const scripts = scriptsResponse.json().items as ScriptVersion[];
  assert.equal(scripts.length, 3, "幂等提交后必须只保留三个不可变稿件版本");
  const episodeSources = new Map(episode.sources.map((item) => [item.sourceIndex, item]));
  for (const script of scripts) {
    const created = createdScripts.get(script.id);
    assert(created, `重启后出现未知稿件版本：${script.id}`);
    assert.equal(script.contentHash, created.contentHash, `重启后旧稿哈希变化：${script.id}`);
    assert.equal(JSON.stringify(script.paragraphs), JSON.stringify(created.paragraphs), `重启后旧稿内容变化：${script.id}`);
    assert.equal(script.parentVersionId, created.parentVersionId, `重启后稿件父链变化：${script.id}`);
    for (const paragraph of script.paragraphs) {
      assert(paragraph.text.length > 0, `稿件段落文本不能为空：${script.id}`);
      assert(paragraph.sources.length > 0, `稿件段落必须保留来源快照：${script.id}`);
      for (const snapshot of paragraph.sources) {
        const episodeSource = episodeSources.get(snapshot.episodeSourceIndex);
        assert(episodeSource, `稿件引用未知分集来源：${snapshot.episodeSourceIndex}`);
        assert.deepEqual(
          snapshot,
          {
            episodeSourceIndex: episodeSource.sourceIndex,
            chapterId: episodeSource.chapterId,
            sourceEventId: episodeSource.sourceEventId,
            byteStart: episodeSource.byteStart,
            byteEnd: episodeSource.byteEnd,
            sourceHash: episodeSource.sourceHash,
          },
          `稿件来源快照与分集证据不一致：${script.id}`,
        );
        assert.equal(
          hash(source.subarray(snapshot.byteStart, snapshot.byteEnd)),
          snapshot.sourceHash,
          `稿件来源原文字节哈希不一致：${script.id}`,
        );
      }
    }
  }
  const restartedApproval = await app.inject({ method: "GET", url: approvalUrl });
  assert.equal(restartedApproval.statusCode, 200, `重启后批准状态查询失败：${restartedApproval.body}`);
  assert.equal(restartedApproval.json().approval.status, "approved");
  assert.equal(restartedApproval.json().approval.revision, 3);
  assert.equal(restartedApproval.json().approval.scriptVersionId, packagedV1.id);
  assert.equal(probeProduction("tts").scriptVersionId, packagedV1.id);
  assert.equal(productionSideEffects, 3, "重启后只能放行最终重新批准的包装稿");

  process.stdout.write(`${JSON.stringify({
    ok: true,
    source_bytes: source.length,
    source_sha256: hash(source),
    chapters: tasks.length,
    source_events: sourceEventIds.length,
    episode_index: episode.index,
    evidence_snapshots: episode.sources.length,
    restart_query: true,
    idempotent_put: true,
    script_versions: scripts.length,
    idempotent_script_post: true,
    script_restart_query: true,
    approval_revision: restartedApproval.json().approval.revision,
    production_guard: true,
    production_side_effects: productionSideEffects,
    approved_script_characters: approvedNarrationCharacters,
    estimated_narration_seconds: estimatedNarrationSeconds,
    data_root: dataRoot,
    book_id: bookId,
    series_id: seriesId,
    episode_id: episode.id,
    approved_script_version_id: packagedV1.id,
    approved_script_content_hash: packagedV1.contentHash,
  }, null, 2)}\n`);
} finally {
  if (app) await app.close();
  await rm(root, { recursive: true, force: true });
}
