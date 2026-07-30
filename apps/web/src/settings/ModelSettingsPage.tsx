import { useEffect, useMemo, useState } from "react";

import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription,
  AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "../components/ui/alert-dialog";
import {
  activeModelLabel,
  emptyProvider,
  enabledModelSummary,
  loadModelConfig,
  MODEL_PROTOCOLS,
  MODEL_TYPE_INFO,
  MODEL_TYPE_LABELS,
  MODEL_TYPES,
  providerList,
  removeProvider,
  saveModelConfig,
  updateActive,
  updateProvider,
  updateProviderModel,
  type ModelConfig,
  type ModelEntry,
  type ModelProvider,
  type ModelType,
} from "./model-settings";
import { ProductPromptSettings } from "./ProductPromptSettings";

interface ModelSettingsPageProps {
  onBack: () => void;
}

export function ModelSettingsPage({ onBack }: ModelSettingsPageProps) {
  const [section, setSection] = useState<"models" | "prompts">("models");
  const [config, setConfig] = useState<ModelConfig>();
  const [selectedProviderId, setSelectedProviderId] = useState("edge-tts");
  const [status, setStatus] = useState("正在加载模型配置…");
  const [statusTone, setStatusTone] = useState<"info" | "success" | "error" | "warning">("info");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [confirmation, setConfirmation] = useState<
    { type: "delete-provider"; provider: ModelProvider } | { type: "leave" }
  >();

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setStatusTone("info");
    setStatus("正在加载模型配置…");
    loadModelConfig()
      .then((next) => {
        if (cancelled) return;
        setConfig(next);
        setStatusTone("success");
        setStatus("模型配置已加载。敏感字段只显示保存状态，不回显原值。");
      })
      .catch((error: Error) => {
        if (cancelled) return;
        setStatusTone("error");
        setStatus(`模型配置加载失败：${error.message}`);
      })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    if (!dirty) return undefined;
    const handler = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", handler);
    return () => window.removeEventListener("beforeunload", handler);
  }, [dirty]);

  const providers = useMemo(() => config ? providerList(config) : [], [config]);
  const selectedProvider = config?.providers[selectedProviderId] ?? providers[0];

  function patchConfig(next: ModelConfig) {
    setConfig(next);
    setDirty(true);
  }

  function patchProvider(provider: ModelProvider) {
    if (!config) return;
    patchConfig(updateProvider(config, provider));
  }

  function patchModel(provider: ModelProvider, type: ModelType, field: keyof ModelEntry, value: string | boolean | number) {
    if (!config) return;
    patchConfig(updateProviderModel(config, provider, type, field, value));
  }

  function addProvider() {
    if (!config) return;
    const provider = emptyProvider();
    patchConfig(updateProvider(config, provider));
    setSelectedProviderId(provider.id);
    setStatusTone("warning");
    setStatus("已添加供应商草稿。填写名称、Base URL、API Key 和需要启用的模式后，点击顶部保存模型配置。");
  }

  function deleteProvider(provider: ModelProvider) {
    if (!config || provider.kind === "edge-tts") return;
    setConfirmation({ type: "delete-provider", provider });
  }

  function confirmDeleteProvider(provider: ModelProvider) {
    if (!config || provider.kind === "edge-tts") return;
    patchConfig(removeProvider(config, provider.id));
    setSelectedProviderId("edge-tts");
  }

  async function save() {
    if (!config || saving) return;
    setSaving(true);
    setStatusTone("info");
    setStatus("正在保存模型配置，请稍候…");
    try {
      const body = await saveModelConfig(config);
      setConfig(body.config);
      setDirty(false);
      setStatusTone("success");
      setStatus("模型配置已保存。默认 TTS 为 Edge TTS / Chinese - China - Yunjian。");
    } catch (error) {
      setStatusTone("error");
      setStatus(`模型配置保存失败：${(error as Error).message}`);
    } finally {
      setSaving(false);
    }
  }

  function setActive(type: ModelType, value: string) {
    if (!config) return;
    patchConfig(updateActive(config, type, value));
  }

  function back() {
    if (dirty) setConfirmation({ type: "leave" });
    else onBack();
  }

  const statusClasses = {
    info: "border-[var(--border-subtle)] bg-[var(--bg-subtle)] text-[var(--fg-secondary)]",
    success: "border-green-700/25 bg-green-700/10 text-green-800 dark:text-green-200",
    error: "border-red-700/25 bg-red-700/10 text-red-800 dark:text-red-200",
    warning: "border-amber-700/25 bg-amber-700/10 text-amber-800 dark:text-amber-200",
  };

  return (
    <main className="min-h-screen bg-[var(--bg-canvas)] p-7 text-[var(--fg-primary)] max-md:p-0">
      <div className="mx-auto min-h-[calc(100vh-56px)] w-full max-w-[1520px] border border-[var(--border-subtle)] bg-[var(--bg-surface)] max-md:min-h-screen max-md:border-0">
        <header className="flex min-h-28 items-center justify-between gap-6 border-b border-[var(--border-subtle)] px-7 py-6 max-md:flex-col max-md:items-start max-md:px-4">
          <div>
            <p className="mb-2 font-mono text-[11px] font-semibold tracking-[.17em] text-[var(--accent)]">映述 / 全局设置</p>
            <h1 className="m-0 text-3xl font-semibold">设置</h1>
            <p className="mt-2 text-sm text-[var(--fg-secondary)]">管理模型、产品级提示词及后续全局配置。</p>
          </div>
          <div className="flex gap-2 max-md:w-full">
            <button className="min-h-11 rounded border border-[var(--border-strong)] px-4 text-sm text-[var(--fg-secondary)] hover:bg-[var(--bg-subtle)] max-md:flex-1" type="button" onClick={back}>返回上一页</button>
            {section === "models" ? <button className="min-h-11 rounded bg-[var(--accent)] px-4 text-sm font-semibold text-[var(--accent-contrast)] disabled:opacity-50 max-md:flex-1" type="button" disabled={!config || loading || saving} onClick={() => void save()}>{saving ? "正在保存…" : "保存模型配置"}</button> : null}
          </div>
        </header>

        {section === "models" ? <div className={`mx-7 mt-5 rounded border px-4 py-3 text-sm ${statusClasses[statusTone]}`} role={statusTone === "error" ? "alert" : "status"} aria-live="polite">{status}</div> : null}
        <div className="mx-7 mt-3 flex min-h-12 items-center justify-between gap-4 border border-[var(--border-subtle)] bg-[var(--bg-subtle)] px-4 py-2 text-sm text-[var(--fg-secondary)] max-md:flex-col max-md:items-start">
          <span>全局设置由书库与系列工作台共用，不属于七个制作阶段。</span>
          {dirty ? <span className="font-semibold text-amber-700 dark:text-amber-200">模型配置有未保存的修改</span> : <span className="font-mono text-[11px]">入口：顶栏「设置」</span>}
        </div>

        <nav className="mx-7 mt-5 flex gap-1 border-b border-[var(--border-subtle)] max-md:mx-4" aria-label="设置分类">
          {([['models', '模型配置'], ['prompts', '产品级提示词']] as const).map(([id, label]) => <button key={id} type="button" aria-current={section === id ? "page" : undefined} onClick={() => setSection(id)} className={`min-h-11 border-b-2 px-4 text-sm font-semibold ${section === id ? "border-[var(--accent)] text-[var(--fg-primary)]" : "border-transparent text-[var(--fg-secondary)] hover:bg-[var(--bg-subtle)]"}`}>{label}</button>)}
        </nav>

        {section === "models" ? <section className="grid grid-cols-[240px_minmax(0,1fr)] gap-0 px-7 py-6 max-lg:grid-cols-1 max-md:px-4">
          <aside className="border-r border-[var(--border-subtle)] pr-4 max-lg:border-r-0 max-lg:pr-0">
            <p className="mb-3 font-mono text-[11px] font-semibold tracking-[.17em] text-[var(--fg-tertiary)]">供应商</p>
            <button type="button" disabled={!config || loading || saving} onClick={addProvider} className="mb-3 min-h-10 w-full rounded border border-[var(--border-strong)] bg-[var(--bg-inset)] px-3 text-sm font-semibold hover:bg-[var(--bg-subtle)] disabled:opacity-50">添加供应商</button>
            <div className="grid gap-2 max-lg:grid-cols-2 max-sm:grid-cols-1">
              {providers.map((provider) => (
                <button
                  key={provider.id}
                  type="button"
                  className={`min-h-16 rounded border px-3 py-2 text-left text-sm ${provider.id === selectedProvider?.id ? "border-[var(--border-strong)] bg-[var(--accent-soft)]" : "border-[var(--border-subtle)] hover:bg-[var(--bg-subtle)]"}`}
                  onClick={() => setSelectedProviderId(provider.id)}
                >
                  <strong className="block">{provider.name}</strong>
                  <span className="mt-1 block font-mono text-[11px] text-[var(--fg-tertiary)]">{provider.kind === "edge-tts" ? "内置默认" : provider.hasApiKey ? "已保存密钥" : "待配置"}</span>
                  <span className="mt-1 block truncate text-xs text-[var(--fg-secondary)]">{enabledModelSummary(provider)}</span>
                </button>
              ))}
            </div>
          </aside>

          <div className="min-w-0 pl-6 max-lg:mt-6 max-lg:pl-0">
            {config ? (
              <>
                <section className="border border-[var(--border-subtle)]">
                  <div className="border-b border-[var(--border-subtle)] bg-[var(--bg-subtle)] px-4 py-3">
                    <h2 className="m-0 text-lg font-semibold">全局默认模型</h2>
                    <p className="mt-1 text-sm text-[var(--fg-secondary)]">生产任务只读取这里选中的模型；供应商编辑不会自动切换默认值。</p>
                  </div>
                  <div className="grid grid-cols-3 max-lg:grid-cols-1">
                    {MODEL_TYPES.map((type) => (
                      <label key={type} className="grid gap-2 border-r border-[var(--border-subtle)] p-4 last:border-r-0 max-lg:border-b max-lg:border-r-0 max-lg:last:border-b-0">
                        <span className="text-xs font-semibold text-[var(--fg-tertiary)]">{MODEL_TYPE_LABELS[type]}</span>
                        <select className="min-h-11 rounded border border-[var(--border-strong)] bg-[var(--bg-inset)] px-3 text-sm" value={config.active[type] ?? ""} onChange={(event) => setActive(type, event.target.value)}>
                          <option value="">未配置</option>
                          {providers.flatMap((provider) => {
                            const model = provider.models[type];
                            return [<option key={`${provider.id}/${type}`} disabled={!model?.enabled || !model.modelId} value={`${provider.id}/${type}`}>{provider.kind === "edge-tts" ? `${provider.name} / ${model?.voiceLabel || model?.voiceId || model?.modelId || "未配置"}` : `${provider.name} / ${model?.modelId || "未配置"}`}</option>];
                          })}
                        </select>
                        <span className="truncate font-mono text-[11px] text-[var(--fg-tertiary)]">{activeModelLabel(config, type)}</span>
                      </label>
                    ))}
                  </div>
                </section>

                {selectedProvider ? (
                  <ProviderEditor provider={selectedProvider} onChange={patchProvider} onModelChange={patchModel} onDelete={deleteProvider} />
                ) : null}

              </>
            ) : (
              <div className="border border-[var(--border-subtle)] p-8 text-sm text-[var(--fg-secondary)]">{loading ? "正在读取模型配置…" : "模型配置暂不可用。"}</div>
            )}
          </div>
        </section> : <div className="px-7 py-6 max-md:px-4"><ProductPromptSettings /></div>}
        <AlertDialog open={!!confirmation} onOpenChange={(open) => { if (!open) setConfirmation(undefined); }}>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>{confirmation?.type === "leave" ? "放弃未保存的修改？" : "删除这个供应商？"}</AlertDialogTitle>
              <AlertDialogDescription>
                {confirmation?.type === "leave"
                  ? "返回后，本页尚未保存的模型配置将丢失。"
                  : `供应商“${confirmation?.provider.name || confirmation?.provider.id}”将从页面草稿中删除；点击顶部“保存模型配置”后才会持久化。`}
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>取消</AlertDialogCancel>
              <AlertDialogAction onClick={() => {
                const pending = confirmation;
                setConfirmation(undefined);
                if (pending?.type === "leave") onBack();
                else if (pending?.type === "delete-provider") confirmDeleteProvider(pending.provider);
              }}>{confirmation?.type === "leave" ? "放弃修改并返回" : "删除供应商"}</AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </div>
    </main>
  );
}

