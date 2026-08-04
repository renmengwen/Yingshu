import type { VideoPlan, VideoScriptParagraph, VideoVisualDraft } from "../types";

export const DEFAULT_PAGE_SIZE = 10;
export const PAGE_SIZE_OPTIONS = [10, 20] as const;

export function normalizePageSize(pageSize: number) {
  return PAGE_SIZE_OPTIONS.includes(pageSize as (typeof PAGE_SIZE_OPTIONS)[number]) ? pageSize : DEFAULT_PAGE_SIZE;
}

export function paginate<T>(items: readonly T[], requestedPage: number, requestedPageSize = DEFAULT_PAGE_SIZE) {
  const pageSize = normalizePageSize(requestedPageSize);
  const totalPages = Math.max(1, Math.ceil(items.length / pageSize));
  const page = Math.min(Math.max(1, Math.trunc(requestedPage) || 1), totalPages);
  const start = (page - 1) * pageSize;
  return { items: items.slice(start, start + pageSize), page, pageSize, totalPages, totalItems: items.length };
}

export function isScriptDirty(
  draft: { title: string; summary: string; paragraphs: VideoScriptParagraph[] },
  saved: Pick<VideoPlan["script"], "title" | "summary" | "paragraphs">,
) {
  return JSON.stringify(draft) !== JSON.stringify({ title: saved.title, summary: saved.summary, paragraphs: saved.paragraphs });
}

export function isVisualDirty(draft: VideoVisualDraft[], saved: readonly VideoVisualDraft[]) {
  return JSON.stringify(draft) !== JSON.stringify(saved);
}

export function isPlanIncompatible(plan: Pick<VideoPlan, "script" | "visual">) {
  return plan.visual.scriptRevisionId !== plan.script.id || plan.visual.scriptContentHash !== plan.script.contentHash;
}

export function syncVisualDrafts(
  currentVisuals: VideoVisualDraft[],
  previousVisualRevisionId: string | null,
  nextVisualRevision: Pick<VideoPlan["visual"], "id" | "visuals">,
) {
  // 保存旁白会更换 script ID，但画面草稿只应在服务端画面修订真的变化时被覆盖。
  return previousVisualRevisionId !== nextVisualRevision.id ? nextVisualRevision.visuals : currentVisuals;
}

export function adjacentVisualIdAfterDelete(visualIds: readonly string[], deletedId: string) {
  const deletedIndex = visualIds.indexOf(deletedId);
  if (deletedIndex < 0) return null;
  return visualIds[deletedIndex + 1] ?? visualIds[deletedIndex - 1] ?? null;
}

type Gate = { allowed: boolean; reason: string | null };

function allow(): Gate {
  return { allowed: true, reason: null };
}

function block(reason: string): Gate {
  return { allowed: false, reason };
}

export function planReviewGates({
  busy,
  stale,
  scriptDirty,
  visualDirty,
  incompatible,
  approved,
}: {
  busy: boolean;
  stale: boolean;
  scriptDirty: boolean;
  visualDirty: boolean;
  incompatible: boolean;
  approved: boolean;
}) {
  // 输入快照失效后，所有修订写入和批准都必须停止，避免把旧方案绑定到新输入。
  const staleReason = "输入快照已经变化，当前方案已失效。请重新生成方案。";
  const busyReason = "当前操作尚未完成，请稍候。";

  const saveScript = stale
    ? block(staleReason)
    : busy
      ? block(busyReason)
      : scriptDirty
        ? allow()
        : block("旁白没有未保存修改。");

  const saveVisual = stale
    ? block(staleReason)
    : busy
      ? block(busyReason)
      : scriptDirty
        ? block("请先保存旁白修订，再保存与新修订绑定的画面方案。")
        : visualDirty || incompatible
          ? allow()
          : block("画面方案没有未保存修改。");

  const unsavedCount = Number(scriptDirty) + Number(visualDirty);
  const approve = stale
    ? block(staleReason)
    : busy
      ? block(busyReason)
      : unsavedCount
        ? block(`无法批准：还有 ${unsavedCount} 组修改未保存。`)
        : incompatible
          ? block("无法批准：画面方案尚未绑定当前旁白修订。请先保存兼容的画面修订。")
          : approved
            ? block("当前方案已经批准。")
            : allow();

  return { saveScript, saveVisual, approve, unsavedCount };
}
