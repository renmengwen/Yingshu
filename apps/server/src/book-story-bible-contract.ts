export const BOOK_STORY_BIBLE_CONTRACT_VERSION = "book-story-bible-v1";

const MAX_NAME_LENGTH = 200;
const MAX_TEXT_LENGTH = 2_000;
const MAX_LIST_ITEMS = 100;
const MAX_FACTS_PER_SECTION = 2_000;
const MAX_TOTAL_FACTS = 5_000;
const MAX_SOURCE_EVENTS_PER_FACT = 100;
const MAX_CANONICAL_BYTES = 8 * 1024 * 1024;

export interface SourcedTextFact {
  text: string;
  sourceEventIds: string[];
}

export interface CharacterStateFact {
  state: string;
  chapterIds: string[];
  sourceEventIds: string[];
}

export interface CharacterFact {
  canonicalName: string;
  aliases: string[];
  identities: SourcedTextFact[];
  motivations: SourcedTextFact[];
  stateChanges: CharacterStateFact[];
  sourceEventIds: string[];
}

export interface RelationshipFact {
  subject: string;
  object: string;
  relation: string;
  chapterIds: string[];
  sourceEventIds: string[];
}

export interface NamedFact {
  name: string;
  aliases: string[];
  detail: string;
  sourceEventIds: string[];
}

export interface TimelineFact {
  summary: string;
  chapterIds: string[];
  sourceEventIds: string[];
}

export interface FlashbackFact {
  summary: string;
  startChapterId: string;
  endChapterId: string;
  sourceEventIds: string[];
}

export type PlotThreadKind = "foreshadowing" | "suspense" | "revelation";

export interface PlotThreadFact {
  kind: PlotThreadKind;
  setup: string;
  revealCondition: string | null;
  resolution: string | null;
  chapterIds: string[];
  sourceEventIds: string[];
}

export interface ConfusingFact {
  statement: string;
  clarification: string;
  sourceEventIds: string[];
}

export interface SpoilerRestrictionFact {
  information: string;
  forbiddenUntil: string;
  sourceEventIds: string[];
}

export interface ProperNounFact {
  term: string;
  pronunciation: string;
  aliases: string[];
  sourceEventIds: string[];
}

export interface BookStoryBibleContent {
  characters: CharacterFact[];
  relationships: RelationshipFact[];
  locations: NamedFact[];
  organizations: NamedFact[];
  items: NamedFact[];
  concepts: NamedFact[];
  timeline: TimelineFact[];
  flashbacks: FlashbackFact[];
  plotThreads: PlotThreadFact[];
  confusingFacts: ConfusingFact[];
  spoilerRestrictions: SpoilerRestrictionFact[];
  properNouns: ProperNounFact[];
}

export class BookStoryBibleContractError extends Error {}

interface ParseContext {
  allowedSourceEventIds: ReadonlySet<string>;
  facts: number;
}

function object(value: unknown, label: string, keys: readonly string[]) {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) {
    throw new BookStoryBibleContractError(`${label}必须是普通对象`);
  }
  const record = value as Record<string, unknown>;
  const unknown = Object.keys(record).filter((key) => !keys.includes(key));
  if (unknown.length) throw new BookStoryBibleContractError(`${label}包含未知字段：${unknown.sort().join("、")}`);
  return record;
}

function text(value: unknown, label: string, maximum = MAX_TEXT_LENGTH) {
  if (typeof value !== "string") throw new BookStoryBibleContractError(`${label}必须是字符串`);
  const normalized = value.replace(/\r\n?/gu, "\n").trim();
  if (!normalized || normalized.length > maximum) {
    throw new BookStoryBibleContractError(`${label}长度必须在 1～${maximum} 个字符之间`);
  }
  return normalized;
}

function list(value: unknown, label: string, minimum: number, maximum: number) {
  if (!Array.isArray(value) || value.length < minimum || value.length > maximum) {
    throw new BookStoryBibleContractError(`${label}必须包含 ${minimum}～${maximum} 项`);
  }
  return value;
}

function stringList(value: unknown, label: string, minimum = 0, sort = false) {
  const normalized = list(value, label, minimum, MAX_LIST_ITEMS)
    .map((item) => text(item, label, MAX_NAME_LENGTH));
  if (new Set(normalized).size !== normalized.length) {
    throw new BookStoryBibleContractError(`${label}不能包含重复项`);
  }
  return sort ? normalized.sort((left, right) => left.localeCompare(right)) : normalized;
}

