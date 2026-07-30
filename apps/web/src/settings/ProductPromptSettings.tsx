import { useEffect, useState } from "react";

import { responseJson } from "../client-logic";

export interface ProductPromptSet {
  setVersion: string;
  titles: Record<string, string>;
  versions: Record<string, string>;
  prompts: Record<string, string>;
}

export function ProductPromptSettings() {
  const [promptSet, setPromptSet] = useState<ProductPromptSet>();
  const [error, setError] = useState<string>();

  useEffect(() => {
    const controller = new AbortController();
    fetch("/api/product-prompts", { signal: controller.signal })
      .then((response) => responseJson<ProductPromptSet>(response))
      .then(setPromptSet)
      .catch((cause) => {
        if (!(cause instanceof DOMException && cause.name === "AbortError")) setError((cause as Error).message);
      });
    return () => controller.abort();
  }, []);

  if (error) return <div className="border border-[var(--danger)] bg-[var(--danger-soft)] px-4 py-3 text-sm text-[var(--danger)]" role="alert">产品级提示词加载失败：{error}</div>;
  if (!promptSet) return <div className="border border-[var(--border-subtle)] bg-[var(--bg-subtle)] px-4 py-3 text-sm text-[var(--fg-secondary)]" role="status">正在读取产品级提示词…</div>;
  return <ProductPromptList promptSet={promptSet} />;
}

export function ProductPromptList({ promptSet }: { promptSet: ProductPromptSet }) {
  return (
    <section className="border border-[var(--border-subtle)]" aria-labelledby="product-prompts-heading">
      <div className="flex items-start justify-between gap-4 border-b border-[var(--border-subtle)] bg-[var(--bg-subtle)] px-4 py-3 max-md:flex-col">
        <div>
          <h2 id="product-prompts-heading" className="m-0 text-lg font-semibold">产品级提示词</h2>
          <p className="mt-1 text-sm leading-6 text-[var(--fg-secondary)]">所有项目与视频任务共用。提示词随产品版本发布，只读展示，不能覆盖运行合同、安全边界或审批门禁。</p>
        </div>
        <span className="whitespace-nowrap font-mono text-xs text-[var(--fg-tertiary)]">{promptSet.setVersion}</span>
      </div>
      <div className="divide-y divide-[var(--border-subtle)]">
        {Object.entries(promptSet.prompts).map(([key, prompt]) => (
          <details key={key} className="group bg-[var(--bg-canvas)]">
            <summary className="flex min-h-14 cursor-pointer list-none items-center justify-between gap-4 px-4 py-3 text-sm font-semibold focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--focus)]">
              <span>{promptSet.titles[key] ?? key}</span>
              <span className="font-mono text-[11px] font-normal text-[var(--fg-tertiary)]">{promptSet.versions[key]}</span>
            </summary>
            <pre className="m-0 whitespace-pre-wrap border-t border-[var(--border-subtle)] bg-[var(--bg-subtle)] p-4 text-xs leading-6 text-[var(--fg-secondary)]">{prompt}</pre>
          </details>
        ))}
      </div>
    </section>
  );
}
