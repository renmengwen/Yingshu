import { useState } from "react";

import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription,
  AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "../components/ui/alert-dialog";
import { Button } from "../components/ui/button";
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger,
} from "../components/ui/dialog";
import { Field, FieldDescription, FieldError, FieldLabel } from "../components/ui/field";
import { Textarea } from "../components/ui/textarea";
import { INPUT_LIMITS } from "./input-logic";

interface VideoPromptInstructionsDialogProps {
  disabled: boolean;
  scriptInstructions: string;
  visualInstructions: string;
  onApply: (scriptInstructions: string, visualInstructions: string) => void;
}

const codePointLength = (value: string) => [...value].length;

export const VISUAL_STYLE_PRESETS = [
  { id: "realistic", label: "写实摄影", description: "真实材质与自然光，画面可信，保持摄影质感。" },
  { id: "cinematic", label: "电影纪实", description: "电影级光影与克制调色，真实环境细节，中等景深。" },
  { id: "anime", label: "日系动漫", description: "精致二维赛璐璐，清晰线条与层次光影，避免真人质感。" },
  { id: "chinese", label: "国风插画", description: "当代国风插画，含蓄色彩与水墨肌理，主体清晰。" },
  { id: "vector", label: "扁平矢量", description: "简洁几何造型、纯色色块、清晰轮廓与信息图式构图。" },
  { id: "line-art", label: "手绘线稿", description: "黑白手绘线稿，结构准确、疏密有序，辅以少量灰度阴影。" },
  { id: "3d-cartoon", label: "3D 卡通", description: "风格化三维角色与场景，柔和布光，圆润材质，空间层次清楚。" },
  { id: "retro-collage", label: "复古拼贴", description: "复古印刷色、颗粒肌理与拼贴构图，保留清楚的视觉焦点。" },
] as const;

export type VisualStylePresetId = typeof VISUAL_STYLE_PRESETS[number]["id"];

const visualStyleLinePattern = /^【画风预设：([^】\r\n]+)】[^\r\n]*(?:\r?\n)?/u;

export function selectedVisualStylePreset(value: string): VisualStylePresetId | null {
  const label = value.match(visualStyleLinePattern)?.[1];
  return VISUAL_STYLE_PRESETS.find((preset) => preset.label === label)?.id ?? null;
}

export function applyVisualStylePreset(value: string, presetId: VisualStylePresetId | null) {
  const customInstructions = value.replace(visualStyleLinePattern, "");
  const preset = VISUAL_STYLE_PRESETS.find((item) => item.id === presetId);
  return preset
    ? `【画风预设：${preset.label}】${preset.description}${customInstructions ? `\n${customInstructions}` : ""}`
    : customInstructions;
}

export function instructionLimitMessage(value: string) {
  const exceeded = codePointLength(value) - INPUT_LIMITS.instructionsCodePoints;
  return exceeded > 0 ? `已超过 ${INPUT_LIMITS.instructionsCodePoints.toLocaleString()} 字，请删除 ${exceeded.toLocaleString()} 字后再应用。` : null;
}

export function promptInstructionsStatus(scriptInstructions: string, visualInstructions: string) {
  const preset = VISUAL_STYLE_PRESETS.find((item) => item.id === selectedVisualStylePreset(visualInstructions));
  const configured = [scriptInstructions.trim() && "文案", visualInstructions.trim() && (preset ? `画面（${preset.label}）` : "画面")].filter(Boolean);
  return configured.length ? `已设置：${configured.join("、")}` : "未设置";
}

export function VideoPromptInstructionsDialog({ disabled, scriptInstructions, visualInstructions, onApply }: VideoPromptInstructionsDialogProps) {
  const [open, setOpen] = useState(false);
  const [discardOpen, setDiscardOpen] = useState(false);
  const [scriptDraft, setScriptDraft] = useState(scriptInstructions);
  const [visualDraft, setVisualDraft] = useState(visualInstructions);
  const changed = scriptDraft !== scriptInstructions || visualDraft !== visualInstructions;
  const scriptError = instructionLimitMessage(scriptDraft);
  const visualError = instructionLimitMessage(visualDraft);
  const invalid = Boolean(scriptError || visualError);

  function requestOpen(next: boolean) {
    if (next) {
      setScriptDraft(scriptInstructions);
      setVisualDraft(visualInstructions);
      setOpen(true);
    } else if (changed) {
      setDiscardOpen(true);
    } else {
      setOpen(false);
    }
  }

  function apply() {
    onApply(scriptDraft, visualDraft);
    setOpen(false);
  }

  return <>
    <Dialog open={open} onOpenChange={requestOpen}>
      <DialogTrigger asChild><Button type="button" variant="outline" disabled={disabled}>编辑提示词</Button></DialogTrigger>
      <DialogContent aria-describedby="video-prompt-dialog-description">
        <DialogHeader>
          <DialogTitle>编辑当前视频提示词</DialogTitle>
          <DialogDescription id="video-prompt-dialog-description">这些补充只影响当前视频，不会修改项目或全局设置。应用后仍需保存草稿。</DialogDescription>
        </DialogHeader>
        <div className="grid gap-6 p-5 sm:p-6">
          <Field data-invalid={Boolean(scriptError)}>
            <FieldLabel htmlFor="video-script-instructions">文案补充要求</FieldLabel>
            <FieldDescription id="video-script-help">例如：使用克制、客观的讲解语气，避免营销化表达。</FieldDescription>
            <Textarea id="video-script-instructions" className="min-h-40" aria-describedby="video-script-help video-script-count video-script-error" aria-invalid={Boolean(scriptError)} value={scriptDraft} onChange={(event) => setScriptDraft(event.target.value)} />
            <p id="video-script-count" className={`text-right font-mono text-xs ${scriptError ? "text-[var(--danger)]" : "text-[var(--fg-tertiary)]"}`}>{codePointLength(scriptDraft).toLocaleString()} / {INPUT_LIMITS.instructionsCodePoints.toLocaleString()}</p>
            <FieldError id="video-script-error">{scriptError}</FieldError>
          </Field>
          <Field data-invalid={Boolean(visualError)}>
            <FieldLabel htmlFor="video-visual-instructions">画面补充要求</FieldLabel>
            <FieldDescription id="video-visual-help">预设内容会显示在第一行；可继续编辑或追加要求，例如避免画面内出现文字和水印。</FieldDescription>
            <Textarea id="video-visual-instructions" className="min-h-40" aria-describedby="video-visual-help video-visual-count video-visual-error" aria-invalid={Boolean(visualError)} value={visualDraft} onChange={(event) => setVisualDraft(event.target.value)} />
            <p id="video-visual-count" className={`text-right font-mono text-xs ${visualError ? "text-[var(--danger)]" : "text-[var(--fg-tertiary)]"}`}>{codePointLength(visualDraft).toLocaleString()} / {INPUT_LIMITS.instructionsCodePoints.toLocaleString()}</p>
            <FieldError id="video-visual-error">{visualError}</FieldError>
          </Field>
        </div>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => requestOpen(false)}>取消</Button>
          <Button type="button" disabled={!changed || invalid} onClick={apply}>应用到草稿</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
    <AlertDialog open={discardOpen} onOpenChange={setDiscardOpen}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>放弃提示词修改？</AlertDialogTitle>
          <AlertDialogDescription>当前弹框中的修改尚未应用到草稿，放弃后无法恢复。</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>继续编辑</AlertDialogCancel>
          <AlertDialogAction onClick={() => { setDiscardOpen(false); setOpen(false); }}>放弃修改</AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  </>;
}
