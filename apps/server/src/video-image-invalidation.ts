import type { DatabaseSync } from "node:sqlite";

import { requestJobCancellation } from "./job-store.js";

/** 上游版本变化时停止未完成任务；成功候选仍作为不可变历史保留。 */
export function cancelActiveVideoImageJobs(database: DatabaseSync, videoId: string, now = Date.now()) {
  const jobs = database.prepare(
    `SELECT item.job_id AS id
     FROM video_image_batch_items item
     JOIN video_image_batches batch ON batch.id = item.batch_id
     JOIN jobs ON jobs.id = item.job_id
     WHERE batch.video_id = ? AND jobs.status IN ('queued', 'running')`,
  ).all(videoId) as Array<{ id: string }>;
  for (const job of jobs) requestJobCancellation(database, job.id, now);
  database.prepare(
    `UPDATE video_image_batch_items SET status = 'cancelled', updated_at = ?
     WHERE video_id = ? AND job_id IN (SELECT id FROM jobs WHERE status = 'cancelled')`,
  ).run(now, videoId);
  return jobs.length;
}
