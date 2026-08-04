import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createElement } from "react";
import { renderToString } from "react-dom/server";

import { NativeSelect } from "../src/components/ui/native-select.tsx";
import { ProjectShell } from "../src/projects/ProjectShell.tsx";

const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");
const styles = read("../src/styles.css");
const tokens = read("../../../opendesign/design-systems/yingshu-product/tokens/colors_and_type.css");

function cssRules(source: string) {
  return [...source.matchAll(/([^{}]+)\{([^{}]*)\}/gu)].map((match) => ({
    selector: match[1].trim(),
    declarations: match[2].trim(),
  }));
}

function customPropertyDefinitions(source: string) {
  return new Map([...source.matchAll(/--([a-z0-9-]+)\s*:\s*([^;{}]+)\s*;/giu)].map((match) => [match[1], match[2].trim()]));
}

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return /\.(?:css|ts|tsx)$/u.test(entry.name) ? [path] : [];
  });
}

test("全局样式只加载映述设计系统 token", () => {
  assert.match(styles, /@import\s+["']\.\.\/\.\.\/\.\.\/opendesign\/design-systems\/yingshu-product\/tokens\/colors_and_type\.css["']/u);
  assert.doesNotMatch(styles, /narralume-product/u);
});

test("普通 label 不再获得泛化的父容器焦点框", () => {
  assert.doesNotMatch(styles, /label\s*:\s*has\(\s*input\s*:\s*focus-visible/iu);
  assert.doesNotMatch(styles, /label\s*:\s*focus-within/iu);
});

test("基础控件共享唯一的 2px focus-visible outline", () => {
  const focusRules = cssRules(styles).filter(({ selector, declarations }) => selector.includes(":focus-visible") && /outline\s*:\s*2px\s+solid\s+var\(--focus\)/u.test(declarations));
  for (const element of ["input", "textarea", "select", "button"]) {
    const matches = focusRules.filter(({ selector }) => selector.includes(":focus-visible") && new RegExp(`\\b${element}\\b`, "u").test(selector));
    assert.equal(matches.length, 1, `${element} 应且只应命中一条全局 focus-visible 规则`);
    assert.match(matches[0].declarations, /outline\s*:\s*2px\s+solid\s+var\(--focus\)/u);
    assert.doesNotMatch(matches[0].declarations, /box-shadow/u);
  }
});

test("基础控件保留 disabled 光标和 44px 触控目标，原生小控件不被强制放大", () => {
  const rules = cssRules(styles);
  const disabled = rules.find(({ selector, declarations }) => /:disabled/u.test(selector) && /cursor\s*:\s*not-allowed/u.test(declarations));
  assert.ok(disabled, "disabled 基础规则应显示不可操作光标");

  const touchRule = rules.find(({ declarations }) => /min-height\s*:\s*(?:44px|var\(--control-height\))/u.test(declarations));
  assert.ok(touchRule, "基础控件应保留至少 44px 的触控高度");
  if (/var\(--control-height\)/u.test(touchRule.declarations)) assert.match(tokens, /--control-height\s*:\s*(?:44px|2\.75rem)/u);
  for (const element of ["input", "textarea", "select", "button"]) assert.match(touchRule.selector, new RegExp(`\\b${element}\\b`, "u"));
  for (const type of ["checkbox", "radio", "file"]) {
    assert.match(touchRule.selector, new RegExp(`:not\\([^)]*${type}[^)]*\\)`, "u"), `44px 尺寸规则应排除 ${type}`);
  }
});

test("隐藏文件输入由上传标签代理单层焦点且不依赖 focus-within", () => {
  assert.match(styles, /\.focus-ring-proxy:has\([^)]*:focus-visible\)[^{]*\{[^}]*outline\s*:\s*2px\s+solid\s+var\(--focus\)/su);
  assert.match(styles, /\.focus-ring-proxy\s+:where\([^)]*input[^)]*\):focus-visible\s*\{[^}]*outline\s*:\s*none/su);

  for (const path of ["../src/production/assets/CandidatePanel.tsx", "../src/projects/VisualImageReviewRow.tsx"]) {
    const source = read(path);
    assert.match(source, /<label\b[^>]*focus-ring-proxy[\s\S]*?<input\b[^>]*type="file"/u, `${path} 的隐藏文件输入应由上传标签代理焦点`);
    assert.doesNotMatch(source, /focus-within/u);
  }
});

test("普通输入热点不再保留与全局 outline 叠加的局部 ring", () => {
  for (const path of [
    "../src/projects/CreateForm.tsx",
    "../src/projects/VideoPlanReviewStage.tsx",
  ]) {
    const source = read(path);
    assert.doesNotMatch(source, /<(?:input|textarea|select|button)\b[^>]*focus-visible:(?:ring|outline-none)/u, `${path} 的基础控件不应覆盖或叠加统一 outline`);
    for (const className of ["inputClass", "textareaClass", "secondaryButton"]) {
      const classValue = source.match(new RegExp(`const\\s+${className}\\s*=\\s*["']([^"']*)["']`, "u"))?.[1];
      if (classValue) assert.doesNotMatch(classValue, /focus-visible:(?:ring|outline-none)/u, `${path} 的 ${className} 不应覆盖或叠加统一 outline`);
    }
  }
});

test("buttonVariants 的禁用态保留光标反馈且不吞掉指针事件", () => {
  const source = read("../src/components/ui/button.tsx");
  assert.doesNotMatch(source, /disabled:pointer-events-none/u);
  assert.match(source, /disabled:cursor-not-allowed/u);
});

test("Accordion 触发按钮不再叠加本地 ring 与全局 outline", () => {
  const source = read("../src/components/ui/accordion.tsx");
  assert.doesNotMatch(source, /focus-visible:ring/u);
  assert.doesNotMatch(source, /focus-visible:outline/u);
});

test("受控删除 AlertDialog 从实际删除按钮打开并在关闭后返焦", () => {
  const source = read("../src/projects/ProjectHomePage.tsx");
  assert.match(source, /<Button\b[^>]*onClick=\{\(event\)[^}]*\.current\s*=\s*event\.currentTarget;\s*setPendingDelete\(/su);

  const closeHandlerIndex = source.indexOf("onCloseAutoFocus");
  assert.notEqual(closeHandlerIndex, -1, "受控弹框应接管关闭后的自动焦点");
  const closeHandler = source.slice(closeHandlerIndex, closeHandlerIndex + 700);
  assert.match(closeHandler, /preventDefault\s*\(\s*\)/u);
  assert.match(closeHandler, /isConnected/u);
  assert.match(closeHandler, /\.focus\s*\(\s*\)/u);
});

test("本轮实际使用的交互基础组件保持 2px 单层焦点、44px 命中区和中文模板", () => {
  const interactive = [
    "button.tsx",
    "input.tsx",
    "textarea.tsx",
    "native-select.tsx",
    "radio-group.tsx",
    "checkbox.tsx",
    "dialog.tsx",
    "alert-dialog.tsx",
    "pagination.tsx",
  ].map((name) => ({ name, source: read(`../src/components/ui/${name}`) }));

  for (const { name, source } of interactive) {
    assert.doesNotMatch(source, /ring-\[3px\]/u, `${name} 不得恢复 shadcn 默认 3px ring`);
    assert.doesNotMatch(source, />\s*(?:Close|Previous|Next|Loading)\s*</u, `${name} 的可见模板文案必须为中文`);
  }

  for (const name of ["button.tsx", "input.tsx", "textarea.tsx", "native-select.tsx", "radio-group.tsx", "checkbox.tsx", "dialog.tsx"]) {
    const source = interactive.find((item) => item.name === name)!.source;
    assert.match(source, /(?:min-h|h|size)-(?:1[1-9]|[2-9]\d)\b/u, `${name} 的主要交互目标不得小于 44px`);
  }

  const pagination = interactive.find((item) => item.name === "pagination.tsx")!.source;
  assert.match(pagination, /aria-label="分页"/u);
  assert.match(pagination, /aria-label="前往上一页"[\s\S]*>上一页</u);
  assert.match(pagination, /aria-label="前往下一页"[\s\S]*>下一页</u);
  assert.match(pagination, /buttonVariants\(/u, "分页链接应复用 Button 的 44px 命中区");

  const dialog = interactive.find((item) => item.name === "dialog.tsx")!.source;
  assert.match(dialog, /<span[^>]*className="sr-only"[^>]*>关闭<\/span>/u);
});

test("NativeSelect 的表单包装可全宽，默认分页包装保持紧凑", () => {
  const form = renderToString(createElement(NativeSelect, { "aria-label": "关联旁白", wrapperClassName: "w-full" }));
  const pagination = renderToString(createElement(NativeSelect, { "aria-label": "每页条数" }));
  const formWrapper = form.match(/<div\b[^>]*class="([^"]*)"[^>]*data-slot="native-select-wrapper"/u)?.[1];
  const paginationWrapper = pagination.match(/<div\b[^>]*class="([^"]*)"[^>]*data-slot="native-select-wrapper"/u)?.[1];

  assert.ok(formWrapper?.split(/\s+/u).includes("w-full"), "表单用途应通过公开 wrapperClassName API 占满字段宽度");
  assert.ok(!formWrapper?.split(/\s+/u).includes("w-fit"), "显式全宽不应残留紧凑宽度冲突");
  assert.ok(paginationWrapper?.split(/\s+/u).includes("w-fit"), "默认分页用途应保持紧凑包装");
  assert.ok(!paginationWrapper?.split(/\s+/u).includes("w-full"), "默认包装不应擅自扩展为全宽");
});

test("ProjectShell 主题组保留 system/light/dark 三态且不生成 aria-pressed 阴影", () => {
  const html = renderToString(createElement(ProjectShell, {
    title: "测试项目",
    description: "主题语义验证",
    navigate: () => undefined,
    onOpenSettings: () => undefined,
    themePreference: "light",
    onThemeChange: () => undefined,
  }));
  const themeGroup = html.match(/<div\b[^>]*role="group"[^>]*aria-label="页面主题"[\s\S]*?<\/div>/u)?.[0];

  assert.ok(themeGroup, "应渲染带中文名称的主题按钮组");
  assert.equal((themeGroup.match(/<button\b/g) ?? []).length, 3);
  assert.equal((themeGroup.match(/aria-pressed="true"/g) ?? []).length, 1);
  assert.equal((themeGroup.match(/aria-pressed="false"/g) ?? []).length, 2);
  assert.match(themeGroup, />系统<\/button>[\s\S]*>浅色<\/button>[\s\S]*>深色<\/button>/u);
  assert.doesNotMatch(themeGroup, /\bshadow(?:-|\b)/u);
});

test("保留专用 ring 的阶段导航不再叠加全局 outline", () => {
  const globalFocusRule = cssRules(styles).find(({ selector, declarations }) =>
    /\bbutton\b/u.test(selector) && /:focus-visible/u.test(selector) && /outline\s*:\s*2px\s+solid\s+var\(--focus\)/u.test(declarations));
  assert.ok(globalFocusRule, "应存在基础 button focus-visible outline 规则");
  assert.match(globalFocusRule.selector, /:not\(\s*\[class\*\s*=\s*["']focus-visible:ring["']\]\s*\)/u);

  const navigation = read("../src/projects/VideoStageNavigation.tsx");
  assert.match(navigation, /focus-visible:ring-2/u);
  assert.match(navigation, /focus-visible:ring-inset/u);
});

test("Web 源码使用的 CSS token 均由映述设计系统或全局兼容层定义", () => {
  const definitions = new Map([
    ...customPropertyDefinitions(tokens),
    ...customPropertyDefinitions(styles),
  ]);
  assert.equal(definitions.get("font-reading"), "var(--font-sans)");
  assert.equal(definitions.get("warning"), "var(--status-warning)");

  const sourceRoot = fileURLToPath(new URL("../src/", import.meta.url));
  const usages = new Map<string, Set<string>>();
  for (const path of sourceFiles(sourceRoot)) {
    const source = readFileSync(path, "utf8");
    for (const match of source.matchAll(/var\(\s*--([a-z0-9-]+)/giu)) {
      const files = usages.get(match[1]) ?? new Set<string>();
      files.add(path.slice(sourceRoot.length));
      usages.set(match[1], files);
    }
  }

  // shadcn 组件中的这些变量由 Radix/Base UI、组件内联样式或 Tailwind 运行时提供，不属于产品主题 token。
  const runtimeComponentVariables = new Set([
    "anchor-width",
    "available-height",
    "gap",
    "radix-navigation-menu-viewport-height",
    "radix-navigation-menu-viewport-width",
    "radix-select-trigger-height",
    "radix-select-trigger-width",
    "sidebar-width",
    "sidebar-width-icon",
    "spacing",
  ]);
  const undefinedTokens = [...usages]
    .filter(([name]) => !definitions.has(name) && !runtimeComponentVariables.has(name))
    .map(([name, files]) => `--${name} (${[...files].join(", ")})`)
    .sort();
  assert.deepEqual(undefinedTokens, []);
});