function ProviderEditor({
  provider,
  onChange,
  onModelChange,
  onDelete,
}: {
  provider: ModelProvider;
  onChange: (provider: ModelProvider) => void;
  onModelChange: (provider: ModelProvider, type: ModelType, field: keyof ModelEntry, value: string | boolean | number) => void;
  onDelete: (provider: ModelProvider) => void;
}) {
  const credentialed = provider.kind !== "edge-tts";
  return (
    <section className="mt-5 border border-[var(--border-subtle)]">
      <div className="flex items-start justify-between gap-4 border-b border-[var(--border-subtle)] bg-[var(--bg-subtle)] px-4 py-3">
        <div>
          <h2 className="m-0 text-lg font-semibold">{provider.name}</h2>
          <p className="mt-1 text-sm text-[var(--fg-secondary)]">{provider.kind === "edge-tts" ? "内置零成本语音供应商，不需要 API Key。" : "像 MuseDock 一样，先在供应商下启用具体模式，再到全局默认模型中选择。"}</p>
        </div>
        <div className="flex items-center gap-2">
          <span className="rounded border border-[var(--border-subtle)] px-2 py-1 text-xs text-[var(--fg-secondary)]">{credentialed && !provider.hasApiKey ? "待配置" : "已启用"}</span>
          {provider.kind !== "edge-tts" ? <button type="button" onClick={() => onDelete(provider)} className="rounded border border-red-700/25 bg-red-700/10 px-3 py-1 text-xs font-semibold text-red-800 dark:text-red-200">删除</button> : null}
        </div>
      </div>
      <div className="grid grid-cols-2 gap-4 p-4 max-lg:grid-cols-1">
        <label className="grid gap-2">
          <span className="text-xs font-semibold text-[var(--fg-tertiary)]">供应商名称</span>
          <input className="min-h-11 rounded border border-[var(--border-strong)] bg-[var(--bg-inset)] px-3 text-sm" value={provider.name} onChange={(event) => onChange({ ...provider, name: event.target.value })} />
        </label>
        {credentialed ? (
          <>
            <label className="grid gap-2">
              <span className="text-xs font-semibold text-[var(--fg-tertiary)]">分析模型协议</span>
              <select className="min-h-11 rounded border border-[var(--border-strong)] bg-[var(--bg-inset)] px-3 text-sm" value={provider.protocol} onChange={(event) => onChange({ ...provider, protocol: event.target.value as ModelProvider["protocol"], baseUrl: provider.baseUrl || (event.target.value === "anthropic-message" ? "https://api.anthropic.com/v1" : "https://api.openai.com/v1") })}>
                {MODEL_PROTOCOLS.map((protocol) => <option key={protocol.id} value={protocol.id}>{protocol.label}</option>)}
              </select>
            </label>
            <label className="grid gap-2">
              <span className="text-xs font-semibold text-[var(--fg-tertiary)]">Base URL</span>
              <input className="min-h-11 rounded border border-[var(--border-strong)] bg-[var(--bg-inset)] px-3 text-sm" value={provider.baseUrl} onChange={(event) => onChange({ ...provider, baseUrl: event.target.value })} />
            </label>
            <label className="grid gap-2 lg:col-span-2">
              <span className="text-xs font-semibold text-[var(--fg-tertiary)]">API Key</span>
              <input className="min-h-11 rounded border border-[var(--border-strong)] bg-[var(--bg-inset)] px-3 text-sm" type="password" value={provider.apiKey} placeholder={provider.hasApiKey ? `已保存 ${provider.apiKeyMasked}；输入新值可替换` : "请输入 API Key"} autoComplete="new-password" onChange={(event) => onChange({ ...provider, apiKey: event.target.value })} />
              <span className="text-xs text-[var(--fg-tertiary)]">保存后不再回显完整值；留空会保留已保存密钥。</span>
            </label>
          </>
        ) : null}
        <div className="grid gap-3 lg:col-span-2">
          {MODEL_TYPES.map((type) => <ModelConfigCard key={type} provider={provider} type={type} model={provider.models[type]} onChange={onModelChange} />)}
        </div>
      </div>
    </section>
  );
}

