import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { createElement } from "react";
import { renderToString } from "react-dom/server";

import { paragraphTextFieldError, scriptMetadataFieldErrors, visualDraftFieldErrors } from "../src/projects/plan-logic.ts";
import type { VideoPlan, VideoScriptParagraph, VideoVisualDraft } from "../src/projects/types.ts";
import { NarrationReview } from "../src/projects/video-plan-review/NarrationReview.tsx";
import { PlanActionBar } from "../src/projects/video-plan-review/PlanReviewSupport.tsx";
import { VisualReview } from "../src/projects/video-plan-review/VisualReview.tsx";
import {
  adjacentVisualIdAfterDelete,
  isPlanIncompatible,
  isScriptDirty,
  isVisualDirty,
  paginate,
  planReviewGates,
  syncVisualDrafts,
} from "../src/projects/video-plan-review/logic.ts";

const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");

const paragraphs: VideoScriptParagraph[] = Array.from({ length: 21 }, (_, index) => ({
  id: `paragraph_${index + 1}`,
  text: `第 ${index + 1} 段旁白正文`,
}));

const visual = (index = 0): VideoVisualDraft => ({
  id: `visual_${index + 1}`,
  paragraphId: paragraphs[index % paragraphs.length]!.id,
  purpose: `画面用途 ${index + 1}`,
  description: `中文画面描述 ${index + 1}`,
  prompt: `editorial video frame ${index + 1}`,
  negativePrompt: "文字、水印",
  suggestedDurationSeconds: 3,
  weight: 1,
  generationStatus: "not_generated",
  currentCandidate: null,
});

const visuals = Array.from({ length: 21 }, (_, index) => visual(index));

const plan: VideoPlan = {
  snapshotId: "snapshot_1",
  snapshotHash: "snapshot_hash_1",
  webEnabled: true,
  createdAt: 1,
  stale: false,
  script: {
    id: "script_revision_1",
    revision: 1,
    title: "映述方案",
    summary: "方案摘要",
    narration: paragraphs.map((paragraph) => paragraph.text).join("\n\n"),
    estimatedCharacters: 210,
    estimatedDurationSeconds: 90,
    paragraphs,
    sourceSummary: ["冻结资料摘要"],
    risks: ["数字仍需核对"],
    contentHash: "script_hash_1",
    createdAt: 1,
  },
  visual: {
    id: "visual_revision_1",
    revision: 1,
    scriptRevisionId: "script_revision_1",
    scriptContentHash: "script_hash_1",
    contentHash: "visual_hash_1",
    createdAt: 1,
    visuals,
  },
  approval: null,
};

test("分页默认 10 条、支持 20 条并夹紧页码边界", () => {
  assert.deepEqual(paginate(paragraphs, 1), {
    items: paragraphs.slice(0, 10), page: 1, pageSize: 10, totalPages: 3, totalItems: 21,
  });
  assert.deepEqual(paginate(paragraphs, 2, 20), {
    items: paragraphs.slice(20), page: 2, pageSize: 20, totalPages: 2, totalItems: 21,
  });
  assert.equal(paginate(paragraphs, -9).page, 1);
  assert.equal(paginate(paragraphs, 99).page, 3);
  assert.equal(paginate(paragraphs, Number.NaN).page, 1);
  assert.equal(paginate(paragraphs, 1, 99).pageSize, 10);
});

test("分页覆盖末页、空列表和删除后当前页回退", () => {
  assert.deepEqual(paginate(paragraphs, 3).items, paragraphs.slice(20));
  assert.deepEqual(paginate([], 8), { items: [], page: 1, pageSize: 10, totalPages: 1, totalItems: 0 });
  const beforeDelete = paginate(paragraphs.slice(0, 11), 2);
  const afterDelete = paginate(paragraphs.slice(0, 10), beforeDelete.page);
  assert.equal(beforeDelete.page, 2);
  assert.equal(afterDelete.page, 1);
  assert.equal(afterDelete.items.length, 10);
});

