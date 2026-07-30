import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import {
  buildChapterEvidenceAtoms,
  createOpenAiResponsesChapterAnalyzer,
  type ChapterTextModelConfig,
} from "../chapter-event-analyzer.js";
import { prepareChapterEvents } from "../chapter-event-store.js";
import { openDatabase } from "../database.js";
import { writeTextModelDiagnostic } from "../text-model-diagnostics.js";
import { TextModelCallError } from "../text-model-stream.js";

const MUSEDOCK_CONFIG = "D:\\code3\\MuseDock\\data\\config\\ai-models.json";
const DEFAULT_BOOK_ID = "book_6d95e28bde2ba49123a80df990f0c70de7108c38dfc5b47f8db777504c53ba82";
const DEFAULT_CHAPTER_ID = "chapter_b93ab011f8b1081d5ceb3fa93cbd95d419921e6166c49d03ab3334d8d19f5f6d";

async function readTextConfig(): Promise<ChapterTextModelConfig> {
  const stored = JSON.parse(await readFile(MUSEDOCK_CONFIG, "utf8")) as {
    active?: { text?: string };
    providers?: Record<string, {
      protocol?: string;
      apiKey?: string;
      baseUrl?: string;
      models?: Record<string, { enabled?: boolean; modelId?: string }>;
    }>;
  };
  const selected = process.env.YINGSHU_GATE_TEXT_PROVIDER?.trim();
  const [providerId, modelType] = selected ? [selected, "text"] : stored.active?.text?.split("/") ?? [];
  const provider = providerId ? stored.providers?.[providerId] : undefined;
  const model = modelType ? provider?.models?.[modelType] : undefined;
  const apiKey = provider?.apiKey?.trim() ?? "";
  const baseUrl = provider?.baseUrl?.trim() ?? "";
  const modelId = model?.modelId?.trim() ?? "";
  assert.equal(provider?.protocol, "openai-response", "真实 gate 当前只支持已冻结的 /v1/response 文本协议");
  assert.ok(providerId && apiKey && baseUrl && model?.enabled && modelId, "MuseDock 本机文本模型配置不可用");
  return {
    providerId,
    apiKey,
    baseUrl,
    model: modelId,
  };
}

const dataRoot = resolve("apps/server/data");
const connection = openDatabase(dataRoot);
let modelConfig: ChapterTextModelConfig | undefined;
try {
  const bookId = process.env.YINGSHU_GATE_BOOK_ID?.trim() || DEFAULT_BOOK_ID;
  const chapterId = process.env.YINGSHU_GATE_CHAPTER_ID?.trim() || DEFAULT_CHAPTER_ID;
  const source = await buildChapterEvidenceAtoms(connection.database, dataRoot, bookId, chapterId);
  console.log(JSON.stringify({ stage: "source-ready", chapterId, atoms: source.atoms.length, sourceCharacters: source.atoms.reduce((total, atom) => total + atom.text.length, 0) }));
  modelConfig = await readTextConfig();
  const analyze = createOpenAiResponsesChapterAnalyzer(modelConfig);
  const inputs = await analyze({
    chapterId,
    atoms: source.atoms,
    signal: AbortSignal.timeout(180_000),
  });
  assert.ok(inputs.length > 0, "真实章节分析没有返回可验收事件");
  const prepared = await prepareChapterEvents(connection.database, dataRoot, bookId, chapterId, inputs);
  assert.equal(prepared.length, inputs.length);
  assert.ok(prepared.every((event) => event.sources.length > 0 && event.sources.every((item) => /^[0-9a-f]{64}$/.test(item.sourceHash))));
  console.log(JSON.stringify({ ok: true, chapterId, atoms: source.atoms.length, events: prepared.length }));
} catch (error) {
  if (modelConfig && error instanceof TextModelCallError) {
    await writeTextModelDiagnostic({
      dataRoot,
      jobId: "gate:p2-real-chapter-analysis",
      attempt: 1,
      stage: error.stage,
      providerId: modelConfig.providerId,
      model: modelConfig.model,
      protocol: error.evidence.statistics?.protocol ?? modelConfig.protocol ?? "openai-response",
      error: { name: error.name, message: error.message },
      statistics: error.evidence.statistics,
      partialText: error.evidence.partialText,
      partialTextTruncated: error.evidence.partialTextTruncated,
    }).catch(() => undefined);
  }
  throw error;
} finally {
  connection.close();
}
