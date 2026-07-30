import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "../../components/ui/alert-dialog";
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from "../../components/ui/accordion";
import type { EpisodeSourceSnapshot, JobRecord, ScriptVersion } from "../types";
import { allowedSourceIndexes, canStartEpisodeScriptGeneration } from "./script-editor";
import { useScriptWorkspace } from "./use-script-workspace";

export function ScriptStage({
  seriesId, episodeIndex, busy, jobActive, currentJob, setBusy, setStatus, onDraftDirtyChange, onJobCreated,
}: {
  seriesId: string;
  episodeIndex: number;
  busy: boolean;
  jobActive: boolean;
  currentJob?: JobRecord;
  setBusy: (busy: boolean) => void;
  setStatus: (message: string) => void;
  onDraftDirtyChange: (dirty: boolean) => void;
  onJobCreated: (id: string) => void;
}) {
  const state = useScriptWorkspace({
    seriesId, episodeIndex, currentJob, jobActive, setBusy, setStatus, onDraftDirtyChange, onJobCreated,
  });
  const faithful = state.scripts.filter((item) => item.kind === "faithful");
  const packaged = state.scripts.filter((item) => item.kind === "packaged");
  const parent = faithful.find((item) => item.id === state.parentVersionId);
  const allowed = new Set(allowedSourceIndexes(state.kind, state.episode?.sources.map((source) => source.sourceIndex) ?? [], parent));
  const sources = (state.episode?.sources ?? []).filter((source) => allowed.has(source.sourceIndex));
  const canGenerate = canStartEpisodeScriptGeneration(busy, jobActive, state.episode?.id);
  const finishedNarration = state.contractVersion === 6;
  const visibleSources = finishedNarration ? state.episode?.sources ?? [] : sources;

  return <>
  <div className="grid grid-cols-[260px_minmax(0,1fr)_340px] border-t border-[var(--border-subtle)] max-xl:grid-cols-1">
    <aside className="border-r border-[var(--border-subtle)] p-5 max-xl:border-r-0 max-xl:border-b">
      <div className="mt-5 space-y-3 rounded border border-[var(--border-subtle)] p-3">
        <p className="text-xs font-semibold">{finishedNarration ? "直接成片旁白" : "跨章骨架与长稿"}</p>
        {finishedNarration ? <p className="text-xs leading-5 text-[var(--fg-tertiary)]">当前分集使用 v6 单稿合同。成片旁白按 beat 直接读取原文生成；重新生成请从流水线发起，页面不会创建缺少冻结身份的独立稿件。</p> : <>
        <label className="block text-xs text-[var(--fg-secondary)]">音色<input value={state.voice} disabled={busy || jobActive || !!state.calibration} onChange={(event) => state.setVoice(event.target.value)} className="mt-1 w-full rounded border border-[var(--border-subtle)] bg-[var(--bg-canvas)] p-2" /></label>
        <label className="block text-xs text-[var(--fg-secondary)]">语速<input type="number" min={-10} max={10} step={1} value={state.rate} disabled={busy || jobActive || !!state.calibration} onChange={(event) => state.setRate(Number(event.target.value))} className="mt-1 w-full rounded border border-[var(--border-subtle)] bg-[var(--bg-canvas)] p-2" /></label>
        <label className="block text-xs text-[var(--fg-secondary)]">{state.calibration ? "实测字/秒" : "暂定字/秒"}<input type="number" min={0.1} max={20} step={0.1} value={state.charactersPerSecond} disabled={busy || jobActive || !!state.calibration} onChange={(event) => state.setCharactersPerSecond(Number(event.target.value))} className="mt-1 w-full rounded border border-[var(--border-subtle)] bg-[var(--bg-canvas)] p-2" /></label>
        <label className="block text-xs text-[var(--fg-secondary)]">旁白占用率<input type="number" min={0.1} max={1} step={0.05} value={state.narrationOccupancy} disabled={busy || jobActive} onChange={(event) => state.setNarrationOccupancy(Number(event.target.value))} className="mt-1 w-full rounded border border-[var(--border-subtle)] bg-[var(--bg-canvas)] p-2" /></label>
        <button type="button" disabled={!canGenerate} onClick={() => void state.generateScripts()} className="w-full rounded bg-[var(--accent)] px-3 py-2 text-sm font-semibold text-white disabled:opacity-50">{jobActive ? "生成任务处理中…" : "生成故事骨架与两版旁白"}</button>
        <p className="text-xs leading-5 text-[var(--fg-tertiary)]">{state.calibration
          ? `当前使用已选短样 ${state.calibration.sampleId} 的 measured 预算；服务端会复核。`
          : "当前为短样校准前的 provisional 暂定语速；生成后不会自动批准。"}</p>
        </>}
      </div>
      <p className="mt-5 text-xs leading-6 text-[var(--fg-tertiary)]">{finishedNarration ? "v6 成片旁白稿保持只读，查看不会触发生成、批准或下游任务。" : <>也可继续人工整理；每次保存都会创建不可变新版本。{state.draftDirty ? " 当前草稿有未保存修改。" : ""}</>}</p>
      {!finishedNarration ? <VersionList title="原著还原稿版本" items={faithful} onLoad={state.loadVersion} /> : null}
      <VersionList title="成片旁白稿版本" items={packaged} onLoad={state.loadVersion} />
    </aside>

    <section className="p-6" aria-labelledby="script-editor-heading">
      <div className="mb-5 flex flex-wrap items-end gap-4">
        <div><p id="script-editor-heading" className="text-xs font-bold tracking-wider">{finishedNarration ? "成片旁白稿" : "人工稿件编辑"}</p><p className="mt-1 text-xs text-[var(--fg-tertiary)]">{finishedNarration ? "单一成片稿只读展示；批准仍需人工提交。" : "新版本不会自动迁移现有批准指针。"}</p></div>
        {!finishedNarration ? <label className="ml-auto text-xs text-[var(--fg-secondary)]">稿件用途<select disabled={busy || !state.episode} value={state.kind} onChange={(event) => state.changeKind(event.target.value as "faithful" | "packaged")} className="ml-2 rounded border border-[var(--border-subtle)] bg-[var(--bg-canvas)] p-2"><option value="faithful">原著还原稿</option><option value="packaged">成片旁白稿</option></select></label> : null}
        {!finishedNarration && state.kind === "packaged" ? <label className="text-xs text-[var(--fg-secondary)]">基于还原稿<select disabled={busy} value={state.parentVersionId} onChange={(event) => state.setParentVersionId(event.target.value)} className="ml-2 max-w-60 rounded border border-[var(--border-subtle)] bg-[var(--bg-canvas)] p-2"><option value="">请选择</option>{faithful.map((item) => <option key={item.id} value={item.id}>原著还原稿 v{item.versionNumber}</option>)}</select></label> : null}
      </div>

      {!state.episode ? <p className="rounded border border-dashed border-[var(--border-subtle)] p-8 text-sm text-[var(--fg-tertiary)]">该分集尚未创建。请先在“故事弧与分集”保存故事弧和来源证据。</p> : <div className="space-y-5">
        {state.paragraphs.map((paragraph, index) => <article key={paragraph.key} className="rounded border border-[var(--border-subtle)] p-4">
          <div className="mb-3 flex items-center justify-between"><span className="font-mono text-xs text-[var(--fg-tertiary)]">段落 {index + 1}</span>{!finishedNarration ? <button type="button" disabled={busy || state.paragraphs.length === 1} onClick={() => state.removeParagraph(paragraph.key)} className="text-xs text-[var(--fg-secondary)] disabled:opacity-40">移除</button> : null}</div>
          <textarea disabled={busy || finishedNarration} readOnly={finishedNarration} rows={5} value={paragraph.text} onChange={(event) => state.updateParagraph(paragraph.key, { text: event.target.value })} placeholder="填写人工整理的旁白或画面稿" className="w-full rounded border border-[var(--border-subtle)] bg-[var(--bg-canvas)] p-3 text-sm leading-6 disabled:opacity-100" />
          <Accordion type="single" collapsible className="mt-3 rounded border border-[var(--border-subtle)]">
            <AccordionItem value="sources">
              <AccordionTrigger className="font-normal"><span>引用来源 <span className="font-mono text-xs text-[var(--fg-tertiary)]">已选 {paragraph.sourceIndexes.length} / {visibleSources.length}</span></span></AccordionTrigger>
              <AccordionContent><fieldset className="grid max-h-80 gap-2 overflow-y-auto p-3"><legend className="sr-only">段落 {index + 1} 的引用来源</legend>{visibleSources.map((source) => <SourceOption key={source.sourceIndex} source={source} checked={paragraph.sourceIndexes.includes(source.sourceIndex)} disabled={busy || finishedNarration} onChange={(checked) => state.updateParagraph(paragraph.key, { sourceIndexes: checked ? [...paragraph.sourceIndexes, source.sourceIndex] : paragraph.sourceIndexes.filter((item) => item !== source.sourceIndex) })} />)}{!visibleSources.length ? <p className="text-xs text-[var(--fg-tertiary)]">当前没有可用来源；成片旁白稿只能使用对应原著还原稿的来源。</p> : null}</fieldset></AccordionContent>
            </AccordionItem>
          </Accordion>
        </article>)}
        {!finishedNarration ? <div className="flex gap-3"><button type="button" disabled={busy} onClick={state.addParagraph} className="rounded border border-[var(--border-subtle)] px-4 py-2 text-sm disabled:opacity-50">添加段落</button><button type="button" disabled={busy} onClick={() => void state.saveVersion()} className="rounded bg-[var(--accent)] px-4 py-2 text-sm font-semibold text-white disabled:opacity-50">{busy ? "处理中…" : "创建不可变新版本"}</button></div> : null}
      </div>}
    </section>

    <aside className="border-l border-[var(--border-subtle)] p-5 max-xl:border-l-0 max-xl:border-t">
      <h2 className="text-xs font-bold tracking-wider">人工批准</h2>
      <p className="mt-2 text-sm">状态：{approvalLabel(state.approval?.status)} · revision {state.approval?.revision ?? "—"}</p>
      {state.approval?.scriptVersionId ? <p className="mt-2 break-all font-mono text-[10px] text-[var(--fg-tertiary)]">当前批准：{state.approval.scriptVersionId}</p> : null}
      <label className="mt-5 block text-xs text-[var(--fg-secondary)]">待批准成片旁白稿<select disabled={busy || !packaged.length} value={state.selectedPackagedId} onChange={(event) => state.setSelectedPackagedId(event.target.value)} className="mt-2 w-full rounded border border-[var(--border-subtle)] bg-[var(--bg-canvas)] p-2"><option value="">请选择</option>{packaged.map((item) => <option key={item.id} value={item.id}>成片旁白稿 v{item.versionNumber}</option>)}</select></label>
      <div className="mt-4 grid gap-2"><button type="button" disabled={busy || !state.approval || !state.selectedPackagedId} onClick={() => void state.changeApproval("approve")} className="rounded bg-[var(--accent)] px-4 py-2 text-sm font-semibold text-white disabled:opacity-50">批准所选成片旁白稿</button><button type="button" disabled={busy || state.approval?.status !== "approved"} onClick={() => void state.changeApproval("withdraw")} className="rounded border border-[var(--border-subtle)] px-4 py-2 text-sm disabled:opacity-50">撤回当前批准</button></div>
      <p className="mt-4 text-xs leading-6 text-[var(--fg-tertiary)]">批准与撤回使用页面当前 revision。若服务端返回冲突，页面只刷新状态，不会自动重放人工决定。</p>
    </aside>
  </div>
  <AlertDialog open={!!state.pendingLoadVersion} onOpenChange={(open) => { if (!open) state.cancelLoadVersion(); }}>
    <AlertDialogContent>
      <AlertDialogHeader>
        <AlertDialogTitle>载入版本会覆盖当前草稿</AlertDialogTitle>
        <AlertDialogDescription>
          当前稿件已有未保存修改。取消会保留当前草稿；确认后载入所选版本 v{state.pendingLoadVersion?.versionNumber}，本地未保存内容将被覆盖。
        </AlertDialogDescription>
      </AlertDialogHeader>
      <AlertDialogFooter>
        <AlertDialogCancel>取消，保留草稿</AlertDialogCancel>
        <AlertDialogAction onClick={state.confirmLoadVersion}>确认载入版本</AlertDialogAction>
      </AlertDialogFooter>
    </AlertDialogContent>
  </AlertDialog>
  <AlertDialog open={!!state.pendingKind} onOpenChange={(open) => { if (!open) state.cancelChangeKind(); }}>
    <AlertDialogContent>
      <AlertDialogHeader>
        <AlertDialogTitle>切换稿件类型会覆盖当前草稿</AlertDialogTitle>
        <AlertDialogDescription>
          当前稿件已有未保存修改。取消会保留当前草稿；确认后切换到{state.pendingKind === "faithful" ? "原著还原稿" : "成片旁白稿"}，本地未保存内容将被覆盖。
        </AlertDialogDescription>
      </AlertDialogHeader>
      <AlertDialogFooter>
        <AlertDialogCancel>取消，保留草稿</AlertDialogCancel>
        <AlertDialogAction onClick={state.confirmChangeKind}>确认切换稿件类型</AlertDialogAction>
      </AlertDialogFooter>
    </AlertDialogContent>
  </AlertDialog>
  </>;
}

