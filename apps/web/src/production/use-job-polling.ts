import { useEffect, useRef, useState } from "react";

import { responseJson } from "../client-logic";
import { isTerminalJobStatus, jobStatusText } from "../production-logic";
import type { JobRecord } from "./types";

export function useJobPolling(jobId: string | undefined, onMessage: (message: string) => void) {
  const [job, setJob] = useState<JobRecord>();
  const messageRef = useRef(onMessage);
  messageRef.current = onMessage;

  useEffect(() => {
    setJob(undefined);
    if (!jobId) return;
    let cancelled = false;
    let timer: number | undefined;

    async function hydrate() {
      try {
        const body = await responseJson<{ job: JobRecord }>(await fetch(`/api/jobs/${encodeURIComponent(jobId!)}`));
        if (cancelled) return;
        setJob(body.job);
        const suffix = body.job.errorMessage ? `：${body.job.errorMessage}` : "";
        messageRef.current(`${jobStatusText(body.job.status)}${suffix}`);
        if (!isTerminalJobStatus(body.job.status)) timer = window.setTimeout(hydrate, 3000);
      } catch (error) {
        if (cancelled) return;
        messageRef.current(`任务恢复失败：${(error as Error).message}`);
        timer = window.setTimeout(hydrate, 3000);
      }
    }

    void hydrate();
    return () => {
      cancelled = true;
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, [jobId]);

  return job;
}
