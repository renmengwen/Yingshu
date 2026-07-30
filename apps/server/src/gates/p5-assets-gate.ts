import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { buildApp } from "../app.js";
import { openDatabase } from "../database.js";

const dataRoot = await mkdtemp(join(tmpdir(), "narralume-p5-assets-"));
let app = buildApp({ dataRoot, logger: false });

try {
  const imported = await app.inject({
    method: "POST",
    url: "/api/books/import",
    headers: { "content-type": "text/plain" },
    payload: Buffer.from("第一章\n林黛玉初入荣国府，随身带着绛珠手帕。", "utf8"),
  });
  assert.equal(imported.statusCode, 201);
  const bookId = imported.json().book.id as string;
  const seriesResponse = await app.inject({
    method: "POST",
    url: `/api/books/${bookId}/series`,
    payload: { title: "红楼梦样片资产" },
  });
  assert.equal(seriesResponse.statusCode, 201);
  const seriesId = seriesResponse.json().series.id as string;

  const create = async (payload: Record<string, unknown>) => {
    const response = await app.inject({ method: "POST", url: `/api/series/${seriesId}/assets`, payload });
    assert.equal(response.statusCode, 201, response.body);
    return response.json().asset as {
      id: string;
      type: "character" | "scene" | "prop";
      role: "master" | "state";
      name: string;
      parentAssetId: string | null;
      aliases: string[];
    };
  };

  const lin = await create({ type: "character", name: "林黛玉", description: "长期人物主资产" });
  const arrival = await create({
    type: "character", name: "林黛玉·初入贾府", parentAssetId: lin.id, stateLabel: "初入贾府",
  });
  const ill = await create({
    type: "character", name: "林黛玉·病中", parentAssetId: lin.id, stateLabel: "病中",
  });
  const mansion = await create({ type: "scene", name: "荣国府" });
  const handkerchief = await create({ type: "prop", name: "绛珠手帕" });
  assert.equal((await create({
    type: "character", name: " 林黛玉 ", description: "长期人物主资产",
  })).id, lin.id);

  const aliases = async (assetId: string, values: string[]) => {
    const response = await app.inject({
      method: "POST", url: `/api/assets/${assetId}/aliases`, payload: { aliases: values },
    });
    assert.equal(response.statusCode, 200, response.body);
  };
  await aliases(lin.id, ["黛玉", "林姑娘"]);
  await aliases(mansion.id, ["贾府"]);
  await aliases(handkerchief.id, ["手帕"]);
  await aliases(lin.id, [" 黛玉 "]);

  const conflict = await app.inject({
    method: "POST", url: `/api/assets/${mansion.id}/aliases`, payload: { aliases: ["黛玉"] },
  });
  assert.equal(conflict.statusCode, 409);
  assert.match(conflict.json().message, /别名|名称/);
  const illegalParent = await app.inject({
    method: "POST",
    url: `/api/series/${seriesId}/assets`,
    payload: { type: "character", name: "非法状态", parentAssetId: arrival.id, stateLabel: "非法" },
  });
  assert.equal(illegalParent.statusCode, 409);

  await app.close();
  app = buildApp({ dataRoot, logger: false });
  const listed = await app.inject({ method: "GET", url: `/api/series/${seriesId}/assets` });
  assert.equal(listed.statusCode, 200, listed.body);
  const items = listed.json().items as Array<{
    id: string; type: string; parentAssetId: string | null; aliases: string[];
    states: Array<{ id: string; parentAssetId: string | null }>;
  }>;
  assert.equal(items.length, 3);
  assert.deepEqual(new Set(items.map((asset) => asset.type)), new Set(["character", "scene", "prop"]));
  const character = items.find((asset) => asset.id === lin.id)!;
  assert.deepEqual(new Set(character.states.map((asset) => asset.id)), new Set([arrival.id, ill.id]));
  assert(character.states.every((asset) => asset.parentAssetId === lin.id));
  assert.deepEqual(new Set(character.aliases), new Set(["林黛玉", "林姑娘", "黛玉"]));
  assert.deepEqual(items.find((asset) => asset.id === mansion.id)?.aliases, ["荣国府", "贾府"]);
  assert.deepEqual(items.find((asset) => asset.id === handkerchief.id)?.aliases, ["绛珠手帕", "手帕"]);

  await app.close();
  const connection = openDatabase(dataRoot);
  try {
    connection.database.prepare("DELETE FROM series_projects WHERE id = ?").run(seriesId);
    assert.equal(
      (connection.database.prepare("SELECT COUNT(*) AS count FROM assets WHERE series_project_id = ?")
        .get(seriesId) as { count: number }).count,
      0,
    );
    assert.equal(
      (connection.database.prepare("SELECT COUNT(*) AS count FROM asset_aliases WHERE series_project_id = ?")
        .get(seriesId) as { count: number }).count,
      0,
    );
  } finally {
    connection.close();
  }

  console.log("P5 资产真实门禁通过");
  console.log(`series_id=${seriesId}`);
  console.log(`asset_ids=${[lin.id, arrival.id, ill.id, mansion.id, handkerchief.id].join(",")}`);
  console.log("asset_types=character,scene,prop");
  console.log("restart_stable=true");
  console.log("series_cascade=true");
} finally {
  await app.close();
  await rm(dataRoot, { recursive: true, force: true });
}
