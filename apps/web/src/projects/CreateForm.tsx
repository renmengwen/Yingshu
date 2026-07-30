import { useState } from "react";

import { normalizeName } from "./logic";

export function CreateForm({ kind, busy, onSubmit }: {
  kind: "项目" | "视频";
  busy: boolean;
  onSubmit: (value: string) => Promise<unknown>;
}) {
  const [value, setValue] = useState("");
  const [error, setError] = useState<string>();
  const label = kind === "项目" ? "项目名称" : "视频标题";
  const action = kind === "项目" ? "创建项目" : "创建草稿视频";

  return <form className="grid gap-3 border-b border-[var(--border-subtle)] p-5 md:grid-cols-[minmax(0,1fr)_auto] md:p-7" onSubmit={(event) => {
    event.preventDefault();
    if (busy) return;
    try {
      const normalized = normalizeName(value, label);
      setError(undefined);
      void onSubmit(normalized).then(() => setValue("")).catch((cause: Error) => setError(cause.message));
    } catch (cause) {
      setError((cause as Error).message);
    }
  }}>
    <label className="grid gap-2 text-sm font-semibold">{label}
      <input className="min-h-11 rounded border border-[var(--border-strong)] bg-[var(--bg-surface)] px-3 font-normal outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus)]" value={value} disabled={busy} aria-invalid={!!error} aria-describedby={error ? `${kind}-name-error` : undefined} onChange={(event) => setValue(event.target.value)} placeholder={kind === "项目" ? "例如：产品功能讲解" : "例如：3分钟介绍核心功能"} />
      {error ? <span id={`${kind}-name-error`} className="font-normal text-[var(--danger)]" role="alert">{error}</span> : null}
    </label>
    <button className="min-h-11 self-end rounded bg-[var(--accent)] px-5 text-sm font-semibold text-[var(--accent-contrast)] hover:bg-[var(--accent-strong)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus)] disabled:cursor-not-allowed disabled:opacity-50" type="submit" disabled={busy}>{busy ? `正在${action}…` : action}</button>
  </form>;
}
