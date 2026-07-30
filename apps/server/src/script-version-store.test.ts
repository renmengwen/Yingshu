import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { openDatabase } from "./database.js";
import {
  createScriptVersion, listScriptVersions, ScriptVersionStoreError,
} from "./script-version-store.js";

async function fixture() {
  const dataRoot = await mkdtemp(join(tmpdir(), "narralume-script-versions-"));
  const connection = openDatabase(dataRoot);
  const database = connection.database;
  database.prepare(
    `INSERT INTO books (
       id, title, original_file_path, original_file_hash, encoding, import_status
     ) VALUES ('book', '书', 'books/book/source.txt', ?, 'UTF-8', 'ready')`,
  ).run("a".repeat(64));
  database.prepare(
    `INSERT INTO chapters (
       id, book_id, chapter_index, title, byte_start, byte_end, char_count, content_hash
     ) VALUES ('chapter', 'book', 0, '第一章', 0, 20, 20, 'hash')`,
  ).run();
  for (const series of ["series_a", "series_b"]) {
    database.prepare(
      `INSERT INTO series_projects (id, book_id, title, created_at, updated_at)
       VALUES (?, 'book', ?, 1, 1)`,
    ).run(series, series);
  }
  for (const [episode, series] of [["episode_a", "series_a"], ["episode_b", "series_b"]] as const) {
    database.prepare(
      `INSERT INTO episodes (
         id, series_project_id, episode_index, title, story_arc,
         target_duration_seconds, created_at, updated_at
       ) VALUES (?, ?, 1, '第一集', '开端', 180, 1, 1)`,
    ).run(episode, series);
    for (const sourceIndex of [0, 1]) {
      database.prepare(
        `INSERT INTO episode_sources (
           episode_id, source_index, chapter_id, source_event_id,
           source_byte_start, source_byte_end, source_hash
         ) VALUES (?, ?, 'chapter', ?, ?, ?, ?)`,
      ).run(episode, sourceIndex, `event_${sourceIndex}`, sourceIndex * 5,
        sourceIndex * 5 + 5, String(sourceIndex + 1).repeat(64));
    }
  }
  return { dataRoot, connection };
}

function concurrentCreator(dataRoot: string) {
  const databaseModule = new URL("./database.ts", import.meta.url).href;
  const storeModule = new URL("./script-version-store.ts", import.meta.url).href;
  const code = `
    const { openDatabase } = await import(${JSON.stringify(databaseModule)});
    const { createScriptVersion } = await import(${JSON.stringify(storeModule)});
    const connection = openDatabase(process.env.YINGSHU_CONCURRENT_DATA_ROOT);
    process.stdout.write("READY\\n");
    await new Promise((resolve) => process.stdin.once("data", resolve));
    try {
      const script = createScriptVersion(connection.database, "episode_a", {
        kind: "faithful", paragraphs: [{ text: "并发正文", sourceIndexes: [0] }],
      }, 50);
      process.stdout.write(JSON.stringify(script) + "\\n");
    } finally { connection.close(); }
  `;
  const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "--eval", code], {
    env: { ...process.env, YINGSHU_CONCURRENT_DATA_ROOT: dataRoot },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  let readyResolve!: () => void;
  const ready = new Promise<void>((resolve) => { readyResolve = resolve; });
  child.stdout.on("data", (chunk: Buffer) => {
    stdout += chunk.toString("utf8");
    if (stdout.includes("READY\n")) readyResolve();
  });
  child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString("utf8"); });
  const done = new Promise<Record<string, unknown>>((resolve, reject) => child.once("close", (code) => {
    if (code !== 0) reject(new Error(`并发稿件子进程失败 ${code}：${stderr}`));
    else resolve(JSON.parse(stdout.trim().split("\n").at(-1)!) as Record<string, unknown>);
  }));
  return { child, ready, done };
}

