import { useState } from "react";
import { CheckIcon, Settings2Icon } from "lucide-react";

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "../components/ui/alert-dialog";
import { Button } from "../components/ui/button";
import { Checkbox } from "../components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "../components/ui/dialog";
import {
  Field,
  FieldDescription,
  FieldError,
  FieldLabel,
  FieldLegend,
  FieldSet,
} from "../components/ui/field";
import { RadioGroup, RadioGroupItem } from "../components/ui/radio-group";
import { Textarea } from "../components/ui/textarea";
import { INPUT_LIMITS } from "./input-logic";
import { getVideoOutputProfile, normalizeAspectRatio, type VideoInputDraft } from "./types";
import { applyVisualStylePreset, selectedVisualStylePreset, VISUAL_STYLE_PRESETS } from "./visual-style-presets";

type ProductionSettings = Pick<
  VideoInputDraft,
  "aspectRatio" | "targetDurationSeconds" | "visualDensity" | "visualInstructions" | "webEnabled" | "scriptInstructions"
>;

interface VideoProductionSettingsDialogProps {
  disabled: boolean;
  settings: ProductionSettings;
  onApply: (settings: ProductionSettings) => void;
}

export const segmentedOptionClass = "focus-ring-proxy flex min-h-11 w-full cursor-pointer items-center justify-center rounded-md border border-border px-3 text-center text-sm font-medium has-data-[state=checked]:border-primary has-data-[state=checked]:bg-[var(--surface-selected)] has-data-[state=checked]:text-[var(--accent-strong)]";
export const hiddenRadioClass = "sr-only absolute! size-px!";

const codePointLength = (value: string) => [...value].length;

export function instructionLimitMessage(value: string) {
  const exceeded = codePointLength(value) - INPUT_LIMITS.instructionsCodePoints;
  return exceeded > 0 ? `已超过 ${INPUT_LIMITS.instructionsCodePoints.toLocaleString()} 字，请删除 ${exceeded.toLocaleString()} 字后再应用。` : null;
}

