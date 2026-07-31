import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription,
  AlertDialogFooter, AlertDialogHeader, AlertDialogTitle, AlertDialogTrigger,
} from "../components/ui/alert-dialog";
import type { VideoInputDraft } from "./types";

export function VideoPlanLauncher({ input, dirty, busy, modelLabel, modelAvailable, onStart }: {
  input: VideoInputDraft;
  dirty: boolean;
  busy: boolean;
  modelLabel: string;
  modelAvailable: boolean;
  onStart: () => void;
}) {
  const webBlocked = input.webEnabled;
  const disabled = dirty || busy || !modelAvailable || webBlocked;
  return <section className="border-t border-[var(--border-subtle)] pt-6" aria-labelledby="plan-launch-heading">
    <h3 id="plan-launch-heading" className="text-base font-semibold">创建文案与画面方案</h3>
    <p className="mt-2 text-sm leading-6 text-[var(--fg-secondary)]">启动时会冻结当前输入、提示词、联网开关和文本模型配置。后续设置变化不会改写本次任务。</p>
    <dl className="mt-4 grid gap-x-5 gap-y-3 border-y border-[var(--border-subtle)] bg-[var(--bg-subtle)] px-4 py-4 text-sm sm:grid-cols-2">
      <div><dt className="text-[var(--fg-tertiary)]">文本模型 / Provider</dt><dd className="mt-1 font-medium">{modelLabel}</dd></div>
      <div><dt className="text-[var(--fg-tertiary)]">目标时长</dt><dd className="mt-1 font-mono">约 {input.targetDurationSeconds} 秒</dd></div>
      <div><dt className="text-[var(--fg-tertiary)]">联网</dt><dd className="mt-1">{input.webEnabled ? "已开启" : "已关闭，本次不联网核验"}</dd></div>
      <div><dt className="text-[var(--fg-tertiary)]">预计步骤</dt><dd className="mt-1">资料准备 → 旁白 → 画面规划</dd></div>
    </dl>
    {webBlocked ? <p className="mt-4 border border-[var(--warning)] bg-[var(--warning-soft)] px-3 py-3 text-sm leading-6 text-[var(--warning)]" role="alert">当前文本模型没有受支持的联网来源返回路径，无法执行开启联网的任务。请关闭“本次允许联网”并保存草稿后再生成。</p> : null}
    {!modelAvailable ? <p className="mt-4 text-sm text-[var(--danger)]" role="alert">文本模型不可用。请先在设置中选择并保存分析与改编模型。</p> : null}
    <div className="mt-5 flex flex-wrap items-center gap-3">
      <AlertDialog>
        <AlertDialogTrigger asChild><button className="min-h-11 rounded bg-[var(--accent)] px-5 text-sm font-semibold text-[var(--accent-contrast)] hover:bg-[var(--accent-strong)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus)] disabled:cursor-not-allowed disabled:opacity-50" type="button" disabled={disabled}>{busy ? "正在创建任务…" : "创建并生成方案"}</button></AlertDialogTrigger>
        <AlertDialogContent>
          <AlertDialogHeader><AlertDialogTitle>确认创建方案</AlertDialogTitle><AlertDialogDescription asChild><div className="grid gap-3"><p>本次使用 <strong>{modelLabel}</strong>，目标约 {input.targetDurationSeconds} 秒，{input.webEnabled ? "允许联网" : "不联网核验"}。</p><p>任务会准备资料、生成旁白并规划画面。不会自动生成图片、TTS、字幕或视频，也不会伪造精确费用。</p></div></AlertDialogDescription></AlertDialogHeader>
          <AlertDialogFooter><AlertDialogCancel>返回检查</AlertDialogCancel><AlertDialogAction className="bg-[var(--accent)] text-[var(--accent-contrast)] hover:bg-[var(--accent-strong)]" onClick={onStart}>确认创建</AlertDialogAction></AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      <span className="text-sm text-[var(--fg-tertiary)]">{dirty ? "请先保存当前输入修改。" : "不会自动生成图片、TTS、字幕或视频；生成完成后必须人工审核。"}</span>
    </div>
  </section>;
}
