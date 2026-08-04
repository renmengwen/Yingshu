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

export function instructionLimitMessage(value: string) {
  const exceeded = codePointLength(value) - INPUT_LIMITS.instructionsCodePoints;
  return exceeded > 0 ? `已超过 ${INPUT_LIMITS.instructionsCodePoints.toLocaleString()} 字，请删除 ${exceeded.toLocaleString()} 字后再应用。` : null;
}

export function promptInstructionsStatus(scriptInstructions: string, visualInstructions: string) {
  const configured = [scriptInstructions.trim() && "文案", visualInstructions.trim() && "画面"].filter(Boolean);
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
            <FieldDescription id="video-visual-help">例如：使用写实摄影风格，避免画面内出现文字和水印。</FieldDescription>
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