function sources(value: unknown, label: string, context: ParseContext) {
  const ids = list(value, `${label}.sourceEventIds`, 1, MAX_SOURCE_EVENTS_PER_FACT)
    .map((item) => text(item, `${label}.sourceEventIds`, MAX_NAME_LENGTH));
  if (new Set(ids).size !== ids.length) {
    throw new BookStoryBibleContractError(`${label}.sourceEventIds 不能重复引用同一事件`);
  }
  for (const id of ids) {
    if (!context.allowedSourceEventIds.has(id)) {
      throw new BookStoryBibleContractError(`${label}.sourceEventIds 引用了未获准事件：${id}`);
    }
  }
  return ids.sort((left, right) => left.localeCompare(right));
}

function fact(context: ParseContext, label: string) {
  context.facts += 1;
  if (context.facts > MAX_TOTAL_FACTS) {
    throw new BookStoryBibleContractError(`${label}使全书世界观事实总数超过 ${MAX_TOTAL_FACTS}`);
  }
}

function facts<T>(value: unknown, label: string, context: ParseContext, parse: (item: unknown, itemLabel: string) => T) {
  return list(value, label, 0, MAX_FACTS_PER_SECTION).map((item, index) => {
    const itemLabel = `${label}[${index}]`;
    fact(context, itemLabel);
    return parse(item, itemLabel);
  });
}

function sourcedTexts(value: unknown, label: string, context: ParseContext) {
  return facts(value, label, context, (item, itemLabel): SourcedTextFact => {
    const row = object(item, itemLabel, ["text", "sourceEventIds"]);
    return { text: text(row.text, `${itemLabel}.text`), sourceEventIds: sources(row.sourceEventIds, itemLabel, context) };
  });
}

function namedFacts(value: unknown, label: string, context: ParseContext) {
  return facts(value, label, context, (item, itemLabel): NamedFact => {
    const row = object(item, itemLabel, ["name", "aliases", "detail", "sourceEventIds"]);
    return {
      name: text(row.name, `${itemLabel}.name`, MAX_NAME_LENGTH),
      aliases: stringList(row.aliases, `${itemLabel}.aliases`, 0, true),
      detail: text(row.detail, `${itemLabel}.detail`),
      sourceEventIds: sources(row.sourceEventIds, itemLabel, context),
    };
  });
}

function nullableText(value: unknown, label: string) {
  return value === null ? null : text(value, label);
}

