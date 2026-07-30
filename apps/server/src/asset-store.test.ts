import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { addAssetAliases, AssetStoreError, createAsset, listAssets } from "./asset-store.js";
import { openDatabase } from "./database.js";

function seedSeries(database: ReturnType<typeof openDatabase>["database"]) {
  database.prepare(
    `INSERT INTO books (
       id, title, original_file_path, original_file_hash, encoding, import_status
     ) VALUES (?, ?, ?, ?, 'UTF-8', 'ready')`,
  ).run("book_assets", "资产测试", "books/assets.txt", "a".repeat(64));
  database.prepare(
    `INSERT INTO series_projects (id, book_id, title, created_at, updated_at)
     VALUES (?, 'book_assets', ?, 1, 1), (?, 'book_assets', ?, 2, 2)`,
  ).run("series_one", "系列一", "series_two", "系列二");
}

function isStatus(statusCode: number) {
  return (error: unknown) => error instanceof AssetStoreError && error.statusCode === statusCode;
}

test("资产主从关系、别名、冲突与重启读回保持稳定", async () => {
  const dataRoot = await mkdtemp(join(tmpdir(), "narralume-assets-"));
  let connection = openDatabase(dataRoot);
  try {
    seedSeries(connection.database);
    const character = createAsset(connection.database, "series_one", {
      type: "character", name: "  项　云峰  ", description: "主角",
    });
    const sameCharacter = createAsset(connection.database, "series_one", {
      type: "character", name: "项 云峰", description: "主角",
    });
    assert.equal(sameCharacter.id, character.id);
    assert.deepEqual(character.aliases, ["项 云峰"]);

    const young = createAsset(connection.database, "series_one", {
      type: "character", name: "少年云峰", parentAssetId: character.id,
      stateLabel: " 少年　时期 ", description: "初入行",
    });
    const injured = createAsset(connection.database, "series_one", {
      type: "character", name: "受伤云峰", parentAssetId: character.id,
      stateLabel: "受伤",
    });
    const scene = createAsset(connection.database, "series_one", { type: "scene", name: "古墓" });
    const prop = createAsset(connection.database, "series_one", { type: "prop", name: "洛阳铲" });
    assert.deepEqual([character.type, scene.type, prop.type], ["character", "scene", "prop"]);
    assert.deepEqual([young.role, injured.role], ["state", "state"]);

    const aliased = addAssetAliases(connection.database, character.id, [" 我 ", "云　峰", "我", "项 云峰"]);
    assert.deepEqual(aliased.aliases, ["项 云峰", "云 峰", "我"]);
    assert.deepEqual(addAssetAliases(connection.database, character.id, ["我"]).aliases, aliased.aliases);

    assert.throws(
      () => createAsset(connection.database, "series_one", { type: "prop", name: "云 峰" }),
      isStatus(409),
    );
    assert.throws(() => addAssetAliases(connection.database, prop.id, ["我"]), isStatus(409));
    assert.throws(
      () => createAsset(connection.database, "series_two", {
        type: "character", name: "跨系列状态", parentAssetId: character.id, stateLabel: "错误",
      }),
      isStatus(409),
    );
    assert.throws(
      () => createAsset(connection.database, "series_one", {
        type: "prop", name: "跨类型状态", parentAssetId: character.id, stateLabel: "错误",
      }),
      isStatus(409),
    );
    assert.throws(
      () => createAsset(connection.database, "series_one", {
        type: "character", name: "状态的状态", parentAssetId: young.id, stateLabel: "错误",
      }),
      isStatus(409),
    );
    assert.throws(
      () => createAsset(connection.database, "series_one", {
        type: "character", name: "缺少标签", parentAssetId: character.id,
      }),
      isStatus(400),
    );
    assert.throws(() => addAssetAliases(connection.database, "asset_missing", ["别名"]), isStatus(404));
    assert.throws(
      () => createAsset(connection.database, "series_missing", { type: "scene", name: "不存在" }),
      isStatus(404),
    );

    const beforeRestart = listAssets(connection.database, "series_one");
    assert.deepEqual(beforeRestart.map((asset) => [asset.type, asset.name]), [
      ["character", "项 云峰"], ["prop", "洛阳铲"], ["scene", "古墓"],
    ]);
    assert.deepEqual(beforeRestart[0]?.aliases, ["项 云峰", "云 峰", "我"]);
    assert.deepEqual(beforeRestart[0]?.states.map((state) => state.name), ["受伤云峰", "少年云峰"]);

    connection.close();
    connection = openDatabase(dataRoot);
    assert.deepEqual(listAssets(connection.database, "series_one"), beforeRestart);
  } finally {
    connection.close();
    await rm(dataRoot, { recursive: true, force: true });
  }
});
