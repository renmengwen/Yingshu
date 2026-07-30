import { useState } from "react";

import {
  exportArtifactUrl,
  formatExportBytes,
  formatExportDuration,
  projectPackageMatchesFinal,
} from "./export-logic";
import { useExportWorkspace, type ExportWorkspaceOptions } from "./use-export-workspace";

export function ExportStage(props: ExportWorkspaceOptions) {
  const state = useExportWorkspace(props);
  const final = state.readiness?.episodeId === props.episodeId && state.readiness.timelineHash === props.timelineHash && state.readiness.finalExport?.verified
    ? state.readiness.finalExport
    : undefined;
  const projectPackage = projectPackageMatchesFinal(state.projectPackage, final && { episodeId: props.episodeId, exportHash: final.exportHash })
    ? state.projectPackage
    : undefined;
  const isInterrupted = state.job?.status === "cancelled";
  const statusRole = state.error || isInterrupted ? "alert" : "status";

  return <section className="grid min-h-[calc(100vh-344px)] grid-cols-[minmax(0,1.35fr)_minmax(280px,.65fr)] max-lg:grid-cols-1" aria-labelledby="export-stage-heading">
    <div className="border-r border-[var(--border-subtle)] p-5 max-lg:border-b max-lg:border-r-0">
      <header className="border-b border-[var(--border-subtle)] pb-4">
        <p className="font-mono text-[10px] tracking-[.08em] text-[var(--accent)]">PRODUCTION REVIEW</p>
        <h2 id="export-stage-heading" className="mt-1 text-xl font-semibold">审核与导出</h2>
        <p className="mt-2 text-xs leading-6 text-[var(--fg-secondary)]">服务端复核批准稿、时间轴、视觉绑定、渲染分片与最终文件。这里不会批准任何上游产物。</p>
      </header>

      <div className="grid gap-5 py-5">
        <div className="grid grid-cols-2 gap-3 max-sm:grid-cols-1">
          <Identity label="分集" value={props.episodeId} />
          <Identity label="时间轴" value={props.timelineHash} />
        </div>

        <section aria-labelledby="readiness-heading" className="rounded-md border border-[var(--border-subtle)] bg-[var(--bg-subtle)] p-4">
          <div className="flex items-center justify-between gap-3">
            <h3 id="readiness-heading" className="text-sm font-semibold">生产就绪复核</h3>
            <span className="text-xs font-semibold">{state.loading ? "复核中" : state.readiness?.productionReady ? "已通过" : "未通过"}</span>
          </div>
          {state.readiness?.blockers.length ? <ul className="mt-3 grid gap-2" aria-label="生产阻断项">
            {state.readiness.blockers.map((blocker) => <li key={blocker.code} className="flex gap-2 rounded border border-[var(--danger)] p-3 text-xs leading-5 text-[var(--danger)]"><span aria-hidden="true">×</span><span><strong className="block">阻断</strong>{blocker.message}</span></li>)}
          </ul> : <p className="mt-3 text-xs leading-6 text-[var(--fg-secondary)]">{state.loading ? "正在读取服务端门禁…" : state.readiness?.productionReady ? "所有生产门禁均已通过。" : "尚未取得有效复核结果。"}</p>}
        </section>

        <section aria-labelledby="render-heading" className="rounded-md border border-[var(--border-subtle)] p-4">
          <h3 id="render-heading" className="text-sm font-semibold">渲染链路</h3>
          <ol className="mt-3 grid gap-3 text-xs">
            <Step index="01" title="render_chunks" detail={state.readiness ? `${state.readiness.renderChunks.completed}/${state.readiness.renderChunks.total} 个分片已验证` : "等待生产复核"} done={state.readiness?.renderChunks.ready === true} />
            <Step index="02" title="final_video" detail={final ? `${formatExportDuration(final.durationMs)} · ${formatExportBytes(final.bytes)}` : "必须在全部分片通过后执行"} done={Boolean(final)} />
          </ol>
          {final ? <FinalVideoEvidence final={final} jobId={state.readiness?.jobs.finalVideo?.id} /> : null}
        </section>
      </div>
    </div>

    <aside className="p-5">
      <h3 className="text-sm font-semibold">当前操作</h3>
      <div className="mt-3 min-h-20 rounded-md border border-[var(--border-subtle)] bg-[var(--bg-subtle)] p-3 text-xs leading-6" role={statusRole} aria-live="polite">
        <strong className="block">{state.job?.status === "failed" || state.error ? "失败" : isInterrupted ? "已中断" : state.job?.status === "succeeded" || final ? "成功" : state.actionBusy || state.loading || state.job?.status === "running" ? "正在进行" : "就绪"}</strong>
        {state.message}
      </div>

      {state.workflow.action === "download" && final
        ? <a className="mt-4 flex min-h-11 w-full items-center justify-center rounded-md bg-[var(--accent)] px-4 text-center text-sm font-semibold text-white focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--focus)]" href={exportArtifactUrl(props.episodeId, final.exportHash, "video")} download>下载已复核 MP4</a>
        : <button type="button" className="mt-4 min-h-11 w-full rounded-md bg-[var(--accent)] px-4 text-sm font-semibold text-white disabled:cursor-not-allowed disabled:opacity-45" disabled={state.workflow.disabled} onClick={() => void state.runPrimary()}>{state.workflow.label}</button>}

      {final ? <a className="mt-2 flex min-h-11 w-full items-center justify-center rounded-md border border-[var(--border-subtle)] px-4 text-center text-xs font-semibold hover:bg-[var(--bg-subtle)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--focus)]" href={exportArtifactUrl(props.episodeId, final.exportHash, "manifest")} target="_blank" rel="noreferrer">查看受控 manifest</a> : null}

      <div className="mt-6 border-t border-[var(--border-subtle)] pt-5">
        <h3 className="text-sm font-semibold">项目包</h3>
        <p className="mt-2 text-xs leading-6 text-[var(--fg-secondary)]">项目包仅保存在服务端受控目录，不会触发浏览器下载。</p>
        {final ? <>
          <div className="mt-3 rounded-md border border-[var(--border-subtle)] bg-[var(--bg-subtle)] p-3 text-xs leading-5" role={state.packageStatus === "failure" || state.packageStatus === "interrupted" ? "alert" : "status"} aria-live="polite">
            <strong className="block">{state.packageStatus === "loading" ? "正在进行" : state.packageStatus === "success" ? "成功" : state.packageStatus === "failure" ? "失败" : state.packageStatus === "interrupted" ? "已中断" : "就绪"}</strong>
            {state.packageMessage}
          </div>
          <button type="button" className="mt-3 min-h-11 w-full rounded-md border border-[var(--border-subtle)] px-4 text-xs font-semibold hover:bg-[var(--bg-subtle)] disabled:cursor-not-allowed disabled:opacity-45" disabled={state.packageStatus === "loading"} onClick={() => void state.createServerProjectPackage()}>{state.packageStatus === "loading" ? "正在创建项目包…" : projectPackage ? "重新创建服务端项目包" : "创建服务端项目包"}</button>
          {projectPackage ? <div className="mt-3 grid gap-2 text-xs">
            <CopyPath value={projectPackage.packagePath} />
            <p><span className="block text-[var(--fg-muted)]">项目包哈希</span><code className="break-all text-[11px]">{projectPackage.packageHash}</code></p>
          </div> : null}
        </> : <p className="mt-2 text-xs leading-6 text-[var(--fg-muted)]">最终视频复核通过后可创建。</p>}
      </div>
    </aside>
  </section>;
}

