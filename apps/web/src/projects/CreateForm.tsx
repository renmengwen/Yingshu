import { useState } from "react";

import { Button } from "../components/ui/button";
import { Field, FieldError, FieldLabel } from "../components/ui/field";
import { Input } from "../components/ui/input";
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
    <Field data-invalid={!!error}>
      <FieldLabel htmlFor={`${kind}-name`}>{label}</FieldLabel>
      <Input id={`${kind}-name`} value={value} disabled={busy} aria-invalid={!!error} aria-describedby={error ? `${kind}-name-error` : undefined} onChange={(event) => setValue(event.target.value)} placeholder={kind === "项目" ? "例如：产品功能讲解" : "例如：3分钟介绍核心功能"} />
      {error ? <FieldError id={`${kind}-name-error`}>{error}</FieldError> : null}
    </Field>
    <Button className="self-end" type="submit" disabled={busy}>{busy ? `正在${action}…` : action}</Button>
  </form>;
}
