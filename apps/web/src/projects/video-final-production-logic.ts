import { getVideoOutputProfile, normalizeAspectRatio, type AspectRatio } from "./types";

export type VideoMotionKind = "still" | "zoom_in" | "zoom_out" | "pan_left" | "pan_right";
export type AsyncState = "idle" | "loading" | "success" | "error" | "interrupted";

export interface VideoVisualSegment {
  id: string;
  segmentIndex: number;
  cueStartIndex: number;
  cueEndIndex: number;
  startMs: number;
  endMs: number;
  visualId: string;
  narrationSummary: string;
  candidateId: string;
  candidateHash: string;
  previewUrl: string;
  motionKind: VideoMotionKind;
  motionAmountPpm: number;
  fadeInMs: number;
  fadeOutMs: number;
}

export interface VideoVisualTimelineWorkspace {
  aspectRatio: AspectRatio;
  gates: Array<{ key: string; label: string; valid: boolean; message: string }>;
  timeline: null | { id: string; revision: number; hash: string; identityHash: string; durationMs: number; stale: boolean };
  segments: VideoVisualSegment[];
  issues: string[];
  review: null | { complete: boolean; action: "approve" | "needs_changes" | null; notes: string | null; hasStaleReview: boolean };
}

export interface VideoRenderWorkspace {
  gates: Array<{ key: string; label: string; valid: boolean; message: string }>;
  readiness: {
    ready: boolean;
    issues: string[];
    spec: { aspectRatio: "9:16" | "16:9"; width: number; height: number; fps: 25; videoCodec: "h264"; audioCodec: "aac"; pixelFormat: "yuv420p" };
    segmentCount: number;
    durationMs: number;
    estimatedChunks: number;
  };
  render: null | {
    id: string;
    status: "queued" | "running" | "succeeded" | "failed" | "cancelled";
    jobId: string;
    progress: number;
    chunks: { total: number; queued: number; running: number; succeeded: number; failed: number; cancelled: number };
    errorMessage: string | null;
  };
  final: null | { fileHash: string; bytes: number; durationMs: number; width: number; height: number; fps: number; videoCodec: string; audioCodec: string; pixelFormat: string };
}

const MOTIONS = new Set<VideoMotionKind>(["still", "zoom_in", "zoom_out", "pan_left", "pan_right"]);
const HASH = /^[0-9a-f]{64}$/u;

