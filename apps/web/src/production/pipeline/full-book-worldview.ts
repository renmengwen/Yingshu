import { responseJson } from "../../client-logic";

interface SourceRef { chapterIds: string[]; sourceEventIds: string[] }
interface TextFact { text: string; sourceEventIds: string[] }
interface StateFact extends SourceRef { state: string }
interface NamedFact { name: string; aliases: string[]; detail: string; sourceEventIds: string[] }

export interface FullBookWorldviewContent {
  characters: Array<{
    canonicalName: string; aliases: string[]; identities: TextFact[]; motivations: TextFact[];
    stateChanges: StateFact[]; sourceEventIds: string[];
  }>;
  relationships: Array<SourceRef & { subject: string; object: string; relation: string }>;
  locations: NamedFact[];
  organizations: NamedFact[];
  items: NamedFact[];
  concepts: NamedFact[];
  timeline: Array<SourceRef & { summary: string }>;
  flashbacks: Array<{ summary: string; startChapterId: string; endChapterId: string; sourceEventIds: string[] }>;
  plotThreads: Array<SourceRef & {
    kind: "foreshadowing" | "suspense" | "revelation";
    setup: string; revealCondition: string | null; resolution: string | null;
  }>;
  confusingFacts: Array<{ statement: string; clarification: string; sourceEventIds: string[] }>;
  spoilerRestrictions: Array<{ information: string; forbiddenUntil: string; sourceEventIds: string[] }>;
  properNouns: Array<{ term: string; pronunciation: string; aliases: string[]; sourceEventIds: string[] }>;
}

export interface FullBookWorldview {
  content: FullBookWorldviewContent;
  metadata: {
    revision: number; contentHash: string; provider: string; model: string;
    sourceStartChapterId: string; sourceEndChapterId: string; createdAt: number;
  };
}

export interface WorldviewDetail extends SourceRef { label?: string; text: string }
export interface WorldviewEntry { title: string; details: WorldviewDetail[] }
export interface WorldviewSection { key: keyof FullBookWorldviewContent; label: string; entries: WorldviewEntry[] }

const noChapters: string[] = [];
const detail = (text: string, sourceEventIds: string[], chapterIds = noChapters, label?: string): WorldviewDetail =>
  ({ text, sourceEventIds, chapterIds, label });
const aliases = (value: string[]) => value.length ? `别名：${value.join("、")}` : "";

export function mapFullBookWorldview(content: FullBookWorldviewContent): WorldviewSection[] {
  const named = (items: NamedFact[]) => items.map((item) => ({
    title: item.name,
    details: [detail([aliases(item.aliases), item.detail].filter(Boolean).join("；"), item.sourceEventIds)],
  }));
  return [
    { key: "characters", label: "人物", entries: content.characters.map((item) => ({
      title: item.canonicalName,
      details: [
        aliases(item.aliases) ? detail(aliases(item.aliases), item.sourceEventIds) : null,
        ...item.identities.map((fact) => detail(fact.text, fact.sourceEventIds, noChapters, "身份")),
        ...item.motivations.map((fact) => detail(fact.text, fact.sourceEventIds, noChapters, "动机")),
        ...item.stateChanges.map((fact) => detail(fact.state, fact.sourceEventIds, fact.chapterIds, "状态变化")),
      ].filter((item): item is WorldviewDetail => item !== null),
    })) },
    { key: "relationships", label: "关系", entries: content.relationships.map((item) => ({
      title: `${item.subject}与${item.object}`,
      details: [detail(item.relation, item.sourceEventIds, item.chapterIds)],
    })) },
    { key: "locations", label: "地点", entries: named(content.locations) },
    { key: "organizations", label: "组织", entries: named(content.organizations) },
    { key: "items", label: "器物", entries: named(content.items) },
    { key: "concepts", label: "概念", entries: named(content.concepts) },
    { key: "timeline", label: "时间线", entries: content.timeline.map((item, index) => ({
      title: `时间线 ${index + 1}`,
      details: [detail(item.summary, item.sourceEventIds, item.chapterIds)],
    })) },
    { key: "flashbacks", label: "回忆", entries: content.flashbacks.map((item, index) => ({
      title: `回忆 ${index + 1}`,
      details: [detail(item.summary, item.sourceEventIds, [item.startChapterId, item.endChapterId])],
    })) },
    { key: "plotThreads", label: "情节线", entries: content.plotThreads.map((item, index) => ({
      title: `${{ foreshadowing: "伏笔", suspense: "悬念", revelation: "揭示" }[item.kind]} ${index + 1}`,
      details: [
        detail(item.setup, item.sourceEventIds, item.chapterIds, "铺设"),
        item.revealCondition ? detail(item.revealCondition, item.sourceEventIds, item.chapterIds, "揭示条件") : null,
        item.resolution ? detail(item.resolution, item.sourceEventIds, item.chapterIds, "结果") : null,
      ].filter((value): value is WorldviewDetail => value !== null),
    })) },
    { key: "confusingFacts", label: "疑难事实", entries: content.confusingFacts.map((item, index) => ({
      title: `疑难事实 ${index + 1}`,
      details: [detail(`${item.statement}；说明：${item.clarification}`, item.sourceEventIds)],
    })) },
    { key: "spoilerRestrictions", label: "剧透限制", entries: content.spoilerRestrictions.map((item, index) => ({
      title: `剧透限制 ${index + 1}`,
      details: [detail(`${item.information}；限制至：${item.forbiddenUntil}`, item.sourceEventIds)],
    })) },
    { key: "properNouns", label: "专有名词", entries: content.properNouns.map((item) => ({
      title: item.term,
      details: [detail([`读音：${item.pronunciation}`, aliases(item.aliases)].filter(Boolean).join("；"), item.sourceEventIds)],
    })) },
  ];
}

export async function readFullBookWorldview(runId: string, signal: AbortSignal) {
  const response = await fetch(`/api/pipeline-runs/${encodeURIComponent(runId)}/full-book-worldview`, {
    method: "GET", signal,
  });
  return (await responseJson<{ worldview: FullBookWorldview }>(response)).worldview;
}
