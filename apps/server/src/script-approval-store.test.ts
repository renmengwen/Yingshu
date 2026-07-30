import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { openDatabase } from "./database.js";
import {
  changeScriptApproval,
  getScriptApproval,
  requireApprovedScriptForProduction,
  ScriptApprovalStoreError,
} from "./script-approval-store.js";

function seed(database: ReturnType<typeof openDatabase>["database"]) {
  database.prepare(
    `INSERT INTO books (
       id, title, original_file_path, original_file_hash, encoding, import_status
     ) VALUES ('book_approval', '测试书', 'books/source.txt', ?, 'UTF-8', 'ready')`,
  ).run("a".repeat(64));
  database.prepare(
    `INSERT INTO series_projects (id, book_id, title, created_at, updated_at)
     VALUES ('series_approval', 'book_approval', '测试系列', 1, 1)`,
  ).run();
  for (const index of [1, 2]) {
    database.prepare(
      `INSERT INTO episodes (
         id, series_project_id, episode_index, title, story_arc,
         target_duration_seconds, created_at, updated_at
       ) VALUES (?, 'series_approval', ?, ?, '故事弧', 240, 1, 1)`,
    ).run(`episode_${index}`, index, `第 ${index} 集`);
    database.prepare(
      `INSERT INTO script_versions (
         id, episode_id, kind, version, parent_version_id, content_json, content_hash, created_at
       ) VALUES (?, ?, 'faithful', 1, NULL, '{"paragraphs":[]}', ?, 1)`,
    ).run(`faithful_${index}`, `episode_${index}`, String(index).repeat(64));
    database.prepare(
      `INSERT INTO script_versions (
         id, episode_id, kind, version, parent_version_id, content_json, content_hash, created_at
       ) VALUES (?, ?, 'packaged', 1, ?, '{"paragraphs":[]}', ?, 2)`,
    ).run(`packaged_${index}`, `episode_${index}`, `faithful_${index}`, String(index + 2).repeat(64));
  }
  database.prepare(
    `INSERT INTO script_versions (
       id, episode_id, kind, version, parent_version_id, script_contract_version, content_json, content_hash, created_at
     ) VALUES ('finished_2', 'episode_2', 'packaged', 2, NULL, 6, '{"paragraphs":[]}', ?, 3)`,
  ).run("f".repeat(64));
}

function expectApprovalError(fn: () => unknown, statusCode: number, message: RegExp) {
  assert.throws(fn, (error) => {
    assert(error instanceof ScriptApprovalStoreError);
    assert.equal(error.statusCode, statusCode);
    assert.match(error.message, message);
    return true;
  });
}

test("批准与撤回追加不可变 revision，并控制语音和图片生产", async () => {
  const dataRoot = await mkdtemp(join(tmpdir(), "narralume-approval-"));
  const connection = openDatabase(dataRoot);
  try {
    seed(connection.database);
    assert.deepEqual(getScriptApproval(connection.database, "episode_1"), {
      episodeId: "episode_1", status: "unapproved", revision: 0, scriptVersionId: null, changedAt: null,
    });
    for (const purpose of ["tts", "image"] as const) {
      expectApprovalError(
        () => requireApprovedScriptForProduction(connection.database, "episode_1", purpose),
        409,
        /未人工批准/,
      );
    }

    expectApprovalError(
      () => changeScriptApproval(connection.database, "episode_1", {
        action: "approve", expectedRevision: 0, scriptVersionId: "faithful_1",
      }),
      409,
      /成片旁白稿/,
    );
    expectApprovalError(
      () => changeScriptApproval(connection.database, "episode_1", {
        action: "approve", expectedRevision: 0, scriptVersionId: "packaged_2",
      }),
      409,
      /成片旁白稿/,
    );

    const approved = changeScriptApproval(connection.database, "episode_1", {
      action: "approve", expectedRevision: 0, scriptVersionId: "packaged_1",
    }, 10);
    assert.deepEqual(approved, {
      episodeId: "episode_1", status: "approved", revision: 1,
      scriptVersionId: "packaged_1", changedAt: 10,
    });
    assert.deepEqual(requireApprovedScriptForProduction(connection.database, "episode_1", "tts"), {
      episodeId: "episode_1", scriptVersionId: "packaged_1",
      contentHash: "3".repeat(64), approvalRevision: 1,
    });
    const approvedFinished = changeScriptApproval(connection.database, "episode_2", {
      action: "approve", expectedRevision: 0, scriptVersionId: "finished_2",
    }, 11);
    assert.equal(approvedFinished.scriptVersionId, "finished_2");
    assert.deepEqual(requireApprovedScriptForProduction(connection.database, "episode_2", "tts"), {
      episodeId: "episode_2", scriptVersionId: "finished_2",
      contentHash: "f".repeat(64), approvalRevision: 1,
    });
    expectApprovalError(
      () => changeScriptApproval(connection.database, "episode_1", {
        action: "approve", expectedRevision: 0, scriptVersionId: "packaged_1",
      }),
      409,
      /revision=1/,
    );

    const withdrawn = changeScriptApproval(connection.database, "episode_1", {
      action: "withdraw", expectedRevision: 1,
    }, 20);
    assert.deepEqual(withdrawn, {
      episodeId: "episode_1", status: "withdrawn", revision: 2, scriptVersionId: null, changedAt: 20,
    });
    expectApprovalError(
      () => requireApprovedScriptForProduction(connection.database, "episode_1", "image"),
      409,
      /未人工批准/,
    );
    expectApprovalError(
      () => changeScriptApproval(connection.database, "episode_1", {
        action: "withdraw", expectedRevision: 2,
      }),
      409,
      /没有可撤回/,
    );
    assert.equal(
      connection.database.prepare("SELECT COUNT(*) AS count FROM script_approval_events").get()?.count,
      3,
    );
  } finally {
    connection.close();
    await rm(dataRoot, { recursive: true, force: true });
  }
});

test("两个连接使用同一 expectedRevision 时只有一个批准成功", async () => {
  const dataRoot = await mkdtemp(join(tmpdir(), "narralume-approval-concurrent-"));
  const first = openDatabase(dataRoot);
  seed(first.database);
  const second = openDatabase(dataRoot);
  try {
    const approved = changeScriptApproval(first.database, "episode_1", {
      action: "approve", expectedRevision: 0, scriptVersionId: "packaged_1",
    });
    assert.equal(approved.revision, 1);
    expectApprovalError(
      () => changeScriptApproval(second.database, "episode_1", {
        action: "approve", expectedRevision: 0, scriptVersionId: "packaged_1",
      }),
      409,
      /revision=1/,
    );
    assert.equal(
      first.database.prepare("SELECT COUNT(*) AS count FROM script_approval_events").get()?.count,
      1,
    );
  } finally {
    second.close();
    first.close();
    await rm(dataRoot, { recursive: true, force: true });
  }
});