export function VideoProductionSettingsDialog({ disabled, settings, onApply }: VideoProductionSettingsDialogProps) {
  const [open, setOpen] = useState(false);
  const [discardOpen, setDiscardOpen] = useState(false);
  const [draft, setDraft] = useState(settings);
  const changed = Object.keys(settings).some((key) => draft[key as keyof ProductionSettings] !== settings[key as keyof ProductionSettings]);
  const scriptError = instructionLimitMessage(draft.scriptInstructions);
  const visualError = instructionLimitMessage(draft.visualInstructions);
  const invalid = Boolean(scriptError || visualError);
  const visualStylePreset = selectedVisualStylePreset(draft.visualInstructions);
  const aspectRatio = normalizeAspectRatio(draft.aspectRatio);
  const outputProfile = getVideoOutputProfile(aspectRatio);

  function requestOpen(next: boolean) {
    if (next) {
      setDraft(settings);
      setOpen(true);
      return;
    }
    if (changed) {
      setDiscardOpen(true);
      return;
    }
    setOpen(false);
  }

  function apply() {
    onApply(draft);
    setOpen(false);
  }

  return (
    <>
      <Dialog open={open} onOpenChange={requestOpen}>
        <DialogTrigger asChild>
          <Button type="button" variant="outline" disabled={disabled}>
            <Settings2Icon aria-hidden="true" />
            编辑制作设置
          </Button>
        </DialogTrigger>
        <DialogContent aria-describedby="video-production-settings-description">
          <DialogHeader>
            <DialogTitle>编辑制作设置</DialogTitle>
            <DialogDescription id="video-production-settings-description">
              这些设置只影响当前视频，并随方案一起冻结。应用后会在主页面自动保存。
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-6 p-5 sm:p-6">
            <div className="grid gap-6 sm:grid-cols-2">
              <FieldSet disabled={disabled}>
                <FieldLegend className="mb-0" variant="label">目标时长</FieldLegend>
                <FieldDescription>影响旁白篇幅和预计画面数量。</FieldDescription>
                <RadioGroup className="grid grid-cols-2 gap-2" name="dialog-duration" value={String(draft.targetDurationSeconds)} onValueChange={(value) => setDraft({ ...draft, targetDurationSeconds: Number(value) })}>
                  {([[60, "1 分钟"], [180, "3 分钟"], [300, "5 分钟"], [600, "10 分钟"]] as const).map(([value, label]) => (
                    <FieldLabel className={segmentedOptionClass} key={value}>
                      <RadioGroupItem className={hiddenRadioClass} value={String(value)} />
                      <span>{label}</span>
                    </FieldLabel>
                  ))}
                </RadioGroup>
              </FieldSet>
              <FieldSet disabled={disabled}>
                <FieldLegend className="mb-0" variant="label">画面密度</FieldLegend>
                <RadioGroup className="grid grid-cols-3 gap-2" name="dialog-visual-density" value={draft.visualDensity} onValueChange={(value) => setDraft({ ...draft, visualDensity: value as VideoInputDraft["visualDensity"] })}>
                  {([["relaxed", "舒缓"], ["standard", "标准"], ["compact", "紧凑"]] as const).map(([value, label]) => (
                    <FieldLabel className={segmentedOptionClass} key={value}>
                      <RadioGroupItem className={hiddenRadioClass} value={value} />
                      <span>{label}</span>
                    </FieldLabel>
                  ))}
                </RadioGroup>
                <FieldDescription>{draft.visualDensity === "relaxed" ? "单张画面停留更久。" : draft.visualDensity === "compact" ? "画面切换更频繁。" : "适合大多数讲解视频。"}</FieldDescription>
              </FieldSet>
            </div>
            <FieldSet disabled={disabled}>
              <FieldLegend className="mb-0" variant="label">输出画幅</FieldLegend>
              <FieldDescription id="dialog-aspect-ratio-help">选择成片画幅；摘要、提示词和导出规格会同步跟随。</FieldDescription>
              <RadioGroup className="grid grid-cols-2 gap-2" name="dialog-aspect-ratio" aria-describedby="dialog-aspect-ratio-help" value={aspectRatio} onValueChange={(value) => setDraft({ ...draft, aspectRatio: value as VideoInputDraft["aspectRatio"] })}>
                {([["9:16", "竖屏"], ["16:9", "横屏"]] as const).map(([value, label]) => (
                  <FieldLabel className={segmentedOptionClass} key={value}>
                    <RadioGroupItem className={hiddenRadioClass} value={value} />
                    <span>{label}</span>
                  </FieldLabel>
                ))}
              </RadioGroup>
            </FieldSet>
            <FieldSet disabled={disabled}>
              <FieldLegend className="mb-0" variant="label">生图画风</FieldLegend>
              <FieldDescription id="dialog-visual-style-help">选择基础画风；更细的色彩、构图和禁用项可在下方补充。</FieldDescription>
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-4" role="group" aria-describedby="dialog-visual-style-help" aria-label="生图画风预设">
                {VISUAL_STYLE_PRESETS.map((preset) => (
                  <Button key={preset.id} type="button" variant="outline" className={`${segmentedOptionClass} h-auto whitespace-normal py-2`} aria-pressed={visualStylePreset === preset.id} data-state={visualStylePreset === preset.id ? "checked" : "unchecked"} onClick={() => setDraft({ ...draft, visualInstructions: applyVisualStylePreset(draft.visualInstructions, preset.id) })}>
                    {preset.label}
                  </Button>
                ))}
                <Button type="button" variant="outline" className={`${segmentedOptionClass} h-auto whitespace-normal py-2 sm:col-span-2`} aria-pressed={visualStylePreset === null} data-state={visualStylePreset === null ? "checked" : "unchecked"} onClick={() => setDraft({ ...draft, visualInstructions: applyVisualStylePreset(draft.visualInstructions, null) })}>
                  不使用预设
                </Button>
              </div>
            </FieldSet>
            <div className="grid gap-4 bg-[var(--bg-subtle)] p-4 sm:grid-cols-2">
              <div>
                <h4 className="text-sm font-medium">输出规格</h4>
                <p className="mt-2 font-mono text-sm">{outputProfile.orientation} · {outputProfile.aspectRatio}</p>
                <p className="mt-1 font-mono text-xs text-[var(--fg-tertiary)]">{outputProfile.width} × {outputProfile.height}</p>
              </div>
              <FieldLabel className="flex w-full cursor-pointer items-start gap-3">
                <Checkbox disabled={disabled} checked={draft.webEnabled} onCheckedChange={(checked) => setDraft({ ...draft, webEnabled: checked === true })} />
                <span className="pt-2">
                  <strong className="block text-sm font-medium">联网查证</strong>
                  <span className="mt-1 block text-sm leading-6 text-[var(--fg-secondary)]">{draft.webEnabled ? "生成方案时搜索并冻结可核验来源。" : "仅使用当前输入和参考资料。"}</span>
                </span>
              </FieldLabel>
            </div>
            <Field data-invalid={Boolean(scriptError)}>
              <FieldLabel htmlFor="video-script-instructions">文案补充要求</FieldLabel>
              <FieldDescription id="video-script-help">例如：使用克制、客观的讲解语气，避免营销化表达。</FieldDescription>
              <Textarea id="video-script-instructions" className="min-h-32" aria-describedby="video-script-help video-script-count video-script-error" aria-invalid={Boolean(scriptError)} value={draft.scriptInstructions} onChange={(event) => setDraft({ ...draft, scriptInstructions: event.target.value })} />
              <p id="video-script-count" className={`text-right font-mono text-xs ${scriptError ? "text-[var(--danger)]" : "text-[var(--fg-tertiary)]"}`}>{codePointLength(draft.scriptInstructions).toLocaleString()} / {INPUT_LIMITS.instructionsCodePoints.toLocaleString()}</p>
              <FieldError id="video-script-error">{scriptError}</FieldError>
            </Field>
            <Field data-invalid={Boolean(visualError)}>
              <FieldLabel htmlFor="video-visual-instructions">画面补充要求</FieldLabel>
              <FieldDescription id="video-visual-help">预设内容会显示在第一行；可继续编辑或追加要求，例如避免画面内出现文字和水印。</FieldDescription>
              <Textarea id="video-visual-instructions" className="min-h-32" aria-describedby="video-visual-help video-visual-count video-visual-error" aria-invalid={Boolean(visualError)} value={draft.visualInstructions} onChange={(event) => setDraft({ ...draft, visualInstructions: event.target.value })} />
              <p id="video-visual-count" className={`text-right font-mono text-xs ${visualError ? "text-[var(--danger)]" : "text-[var(--fg-tertiary)]"}`}>{codePointLength(draft.visualInstructions).toLocaleString()} / {INPUT_LIMITS.instructionsCodePoints.toLocaleString()}</p>
              <FieldError id="video-visual-error">{visualError}</FieldError>
            </Field>
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => requestOpen(false)}>取消</Button>
            <Button type="button" disabled={!changed || invalid} onClick={apply}><CheckIcon aria-hidden="true" />应用到草稿</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <AlertDialog open={discardOpen} onOpenChange={setDiscardOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>放弃制作设置修改？</AlertDialogTitle>
            <AlertDialogDescription>当前弹窗中的修改尚未应用到草稿，放弃后无法恢复。</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>继续编辑</AlertDialogCancel>
            <AlertDialogAction onClick={() => { setDiscardOpen(false); setOpen(false); }}>放弃修改</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