test("画面修订 ID 未变化时保留全部本地编辑、新增与删除", () => {
  const currentVisuals = [
    { ...visuals[0]!, description: "尚未保存的本地编辑" },
    { ...visual(99), id: "visual_local_new", purpose: "本地新增" },
  ];
  const serverVisuals = [visuals[0]!, visuals[1]!, visuals[2]!];
  const scriptUpdatedPlan = {
    ...plan,
    script: { ...plan.script, id: "script_revision_2", contentHash: "script_hash_2" },
    visual: { ...plan.visual, visuals: serverVisuals },
  };

  const preserved = syncVisualDrafts(currentVisuals, "visual_revision_1", scriptUpdatedPlan.visual);
  assert.strictEqual(preserved, currentVisuals);
  assert.deepEqual(preserved, currentVisuals);
  assert.equal(preserved.some((item) => item.id === visuals[1]!.id), false, "本地删除不应被旧服务端内容恢复");

  const nextServerVisuals = [{ ...visuals[0]!, description: "新画面修订" }];
  const replaced = syncVisualDrafts(currentVisuals, "visual_revision_1", {
    id: "visual_revision_2",
    visuals: nextServerVisuals,
  });
  assert.strictEqual(replaced, nextServerVisuals);
  assert.deepEqual(replaced, nextServerVisuals);
});

test("删除后焦点纯选择优先下一条、末尾回上一条且安全处理未知和空列表", () => {
  assert.equal(adjacentVisualIdAfterDelete(["a", "b", "c"], "b"), "c");
  assert.equal(adjacentVisualIdAfterDelete(["a", "b", "c"], "c"), "b");
  assert.equal(adjacentVisualIdAfterDelete(["a"], "a"), null);
  assert.equal(adjacentVisualIdAfterDelete(["a", "b"], "missing"), null);
  assert.equal(adjacentVisualIdAfterDelete([], "missing"), null);

  const source = read("../src/projects/video-plan-review/VisualReview.tsx");
  assert.match(source, /onCloseAutoFocus=\{focusAfterDelete\}/);
  assert.match(source, /focusAfterDelete[\s\S]*preventDefault\(\)/);
  assert.match(source, /focusAfterDelete[\s\S]*(?:isConnected|getClientRects)/);
});

test("旁白与画面 dirty 比较保留完整字段和顺序语义", () => {
  const scriptDraft = { title: plan.script.title, summary: plan.script.summary, paragraphs: plan.script.paragraphs };
  assert.equal(isScriptDirty(scriptDraft, plan.script), false);
  assert.equal(isScriptDirty({ ...scriptDraft, title: `${scriptDraft.title}（修订）` }, plan.script), true);
  assert.equal(isScriptDirty({ ...scriptDraft, paragraphs: [...paragraphs].reverse() }, plan.script), true);
  assert.equal(isVisualDirty(visuals, plan.visual.visuals), false);
  assert.equal(isVisualDirty([{ ...visuals[0]!, prompt: "new prompt" }, ...visuals.slice(1)], plan.visual.visuals), true);
});

test("画面修订必须同时绑定当前旁白修订 ID 与内容哈希", () => {
  assert.equal(isPlanIncompatible(plan), false);
  assert.equal(isPlanIncompatible({ ...plan, visual: { ...plan.visual, scriptRevisionId: "old_revision" } }), true);
  assert.equal(isPlanIncompatible({ ...plan, visual: { ...plan.visual, scriptContentHash: "old_hash" } }), true);
});

test("三类编辑字段校验直接区分空白与有效值", () => {
  assert.deepEqual(scriptMetadataFieldErrors(" \n ", "\t"), {
    title: "请输入标题建议",
    summary: "请输入内容摘要",
  });
  assert.deepEqual(scriptMetadataFieldErrors("有效标题", "有效摘要"), { title: null, summary: null });
  assert.equal(paragraphTextFieldError("　\n"), "旁白段落不能为空");
  assert.equal(paragraphTextFieldError("有效旁白"), null);
  assert.deepEqual(visualDraftFieldErrors({ description: " ", prompt: "\n" }), {
    description: "画面描述不能为空",
    prompt: "生图 prompt 不能为空",
  });
  assert.deepEqual(visualDraftFieldErrors({ description: "有效描述", prompt: "valid prompt" }), {
    description: null,
    prompt: null,
  });
});

