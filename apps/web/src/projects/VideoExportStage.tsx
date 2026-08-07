import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "../components/ui/alert-dialog";
import { buttonVariants } from "../components/ui/button";
import { formatProductionTime } from "./video-final-production-logic";
import { useVideoRenderExport } from "./use-video-final-production";

const primaryButton = buttonVariants({ variant: "default" });
const secondaryButton = buttonVariants({ variant: "outline" });

export function VideoExportStage({
  projectId,
  videoId,
}: {
  projectId: string;
  videoId: string;
}) {
  const state = useVideoRenderExport(projectId, videoId);
  const workspace = state.workspace;
  if (!state.loaded) {
    return (
      <section className="p-6 text-sm text-[var(--fg-secondary)]" aria-live="polite">
        正在恢复最终渲染与导出状态…
      </section>
    );
  }
  if (!workspace) {
    return (
      <section className="p-6" role="alert">
        <h2 className="text-lg font-semibold">无法恢复审核与导出阶段</h2>
        <p className="mt-2 text-sm leading-6 text-[var(--fg-secondary)]">{state.message}</p>
        <button
          className={`${secondaryButton} mt-5`}
          type="button"
          disabled={state.state === "loading"}
          onClick={() => void state.refresh()}
        >
          {state.state === "loading" ? "正在重新加载…" : "重新加载"}
        </button>
      </section>
    );
  }

  const render = workspace.render;
  const active = render?.status === "queued" || render?.status === "running";
  const retry = render?.status === "failed" || render?.status === "cancelled";
  const busy = state.busyAction !== null;
  const final = workspace.final;

  return (
    <section className="min-w-0" aria-labelledby="video-export-heading">
      <header className="border-b border-[var(--border-subtle)] bg-[var(--bg-subtle)] px-5 py-5 md:px-7">
        <p className="font-mono text-[11px] font-semibold tracking-[.14em] text-[var(--accent)]">
          MVP 第五阶段
        </p>
        <h2 id="video-export-heading" className="mt-2 text-xl font-semibold">
          审核与导出
        </h2>
        <p className="mt-2 max-w-3xl text-sm leading-6 text-[var(--fg-secondary)]">
          服务端会在启动前重新验证全部生产门禁。最终视频输出规格以当前合同为准，不会在本阶段额外添加 BGM、发布到平台或创建其他格式。
        </p>
        <div
          className="mt-4 min-h-11 border border-[var(--border-subtle)] bg-[var(--bg-surface)] px-4 py-3 text-sm leading-6"
          aria-live="polite"
          role={state.state === "error" ? "alert" : "status"}
        >
          <strong>
            {state.state === "loading"
              ? "正在进行："
              : state.state === "success"
                ? "成功："
                : state.state === "error"
                  ? "失败："
                  : state.state === "interrupted"
                    ? "已中断："
                    : "就绪："}
          </strong>
          {state.message}
        </div>
      </header>

      <div className="grid min-w-0 lg:grid-cols-[minmax(0,1.25fr)_minmax(280px,.75fr)]">
        <div className="min-w-0 border-b border-[var(--border-subtle)] p-5 lg:border-b-0 lg:border-r md:p-7">
          <section aria-labelledby="final-gates-heading">
            <h3 id="final-gates-heading" className="text-sm font-semibold">
              最终渲染门禁
            </h3>
            <div className="mt-3 divide-y divide-[var(--border-subtle)] border-y border-[var(--border-subtle)]">
              {workspace.gates.map((gate) => (
                <div key={gate.key} className="flex min-h-11 items-center justify-between gap-4 py-3 text-sm">
                  <span>
                    <strong>{gate.label}</strong>
                    {gate.message ? (
                      <span className="mt-1 block text-xs text-[var(--fg-secondary)]">{gate.message}</span>
                    ) : null}
                  </span>
                  <span className="shrink-0 font-semibold">{gate.valid ? "已通过" : "未通过"}</span>
                </div>
              ))}
              {!workspace.gates.length ? (
                <p className="py-3 text-sm text-[var(--fg-secondary)]">服务端尚未返回门禁摘要。</p>
              ) : null}
            </div>
            {workspace.readiness.issues.length ? (
              <ul className="mt-4 grid gap-2" aria-label="最终渲染阻断项">
                {workspace.readiness.issues.map((issue) => (
                  <li key={issue} className="border border-[var(--danger)] p-3 text-sm text-[var(--danger)]">
                    <strong>阻断：</strong>
                    {issue}
                  </li>
                ))}
              </ul>
            ) : null}
          </section>

          <section className="mt-7 border-t border-[var(--border-subtle)] pt-6" aria-labelledby="render-status-heading">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <h3 id="render-status-heading" className="text-sm font-semibold">
                持久分片渲染
              </h3>
              <span className="text-sm font-semibold">
                {render ? renderStatusLabel(render.status) : "尚未启动"}
              </span>
            </div>
            {render ? (
              <>
                <p className="mt-2 truncate font-mono text-[11px] text-[var(--fg-secondary)]" title={render.jobId}>
                  Job {render.jobId}
                </p>
                <div className="mt-4 grid grid-cols-2 gap-x-5 gap-y-3 text-sm sm:grid-cols-3">
                  <Count label="总计" value={render.chunks.total} />
                  <Count label="排队" value={render.chunks.queued} />
                  <Count label="渲染中" value={render.chunks.running} />
                  <Count label="成功" value={render.chunks.succeeded} />
                  <Count label="失败" value={render.chunks.failed} />
                  <Count label="已中断" value={render.chunks.cancelled} />
                </div>
                {render.errorMessage ? (
                  <p className="mt-4 text-sm text-[var(--danger)]" role="alert">
                    渲染失败：{render.errorMessage}
                  </p>
                ) : null}
              </>
            ) : (
              <p className="mt-3 text-sm leading-6 text-[var(--fg-secondary)]">
                用户明确启动后，服务端才会创建唯一渲染任务。重复启动会复用同一身份，不会重复生产已验证分片。
              </p>
            )}
          </section>

          {final ? (
            <section className="mt-7 border-t border-[var(--border-subtle)] pt-6" aria-labelledby="final-player-heading">
              <h3 id="final-player-heading" className="text-sm font-semibold">
                最终 MP4
              </h3>
              <video
                className="mt-4 max-h-[70vh] w-full bg-black object-contain"
                style={{ aspectRatio: `${workspace.readiness.spec.width} / ${workspace.readiness.spec.height}` }}
                controls
                preload="metadata"
                src={state.streamUrl}
              >
                当前浏览器无法播放 MP4，请使用下载按钮保存文件。
              </video>
              <dl className="mt-4 grid gap-3 text-sm sm:grid-cols-2">
                <Evidence label="规格" value={`${final.width}×${final.height} · ${final.fps}fps`} />
                <Evidence label="编码" value={`${final.videoCodec.toUpperCase()} / ${final.audioCodec.toUpperCase()} / ${final.pixelFormat}`} />
                <Evidence label="时长" value={formatProductionTime(final.durationMs)} />
                <Evidence label="大小" value={formatBytes(final.bytes)} />
                <Evidence label="MP4 SHA-256" value={final.fileHash} wide />
              </dl>
            </section>
          ) : null}
        </div>

        <aside className="p-5 md:p-7">
          <h3 className="text-sm font-semibold">固定输出规格</h3>
          <dl className="mt-3 divide-y divide-[var(--border-subtle)] border-y border-[var(--border-subtle)] text-sm">
            <Spec label="画幅" value={`${workspace.readiness.spec.aspectRatio}`} />
            <Spec label="分辨率" value={`${workspace.readiness.spec.width}×${workspace.readiness.spec.height}`} />
            <Spec label="帧率" value={`${workspace.readiness.spec.fps}fps`} />
            <Spec label="视频" value="H.264 / yuv420p" />
            <Spec label="音频" value="AAC" />
            <Spec label="字幕" value="当前批准 ASS 烧录" />
          </dl>
          <div className="mt-5 grid gap-2 text-sm">
            <p>
              <span className="text-[var(--fg-secondary)]">视觉段：</span>
              <strong>{workspace.readiness.segmentCount}</strong>
            </p>
            <p>
              <span className="text-[var(--fg-secondary)]">真实时长：</span>
              <strong className="font-mono">{formatProductionTime(workspace.readiness.durationMs)}</strong>
            </p>
            <p>
              <span className="text-[var(--fg-secondary)]">预计分片：</span>
              <strong>{workspace.readiness.estimatedChunks}</strong>
            </p>
          </div>
          {final ? (
            <a className={`${primaryButton} mt-6 w-full`} href={state.downloadUrl} download>
              下载最终 MP4
            </a>
          ) : active ? (
            <button
              className={`${secondaryButton} mt-6 w-full`}
              type="button"
              disabled={busy}
              onClick={() => void state.cancelRender()}
            >
              {state.busyAction === "cancel" ? "正在中断…" : "中断当前渲染"}
            </button>
          ) : (
            <AlertDialog>
              <AlertDialogTrigger className={`${primaryButton} mt-6 w-full`} disabled={busy || !workspace.readiness.ready}>
                {state.busyAction === "render" ? "正在创建任务…" : retry ? "重试最终渲染" : "生成最终视频"}
              </AlertDialogTrigger>
              <AlertDialogContent>
                <AlertDialogHeader>
                  <AlertDialogTitle>确认生成最终视频</AlertDialogTitle>
                  <AlertDialogDescription asChild>
                    <div className="space-y-3">
                      <p>服务端将再次验证方案、图片、音频、字幕、画面时间轴和整片审核，然后启动持久分片渲染。</p>
                      <p>
                        输出为 {workspace.readiness.spec.width}×{workspace.readiness.spec.height}、
                        {workspace.readiness.spec.fps}fps、H.264/AAC MP4，共 {workspace.readiness.segmentCount} 个视觉段，预计 {workspace.readiness.estimatedChunks} 个分片。
                        不会发布到任何平台。
                      </p>
                    </div>
                  </AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                  <AlertDialogCancel>返回检查</AlertDialogCancel>
                  <AlertDialogAction className={primaryButton} onClick={() => void state.startRender()}>
                    确认开始渲染
                  </AlertDialogAction>
                </AlertDialogFooter>
              </AlertDialogContent>
            </AlertDialog>
          )}
          {!workspace.readiness.ready && !final ? (
            <p className="mt-3 text-xs leading-6 text-[var(--fg-secondary)]">
              全部服务端门禁通过后才能明确启动最终渲染。
            </p>
          ) : null}
        </aside>
      </div>
    </section>
  );
}