function ModelConfigCard({
  provider,
  type,
  model,
  onChange,
}: {
  provider: ModelProvider;
  type: ModelType;
  model: ModelEntry;
  onChange: (provider: ModelProvider, type: ModelType, field: keyof ModelEntry, value: string | boolean | number) => void;
}) {
  const edgeTts = provider.kind === "edge-tts" && type === "tts";
  return (
    <div className={`rounded border p-3 ${model.enabled ? "border-[var(--border-strong)] bg-[var(--bg-inset)]" : "border-[var(--border-subtle)] bg-[var(--bg-canvas)]"}`}>
      <label className="flex min-h-8 items-center gap-3">
        <input type="checkbox" checked={model.enabled} disabled={edgeTts} onChange={(event) => onChange(provider, type, "enabled", event.target.checked)} />
        <span className="text-sm font-semibold">{MODEL_TYPE_INFO[type].title}</span>
        <span className="text-xs text-[var(--fg-tertiary)]">{MODEL_TYPE_INFO[type].help}</span>
      </label>
      <div className="mt-3 grid grid-cols-2 gap-3 max-lg:grid-cols-1">
        <label className="grid gap-2">
          <span className="text-xs font-semibold text-[var(--fg-tertiary)]">{edgeTts ? "NPM 包 / 模型" : "模型 ID"}</span>
          <input className="min-h-10 rounded border border-[var(--border-strong)] bg-[var(--bg-inset)] px-3 text-sm disabled:opacity-60" value={model.modelId} disabled={!model.enabled || edgeTts} placeholder={MODEL_TYPE_INFO[type].placeholder} onChange={(event) => onChange(provider, type, "modelId", event.target.value)} />
        </label>
        <label className="grid gap-2">
          <span className="text-xs font-semibold text-[var(--fg-tertiary)]">备注</span>
          <input className="min-h-10 rounded border border-[var(--border-strong)] bg-[var(--bg-inset)] px-3 text-sm disabled:opacity-60" value={model.note} disabled={!model.enabled} placeholder="用途、限制或价格说明" onChange={(event) => onChange(provider, type, "note", event.target.value)} />
        </label>
        {type === "text" && model.enabled ? (
          <label className="flex items-center gap-2 text-sm text-[var(--fg-secondary)]">
            <input type="checkbox" checked={model.supportsMultimodal === true} onChange={(event) => onChange(provider, type, "supportsMultimodal", event.target.checked)} />
            支持多模态输入
          </label>
        ) : null}
        {type === "tts" && model.enabled ? (
          <>
            <label className="grid gap-2">
              <span className="text-xs font-semibold text-[var(--fg-tertiary)]">Voice ID</span>
              <input className="min-h-10 rounded border border-[var(--border-strong)] bg-[var(--bg-inset)] px-3 text-sm" value={model.voiceId ?? ""} disabled={edgeTts} placeholder="Chinese_deep_voiced_male_nv1" onChange={(event) => onChange(provider, type, "voiceId", event.target.value)} />
            </label>
            {edgeTts ? <div className="grid gap-2">
              <span className="text-xs font-semibold text-[var(--fg-tertiary)]">Language / Gender / 字幕边界</span>
              <div className="min-h-10 rounded border border-[var(--border-subtle)] bg-[var(--bg-subtle)] px-3 py-2 text-sm">中文 / 男性 / {model.voiceLabel || "Chinese - China - Yunjian"} / 逐词字幕开启</div>
            </div> : null}
            <label className="grid gap-2">
              <span className="text-xs font-semibold text-[var(--fg-tertiary)]">并发</span>
              <input type="number" min={1} max={5} className="min-h-10 rounded border border-[var(--border-strong)] bg-[var(--bg-inset)] px-3 text-sm" value={model.ttsConcurrency ?? 1} onChange={(event) => onChange(provider, type, "ttsConcurrency", Number(event.target.value))} />
            </label>
            <label className="grid gap-2">
              <span className="text-xs font-semibold text-[var(--fg-tertiary)]">队列间隔 ms</span>
              <input type="number" min={0} max={10000} step={100} className="min-h-10 rounded border border-[var(--border-strong)] bg-[var(--bg-inset)] px-3 text-sm" value={model.ttsQueueIntervalMs ?? 1800} onChange={(event) => onChange(provider, type, "ttsQueueIntervalMs", Number(event.target.value))} />
            </label>
          </>
        ) : null}
      </div>
    </div>
  );
}