test("busy、stale 与未保存修改阻止相应保存和批准", () => {
  const busy = planReviewGates({ busy: true, stale: false, scriptDirty: true, visualDirty: true, incompatible: false, approved: false });
  assert.deepEqual([busy.saveScript.allowed, busy.saveVisual.allowed, busy.approve.allowed], [false, false, false]);
  assert.match(busy.approve.reason ?? "", /尚未完成|稍候/);

  const stale = planReviewGates({ busy: false, stale: true, scriptDirty: true, visualDirty: true, incompatible: true, approved: false });
  assert.deepEqual([stale.saveScript.allowed, stale.saveVisual.allowed, stale.approve.allowed], [false, false, false]);
  assert.match(stale.saveScript.reason ?? "", /快照.*变化|失效/);

  const scriptDirty = planReviewGates({ busy: false, stale: false, scriptDirty: true, visualDirty: false, incompatible: false, approved: false });
  assert.equal(scriptDirty.saveScript.allowed, true);
  assert.equal(scriptDirty.saveVisual.allowed, false);
  assert.equal(scriptDirty.approve.allowed, false);
  assert.equal(scriptDirty.unsavedCount, 1);

  const visualDirty = planReviewGates({ busy: false, stale: false, scriptDirty: false, visualDirty: true, incompatible: false, approved: false });
  assert.equal(visualDirty.saveScript.allowed, false);
  assert.equal(visualDirty.saveVisual.allowed, true);
  assert.equal(visualDirty.approve.allowed, false);
});

test("不兼容允许保存兼容画面，但不允许批准；已批准不可重复批准", () => {
  const incompatible = planReviewGates({ busy: false, stale: false, scriptDirty: false, visualDirty: false, incompatible: true, approved: false });
  assert.equal(incompatible.saveVisual.allowed, true);
  assert.equal(incompatible.approve.allowed, false);
  assert.match(incompatible.approve.reason ?? "", /不兼容|尚未绑定|兼容/);

  const approved = planReviewGates({ busy: false, stale: false, scriptDirty: false, visualDirty: false, incompatible: false, approved: true });
  assert.equal(approved.approve.allowed, false);
  assert.match(approved.approve.reason ?? "", /已经批准/);

  const ready = planReviewGates({ busy: false, stale: false, scriptDirty: false, visualDirty: false, incompatible: false, approved: false });
  assert.deepEqual(ready.approve, { allowed: true, reason: null });
});

test("旁白审核提供桌面语义表格、移动列表、状态操作列和标题摘要入口", () => {
  const html = renderToString(createElement(NarrationReview, {
    title: plan.script.title,
    summary: plan.script.summary,
    paragraphs,
    visuals,
    busy: false,
    onApplyMetadata: () => undefined,
    onApplyParagraph: () => undefined,
  }));
  assert.match(html, /<table\b/);
  assert.match(html, /<caption[^>]*>旁白方案列表<\/caption>/);
  assert.match(html, /<th[^>]*scope="col"[^>]*>状态<\/th>/);
  assert.match(html, /<th[^>]*scope="col"[^>]*>操作<\/th>/);
  assert.match(html, /<ul[^>]*md:hidden/);
  assert.match(html, /编辑标题与摘要/);
  assert.match(html, /查看与编辑/);
  assert.match(html, /旁白分页/);
  assert.equal((html.match(/旁白段落 \d{2}/g) ?? []).length >= 10, true);
});

test("千条旁白仍只渲染上一页和下一页两个常数分页按钮", () => {
  const manyParagraphs: VideoScriptParagraph[] = Array.from({ length: 1_000 }, (_, index) => ({
    id: `many_${index + 1}`,
    text: `第 ${index + 1} 条`,
  }));
  const html = renderToString(createElement(NarrationReview, {
    title: "长方案",
    summary: "分页压力验证",
    paragraphs: manyParagraphs,
    visuals: [],
    busy: false,
    onApplyMetadata: () => undefined,
    onApplyParagraph: () => undefined,
  }));
  const nav = html.match(/<nav[^>]*aria-label="旁白分页"[\s\S]*?<\/nav>/)?.[0];
  assert.ok(nav, "应渲染旁白分页导航");
  assert.match(nav.replaceAll("<!-- -->", ""), /第 1 \/ 100 页，共 1000 条/);
  assert.equal((nav.match(/<button\b/g) ?? []).length, 2);
  assert.match(nav, />上一页<\/button>/);
  assert.match(nav, />下一页<\/button>/);
  assert.doesNotMatch(nav, /aria-label="第 \d+ 页"/);
});

test("画面审核提供桌面语义表格、移动列表及完整已有字段编辑合同", () => {
  const html = renderToString(createElement(VisualReview, {
    visuals,
    paragraphs,
    busy: false,
    incompatible: false,
    onApplyVisual: () => undefined,
    onAddVisual: () => undefined,
    onDeleteVisual: () => undefined,
  }));
  assert.match(html, /<table\b/);
  assert.match(html, /<th[^>]*scope="col"[^>]*>状态<\/th>/);
  assert.match(html, /<th[^>]*scope="col"[^>]*>操作<\/th>/);
  assert.match(html, /md:hidden/);
  assert.match(html, /画面方案分页/);

  const source = read("../src/projects/video-plan-review/VisualReview.tsx");
  for (const label of ["关联旁白段落", "画面用途", "中文画面描述", "最终生图 prompt", "负面 prompt", "建议时长", "画面权重", "生成状态", "当前候选"]) {
    assert.match(source, new RegExp(label, "u"), `画面详情应保留字段：${label}`);
  }
});