function VersionList({ title, items, onLoad }: { title: string; items: ScriptVersion[]; onLoad: (version: ScriptVersion) => void }) {
  return <div className="mt-5"><h3 className="text-xs font-semibold">{title}</h3><div className="mt-2 grid gap-2">{items.map((item) => <button type="button" key={item.id} onClick={() => onLoad(item)} className="rounded border border-[var(--border-subtle)] p-2 text-left text-xs">v{item.versionNumber} · {item.paragraphs.length} 段</button>)}{!items.length ? <p className="text-xs text-[var(--fg-tertiary)]">暂无版本</p> : null}</div></div>;
}

function SourceOption({ source, checked, disabled, onChange }: { source: EpisodeSourceSnapshot; checked: boolean; disabled: boolean; onChange: (checked: boolean) => void }) {
  return <label className="flex gap-2 rounded bg-[var(--bg-canvas)] p-2 text-xs leading-5"><input type="checkbox" disabled={disabled} checked={checked} onChange={(event) => onChange(event.target.checked)} /><span><span className="font-mono text-[10px] text-[var(--fg-tertiary)]">来源 {source.sourceIndex} · {source.byteStart}–{source.byteEnd}</span><br />{source.sourceText}</span></label>;
}

function approvalLabel(status?: "unapproved" | "approved" | "withdrawn") {
  return status === "approved" ? "已批准" : status === "withdrawn" ? "已撤回" : status === "unapproved" ? "未批准" : "未加载";
}