test("忠实稿与包装稿按 kind 追加不可变版本并复制来源快照", async () => {
  const context = await fixture();
  try {
    const faithful = createScriptVersion(context.connection.database, "episode_a", {
      kind: "faithful",
      paragraphs: [{ text: "原文叙述", sourceIndexes: [0] }],
    }, 10);
    const packaged = createScriptVersion(context.connection.database, "episode_a", {
      kind: "packaged", parentVersionId: faithful.id,
      paragraphs: [{ sourceIndexes: [0], text: "开场钩子" }],
    }, 20);
    const changed = createScriptVersion(context.connection.database, "episode_a", {
      kind: "faithful",
      paragraphs: [{ text: "补充原文", sourceIndexes: [0, 1] }],
    }, 30);

    assert.equal(faithful.versionNumber, 1);
    assert.equal(packaged.versionNumber, 1);
    assert.equal(packaged.parentVersionId, faithful.id);
    assert.equal(changed.versionNumber, 2);
    assert.deepEqual(listScriptVersions(context.connection.database, "episode_a", "faithful"), [faithful, changed]);
    const snapshots = context.connection.database.prepare(
      `SELECT episode_source_index, source_hash FROM script_version_sources
       WHERE script_version_id = ? ORDER BY segment_index, source_index`,
    ).all(packaged.id);
    assert.deepEqual(
      snapshots.map((row) => ({ ...row })),
      [{ episode_source_index: 0, source_hash: "1".repeat(64) }],
    );
  } finally {
    context.connection.close();
    await rm(context.dataRoot, { recursive: true, force: true });
  }
});

test("规范 JSON 使相同内容幂等且不改写既有版本", async () => {
  const context = await fixture();
  try {
    const first = createScriptVersion(context.connection.database, "episode_a", {
      kind: "faithful",
      paragraphs: [{ text: "正文", sourceIndexes: [0] }],
    }, 10);
    const repeated = createScriptVersion(context.connection.database, "episode_a", {
      kind: "faithful",
      paragraphs: [{ sourceIndexes: [0], text: "正文" }],
    }, 99);
    assert.deepEqual(repeated, first);
    assert.equal(context.connection.database.prepare("SELECT COUNT(*) AS count FROM script_versions").get()?.count, 1);
    assert.equal(context.connection.database.prepare("SELECT COUNT(*) AS count FROM script_version_sources").get()?.count, 1);
  } finally {
    context.connection.close();
    await rm(context.dataRoot, { recursive: true, force: true });
  }
});

test("双连接并发提交相同内容只产生一个稿件身份", async () => {
  const context = await fixture();
  try {
    const first = concurrentCreator(context.dataRoot);
    const second = concurrentCreator(context.dataRoot);
    await Promise.all([first.ready, second.ready]);
    first.child.stdin.end("GO\n");
    second.child.stdin.end("GO\n");
    const [left, right] = await Promise.all([first.done, second.done]);
    assert.equal(left.id, right.id);
    assert.equal(left.versionNumber, 1);
    assert.equal(right.versionNumber, 1);
    assert.equal(context.connection.database.prepare(
      "SELECT COUNT(*) AS count FROM script_versions WHERE episode_id = 'episode_a'",
    ).get()?.count, 1);
  } finally {
    context.connection.close();
    await rm(context.dataRoot, { recursive: true, force: true });
  }
});

test("错父、跨分集父版本和无来源分段均在写入前拒绝", async () => {
  const context = await fixture();
  try {
    const parent = createScriptVersion(context.connection.database, "episode_a", {
      kind: "faithful", paragraphs: [{ text: "正文", sourceIndexes: [0] }],
    }, 10);
    const otherParent = createScriptVersion(context.connection.database, "episode_b", {
      kind: "faithful", paragraphs: [{ text: "别集", sourceIndexes: [0] }],
    }, 10);
    const before = context.connection.database.prepare("SELECT COUNT(*) AS count FROM script_versions").get()?.count;
    const invalid = [
      { kind: "packaged" as const, parentVersionId: parent.id, paragraphs: [{ text: "越权来源", sourceIndexes: [1] }] },
      { kind: "packaged" as const, parentVersionId: otherParent.id, paragraphs: [{ text: "跨集", sourceIndexes: [0] }] },
      { kind: "faithful" as const, paragraphs: [{ text: "无来源", sourceIndexes: [] }] },
    ];
    for (const input of invalid) {
      assert.throws(
        () => createScriptVersion(context.connection.database, "episode_a", input),
        (error: unknown) => error instanceof ScriptVersionStoreError,
      );
    }
    assert.equal(context.connection.database.prepare("SELECT COUNT(*) AS count FROM script_versions").get()?.count, before);
    assert.equal(context.connection.database.prepare("SELECT COUNT(*) AS count FROM script_version_sources").get()?.count, 2);
  } finally {
    context.connection.close();
    await rm(context.dataRoot, { recursive: true, force: true });
  }
});
