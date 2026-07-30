import type { DatabaseSync } from "node:sqlite";

type PipelineJobStage = "story_bible" | "episode_plan" | "script_generation";

export function mappedPipelineJobConcurrency(database: DatabaseSync, jobId: string, stage: PipelineJobStage) {
  const row = database.prepare(
    `SELECT MIN(run.chapter_concurrency) AS value
     FROM series_pipeline_jobs mapping
     JOIN series_pipeline_runs run ON run.id = mapping.run_id
     WHERE mapping.job_id = ? AND mapping.stage = ?
       AND run.status NOT IN ('cancelled', 'completed')`,
  ).get(jobId, stage) as { value?: unknown } | undefined;
  return Number.isSafeInteger(row?.value) && Number(row!.value) > 0 ? Number(row!.value) : 1;
}

export async function runConcurrent<T>(
  items: readonly T[],
  concurrency: number,
  run: (item: T) => Promise<void>,
) {
  let next = 0;
  const worker = async () => {
    while (next < items.length) await run(items[next++]!);
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker));
}
