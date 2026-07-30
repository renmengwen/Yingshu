import assert from "node:assert/strict";
import test from "node:test";

import {
  BOOK_STORY_BIBLE_CONTRACT_VERSION,
  canonicalBookStoryBibleJson,
  parseBookStoryBibleContent,
} from "./book-story-bible-contract.js";

const allowed = new Set(["event_a", "event_b", "event_c"]);

function validContent() {
  return {
    characters: [{
      canonicalName: " 吴邪 ", aliases: [" 小三爷 "],
      identities: [{ text: "吴家后人", sourceEventIds: ["event_a"] }],
      motivations: [{ text: "查清真相", sourceEventIds: ["event_b", "event_a"] }],
      stateChanges: [{ state: "开始怀疑三叔", chapterIds: ["chapter_2"], sourceEventIds: ["event_b"] }],
      sourceEventIds: ["event_a"],
    }],
    relationships: [{
      subject: "吴邪", object: "三叔", relation: "从信任转为怀疑", chapterIds: ["chapter_2"], sourceEventIds: ["event_b"],
    }],
    locations: [{ name: "墓道", aliases: [], detail: "主角初次遇险之处", sourceEventIds: ["event_a"] }],
    organizations: [], items: [], concepts: [],
    timeline: [{ summary: "吴邪进入墓道", chapterIds: ["chapter_1"], sourceEventIds: ["event_a"] }],
    flashbacks: [{
      summary: "三叔回忆旧案", startChapterId: "chapter_2", endChapterId: "chapter_2", sourceEventIds: ["event_b"],
    }],
    plotThreads: [{
      kind: "foreshadowing", setup: "血字留下警告", revealCondition: "身份揭晓后", resolution: null,
      chapterIds: ["chapter_2"], sourceEventIds: ["event_b"],
    }],
    confusingFacts: [{ statement: "两个称谓相似", clarification: "实际是不同人物", sourceEventIds: ["event_c"] }],
    spoilerRestrictions: [{ information: "幕后身份", forbiddenUntil: "第十章揭示事件", sourceEventIds: ["event_c"] }],
    properNouns: [{ term: "麒麟竭", pronunciation: "qí lín jié", aliases: [], sourceEventIds: ["event_c"] }],
  };
}

test("严格解析并输出稳定、可序列化的故事圣经内容", () => {
  const parsed = parseBookStoryBibleContent(validContent(), allowed);
  assert.equal(BOOK_STORY_BIBLE_CONTRACT_VERSION, "book-story-bible-v1");
  assert.equal(parsed.characters[0]?.canonicalName, "吴邪");
  assert.deepEqual(parsed.characters[0]?.motivations[0]?.sourceEventIds, ["event_a", "event_b"]);
  const canonical = canonicalBookStoryBibleJson(parsed);
  assert.equal(canonical, canonicalBookStoryBibleJson(JSON.parse(canonical)));
  assert.deepEqual(JSON.parse(canonical), parsed);
});

test("拒绝未知字段、伪造、空白和重复来源引用", () => {
  const unknown = validContent() as ReturnType<typeof validContent> & { provider?: string };
  unknown.provider = "不应进入内容合同";
  assert.throws(() => parseBookStoryBibleContent(unknown, allowed), /未知字段.*provider/);

  const forged = validContent();
  forged.characters[0]!.sourceEventIds = ["event_missing"];
  assert.throws(() => parseBookStoryBibleContent(forged, allowed), /未获准事件/);

  const duplicate = validContent();
  duplicate.characters[0]!.sourceEventIds = ["event_a", "event_a"];
  assert.throws(() => parseBookStoryBibleContent(duplicate, allowed), /不能重复引用/);

  const empty = validContent();
  empty.timeline[0]!.summary = "  ";
  assert.throws(() => parseBookStoryBibleContent(empty, allowed), /长度必须/);
});

test("拒绝空故事圣经、嵌套未知字段和字段或数组超限", () => {
  const empty = validContent();
  for (const key of Object.keys(empty) as Array<keyof typeof empty>) empty[key] = [] as never;
  assert.throws(() => parseBookStoryBibleContent(empty, allowed), /至少一条事实/);

  const nestedUnknown = validContent();
  Object.assign(nestedUnknown.characters[0]!.stateChanges[0]!, { provider: "x" });
  assert.throws(() => parseBookStoryBibleContent(nestedUnknown, allowed), /未知字段.*provider/);

  const long = validContent();
  long.locations[0]!.detail = "字".repeat(2_001);
  assert.throws(() => parseBookStoryBibleContent(long, allowed), /1～2000/);

  const tooManyAliases = validContent();
  tooManyAliases.characters[0]!.aliases = Array.from({ length: 101 }, (_, index) => `别名${index}`);
  assert.throws(() => parseBookStoryBibleContent(tooManyAliases, allowed), /0～100 项/);
});

test("每个嵌套事实都必须带非空来源且来源白名单本身有效", () => {
  const missingNestedSources = validContent();
  missingNestedSources.characters[0]!.motivations[0]!.sourceEventIds = [];
  assert.throws(() => parseBookStoryBibleContent(missingNestedSources, allowed), /必须包含 1～100 项/);
  assert.throws(() => parseBookStoryBibleContent(validContent(), new Set()), /白名单无效/);
});
