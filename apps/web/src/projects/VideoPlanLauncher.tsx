import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription,
  AlertDialogFooter, AlertDialogHeader, AlertDialogTitle, AlertDialogTrigger,
} from "../components/ui/alert-dialog";
import { Button } from "../components/ui/button";
import { validateVideoInput } from "./input-logic";
import type { VideoInputDraft, VideoPlanEntryMode } from "./types";

export function videoPlanLaunchBlockReason(input: VideoInputDraft, dirty: boolean, busy: boolean, modelAvailable: boolean,
  entryMode: VideoPlanEntryMode = "primary_input", entryBlockReason: string | null = null) {
  if (busy) return "正在处理当前操作，请稍候。";
  if (dirty) return "正在自动保存当前修改，请稍候。";
  if (entryBlockReason) return entryBlockReason;
  if (entryMode === "primary_input") {
    try { validateVideoInput(input); }
    catch (error) { return error instanceof Error ? `${error.message}。` : "当前输入无效，请检查后重试。"; }
  }
  return modelAvailable ? null : "请先在设置中配置可用的文本模型。";
}

export function videoPlanLaunchConfirmation(input: VideoInputDraft, modelLabel: string) {
  return {
    modelLabel,
    duration: `约 ${input.targetDurationSeconds} 秒`,
    web: input.webEnabled ? "已开启，将检索并冻结可核验来源" : "已关闭，仅使用当前输入和参考资料",
    steps: "资料准备 → 旁白 → 画面规划",
    boundary: "本次不会自动生成图片、配音、字幕或视频；方案生成后仍需人工审核。",
  };
}

export function VideoPlanLauncher({ input, dirty, busy, modelLabel, modelAvailable, entryMode = "primary_input",
  entryBlockReason = null, onStart }: {
  input: VideoInputDraft;
  dirty: boolean;
  busy: boolean;
  modelLabel: string;
  modelAvailable: boolean;
  entryMode?: VideoPlanEntryMode;
  entryBlockReason?: string | null;
  onStart: () => void;
}) {
  const disabled = Boolean(videoPlanLaunchBlockReason(input, dirty, busy, modelAvailable, entryMode, entryBlockReason));
  const confirmation = videoPlanLaunchConfirmation(input, modelLabel);
  return <AlertDialog>
    <AlertDialogTrigger asChild>
      <Button type="button" disabled={disabled}>{busy ? "正在创建任务…" : "生成文案与画面方案"}</Button>
    </AlertDialogTrigger>
    <AlertDialogContent>
      <AlertDialogHeader>
        <AlertDialogTitle>确认生成文案与画面方案</AlertDialogTitle>
        <AlertDialogDescription asChild>
          <div className="grid gap-4">
            <p>任务会冻结当前输入、提示词、联网设置和文本模型配置。</p>
            <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-2 text-[var(--fg-primary)]">
              <dt>文本模型</dt><dd className="break-words font-medium">{confirmation.modelLabel}</dd>
              <dt>目标时长</dt><dd>{confirmation.duration}</dd>
              <dt>联网查证</dt><dd>{confirmation.web}</dd>
              <dt>预计步骤</dt><dd>{confirmation.steps}</dd>
            </dl>
            <p>{confirmation.boundary}</p>
          </div>
        </AlertDialogDescription>
      </AlertDialogHeader>
      <AlertDialogFooter>
        <AlertDialogCancel>返回检查</AlertDialogCancel>
        <AlertDialogAction className="bg-[var(--accent)] text-[var(--accent-contrast)] hover:bg-[var(--accent-strong)]" onClick={onStart}>确认生成</AlertDialogAction>
      </AlertDialogFooter>
    </AlertDialogContent>
  </AlertDialog>;
}