function renderStatusLabel(status: "queued" | "running" | "succeeded" | "failed" | "cancelled") {
  return ({ queued: "已排队", running: "正在渲染", succeeded: "已完成", failed: "失败", cancelled: "已中断" } as const)[status];
}

function Count({ label, value }: { label: string; value: number }) {
  return (
    <p>
      <span className="text-[var(--fg-secondary)]">{label}：</span>
      <strong>{value}</strong>
    </p>
  );
}

function Spec({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex min-h-11 items-center justify-between gap-4 py-2">
      <dt className="text-[var(--fg-secondary)]">{label}</dt>
      <dd className="font-semibold">{value}</dd>
    </div>
  );
}

function Evidence({ label, value, wide = false }: { label: string; value: string; wide?: boolean }) {
  return (
    <div className={wide ? "min-w-0 sm:col-span-2" : "min-w-0"}>
      <dt className="text-xs text-[var(--fg-secondary)]">{label}</dt>
      <dd className="mt-1 break-all font-mono text-xs" title={value}>
        {value}
      </dd>
    </div>
  );
}

function formatBytes(bytes: number) {
  return bytes < 1024 ** 2
    ? `${(bytes / 1024).toFixed(1)} KiB`
    : `${(bytes / 1024 ** 2).toFixed(1)} MiB`;
}
