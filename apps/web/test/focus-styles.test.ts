import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

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

test("整卡焦点代理使用明确类、中文约束注释且不依赖 focus-within", () => {
  const proxyMatch = styles.match(/\.([a-z][\w-]*)[^,{]*:\s*has\([^)]*:\s*focus-visible\s*\)/iu);
  assert.ok(proxyMatch, "应提供仅供选择卡和上传触发器使用的专用焦点代理类");
  const proxyClass = proxyMatch[1];
  const selectorIndex = proxyMatch.index ?? 0;
  assert.match(styles.slice(Math.max(0, selectorIndex - 220), selectorIndex), /\/\*[^*]*[\u3400-\u9fff][^*]*\*\//u);

  for (const path of [
    "../src/projects/VideoInputStage.tsx",
    "../src/production/assets/CandidatePanel.tsx",
    "../src/projects/VisualImageReviewRow.tsx",
  ]) {
    const source = read(path);
    assert.match(source, new RegExp(`\\b${proxyClass}\\b`, "u"), `${path} 应显式使用专用焦点代理类`);
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

test("受控删除 AlertDialog 关闭后显式恢复实际触发按钮焦点", () => {
  const source = read("../src/projects/ProjectHomePage.tsx");
  const triggerRef = source.match(/const\s+(\w+)\s*=\s*useRef<[^>]*HTMLButtonElement[^>]*>/u)?.[1];
  assert.ok(triggerRef, "应记录实际打开删除弹框的按钮");
  assert.match(source, /<button\b[^>]*onClick=\{[^}]*setPendingDelete/su);
  assert.match(source, new RegExp(`${triggerRef}\\.current\\s*=\\s*\\w+\\.currentTarget|ref=\\{[^}]*${triggerRef}`, "su"));

  const closeHandlerIndex = source.indexOf("onCloseAutoFocus");
  assert.notEqual(closeHandlerIndex, -1, "受控弹框应接管关闭后的自动焦点");
  const closeHandler = source.slice(closeHandlerIndex, closeHandlerIndex + 700);
  assert.match(closeHandler, new RegExp(`\\b${triggerRef}\\b`, "u"));
  assert.match(closeHandler, /preventDefault\s*\(\s*\)/u);
  assert.match(closeHandler, /isConnected/u);
  assert.match(closeHandler, /\.focus\s*\(\s*\)/u);
});

test("ProjectShell 的主题与设置按钮只使用全局焦点 outline", () => {
  const source = read("../src/projects/ProjectShell.tsx");
  assert.doesNotMatch(source, /<button\b[^>]*focus-visible:(?:ring|outline-none)/su);
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

  const undefinedTokens = [...usages]
    .filter(([name]) => !definitions.has(name))
    .map(([name, files]) => `--${name} (${[...files].join(", ")})`)
    .sort();
  assert.deepEqual(undefinedTokens, []);
});
