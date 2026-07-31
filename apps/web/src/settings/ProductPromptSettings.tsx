import { useEffect, useRef, useState } from "react";

import { responseJson } from "../client-logic";

export const PRODUCT_PROMPT_INSTRUCTION_MAX_CODE_POINTS = 20_000;

export interface ProductPromptSettingsValue {
  scriptInstructions: string;
  visualInstructions: string;
  updatedAt: number;
}

interface ProductPromptSettingsResponse {
  ok: true;
  settings: ProductPromptSettingsValue;
}

interface ProductPromptSettingsProps {
  onDirtyChange?: (dirty: boolean) => void;
}

type StatusTone = "info" | "success" | "error" | "warning";

export function normalizeProductPromptInstructions(value: string) {
  return value.replace(/\r\n?/g, "\n").trim();
}

export function validateProductPromptInstructions(value: string, label: string) {
  const count = [...normalizeProductPromptInstructions(value)].length;
  return count > PRODUCT_PROMPT_INSTRUCTION_MAX_CODE_POINTS
    ? `${label}不能超过 ${PRODUCT_PROMPT_INSTRUCTION_MAX_CODE_POINTS.toLocaleString("zh-CN")} 个字符，请删减后重试。`
    : undefined;
}

export function ProductPromptSettings({ onDirtyChange }: ProductPromptSettingsProps) {
  const [saved, setSaved] = useState<ProductPromptSettingsValue>();
  const [scriptInstructions, setScriptInstructions] = useState("");
  const [visualInstructions, setVisualInstructions] = useState("");
  const [status, setStatus] = useState("正在读取全局创作补充…");
  const [statusTone, setStatusTone] = useState<StatusTone>("info");
  const [loading, setLoading] = useState(true);
  const [loadFailed, setLoadFailed] = useState(false);
  const [loadAttempt, setLoadAttempt] = useState(0);
  const [saving, setSaving] = useState(false);
  const busyRef = useRef(false);

  const dirty = !!saved && (
    scriptInstructions !== saved.scriptInstructions
    || visualInstructions !== saved.visualInstructions
  );

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setLoadFailed(false);
    setStatusTone("info");
    setStatus("正在读取全局创作补充…");
    fetch("/api/product-prompts", { signal: controller.signal })
      .then((response) => responseJson<ProductPromptSettingsResponse>(response))
      .then((body) => {
        setSaved(body.settings);
        setScriptInstructions(body.settings.scriptInstructions);
        setVisualInstructions(body.settings.visualInstructions);
        setStatusTone("success");
        setStatus("全局创作补充已加载。");
      })
      .catch((cause: Error) => {
        if (cause.name !== "AbortError") setLoadFailed(true);
        setStatusTone(cause.name === "AbortError" ? "warning" : "error");
        setStatus(cause.name === "AbortError"
          ? "读取已中断。重新打开设置后可再次读取。"
          : `全局创作补充加载失败：${cause.message}。请检查后端连接后重试。`);
      })
      .finally(() => setLoading(false));
    return () => controller.abort();
  }, [loadAttempt]);

  useEffect(() => onDirtyChange?.(dirty), [dirty, onDirtyChange]);

  useEffect(() => {
    if (!dirty) return undefined;
    const handler = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", handler);
    return () => window.removeEventListener("beforeunload", handler);
  }, [dirty]);

  async function save() {
    if (!saved || busyRef.current) return;
    const scriptError = validateProductPromptInstructions(scriptInstructions, "全局文案补充");
    const visualError = validateProductPromptInstructions(visualInstructions, "全局画面补充");
    if (scriptError || visualError) {
      setStatusTone("error");
      setStatus(scriptError ?? visualError ?? "输入内容无效，请修改后重试。");
      return;
    }

    busyRef.current = true;
    setSaving(true);
    setStatusTone("info");
    setStatus("正在保存全局创作补充，请稍候…");
    try {
      const response = await fetch("/api/product-prompts", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          scriptInstructions: normalizeProductPromptInstructions(scriptInstructions),
          visualInstructions: normalizeProductPromptInstructions(visualInstructions),
        }),
      });
      const body = await responseJson<ProductPromptSettingsResponse>(response);
      setSaved(body.settings);
      setScriptInstructions(body.settings.scriptInstructions);
      setVisualInstructions(body.settings.visualInstructions);
      setStatusTone("success");
      setStatus("全局创作补充已保存，将用于后续生成。");
    } catch (cause) {
      const error = cause as Error;
      setStatusTone(error.name === "AbortError" ? "warning" : "error");
      setStatus(error.name === "AbortError"
        ? "保存已中断。请重新读取设置，确认服务端是否已经保存。"
        : `全局创作补充保存失败：${error.message}。修改内容仍保留，可再次保存。`);
    } finally {
      busyRef.current = false;
      setSaving(false);
    }
  }

  const statusClasses: Record<StatusTone, string> = {
    info: "border-[var(--border-subtle)] bg-[var(--bg-subtle)] text-[var(--fg-secondary)]",
    success: "border-[var(--status-success)] bg-[var(--status-success-soft)] text-[var(--status-success)]",
    error: "border-[var(--danger)] bg-[var(--danger-soft)] text-[var(--danger)]",
    warning: "border-[var(--status-warning)] bg-[var(--status-warning-soft)] text-[var(--status-warning)]",
  };

  return (
    <section className="border border-[var(--border-subtle)]" aria-labelledby="product-prompts-heading">
      <div className="border-b border-[var(--border-subtle)] bg-[var(--bg-subtle)] px-4 py-4">
        <h2 id="product-prompts-heading" className="m-0 text-lg font-semibold">全局创作补充</h2>
        <p className="mt-1 text-sm leading-6 text-[var(--fg-secondary)]">影响所有项目后续发起的生成。固定系统合同和安全边界由产品控制，不能在这里覆盖。</p>
      </div>

      <div className={`mx-4 mt-4 flex min-h-11 items-center justify-between gap-3 border px-4 py-3 text-sm ${statusClasses[statusTone]}`} role={statusTone === "error" ? "alert" : "status"} aria-live="polite">
        <span>{status}</span>
        {loadFailed ? <button className="min-h-11 shrink-0 rounded border border-current px-3 font-semibold focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus)]" type="button" disabled={loading} onClick={() => setLoadAttempt((value) => value + 1)}>重新读取</button> : null}
      </div>

      <div className="grid grid-cols-2 gap-5 p-4 max-lg:grid-cols-1">
        <div className="grid gap-2">
          <label className="text-sm font-semibold" htmlFor="global-script-instructions">全局文案补充</label>
          <span id="global-script-instructions-help" className="text-xs leading-5 text-[var(--fg-tertiary)]">用于补充通用叙述风格和文案偏好，不得改变事实边界或生成合同。</span>
          <textarea
            id="global-script-instructions"
            aria-describedby="global-script-instructions-help"
            className="min-h-48 resize-y rounded border border-[var(--border-strong)] bg-[var(--bg-inset)] px-3 py-3 text-sm leading-6 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus)] disabled:opacity-60"
            disabled={loading || saving}
            value={scriptInstructions}
            onChange={(event) => setScriptInstructions(event.target.value)}
            placeholder="例如：开头尽快进入具体问题，表达克制，不使用营销话术。"
          />
        </div>
        <div className="grid gap-2">
          <label className="text-sm font-semibold" htmlFor="global-visual-instructions">全局画面补充</label>
          <span id="global-visual-instructions-help" className="text-xs leading-5 text-[var(--fg-tertiary)]">用于补充通用视觉风格和构图偏好，不会开放固定画幅或安全约束。</span>
          <textarea
            id="global-visual-instructions"
            aria-describedby="global-visual-instructions-help"
            className="min-h-48 resize-y rounded border border-[var(--border-strong)] bg-[var(--bg-inset)] px-3 py-3 text-sm leading-6 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus)] disabled:opacity-60"
            disabled={loading || saving}
            value={visualInstructions}
            onChange={(event) => setVisualInstructions(event.target.value)}
            placeholder="例如：暖中性色调，主体清楚，避免无来源文字和平台界面。"
          />
        </div>
      </div>

      <div className="flex min-h-16 items-center justify-between gap-4 border-t border-[var(--border-subtle)] px-4 py-3 max-md:flex-col max-md:items-stretch">
        <span className="text-xs text-[var(--fg-tertiary)]">每项最多 {PRODUCT_PROMPT_INSTRUCTION_MAX_CODE_POINTS.toLocaleString("zh-CN")} 个 Unicode 字符。{dirty ? "有未保存的修改。" : saved?.updatedAt ? `服务端更新：${saved.updatedAt}` : ""}</span>
        <button className="min-h-11 rounded bg-[var(--accent)] px-5 text-sm font-semibold text-[var(--accent-contrast)] hover:bg-[var(--accent-strong)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus)] disabled:cursor-not-allowed disabled:opacity-50" type="button" disabled={!saved || loading || saving || !dirty} onClick={() => void save()}>{saving ? "正在保存…" : "保存全局创作补充"}</button>
      </div>
    </section>
  );
}
