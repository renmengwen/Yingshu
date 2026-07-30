import { limitedResponseText, textModelRequest, type ChapterTextModelConfig } from "./chapter-event-analyzer.js";
import type { GenerateEpisodeScript } from "./episode-script-generation-job.js";
import { layeredPrompt, PRODUCT_PROMPTS } from "./product-prompts.js";
import { textModelConcurrencyGate } from "./text-model-concurrency.js";
import {
  completedTextModelEvidence,
  rememberTextModelEvidence,
  streamedText,
  textModelCallError,
  TextModelStreamError,
  type TextModelStreamStatistics,
} from "./text-model-stream.js";

export function createOpenAiEpisodeScriptGenerator(
  config: ChapterTextModelConfig,
  fetchImpl: typeof fetch = fetch,
): GenerateEpisodeScript {
  return async (input) => {
    const diagnosticStage = input.diagnosticStage ?? `episode-script:${input.stage}`;
    const allowlist = input.stage === "skeleton"
      ? input.sources.map(({ sourceIndex, sourceEventId }) => ({ sourceIndex, sourceEventId }))
      : null;
    const instructions = input.stage === "skeleton"
      ? `${input.correctionError
        ? `上一次完整 JSON 被骨架合同拒绝：${input.correctionError}。只纠正一次并重新输出完整 JSON。`
        : "生成按原文顺序排列的故事 beats。"}
唯一输出 schema：{"beats":[{"intent":"非空字符串","sourceIndexes":[0],"targetDurationSeconds":60}]}。顶层只能包含 beats；每个 beat 只能包含 intent、sourceIndexes 和可选的 targetDurationSeconds；输出中只能出现 sourceIndexes，不得输出 sourceEventId 或其他包装字段。
冻结 sourceIndex→sourceEventId allowlist：${JSON.stringify(allowlist)}。
每个 allowlist sourceIndex 必须在全部 beats 中全局恰好出现一次；sourceIndexes 必须按 allowlist 严格递增；不得遗漏、重复、伪造或越界。只输出 JSON。`
      : input.stage === "faithful"
        ? `只根据本 beat 提供的原文写原著还原叙事，不添加事实。正文必须在 ${input.minimumCharacterCount} 至 ${input.maximumCharacterCount} 字之间，并尽量接近 ${input.characterBudget} 字；不得用摘要代替完整叙事。输出严格 JSON：{"text":"..."}`
        : input.stage === "finished"
          ? `${input.correctionError
            ? `上一次完整 JSON 被合同拒绝：${input.correctionError}。previousParagraphs 是被拒绝的完整输出；只纠正一次并重新输出完整 JSON。`
            : "直接生成当前 beat 可配音的成片旁白。"}
唯一输出 schema：{"paragraphs":[{"text":"...","sourceIndexes":[0]}]}。正文必须在 ${input.minimumCharacterCount} 至 ${input.maximumCharacterCount} 字之间，并尽量接近 ${input.characterBudget} 字；每段只能引用当前 beat allowlist 中实际使用的 sourceIndexes，且全部来源必须至少覆盖一次。只输出 JSON。`
          : `${input.correctionError
            ? `上一次完整成片旁白稿被生成合同拒绝：${input.correctionError}。previousParagraphs 是被拒绝的完整稿，请在保持事实、来源和段落顺序的前提下针对上述错误定向改写，并重新输出完整 JSON。`
            : "在不改变事实的前提下，把原著还原稿整理成可直接配音的成片旁白稿。"}必须对叙述节奏、段落衔接和口语表达进行实际改写，不得原样返回输入 paragraphs。全部正文必须在 ${input.minimumCharacterCount} 至 ${input.maximumCharacterCount} 字之间，并尽量接近 ${input.characterBudget} 字；不得因润色或重组而压缩成摘要。每段只能引用输入已有 sourceIndexes。输出严格 JSON：{"paragraphs":[{"text":"...","sourceIndexes":[0]}]}`;
    const { signal, onActivity } = input;
    const safeInput = input.stage === "skeleton"
      ? (({ signal: _signal, onActivity: _onActivity, correctionError: _correctionError,
        prompt: _prompt, diagnosticStage: _diagnosticStage, ...rest }) => rest)(input)
      : input.stage === "finished"
        ? (({ signal: _signal, onActivity: _onActivity, correctionError: _correctionError,
          prompt: _prompt, paragraphs: _paragraphs, diagnosticStage: _diagnosticStage, ...rest }) => rest)(input)
        : input.stage === "packaged"
          ? (({ signal: _signal, onActivity: _onActivity, correctionError: _correctionError,
            diagnosticStage: _diagnosticStage, ...rest }) => rest)(input)
          : (({ signal: _signal, onActivity: _onActivity, diagnosticStage: _diagnosticStage, ...rest }) => rest)(input);
    const prompt = input.stage === "finished"
      ? `${instructions}\n\n${layeredPrompt(PRODUCT_PROMPTS.finishedNarrationBeat,
        input.prompt.instructions, JSON.stringify(safeInput))}`
      : input.stage === "skeleton" && input.prompt
        ? `${instructions}\n\n${layeredPrompt(PRODUCT_PROMPTS.episodeSkeleton,
          input.prompt.instructions, JSON.stringify(safeInput))}`
        : `${instructions}\n${JSON.stringify(safeInput)}`;
    const request = textModelRequest(config, prompt, 8192, true);
    let statistics: TextModelStreamStatistics | undefined;
    let raw: string;
    try {
      raw = await textModelConcurrencyGate.run(signal, async () => {
        const response = await fetchImpl(request.endpoint, {
          method: "POST", signal, redirect: "error", headers: request.headers, body: request.body,
        });
        if (!response.ok) {
          await response.body?.cancel();
          throw new Error(`长稿生成模型请求失败（HTTP ${response.status}）`);
        }
        return response.headers.get("content-type")?.toLowerCase().includes("text/event-stream")
          ? streamedText(response, config.protocol ?? "openai-response", {
            signal,
            onActivity,
            onStatistics: (value) => { statistics = value; },
          })
          : limitedResponseText(response, {
            protocol: config.protocol ?? "openai-response", signal, onActivity,
            onStatistics: (value) => { statistics = value; },
          });
      });
    } catch (error) {
      if (signal.aborted) throw error;
      const evidence = error instanceof TextModelStreamError ? {
        statistics: error.statistics,
        partialText: error.partialText,
        partialTextTruncated: error.partialTextTruncated,
      } : {};
      throw textModelCallError(error, diagnosticStage, evidence);
    }
    const evidence = completedTextModelEvidence(raw, statistics);
    try {
      return rememberTextModelEvidence(
        JSON.parse(raw) as Awaited<ReturnType<GenerateEpisodeScript>>,
        evidence,
      );
    } catch (error) {
      throw textModelCallError(new Error("长稿生成模型返回了无效 JSON", { cause: error }), diagnosticStage, evidence);
    }
  };
}