function CopyPath({ value }: { value: string }) {
  const [status, setStatus] = useState<"idle" | "loading" | "success" | "failure" | "interrupted">("idle");
  async function copy() {
    if (status === "loading") return;
    setStatus("loading");
    try {
      if (!navigator.clipboard) throw new Error("当前浏览器不支持剪贴板写入");
      await navigator.clipboard.writeText(value);
      setStatus("success");
    } catch (caught) {
      setStatus(caught instanceof DOMException && caught.name === "AbortError" ? "interrupted" : "failure");
    }
  }
  const message = status === "loading" ? "正在复制…" : status === "success" ? "路径已复制" : status === "failure" ? "复制失败，请手工选择" : status === "interrupted" ? "复制已中断" : "复制路径";
  return <div className="grid gap-1">
    <label><span className="block text-[var(--fg-muted)]">服务端路径</span><input className="mt-1 min-h-11 w-full rounded-md border border-[var(--border-subtle)] bg-transparent px-3 font-mono text-[11px]" readOnly value={value} onFocus={(event) => event.currentTarget.select()} /></label>
    <button type="button" className="min-h-11 rounded-md border border-[var(--border-subtle)] px-3 font-semibold hover:bg-[var(--bg-subtle)] disabled:cursor-not-allowed disabled:opacity-45" disabled={status === "loading"} onClick={() => void copy()}>{message}</button>
  </div>;
}

function Identity({ label, value }: { label: string; value: string }) {
  return <div className="min-w-0 rounded-md border border-[var(--border-subtle)] p-3"><span className="block text-[10px] text-[var(--fg-muted)]">{label}</span><strong className="mt-1 block truncate font-mono text-xs" title={value}>{value}</strong></div>;
}

function Step({ index, title, detail, done }: { index: string; title: string; detail: string; done: boolean }) {
  return <li className="grid grid-cols-[32px_1fr_auto] items-center gap-3"><span className="font-mono text-[10px] text-[var(--fg-muted)]">{index}</span><span><strong className="block font-mono">{title}</strong><span className="text-[var(--fg-secondary)]">{detail}</span></span><span className="font-semibold">{done ? "已通过" : "待处理"}</span></li>;
}

export function FinalVideoEvidence({ final, jobId }: {
  final: { exportHash: string; fileHash: string; bytes: number; durationMs: number };
  jobId: string | undefined;
}) {
  return <div className="mt-4 grid gap-2 border-t border-[var(--border-subtle)] pt-4 text-xs" aria-label="最终视频证据">
    <p><span className="block text-[var(--fg-muted)]">当前 Job ID</span><code className="break-all text-[11px]">{jobId ?? "服务端未返回"}</code></p>
    <p><span className="block text-[var(--fg-muted)]">MP4 SHA-256</span><code className="break-all text-[11px]">{final.fileHash}</code></p>
    <p><span className="block text-[var(--fg-muted)]">导出标识</span><code className="break-all text-[11px]">{final.exportHash}</code></p>
    <p className="text-[var(--fg-secondary)]">{`${formatExportDuration(final.durationMs)} · ${formatExportBytes(final.bytes)}`}</p>
  </div>;
}
