import { createHash, randomUUID } from "node:crypto";
import { mkdir, realpath, rename, unlink, writeFile } from "node:fs/promises";
import { isAbsolute, join, relative } from "node:path";

const MAX_PARTIAL_TEXT_BYTES = 1024 * 1024;
const REQUEST_ID_HEADERS = new Set([
  "anthropic-request-id",
  "cf-ray",
  "openai-request-id",
  "request-id",
  "traceparent",
  "x-amz-request-id",
  "x-amzn-requestid",
  "x-anthropic-request-id",
  "x-openai-request-id",
  "x-request-id",
]);

export type TextModelStreamStatistics = {
  protocol: string;
  responseFormat?: "sse" | "json";
  rawBytes: number;
  extractedTextBytes: number;
  eventCount: number;
  eventTypes: Readonly<Record<string, number>>;
  lastEventType: string | null;
  terminalReceived: boolean;
  contentType: string | null;
  declaredContentLength: number | null;
  requestIds: Readonly<Record<string, string>>;
};

export type WriteTextModelDiagnosticInput = {
  dataRoot: string;
  jobId: string;
  attempt: number;
  stage: string;
  providerId: string;
  model: string;
  protocol: string;
  error: {
    name: string;
    message: string;
    code?: string | null;
  };
  statistics?: TextModelStreamStatistics;
  partialText?: string;
  partialTextTruncated?: boolean;
};

function clipped(value: string, maxLength = 512) {
  return value.slice(0, maxLength);
}

function safeCount(value: number) {
  return Number.isFinite(value) && value >= 0 ? Math.floor(value) : 0;
}

function safeFilePart(value: string) {
  return value
    .replace(/[^A-Za-z0-9._-]+/gu, "-")
    .replace(/^[.-]+|[.-]+$/gu, "")
    .slice(0, 48) || "unknown";
}

function utf8Prefix(bytes: Buffer, limit: number) {
  if (bytes.length <= limit) return bytes;
  for (let end = limit; end >= Math.max(0, limit - 3); end -= 1) {
    try {
      new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, end));
      return bytes.subarray(0, end);
    } catch {
      // A UTF-8 code point can straddle the byte limit by at most three bytes.
    }
  }
  return Buffer.alloc(0);
}

function safeEventTypes(eventTypes: Readonly<Record<string, number>>) {
  return Object.fromEntries(Object.entries(eventTypes)
    .sort(([left], [right]) => left.localeCompare(right))
    .slice(0, 256)
    .map(([name, count]) => [clipped(name, 128), safeCount(count)]));
}

function safeRequestIds(requestIds: Readonly<Record<string, string>>) {
  return Object.fromEntries(Object.entries(requestIds)
    .map(([name, value]) => [name.toLowerCase(), value] as const)
    .filter(([name]) => REQUEST_ID_HEADERS.has(name))
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([name, value]) => [name, clipped(value, 256)]));
}

export async function writeTextModelDiagnostic(input: WriteTextModelDiagnosticInput) {
  if (!Number.isSafeInteger(input.attempt) || input.attempt < 0) {
    throw new TypeError("attempt must be a non-negative safe integer");
  }

  const partialBytes = input.partialText === undefined ? null : Buffer.from(input.partialText, "utf8");
  const storedBytes = partialBytes === null ? null : utf8Prefix(partialBytes, MAX_PARTIAL_TEXT_BYTES);
  const diagnostic = {
    schemaVersion: 1,
    trust: "untrusted",
    recoveryEligible: false,
    containsPotentiallySensitiveContent: true,
    confidentialityBoundary: "data-root",
    recordedAt: new Date().toISOString(),
    jobId: clipped(input.jobId),
    attempt: input.attempt,
    stage: clipped(input.stage),
    providerId: clipped(input.providerId),
    model: clipped(input.model),
    protocol: clipped(input.protocol),
    error: {
      name: clipped(input.error.name, 256),
      message: clipped(input.error.message, 2_000),
      code: input.error.code == null ? null : clipped(input.error.code, 256),
    },
    statistics: input.statistics === undefined ? undefined : {
      protocol: clipped(input.statistics.protocol, 64),
      responseFormat: input.statistics.responseFormat ?? "sse",
      rawBytes: safeCount(input.statistics.rawBytes),
      extractedTextBytes: safeCount(input.statistics.extractedTextBytes),
      eventCount: safeCount(input.statistics.eventCount),
      eventTypes: safeEventTypes(input.statistics.eventTypes),
      lastEventType: input.statistics.lastEventType === null
        ? null
        : clipped(input.statistics.lastEventType, 128),
      terminalReceived: input.statistics.terminalReceived === true,
      contentType: input.statistics.contentType === null
        ? null
        : clipped(input.statistics.contentType, 256),
      declaredContentLength: input.statistics.declaredContentLength === null
        ? null
        : safeCount(input.statistics.declaredContentLength),
      requestIds: safeRequestIds(input.statistics.requestIds),
    },
    partialText: partialBytes === null || storedBytes === null ? undefined : {
      content: storedBytes.toString("utf8"),
      extractedBytes: input.partialTextTruncated && input.statistics
        ? safeCount(input.statistics.extractedTextBytes)
        : partialBytes.length,
      capturedBytes: partialBytes.length,
      storedBytes: storedBytes.length,
      capturedSha256: createHash("sha256").update(partialBytes).digest("hex"),
      truncated: input.partialTextTruncated === true || storedBytes.length < partialBytes.length,
    },
  } as const;

  const directory = join(input.dataRoot, "diagnostics", "text-model");
  const identityHash = createHash("sha256")
    .update(`${input.jobId}\0${input.attempt}\0${input.stage}`)
    .digest("hex")
    .slice(0, 16);
  const unique = `${Date.now()}-${randomUUID()}`;
  const fileName = `${safeFilePart(input.jobId)}--${safeFilePart(input.stage)}--attempt-${input.attempt}--${identityHash}--${unique}.json`;
  const targetPath = join(directory, fileName);
  const temporaryPath = join(directory, `.${fileName}.${randomUUID()}.tmp`);

  await mkdir(directory, { recursive: true });
  const [rootRealPath, directoryRealPath] = await Promise.all([realpath(input.dataRoot), realpath(directory)]);
  const fromRoot = relative(rootRealPath, directoryRealPath);
  if (fromRoot === "" || fromRoot.startsWith("..") || isAbsolute(fromRoot)) {
    throw new Error("文本模型诊断目录越出 data root");
  }
  try {
    await writeFile(temporaryPath, `${JSON.stringify(diagnostic, null, 2)}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 });
    await rename(temporaryPath, targetPath);
  } catch (error) {
    await unlink(temporaryPath).catch(() => undefined);
    throw error;
  }
  return targetPath;
}
