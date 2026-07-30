import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, unlink } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";

import { writeTextModelDiagnostic, type WriteTextModelDiagnosticInput } from "./text-model-diagnostics.js";

test("text model diagnostics are bounded, filter unknown fields, and publish atomically", async () => {
  const dataRoot = await mkdtemp(join(tmpdir(), "narralume-text-diagnostic-"));
  const partialText = `${"abc".repeat(349_525)}tail`;
  const input = {
    dataRoot,
    jobId: "../../job/outside",
    attempt: 2,
    stage: "../../../final\\world",
    providerId: "provider",
    model: "model",
    protocol: "openai-response",
    error: { name: "Error", message: "stream failed", code: "stream_limit" },
    statistics: {
      protocol: "openai-response",
      rawBytes: 9_000_000,
      extractedTextBytes: Buffer.byteLength(partialText),
      eventCount: 7,
      eventTypes: { "response.output_text.delta": 7 },
      lastEventType: "response.output_text.delta",
      terminalReceived: false,
      contentType: "text/event-stream",
      declaredContentLength: null,
      requestIds: {
        "X-Request-Id": "safe-request-id",
        traceparent: "00-trace-parent",
        Authorization: "Bearer response-secret",
      },
      apiKey: "statistics-secret",
    },
    partialText,
    partialTextTruncated: false,
    apiKey: "top-level-secret",
    Authorization: "Bearer top-level-secret",
    prompt: "complete-secret-prompt",
  } as WriteTextModelDiagnosticInput & Record<string, unknown>;

  try {
    const path = await writeTextModelDiagnostic(input);
    const expectedDirectory = resolve(dataRoot, "diagnostics", "text-model");
    assert.equal(dirname(resolve(path)), expectedDirectory);
    assert.equal(relative(expectedDirectory, resolve(path)).startsWith(`..${sep}`), false);

    const raw = await readFile(path, "utf8");
    const saved = JSON.parse(raw);
    assert.equal(saved.trust, "untrusted");
    assert.equal(saved.recoveryEligible, false);
    assert.equal(Buffer.byteLength(saved.partialText.content), saved.partialText.storedBytes);
    assert.ok(saved.partialText.storedBytes <= 1024 * 1024);
    assert.equal(saved.partialText.extractedBytes, Buffer.byteLength(partialText));
    assert.equal(saved.partialText.capturedBytes, Buffer.byteLength(partialText));
    assert.equal(saved.partialText.capturedSha256, createHash("sha256").update(partialText).digest("hex"));
    assert.equal(saved.partialText.truncated, true);
    assert.equal(saved.statistics.requestIds["x-request-id"], "safe-request-id");
    assert.equal(saved.statistics.requestIds.traceparent, "00-trace-parent");
    assert.equal(raw.includes("secret"), false);
    assert.equal(saved.containsPotentiallySensitiveContent, true);
    assert.equal(saved.confidentialityBoundary, "data-root");

    const products = await readdir(expectedDirectory);
    assert.deepEqual(products, [products[0]]);
    assert.match(products[0]!, /\.json$/u);
    assert.equal(products.some((name) => name.endsWith(".tmp")), false);
  } finally {
    await rm(dataRoot, { recursive: true, force: true });
  }
});

test("non-stream model errors are recorded without stream fields", async () => {
  const dataRoot = await mkdtemp(join(tmpdir(), "narralume-text-error-"));
  try {
    const path = await writeTextModelDiagnostic({
      dataRoot,
      jobId: "job-1",
      attempt: 1,
      stage: "chapter-analysis",
      providerId: "provider",
      model: "model",
      protocol: "anthropic-message",
      error: { name: "TimeoutError", message: "idle timeout" },
    });
    const saved = JSON.parse(await readFile(path, "utf8"));
    assert.deepEqual(saved.error, { name: "TimeoutError", message: "idle timeout", code: null });
    assert.equal(saved.containsPotentiallySensitiveContent, true);
    assert.equal("statistics" in saved, false);
    assert.equal("partialText" in saved, false);
    await writeTextModelDiagnostic({
      dataRoot,
      jobId: "job-1",
      attempt: 1,
      stage: "chapter-analysis",
      providerId: "provider",
      model: "model",
      protocol: "anthropic-message",
      error: { name: "TimeoutError", message: "second timeout" },
    });
    const products = await readdir(join(dataRoot, "diagnostics", "text-model"));
    assert.equal(products.filter((name) => name.endsWith(".json")).length, 2);
    assert.equal(products.some((name) => name.endsWith(".tmp")), false);
  } finally {
    await rm(dataRoot, { recursive: true, force: true });
  }
});

test("diagnostic directory symlink cannot escape data root", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "narralume-text-diagnostic-link-"));
  const dataRoot = join(root, "data");
  const outside = join(root, "outside");
  const diagnosticDirectory = join(dataRoot, "diagnostics", "text-model");
  let linked = false;
  try {
    await Promise.all([
      mkdir(join(dataRoot, "diagnostics"), { recursive: true }),
      mkdir(outside),
    ]);
    try {
      await symlink(outside, diagnosticDirectory, process.platform === "win32" ? "junction" : "dir");
      linked = true;
    } catch (error) {
      context.skip(`current platform cannot create directory link: ${(error as Error).message}`);
      return;
    }

    await assert.rejects(writeTextModelDiagnostic({
      dataRoot,
      jobId: "job-link",
      attempt: 1,
      stage: "chapter-analysis",
      providerId: "provider",
      model: "model",
      protocol: "openai-response",
      error: { name: "Error", message: "failed" },
    }));
    assert.deepEqual(await readdir(outside), []);
  } finally {
    if (linked) await unlink(diagnosticDirectory);
    await rm(root, { recursive: true, force: true });
  }
});