export function parseBookStoryBibleContent(
  value: unknown,
  allowedSourceEventIds: ReadonlySet<string>,
): BookStoryBibleContent {
  if (!(allowedSourceEventIds instanceof Set) || allowedSourceEventIds.size === 0 ||
      [...allowedSourceEventIds].some((id) => typeof id !== "string" || !id.trim() || id.length > MAX_NAME_LENGTH)) {
    throw new BookStoryBibleContractError("来源事件白名单无效");
  }
  const keys = [
    "characters", "relationships", "locations", "organizations", "items", "concepts", "timeline", "flashbacks",
    "plotThreads", "confusingFacts", "spoilerRestrictions", "properNouns",
  ] as const;
  const body = object(value, "全书世界观", keys);
  const context: ParseContext = { allowedSourceEventIds, facts: 0 };
  const content: BookStoryBibleContent = {
    characters: facts(body.characters, "characters", context, (item, label): CharacterFact => {
      const row = object(item, label, [
        "canonicalName", "aliases", "identities", "motivations", "stateChanges", "sourceEventIds",
      ]);
      return {
        canonicalName: text(row.canonicalName, `${label}.canonicalName`, MAX_NAME_LENGTH),
        aliases: stringList(row.aliases, `${label}.aliases`, 0, true),
        identities: sourcedTexts(row.identities, `${label}.identities`, context),
        motivations: sourcedTexts(row.motivations, `${label}.motivations`, context),
        stateChanges: facts(row.stateChanges, `${label}.stateChanges`, context, (change, changeLabel): CharacterStateFact => {
          const state = object(change, changeLabel, ["state", "chapterIds", "sourceEventIds"]);
          return {
            state: text(state.state, `${changeLabel}.state`),
            chapterIds: stringList(state.chapterIds, `${changeLabel}.chapterIds`, 1),
            sourceEventIds: sources(state.sourceEventIds, changeLabel, context),
          };
        }),
        sourceEventIds: sources(row.sourceEventIds, label, context),
      };
    }),
    relationships: facts(body.relationships, "relationships", context, (item, label): RelationshipFact => {
      const row = object(item, label, ["subject", "object", "relation", "chapterIds", "sourceEventIds"]);
      return {
        subject: text(row.subject, `${label}.subject`, MAX_NAME_LENGTH),
        object: text(row.object, `${label}.object`, MAX_NAME_LENGTH),
        relation: text(row.relation, `${label}.relation`),
        chapterIds: stringList(row.chapterIds, `${label}.chapterIds`, 1),
        sourceEventIds: sources(row.sourceEventIds, label, context),
      };
    }),
    locations: namedFacts(body.locations, "locations", context),
    organizations: namedFacts(body.organizations, "organizations", context),
    items: namedFacts(body.items, "items", context),
    concepts: namedFacts(body.concepts, "concepts", context),
    timeline: facts(body.timeline, "timeline", context, (item, label): TimelineFact => {
      const row = object(item, label, ["summary", "chapterIds", "sourceEventIds"]);
      return {
        summary: text(row.summary, `${label}.summary`),
        chapterIds: stringList(row.chapterIds, `${label}.chapterIds`, 1),
        sourceEventIds: sources(row.sourceEventIds, label, context),
      };
    }),
    flashbacks: facts(body.flashbacks, "flashbacks", context, (item, label): FlashbackFact => {
      const row = object(item, label, ["summary", "startChapterId", "endChapterId", "sourceEventIds"]);
      return {
        summary: text(row.summary, `${label}.summary`),
        startChapterId: text(row.startChapterId, `${label}.startChapterId`, MAX_NAME_LENGTH),
        endChapterId: text(row.endChapterId, `${label}.endChapterId`, MAX_NAME_LENGTH),
        sourceEventIds: sources(row.sourceEventIds, label, context),
      };
    }),
    plotThreads: facts(body.plotThreads, "plotThreads", context, (item, label): PlotThreadFact => {
      const row = object(item, label, [
        "kind", "setup", "revealCondition", "resolution", "chapterIds", "sourceEventIds",
      ]);
      if (row.kind !== "foreshadowing" && row.kind !== "suspense" && row.kind !== "revelation") {
        throw new BookStoryBibleContractError(`${label}.kind 无效`);
      }
      return {
        kind: row.kind,
        setup: text(row.setup, `${label}.setup`),
        revealCondition: nullableText(row.revealCondition, `${label}.revealCondition`),
        resolution: nullableText(row.resolution, `${label}.resolution`),
        chapterIds: stringList(row.chapterIds, `${label}.chapterIds`, 1),
        sourceEventIds: sources(row.sourceEventIds, label, context),
      };
    }),
    confusingFacts: facts(body.confusingFacts, "confusingFacts", context, (item, label): ConfusingFact => {
      const row = object(item, label, ["statement", "clarification", "sourceEventIds"]);
      return {
        statement: text(row.statement, `${label}.statement`),
        clarification: text(row.clarification, `${label}.clarification`),
        sourceEventIds: sources(row.sourceEventIds, label, context),
      };
    }),
    spoilerRestrictions: facts(body.spoilerRestrictions, "spoilerRestrictions", context, (item, label): SpoilerRestrictionFact => {
      const row = object(item, label, ["information", "forbiddenUntil", "sourceEventIds"]);
      return {
        information: text(row.information, `${label}.information`),
        forbiddenUntil: text(row.forbiddenUntil, `${label}.forbiddenUntil`),
        sourceEventIds: sources(row.sourceEventIds, label, context),
      };
    }),
    properNouns: facts(body.properNouns, "properNouns", context, (item, label): ProperNounFact => {
      const row = object(item, label, ["term", "pronunciation", "aliases", "sourceEventIds"]);
      return {
        term: text(row.term, `${label}.term`, MAX_NAME_LENGTH),
        pronunciation: text(row.pronunciation, `${label}.pronunciation`, MAX_NAME_LENGTH),
        aliases: stringList(row.aliases, `${label}.aliases`, 0, true),
        sourceEventIds: sources(row.sourceEventIds, label, context),
      };
    }),
  };
  if (context.facts === 0) throw new BookStoryBibleContractError("全书世界观必须包含至少一条事实");
  if (Buffer.byteLength(canonicalBookStoryBibleJson(content), "utf8") > MAX_CANONICAL_BYTES) {
    throw new BookStoryBibleContractError(`全书世界观规范化内容不能超过 ${MAX_CANONICAL_BYTES} 字节`);
  }
  return content;
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number" && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype) {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => `${JSON.stringify(key)}:${canonicalJson(child)}`).join(",")}}`;
  }
  throw new BookStoryBibleContractError("全书世界观必须是可序列化 JSON");
}

export function canonicalBookStoryBibleJson(content: BookStoryBibleContent) {
  return canonicalJson(content);
}
