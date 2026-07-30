# 映述（Yingshu）

映述是一个本地优先的旁白配图内容讲解视频工作台。用户输入主题、正文和可选参考文本，审核旁白与画面方案后生成图片、TTS、字幕和最终 MP4。


## 产品方向

```text
项目
-> 独立视频
-> 主题、正文、参考文本和来源快照
-> 可审核旁白与画面方案
-> 图片候选和批准
-> TTS 与字幕时间轴
-> ffmpeg 静图视频
-> 分片恢复和导出
```

第一版专注于静图、旁白、字幕、轻微镜头运动和淡化换图，不做连续剧、数字人、口型同步、多轨专业编辑器和 AI 视频片段生成。

## 技术栈

- 前端：React + TypeScript + Vite + Tailwind CSS
- 后端：Fastify + TypeScript
- 数据：SQLite + 本地文件
- 视频：系统 `ffmpeg` / `ffprobe`
- 任务：SQLite 持久化任务 + 本地 Worker

## 开发

要求 Node.js 22 或更高版本。

```bash
npm install
npm run dev
```

- 前端默认地址：`http://localhost:5175`
- 后端默认地址：`http://localhost:3102`
- 健康检查：`http://localhost:3102/api/health`

## 验证

```bash
npm run typecheck
npm test
npm run build
```

唯一产品合同与动态状态源见 [docs/2026-07-30-single-video-explainer-product-boundaries.md](docs/2026-07-30-single-video-explainer-product-boundaries.md)。