function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label}格式无效`);
  return value as Record<string, unknown>;
}

function text(value: unknown, label: string) {
  if (typeof value !== "string" || !value) throw new Error(`${label}无效`);
  return value;
}

function count(value: unknown, label: string) {
  if (!Number.isSafeInteger(value) || Number(value) < 0) throw new Error(`${label}无效`);
  return Number(value);
}

function hash(value: unknown, label: string) {
  const parsed = text(value, label);
  if (!HASH.test(parsed)) throw new Error(`${label}无效`);
  return parsed;
}

function unwrap(value: unknown, expected: { projectId: string; videoId: string }) {
  const root = object(value, "响应");
  if (root.ok !== undefined && root.ok !== true) throw new Error("服务端未确认操作成功");
  const workspace = object(root.workspace ?? root, "工作区");
  if (workspace.projectId !== undefined && workspace.projectId !== expected.projectId) throw new Error("响应不属于当前项目");
  if (workspace.videoId !== undefined && workspace.videoId !== expected.videoId) throw new Error("响应不属于当前视频");
  return workspace;
}

function gates(value: unknown) {
  if (!value) return [];
  if (Array.isArray(value)) {
    return value.map((item, index) => {
      const gate = object(item, "门禁");
      return { key: String(gate.key ?? index), label: text(gate.label, "门禁名称"), valid: gate.valid === true, message: typeof gate.message === "string" ? gate.message : "" };
    });
  }
  return Object.entries(object(value, "门禁")).map(([key, item]) => {
    const gate = object(item, "门禁");
    return { key, label: typeof gate.label === "string" ? gate.label : key, valid: gate.valid === true || gate.complete === true, message: typeof gate.message === "string" ? gate.message : "" };
  });
}

function issues(value: unknown) {
  if (!Array.isArray(value)) return [];
  return value.map((item) => typeof item === "string" ? item : text(object(item, "校验问题").message, "校验问题"));
}

function segment(value: unknown): VideoVisualSegment {
  const input = object(value, "视觉段");
  const motionKind = input.motionKind as VideoMotionKind;
  if (!MOTIONS.has(motionKind)) throw new Error("视觉段运镜类型无效");
  return {
    id: text(input.id, "视觉段身份"),
    segmentIndex: count(input.segmentIndex, "视觉段序号"),
    cueStartIndex: count(input.cueStartIndex, "起始 cue"),
    cueEndIndex: count(input.cueEndIndex, "结束 cue"),
    startMs: count(input.startMs, "视觉段开始时间"),
    endMs: count(input.endMs, "视觉段结束时间"),
    visualId: text(input.visualId, "正式画面身份"),
    narrationSummary: typeof input.narrationSummary === "string" ? input.narrationSummary : "",
    candidateId: text(input.candidateId, "图片候选身份"),
    candidateHash: hash(input.candidateHash, "图片哈希"),
    previewUrl: text(input.previewUrl, "图片预览地址"),
    motionKind,
    motionAmountPpm: count(input.motionAmountPpm, "运镜幅度"),
    fadeInMs: count(input.fadeInMs, "淡入时长"),
    fadeOutMs: count(input.fadeOutMs, "淡出时长"),
  };
}

export function parseVideoVisualTimeline(value: unknown, expected: { projectId: string; videoId: string }): VideoVisualTimelineWorkspace {
  const input = unwrap(value, expected);
  const aspectRatio = normalizeAspectRatio(input.aspectRatio);
  const timelineInput = input.timeline === null || input.timeline === undefined ? null : object(input.timeline, "视觉时间轴");
  if (timelineInput?.projectId !== undefined && timelineInput.projectId !== expected.projectId) throw new Error("时间轴不属于当前项目");
  if (timelineInput?.videoId !== undefined && timelineInput.videoId !== expected.videoId) throw new Error("时间轴不属于当前视频");
  const timeline = timelineInput ? {
    id: text(timelineInput.id, "时间轴身份"),
    revision: count(timelineInput.revision, "时间轴修订"),
    hash: hash(timelineInput.hash ?? timelineInput.timelineHash, "时间轴哈希"),
    identityHash: hash(timelineInput.identityHash, "时间轴上游身份"),
    durationMs: count(timelineInput.durationMs ?? timelineInput.audioDurationMs, "时间轴时长"),
    stale: timelineInput.stale === true,
  } : null;
  const segments = (Array.isArray(input.segments) ? input.segments : []).map(segment).sort((left, right) => left.segmentIndex - right.segmentIndex);
  return { aspectRatio, gates: gates(input.gates), timeline, segments, issues: issues(input.issues), review: null };
}

export function mergeVideoVisualReview(workspace: VideoVisualTimelineWorkspace, value: unknown) {
  const root = object(value, "整片审核响应");
  const review = object(root.review ?? root.workspace ?? root, "整片审核");
  const timeline = object(review.timeline, "审核时间轴");
  if (!workspace.timeline || text(timeline.id, "审核时间轴身份") !== workspace.timeline.id || count(timeline.revision, "审核时间轴修订") !== workspace.timeline.revision) {
    throw new Error("整片审核不属于当前时间轴");
  }
  const preview = Array.isArray(review.preview) ? review.preview.map(segment) : workspace.segments;
  const reviewGate = object(review.reviewGate, "整片审核门禁");
  const latest = review.latestReview === null || review.latestReview === undefined ? null : object(review.latestReview, "整片审核记录");
  const approval = reviewGate.approval === null || reviewGate.approval === undefined ? latest : object(reviewGate.approval, "整片审核记录");
  return {
    ...workspace,
    segments: preview,
    issues: issues(review.validationIssues),
    review: {
      complete: reviewGate.complete === true,
      action: approval ? approval.action === "approve" ? "approve" as const : "needs_changes" as const : null,
      notes: approval && typeof approval.notes === "string" ? approval.notes : null,
      hasStaleReview: review.hasStaleReview === true,
    },
  };
}

export function parseVideoRenderWorkspace(value: unknown, expected: { projectId: string; videoId: string }): VideoRenderWorkspace {
  const input = unwrap(value, expected);
  const readinessInput = object(input.readiness, "渲染就绪状态");
  const spec = object(readinessInput.spec, "输出规格");
  const aspectRatio = normalizeAspectRatio(spec.aspectRatio);
  const profile = getVideoOutputProfile(aspectRatio);
  if (spec.width !== profile.width || spec.height !== profile.height || spec.fps !== 25 || spec.videoCodec !== "h264" || spec.audioCodec !== "aac" || spec.pixelFormat !== "yuv420p") {
    throw new Error("服务端输出规格不符合首版合同");
  }
  const renderInput = input.render === null || input.render === undefined ? null : object(input.render, "渲染任务");
  const render = renderInput ? (() => {
    const status = renderInput.status as VideoRenderWorkspace["render"] extends infer T ? T extends { status: infer S } ? S : never : never;
    if (!["queued", "running", "succeeded", "failed", "cancelled"].includes(String(status))) throw new Error("渲染状态无效");
    const chunks = object(renderInput.chunks, "渲染分片");
    const progress = Number(renderInput.progress ?? 0);
    if (!Number.isFinite(progress) || progress < 0 || progress > 1) throw new Error("渲染进度无效");
    return { id: text(renderInput.id, "渲染身份"), jobId: text(renderInput.jobId, "渲染任务身份"), status, progress, chunks: { total: count(chunks.total, "分片总数"), queued: count(chunks.queued, "排队分片数"), running: count(chunks.running, "运行分片数"), succeeded: count(chunks.succeeded, "成功分片数"), failed: count(chunks.failed, "失败分片数"), cancelled: count(chunks.cancelled, "中断分片数") }, errorMessage: typeof renderInput.errorMessage === "string" ? renderInput.errorMessage : null };
  })() : null;
  const rawFinal = input.final ?? renderInput?.final;
  const finalInput = rawFinal === null || rawFinal === undefined ? null : object(rawFinal, "最终视频");
  const mediaInfo = finalInput ? object(finalInput.mediaInfo ?? finalInput, "最终视频媒体信息") : null;
  return {
    gates: gates(input.gates ?? readinessInput.gates),
    readiness: {
      ready: readinessInput.ready === true,
      issues: issues(readinessInput.issues),
      spec: { aspectRatio: profile.aspectRatio, width: profile.width, height: profile.height, fps: 25, videoCodec: "h264", audioCodec: "aac", pixelFormat: "yuv420p" },
      segmentCount: count(readinessInput.segmentCount, "视觉段数"),
      durationMs: count(readinessInput.durationMs, "真实时长"),
      estimatedChunks: count(readinessInput.estimatedChunks, "预计分片数"),
    },
    render,
    final: finalInput && mediaInfo ? { fileHash: hash(finalInput.fileHash, "最终视频哈希"), bytes: count(finalInput.bytes, "最终视频字节数"), durationMs: count(mediaInfo.durationMs, "最终视频时长"), width: count(mediaInfo.width, "最终视频宽度"), height: count(mediaInfo.height, "最终视频高度"), fps: count(mediaInfo.fps, "最终视频帧率"), videoCodec: text(mediaInfo.videoCodec, "视频编码"), audioCodec: text(mediaInfo.audioCodec, "音频编码"), pixelFormat: text(mediaInfo.pixelFormat, "像素格式") } : null,
  };
}

export function formatProductionTime(milliseconds: number) {
  const seconds = Math.floor(milliseconds / 1000);
  return `${String(Math.floor(seconds / 60)).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`;
}

export function motionLabel(value: VideoMotionKind) {
  return ({ still: "静止", zoom_in: "推近", zoom_out: "拉远", pan_left: "左移", pan_right: "右移" } as const)[value];
}
