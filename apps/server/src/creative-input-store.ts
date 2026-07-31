import type { DatabaseSync } from "node:sqlite";

import {
  type CreativeInstructions,
  CreativeInputError,
  type InputMode,
  parseCreativeInstructions,
  parseVideoInputDraft,
  type ReferenceRole,
  type VideoInputDraft,
  type VisualDensity,
} from "./creative-input-contract.js";
import { getProject, getVideo } from "./project-video-store.js";
import { requestJobCancellation } from "./job-store.js";
import { cancelActiveVideoImageJobs } from "./video-image-invalidation.js";

export interface StoredCreativeInstructions extends CreativeInstructions {
  updatedAt: number;
}

export interface StoredVideoInputDraft extends VideoInputDraft {
  updatedAt: number;
}

interface InstructionRow {
  script_instructions: string;
  visual_instructions: string;
  updated_at: number;
}

interface VideoInputRow extends InstructionRow {
  input_mode: InputMode;
  topic: string;
  body: string;
  reference_text: string;
  reference_role: ReferenceRole;
  target_duration_seconds: number;
  visual_density: VisualDensity;
  web_enabled: number;
}

function instructionResult(row: InstructionRow): StoredCreativeInstructions {
  return {
    scriptInstructions: row.script_instructions,
    visualInstructions: row.visual_instructions,
    updatedAt: row.updated_at,
  };
}

function videoInputResult(row: VideoInputRow): StoredVideoInputDraft {
  return {
    inputMode: row.input_mode,
    topic: row.topic,
    body: row.body,
    referenceText: row.reference_text,
    referenceRole: row.reference_role,
    targetDurationSeconds: row.target_duration_seconds,
    visualDensity: row.visual_density,
    webEnabled: row.web_enabled === 1,
    scriptInstructions: row.script_instructions,
    visualInstructions: row.visual_instructions,
    updatedAt: row.updated_at,
  };
}

export function getProjectSettings(database: DatabaseSync, projectId: string) {
  const project = getProject(database, projectId);
  return instructionResult(database.prepare(
    `SELECT script_instructions, visual_instructions, updated_at FROM projects WHERE id = ?`,
  ).get(project.id) as unknown as InstructionRow);
}

export function putProjectSettings(
  database: DatabaseSync,
  projectId: string,
  input: unknown,
  now = Date.now(),
) {
  const settings = parseCreativeInstructions(input, "项目创作设置");
  const project = getProject(database, projectId);
  const updatedAt = Math.max(now, project.updatedAt + 1);
  database.prepare(
    `UPDATE projects SET script_instructions = ?, visual_instructions = ?, updated_at = ? WHERE id = ?`,
  ).run(settings.scriptInstructions, settings.visualInstructions, updatedAt, project.id);
  return getProjectSettings(database, project.id);
}

export function getVideoInput(database: DatabaseSync, projectId: string, videoId: string) {
  const video = getVideo(database, projectId, videoId);
  return videoInputResult(database.prepare(
    `SELECT input_mode, topic, body, reference_text, reference_role, target_duration_seconds,
            visual_density, web_enabled, script_instructions, visual_instructions, updated_at
     FROM videos WHERE id = ? AND project_id = ?`,
  ).get(video.id, video.projectId) as unknown as VideoInputRow);
}

export function putVideoInput(
  database: DatabaseSync,
  projectId: string,
  videoId: string,
  input: unknown,
  now = Date.now(),
) {
  const draft = parseVideoInputDraft(input);
  const video = getVideo(database, projectId, videoId);
  const project = getProject(database, projectId);
  const current = getVideoInput(database, projectId, videoId);
  const generationInputChanged = JSON.stringify({ ...current, updatedAt: undefined }) !==
    JSON.stringify({ ...draft, updatedAt: undefined });
  const updatedAt = Math.max(now, video.updatedAt + 1, project.updatedAt + 1);

  // 草稿与项目摘要时间必须一起提交，避免首页排序落后于视频的真实编辑时间。
  database.exec("BEGIN IMMEDIATE");
  try {
    database.prepare(
      `UPDATE videos SET input_mode = ?, topic = ?, body = ?, reference_text = ?, reference_role = ?,
         target_duration_seconds = ?, visual_density = ?, web_enabled = ?, script_instructions = ?,
         visual_instructions = ?, updated_at = ? WHERE id = ? AND project_id = ?`,
    ).run(draft.inputMode, draft.topic, draft.body, draft.referenceText, draft.referenceRole,
      draft.targetDurationSeconds, draft.visualDensity, draft.webEnabled ? 1 : 0,
      draft.scriptInstructions, draft.visualInstructions, updatedAt, video.id, video.projectId);
    if (generationInputChanged) {
      // 只有真实生成输入变化才失效已冻结方案；完全相同的重复保存保持批准有效。
      database.prepare(
        "UPDATE video_plan_snapshots SET invalidated_at = ? WHERE video_id = ? AND invalidated_at IS NULL",
      ).run(updatedAt, video.id);
      const activeJobs = database.prepare(
        `SELECT jobs.id FROM video_plan_jobs map JOIN jobs ON jobs.id = map.job_id
         WHERE map.video_id = ? AND jobs.status IN ('queued', 'running')`,
      ).all(video.id) as Array<{ id: string }>;
      for (const job of activeJobs) requestJobCancellation(database, job.id, updatedAt);
      cancelActiveVideoImageJobs(database, video.id, updatedAt);
      database.prepare("UPDATE videos SET status = 'draft' WHERE id = ? AND project_id = ?")
        .run(video.id, video.projectId);
    }
    database.prepare("UPDATE projects SET updated_at = ? WHERE id = ?").run(updatedAt, project.id);
    database.exec("COMMIT");
  } catch (error) {
    try { database.exec("ROLLBACK"); } catch { /* 保留原始写入错误。 */ }
    throw error;
  }
  return getVideoInput(database, project.id, video.id);
}

export function getGlobalPromptSettings(database: DatabaseSync) {
  const row = database.prepare(
    `SELECT script_instructions, visual_instructions, updated_at FROM global_prompt_settings WHERE id = 1`,
  ).get() as InstructionRow | undefined;
  if (!row) throw new CreativeInputError(500, "全局提示词设置不存在");
  return instructionResult(row);
}

export function putGlobalPromptSettings(database: DatabaseSync, input: unknown, now = Date.now()) {
  const settings = parseCreativeInstructions(input, "全局提示词设置");
  const current = getGlobalPromptSettings(database);
  const updatedAt = Math.max(now, current.updatedAt + 1);
  database.prepare(
    `UPDATE global_prompt_settings
     SET script_instructions = ?, visual_instructions = ?, updated_at = ? WHERE id = 1`,
  ).run(settings.scriptInstructions, settings.visualInstructions, updatedAt);
  return getGlobalPromptSettings(database);
}
