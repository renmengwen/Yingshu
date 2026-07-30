# Narralume 产品设计系统

面向长篇叙事视频生产工作台的可复用视觉、交互和文案规范。基调是“暖中性工业编辑室”：可信、耐看、适合长时间工作，有明确技术秩序，但不借助蓝紫渐变、玻璃拟态、无意义发光或拟人化 AI 文案制造科技感。

## 来源

- `apps/web/src/App.tsx`：书库、章节、原文证据的三栏信息架构，琥珀主操作，异步状态与中断能力。
- `apps/web/src/styles.css`：现有字体回退、Tailwind CSS 入口、深色基线。
- `apps/web/package.json`：React 19、TypeScript、Vite、Tailwind CSS 4；没有额外图标或组件依赖。
- 项目协作规则：用户可见文案使用中文，优先官方 `shadcn/ui`，异步操作必须有 loading、成功、失败或中断状态并防止重复提交。

## 索引

- [`SKILL.md`](SKILL.md)：后续设计与实现任务应遵循的便携规则。
- [`tokens/colors_and_type.css`](tokens/colors_and_type.css)：深浅主题共用的 canonical tokens。
- [`brand/voice-and-tone.md`](brand/voice-and-tone.md)：界面文案与状态反馈。
- [`brand/style-notes.md`](brand/style-notes.md)：色彩、排版、空间、组件、动效和可访问性。
- [`ui-kit-narralume/index.html`](ui-kit-narralume/index.html)：核心组件与状态的交互式展示。

## 使用方式

在应用全局样式中引入 tokens，然后让组件只消费语义变量。主题优先级为：用户显式选择（`data-theme="light|dark"`）高于系统偏好；未设置 `data-theme` 时通过 `prefers-color-scheme` 跟随系统。用户选择可持久化到 `localStorage`，但不要把“系统”解析成永久的明/暗值。

新增界面先复用现有信息密度和组件模式。只有真实工作流证明需要时才增加组件种类；不要为“设计系统完整性”搭建未使用的抽象。
