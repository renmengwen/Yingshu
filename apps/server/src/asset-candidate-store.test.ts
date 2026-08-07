import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createReadStream } from "node:fs";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  appendAssetCandidateReview,
  AssetCandidateStoreError,
  listAssetCandidateReviewEvents,
  listAssetCandidates,
  publishAssetCandidate,
  registerAssetCandidate,
  type AssetCandidateSource,
} from "./asset-candidate-store.js";
import { deleteBook } from "./book-library.js";
import { withDataFileMutationLock } from "./data-file-mutation-lock.js";
import { openDatabase } from "./database.js";

function fixture(path: string, format: "png" | "mjpeg" | "webp", size = "32x24") {
  const codec = format === "png" ? "png" : format === "mjpeg" ? "mjpeg" : "libwebp";
  const result = spawnSync("ffmpeg", [
    "-v", "error", "-f", "lavfi", "-i", `color=c=0x5f6f7f:s=${size}`,
    "-frames:v", "1", "-c:v", codec, "-y", path,
  ], { windowsHide: true, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
}

function seedAsset(database: ReturnType<typeof openDatabase>["database"]) {
  database.prepare(
    `INSERT INTO books (id, title, original_file_path, original_file_hash, encoding, import_status)
     VALUES ('book', '候选图测试', 'books/book/source.txt', ?, 'UTF-8', 'ready')`,
  ).run("1".repeat(64));
  database.prepare(
    `INSERT INTO series_projects (id, book_id, title, created_at, updated_at)
     VALUES ('series', 'book', '系列', 1, 1)`,
  ).run();
  database.prepare(
    `INSERT INTO assets (
       id, series_project_id, asset_type, asset_role, canonical_name, normalized_name, created_at
     ) VALUES ('asset', 'series', 'character', 'master', '人物', '人物', 1)`,
  ).run();
}

function isStoreError(statusCode: number) {
  return (error: unknown) => error instanceof AssetCandidateStoreError && error.statusCode === statusCode;
}

test("候选图统一校验三种格式、内容寻址、幂等审核与重启级联", async () => {
  const root = await mkdtemp(join(tmpdir(), "narralume-candidates-"));
  const inputs = join(root, "inputs");
  await mkdir(inputs);
  const files = {
    png: join(inputs, "sample.png"),
    jpeg: join(inputs, "sample.jpg"),
    webp: join(inputs, "sample.webp"),
  };
  fixture(files.png, "png");
  fixture(files.jpeg, "mjpeg");
  fixture(files.webp, "webp");

  let connection = openDatabase(root);
  try {
    assert.equal(
      connection.database.prepare("SELECT MAX(version) AS version FROM schema_migrations").get()?.version,
      28,
    );
    seedAsset(connection.database);

    const registered = [];
    for (const [name, path] of Object.entries(files)) {
      registered.push(await registerAssetCandidate(connection.database, root, {
        assetId: "asset",
        source: { kind: "upload", originalName: `../secret/sample.${name}` },
        raw: createReadStream(path),
        now: 10,
      }));
    }
    assert.deepEqual(registered.map((item) => item.mime), ["image/png", "image/jpeg", "image/webp"]);
    assert.equal(registered.every((item) => item.width === 32 && item.height === 24), true);
    assert.equal(registered.every((item) => item.relativePath.startsWith("assets/candidates/")), true);
    assert.equal(registered.every((item) => !item.relativePath.includes("secret")), true);

    const same = await registerAssetCandidate(connection.database, root, {
      assetId: "asset",
      source: { kind: "upload", originalName: "sample.png" },
      raw: createReadStream(files.png),
      now: 999,
    });
    assert.equal(same.id, registered[0]!.id);
    assert.equal(listAssetCandidates(connection.database, "asset").length, 3);

    const generationWithUnknownSecrets = {
      kind: "generation",
      episodeId: "episode",
      scriptVersionId: "script",
      approvalRevision: 1,
      provider: "provider",
      model: "model",
      promptHash: "2".repeat(64),
      requestHash: "3".repeat(64),
      size: "32x24",
      outputIndex: 0,
      key: "must-not-persist",
      baseUrl: "https://must-not-persist.invalid",
    } as AssetCandidateSource;
    const generated = await registerAssetCandidate(connection.database, root, {
      assetId: "asset", source: generationWithUnknownSecrets, raw: createReadStream(files.png), now: 11,
    });
    assert.equal(generated.sourceJson.includes("must-not-persist"), false);
    assert.equal(listAssetCandidates(connection.database, "asset").length, 4);

    const candidateId = registered[0]!.id;
    appendAssetCandidateReview(connection.database, candidateId, {
      expectedRevision: 0, action: "approve", now: 20,
    });
    appendAssetCandidateReview(connection.database, candidateId, {
      expectedRevision: 1, action: "note", note: "可用于定妆", now: 21,
    });
    assert.throws(
      () => appendAssetCandidateReview(connection.database, candidateId, {
        expectedRevision: 1, action: "reject", now: 22,
      }),
      isStoreError(409),
    );
    const reviewed = listAssetCandidates(connection.database, "asset").find((item) => item.id === candidateId)!;
    assert.equal(reviewed.reviewRevision, 2);
    assert.equal(reviewed.reviewStatus, "approved");
    assert.deepEqual(
      listAssetCandidateReviewEvents(connection.database, candidateId).map((event) => event.action),
      ["approve", "note"],
    );

    connection.close();
    connection = openDatabase(root);
    assert.equal(listAssetCandidates(connection.database, "asset").length, 4);
    connection.database.prepare("DELETE FROM series_projects WHERE id = 'series'").run();
    assert.equal(connection.database.prepare("SELECT COUNT(*) AS count FROM asset_candidates").get()?.count, 0);
    assert.equal(connection.database.prepare("SELECT COUNT(*) AS count FROM asset_candidate_review_events").get()?.count, 0);
  } finally {
    connection.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("候选图拒绝伪装格式、越界尺寸、超限流并清理 staging", async () => {
  const root = await mkdtemp(join(tmpdir(), "narralume-candidates-invalid-"));
  const invalid = join(root, "fake.png");
  const tooWide = join(root, "wide.png");
  await writeFile(invalid, Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), Buffer.from("not-png") ]));
  fixture(tooWide, "png", "9000x16");
  const source = { kind: "upload" as const, originalName: "image.png" };
  try {
    await assert.rejects(
      publishAssetCandidate(root, { assetId: "asset", source, raw: createReadStream(invalid) }),
      isStoreError(400),
    );
    await assert.rejects(
      publishAssetCandidate(root, { assetId: "asset", source, raw: createReadStream(tooWide) }),
      isStoreError(400),
    );
    await assert.rejects(
      publishAssetCandidate(root, {
        assetId: "asset", source,
        raw: (async function* () { yield Buffer.alloc(30 * 1024 * 1024 + 1); })(),
      }),
      isStoreError(413),
    );
    const imports = join(root, ".imports", "images");
    assert.deepEqual(await readdir(imports).catch(() => []), []);
    assert.equal((await readFile(invalid)).length > 8, true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("整书删除排在候选上传前时，上传重新校验资产且不遗留候选文件", async () => {
  const root = await mkdtemp(join(tmpdir(), "narralume-candidate-delete-race-"));
  const input = join(root, "sample.png");
  fixture(input, "png");
  const connection = openDatabase(root);
  try {
    seedAsset(connection.database);
    let releaseBlocker!: () => void;
    let blockerStarted!: () => void;
    const started = new Promise<void>((resolve) => { blockerStarted = resolve; });
    const blocker = withDataFileMutationLock(root, async () => {
      blockerStarted();
      await new Promise<void>((resolve) => { releaseBlocker = resolve; });
    });
    await started;
    const deletion = deleteBook(connection.database, root, "book");
    await Promise.resolve();
    const uploadRejected = assert.rejects(
      registerAssetCandidate(connection.database, root, {
        assetId: "asset",
        source: { kind: "upload", originalName: "sample.png" },
        raw: createReadStream(input),
      }),
      isStoreError(404),
    );
    releaseBlocker();
    await blocker;
    await deletion;
    await uploadRejected;
    const published = await readdir(join(root, "assets", "candidates"), { recursive: true }).catch(() => []);
    assert.deepEqual(published, []);
  } finally {
    connection.close();
    await rm(root, { recursive: true, force: true });
  }
});
