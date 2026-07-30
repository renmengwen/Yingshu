import { useEffect, useState, type FormEvent } from "react";

import type { EpisodeDurationPolicy } from "../episode/episode-editor";
import type { Chapter } from "../types";
import {
  formatPipelineDuration,
  pipelineCreateInput,
  pipelineRangeCount,
} from "./pipeline-logic";
import { adjustEpisodeBoundary, type PipelineCreateRequest } from "./pipeline-setup-logic";
import { usePipelineSetup, type BookPromptProfileContent } from "./use-pipeline-setup";

const PROFILE_FIELDS: Array<[keyof BookPromptProfileContent, string, string]> = [
  ["sharedInstructions", "全书共同要求", "适用于本书全部阶段的叙事口径、禁区或术语要求。"],
  ["chapterAnalysisInstructions", "章节分析要求", "追加本书的事件提取侧重点。"],
  ["narrationInstructions", "成片旁白要求", "追加讲述距离、语言风格和可朗读性要求。"],
  ["assetInstructions", "资产 Prompt 要求", "追加人物、场景、道具或剧情插图草稿要求。"],
];

export function PipelineSetup({ bookId, seriesId, chapters, chapterTotal, policy, loading, submitting, operation, error, onCreate }: {
  bookId: string;
  seriesId: string;
  chapters: Chapter[];
  chapterTotal: number;
  policy?: EpisodeDurationPolicy;
  loading: boolean;
  submitting: boolean;
  operation: string;
  error?: string;
  onCreate: (input: PipelineCreateRequest) => void;
}) {
  const setup = usePipelineSetup(bookId, seriesId);
  const [startId, setStartId] = useState("");
  const [endId, setEndId] = useState("");
  const [episodeCount, setEpisodeCount] = useState("");
  const [targetDurationSeconds, setTargetDurationSeconds] = useState<number>();
  const [chapterConcurrency, setChapterConcurrency] = useState(8);
  const [validationError, setValidationError] = useState<string>();

  useEffect(() => {
    if (!chapters.length) return;
    setStartId((current) => current || chapters[0]!.id);
    setEndId((current) => current || chapters.at(-1)!.id);
  }, [chapters]);

  useEffect(() => {
    if (policy) setTargetDurationSeconds((current) => current ?? policy.defaultSeconds);
  }, [policy]);

  const rangeCount = pipelineRangeCount(chapters, startId, endId);
  const totalDuration = Number(episodeCount) * (targetDurationSeconds ?? 0);
  const disabled = loading || submitting || !!setup.busy || !setup.ready || !policy || !chapters.length;
  const chapterById = new Map(chapters.map((chapter) => [chapter.id, chapter]));

  function baseInput() {
    if (!policy) throw new Error("单集时长策略尚未加载");
    return pipelineCreateInput({
      episodeCount: Number(episodeCount),
      targetDurationSeconds: targetDurationSeconds ?? Number.NaN,
      chapterBatchSize: 1,
      chapterConcurrency,
      sourceStartChapterId: startId,
      sourceEndChapterId: endId,
    }, chapters, policy);
  }

  function invalidatePreview(change: () => void) {
    change();
    setup.setRanges(undefined);
    setup.setConfirmed(false);
    setValidationError(undefined);
  }

  async function preview() {
    if (disabled) return;
    try {
      const input = baseInput();
      setValidationError(undefined);
      await setup.preview(input);
    } catch (cause) {
      setValidationError((cause as Error).message);
    }
  }

  function submit(event: FormEvent) {
    event.preventDefault();
    if (disabled) return;
    try {
      const input = baseInput();
      if (!setup.ranges || !setup.confirmed) throw new Error("请先预览并确认全部分集章节范围");
      if (setup.dirty) throw new Error("本书专属提示词有未保存修改，请先保存再创建任务");
      setValidationError(undefined);
      onCreate({
        ...input,
        episodeRanges: setup.ranges.map(({ episodeIndex, startChapterId, endChapterId }) => ({
          episodeIndex, startChapterId, endChapterId,
        })),
      });
    } catch (cause) {
      setValidationError((cause as Error).message);
    }
  }

  return <section className="border-b border-[var(--border-subtle)] bg-[var(--bg-surface)] p-[clamp(20px,4vw,44px)]" aria-labelledby="pipeline-setup-heading">
    <div className="mx-auto grid max-w-6xl gap-6">
      <div className="max-w-3xl">
        <p className="mb-2 font-mono text-[11px] font-semibold tracking-[.14em] text-[var(--accent)]">全本改写 / 设置</p>
        <h2 id="pipeline-setup-heading" className="m-0 text-2xl font-semibold tracking-[-.02em]">确认范围、提示词与成片规格</h2>
        <p className="mt-3 text-sm leading-7 text-[var(--fg-secondary)]">新任务将依次完成章节分析、冻结已确认的分集来源和生成成片旁白。先预览并确认连续章节分配，确认创建后才会开始可能产生费用的模型分析；稿件与媒体仍由你逐集审核。</p>
      </div>

      <div className="grid gap-2">
        <div className="min-h-11 border border-[var(--border-subtle)] bg-[var(--bg-subtle)] px-4 py-3 text-sm text-[var(--fg-secondary)]" role="status" aria-live="polite">
          <span className="font-semibold text-[var(--fg-primary)]">流水线状态：</span>{operation}
        </div>
        <div className="min-h-11 border border-[var(--border-subtle)] bg-[var(--bg-subtle)] px-4 py-3 text-sm text-[var(--fg-secondary)]" role="status" aria-live="polite">
          <span className="font-semibold text-[var(--fg-primary)]">设置状态：</span>{setup.status}
        </div>
      </div>
      {error || setup.error || validationError ? <div className="border border-[var(--danger)] bg-[var(--danger-soft)] px-4 py-3 text-sm text-[var(--danger)]" role="alert">{validationError ?? setup.error ?? error}</div> : null}

      <section className="grid gap-4 border border-[var(--border-subtle)] p-4" aria-labelledby="book-prompt-profile-heading">
        <div className="flex items-start justify-between gap-4 max-md:flex-col">
          <div>
            <h3 id="book-prompt-profile-heading" className="m-0 text-base font-semibold">本书专属提示词</h3>
            <p className="mt-1 text-xs leading-6 text-[var(--fg-tertiary)]">本书专属要求不会修改全局提示词，只影响之后新建或显式重新生成的任务，且不能覆盖 Schema、来源范围、时长、审批或安全合同。</p>
          </div>
          <span className="font-mono text-xs text-[var(--fg-tertiary)]">{setup.profileRevision ? `revision ${setup.profileRevision}` : "尚未保存版本"}</span>
        </div>
        <div className="grid grid-cols-2 gap-4 max-md:grid-cols-1">
          {PROFILE_FIELDS.map(([field, label, hint]) => <label key={field} className="grid gap-2 text-sm font-semibold">{label}
            <textarea className="min-h-24 resize-y rounded border border-[var(--border-strong)] bg-[var(--bg-canvas)] p-3 text-sm font-normal leading-6 focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--focus)]" maxLength={20_000} disabled={disabled} value={setup.profile[field]} placeholder={hint} onChange={(event) => setup.setProfile((current) => ({ ...current, [field]: event.target.value }))} />
            <span className="text-xs font-normal text-[var(--fg-tertiary)]">{hint}</span>
          </label>)}
        </div>
        <div className="flex items-center justify-between gap-4 max-md:flex-col max-md:items-stretch">
          <span className="text-xs text-[var(--fg-tertiary)]">{setup.dirty ? "有未保存修改。创建任务前必须先保存。" : setup.profileRevision ? "当前本书专属提示词已保存。" : "当前没有未保存修改；首次创建任务时会冻结空白版本。"}</span>
          <button className="min-h-11 rounded border border-[var(--border-strong)] px-4 text-sm font-semibold disabled:cursor-not-allowed disabled:opacity-50" type="button" disabled={disabled || !setup.dirty} onClick={() => void setup.saveProfile()}>{setup.busy === "profile" ? "正在保存提示词…" : "保存本书专属提示词"}</button>
        </div>
      </section>

      <form className="grid gap-5" onSubmit={submit}>
        <div className="grid grid-cols-2 gap-4 max-md:grid-cols-1">
          <label className="grid gap-2 text-sm font-semibold">起始章节
            <select className="min-h-11 rounded border border-[var(--border-strong)] bg-[var(--bg-canvas)] px-3 font-normal" disabled={disabled} value={startId} onChange={(event) => invalidatePreview(() => setStartId(event.target.value))}>
              {chapters.map((chapter) => <option key={chapter.id} value={chapter.id}>第 {chapter.chapter_index + 1} 章 · {chapter.title}</option>)}
            </select>
          </label>
          <label className="grid gap-2 text-sm font-semibold">结束章节
            <select className="min-h-11 rounded border border-[var(--border-strong)] bg-[var(--bg-canvas)] px-3 font-normal" disabled={disabled} value={endId} onChange={(event) => invalidatePreview(() => setEndId(event.target.value))}>
              {chapters.map((chapter) => <option key={chapter.id} value={chapter.id}>第 {chapter.chapter_index + 1} 章 · {chapter.title}</option>)}
            </select>
          </label>
          <label className="grid gap-2 text-sm font-semibold">总集数
            <input className="min-h-11 rounded border border-[var(--border-strong)] bg-[var(--bg-canvas)] px-3 font-mono font-normal" type="number" min="1" max={Math.max(1, rangeCount)} step="1" inputMode="numeric" placeholder="例如 100" disabled={disabled} value={episodeCount} onChange={(event) => invalidatePreview(() => setEpisodeCount(event.target.value))} />
            <span className="text-xs font-normal text-[var(--fg-tertiary)]">每集至少包含一章，因此总集数不能超过选中章节数。</span>
          </label>
          <label className="grid gap-2 text-sm font-semibold">单集目标时长（秒）
            <input className="min-h-11 rounded border border-[var(--border-strong)] bg-[var(--bg-canvas)] px-3 font-mono font-normal" type="number" min={policy?.minimumSeconds} max={policy?.maximumSeconds} step={policy?.stepSeconds} disabled={disabled} value={targetDurationSeconds ?? ""} onChange={(event) => setTargetDurationSeconds(Number(event.target.value))} />
            {policy ? <span className="text-xs font-normal text-[var(--fg-tertiary)]">允许 {policy.minimumSeconds}～{policy.maximumSeconds} 秒，按 {policy.stepSeconds} 秒递增。</span> : null}
          </label>
          <label className="grid gap-2 text-sm font-semibold">章节分析并发数
            <input className="min-h-11 rounded border border-[var(--border-strong)] bg-[var(--bg-canvas)] px-3 font-mono font-normal" type="number" min="1" max="8" step="1" inputMode="numeric" disabled={disabled} value={chapterConcurrency} onChange={(event) => setChapterConcurrency(Number(event.target.value))} />
            <span className="text-xs font-normal text-[var(--fg-tertiary)]">每章独立分析；允许同时处理 1～8 章，完成一章后自动补入下一章。</span>
          </label>
        </div>

        <dl className="grid grid-cols-3 border border-[var(--border-subtle)] bg-[var(--bg-subtle)] max-md:grid-cols-1">
          <Fact label="原著章节" value={`${chapterTotal} 章`} />
          <Fact label="选中范围" value={rangeCount ? `${rangeCount} 章` : "范围待修正"} />
          <Fact label="总目标时长" value={formatPipelineDuration(totalDuration)} />
        </dl>

        <div className="flex justify-end">
          <button className="min-h-11 rounded border border-[var(--border-strong)] px-5 text-sm font-semibold disabled:cursor-not-allowed disabled:opacity-50" type="button" disabled={disabled || !episodeCount || !rangeCount} onClick={() => void preview()}>{setup.busy === "preview" ? "正在预览分集范围…" : "预览分集范围"}</button>
        </div>

        {setup.ranges ? <section className="grid gap-3 border border-[var(--border-subtle)] p-4" aria-labelledby="episode-range-preview-heading">
          <div>
            <h3 id="episode-range-preview-heading" className="m-0 text-base font-semibold">连续章节分配预览</h3>
            <p className="mt-1 text-xs leading-6 text-[var(--fg-tertiary)]">每行范围连续、无重叠并覆盖全部所选章节。可调整相邻两集的边界，不会移动其他边界。</p>
          </div>
          <ol className="m-0 grid list-none gap-2 p-0">
            {setup.ranges.map((range, index) => {
              const start = chapterById.get(range.startChapterId);
              const end = chapterById.get(range.endChapterId);
              const next = setup.ranges![index + 1];
              const choices = next ? chapters.filter((chapter) => chapter.chapter_index >= range.startChapterIndex && chapter.chapter_index < next.endChapterIndex) : [];
              return <li key={range.episodeIndex} className="grid grid-cols-[72px_1fr_auto] items-center gap-3 border-t border-[var(--border-subtle)] py-3 first:border-t-0 max-md:grid-cols-1">
                <span className="font-mono text-xs font-semibold">第 {range.episodeIndex} 集</span>
                <span className="text-sm text-[var(--fg-secondary)]">第 {(start?.chapter_index ?? range.startChapterIndex) + 1} 章 {start?.title} → </span>
                {next ? <label className="flex items-center gap-2 text-xs"><span>结束于</span><select className="min-h-11 rounded border border-[var(--border-strong)] bg-[var(--bg-canvas)] px-3 text-sm" disabled={disabled} value={range.endChapterId} onChange={(event) => {
                  try {
                    setup.setRanges(adjustEpisodeBoundary(setup.ranges!, index, event.target.value, chapters));
                    setup.setConfirmed(false);
                    setValidationError(undefined);
                  } catch (cause) { setValidationError((cause as Error).message); }
                }}>{choices.map((chapter) => <option key={chapter.id} value={chapter.id}>第 {chapter.chapter_index + 1} 章 · {chapter.title}</option>)}</select></label>
                  : <span className="text-sm">第 {(end?.chapter_index ?? range.endChapterIndex) + 1} 章 · {end?.title}</span>}
                <span className="col-start-2 font-mono text-xs text-[var(--fg-tertiary)] max-md:col-start-1">{range.characterCount.toLocaleString("zh-CN")} 字</span>
              </li>;
            })}
          </ol>
          <label className="flex min-h-11 items-center gap-3 border-t border-[var(--border-subtle)] pt-3 text-sm font-semibold">
            <input type="checkbox" className="size-4" disabled={disabled} checked={setup.confirmed} onChange={(event) => setup.setConfirmed(event.target.checked)} />
            我已确认全部分集范围；创建后才开始可能产生费用的模型分析
          </label>
        </section> : null}

        <p className="m-0 text-xs leading-6 text-[var(--fg-tertiary)]">已有章节事件将在启动后由服务端按真实输入身份复用；本操作不会自动批准任何稿件或媒体。</p>
        <div className="flex justify-end">
          <button className="min-h-11 rounded border border-transparent bg-[var(--accent)] px-5 text-sm font-semibold text-[var(--accent-contrast)] hover:bg-[var(--accent-strong)] disabled:cursor-not-allowed disabled:opacity-50" type="submit" disabled={disabled || !setup.confirmed || setup.dirty}>
            {submitting ? "正在创建全本改写任务…" : "确认范围并开始全本改写"}
          </button>
        </div>
      </form>
    </div>
  </section>;
}

function Fact({ label, value }: { label: string; value: string }) {
  return <div className="grid gap-1 border-r border-[var(--border-subtle)] px-4 py-3 last:border-r-0 max-md:border-r-0 max-md:border-b max-md:last:border-b-0">
    <dt className="text-xs text-[var(--fg-tertiary)]">{label}</dt>
    <dd className="m-0 font-mono text-sm font-semibold">{value}</dd>
  </div>;
}
