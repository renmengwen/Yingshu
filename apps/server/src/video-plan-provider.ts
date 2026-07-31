import { limitedResponseText, textModelRequest, type ChapterTextModelConfig } from "./chapter-event-analyzer.js";
import { textModelConcurrencyGate } from "./text-model-concurrency.js";
import { completedTextModelEvidence, rememberTextModelEvidence, streamedText, textModelCallError,
  TextModelStreamError, type TextModelStreamStatistics } from "./text-model-stream.js";
import { withTextModelTimeout } from "./text-model-timeout.js";
import type { GenerateVideoPlan } from "./video-plan-service.js";

export function createVideoPlanGenerator(config: ChapterTextModelConfig, fetchImpl: typeof fetch = fetch): GenerateVideoPlan {
  return async ({ stage, prompt, signal, onActivity }) => {
    let statistics: TextModelStreamStatistics | undefined;
    let raw: string;
    try {
      raw = await withTextModelTimeout(async (timeoutSignal, activity) => {
        return textModelConcurrencyGate.run(timeoutSignal, async () => {
          const request = textModelRequest(config, prompt, stage === "script" ? 16_384 : 12_288, true);
          const response = await fetchImpl(request.endpoint, { method: "POST", signal: timeoutSignal,
            redirect: "error", headers: request.headers, body: request.body });
          if (!response.ok) { await response.body?.cancel(); throw new Error(`方案生成模型请求失败（HTTP ${response.status}）`); }
          const mark = () => { activity(); onActivity(); };
          return response.headers.get("content-type")?.toLowerCase().includes("text/event-stream")
            ? streamedText(response, config.protocol ?? "openai-response", { signal: timeoutSignal, onActivity: mark,
                onStatistics: (value) => { statistics = value; } })
            : limitedResponseText(response, { protocol: config.protocol ?? "openai-response", signal: timeoutSignal,
                onActivity: mark, onStatistics: (value) => { statistics = value; } });
        });
      }, { firstActivityMs: 180_000, idleMs: 180_000, totalMs: 900_000, signal });
    } catch (error) {
      throw error instanceof TextModelStreamError
        ? textModelCallError(error, `video-plan:${stage}`, { statistics: error.statistics,
            partialText: error.partialText, partialTextTruncated: error.partialTextTruncated })
        : textModelCallError(error, `video-plan:${stage}`);
    }
    const evidence = completedTextModelEvidence(raw, statistics);
    try { return rememberTextModelEvidence(JSON.parse(raw) as object, evidence); }
    catch (error) { throw textModelCallError(new Error("方案生成模型返回了无效 JSON", { cause: error }), `video-plan:${stage}`, evidence); }
  };
}