test("固定操作栏并列呈现两类保存与批准动作及邻近阻断原因", () => {
  const gates = planReviewGates({ busy: false, stale: false, scriptDirty: true, visualDirty: true, incompatible: false, approved: false });
  const html = renderToString(createElement(PlanActionBar, {
    gates,
    busy: false,
    approved: false,
    incompatible: false,
    stale: false,
    onSaveScript: () => undefined,
    onSaveVisuals: () => undefined,
    onApprove: () => undefined,
  }));
  assert.match(html, /<aside[^>]*fixed/);
  assert.match(html, />保存旁白修订<\/button>/);
  assert.match(html, />保存画面修订<\/button>/);
  assert.match(html, />批准当前方案<\/button>/);
  assert.match(html, /修改未保存/);
  assert.match(html, /无法批准/);
  assert.equal((html.match(/<button/g) ?? []).length, 3);
});

test("详情 Dialog 保留 Radix Portal 与未保存关闭拦截，真实焦点循环交由 Chrome 验收", () => {
  const dialog = read("../src/components/ui/dialog.tsx");
  assert.match(dialog, /DialogPrimitive\.Root/);
  assert.match(dialog, /DialogPrimitive\.Portal/);
  assert.match(dialog, /DialogPrimitive\.Content/);
  assert.match(dialog, /DialogPrimitive\.Close/);

  for (const path of [
    "../src/projects/video-plan-review/NarrationReview.tsx",
    "../src/projects/video-plan-review/VisualReview.tsx",
  ]) {
    const source = read(path);
    assert.match(source, /onOpenChange/);
    assert.match(source, /(?:requestClose|closeMetadata|closeParagraph)/);
    assert.match(source, /未应用修改/);
    assert.match(source, /继续编辑/);
    assert.match(source, /放弃修改并关闭/);
    assert.match(source, /onOpenAutoFocus/);
    assert.match(source, /onCloseAutoFocus/);
    assert.match(source, /preventDefault\(\)/);
    assert.match(source, /\.focus\(\)/);
  }
});

test("三类编辑字段用 aria-invalid、aria-describedby 和 FieldError 连接校验反馈", () => {
  const narrationHtml = renderToString(createElement(NarrationReview, {
    title: plan.script.title,
    summary: plan.script.summary,
    paragraphs,
    visuals,
    busy: false,
    onApplyMetadata: () => undefined,
    onApplyParagraph: () => undefined,
  }));
  assert.doesNotMatch(narrationHtml, /aria-invalid="true"/);

  const narration = read("../src/projects/video-plan-review/NarrationReview.tsx");
  assert.equal((narration.match(/aria-invalid=\{Boolean\(/g) ?? []).length, 3);
  assert.equal((narration.match(/aria-describedby=\{[^}]+\?[^:]+:\s*undefined\}/g) ?? []).length, 3);
  assert.equal((narration.match(/<FieldError\b/g) ?? []).length, 3);

  const visualSource = read("../src/projects/video-plan-review/VisualReview.tsx");
  assert.equal((visualSource.match(/aria-invalid=\{Boolean\(/g) ?? []).length, 2);
  assert.equal((visualSource.match(/aria-describedby=\{[^}]+\?[^:]+:\s*undefined\}/g) ?? []).length, 2);
  assert.equal((visualSource.match(/<FieldError\b/g) ?? []).length, 2);
});

test("Phase 3 新组件不叠加局部焦点框或普通 label 父焦点框", () => {
  const dialog = read("../src/components/ui/dialog.tsx");
  assert.match(dialog, /focus-visible:ring-2/);

  for (const path of [
    "../src/projects/video-plan-review/NarrationReview.tsx",
    "../src/projects/video-plan-review/PlanReviewSupport.tsx",
    "../src/projects/video-plan-review/VisualReview.tsx",
  ]) {
    const source = read(path);
    assert.doesNotMatch(source, /focus-visible:ring/u, `${path} 不应叠加局部 ring`);
    assert.doesNotMatch(source, /outline-none/u, `${path} 不应移除业务控件的全局焦点可见性`);
    assert.doesNotMatch(source, /label\s*:\s*has|label:has/u, `${path} 不应给普通 label 增加父焦点框`);
  }
});
