import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

export type AssetType = "character" | "scene" | "prop";

export interface AssetInput {
  type: AssetType;
  name: string;
  parentAssetId?: string | null;
  stateLabel?: string | null;
  description?: string | null;
}

export interface AssetRecord {
  id: string;
  seriesId: string;
  type: AssetType;
  role: "master" | "state";
  name: string;
  parentAssetId: string | null;
  stateLabel: string | null;
  description: string | null;
  aliases: string[];
  createdAt: number;
}

export interface AssetGroup extends AssetRecord {
  states: AssetRecord[];
}

interface AssetRow {
  id: string;
  series_project_id: string;
  asset_type: AssetType;
  asset_role: "master" | "state";
  canonical_name: string;
  normalized_name: string;
  parent_asset_id: string | null;
  state_label: string | null;
  description: string | null;
  created_at: number;
}

interface AliasRow {
  asset_id: string;
  alias: string;
  normalized_alias: string;
  is_primary: number;
}

export class AssetStoreError extends Error {
  constructor(readonly statusCode: number, message: string) { super(message); }
}

function displayText(value: unknown, label: string) {
  if (typeof value !== "string") throw new AssetStoreError(400, `${label}不能为空`);
  const text = value.normalize("NFKC").trim().replace(/\s+/gu, " ");
  if (!text) throw new AssetStoreError(400, `${label}不能为空`);
  return text;
}

function normalizedText(value: unknown, label: string) {
  return displayText(value, label).toLocaleLowerCase("zh-CN");
}

function optionalText(value: unknown, label: string) {
  return value === undefined || value === null || value === "" ? null : displayText(value, label);
}

function requireSeries(database: DatabaseSync, seriesId: string) {
  const id = displayText(seriesId, "系列项目 ID");
  if (!database.prepare("SELECT id FROM series_projects WHERE id = ?").get(id)) {
    throw new AssetStoreError(404, "系列项目不存在");
  }
  return id;
}

function aliasesByAsset(database: DatabaseSync, assetIds: string[]) {
  const result = new Map<string, string[]>();
  if (assetIds.length === 0) return result;
  const placeholders = assetIds.map(() => "?").join(", ");
  const rows = database.prepare(
    `SELECT asset_id, alias, normalized_alias, is_primary FROM asset_aliases
     WHERE asset_id IN (${placeholders})
     ORDER BY asset_id, is_primary DESC, normalized_alias, alias`,
  ).all(...assetIds) as unknown as AliasRow[];
  for (const row of rows) {
    const aliases = result.get(row.asset_id) ?? [];
    aliases.push(row.alias);
    result.set(row.asset_id, aliases);
  }
  return result;
}

function assetResult(row: AssetRow, aliases: string[]): AssetRecord {
  return {
    id: row.id,
    seriesId: row.series_project_id,
    type: row.asset_type,
    role: row.asset_role,
    name: row.canonical_name,
    parentAssetId: row.parent_asset_id,
    stateLabel: row.state_label,
    description: row.description,
    aliases,
    createdAt: row.created_at,
  };
}

function getAsset(database: DatabaseSync, assetId: string) {
  return database.prepare(
    `SELECT id, series_project_id, asset_type, asset_role, canonical_name, normalized_name,
            parent_asset_id, state_label, description, created_at
     FROM assets WHERE id = ?`,
  ).get(assetId) as AssetRow | undefined;
}

function resultFor(database: DatabaseSync, row: AssetRow) {
  return assetResult(row, aliasesByAsset(database, [row.id]).get(row.id) ?? []);
}

function rollback(database: DatabaseSync) {
  try { database.exec("ROLLBACK"); } catch { /* 保留原始写入错误。 */ }
}

export function createAsset(database: DatabaseSync, seriesId: string, input: AssetInput) {
  const normalizedSeriesId = requireSeries(database, seriesId);
  if (!input || !(["character", "scene", "prop"] as const).includes(input.type)) {
    throw new AssetStoreError(400, "资产类型必须是人物、场景或道具");
  }
  const name = displayText(input.name, "资产名称");
  const normalizedName = normalizedText(name, "资产名称");
  const parentAssetId = input.parentAssetId === undefined || input.parentAssetId === null || input.parentAssetId === ""
    ? null : displayText(input.parentAssetId, "主资产 ID");
  const stateLabel = optionalText(input.stateLabel, "状态标签");
  const description = optionalText(input.description, "资产描述");
  if ((parentAssetId === null) !== (stateLabel === null)) {
    throw new AssetStoreError(400, "状态资产必须同时指定主资产和状态标签");
  }
  const role = parentAssetId ? "state" : "master";

  let parent: AssetRow | undefined;
  if (parentAssetId) {
    parent = getAsset(database, parentAssetId);
    if (!parent) throw new AssetStoreError(404, "主资产不存在");
    if (parent.series_project_id !== normalizedSeriesId || parent.asset_type !== input.type) {
      throw new AssetStoreError(409, "状态资产必须属于同一系列且类型与主资产一致");
    }
    if (parent.asset_role !== "master") throw new AssetStoreError(409, "状态资产不能继续创建下级状态");
  }

  const normalizedStateLabel = stateLabel ? normalizedText(stateLabel, "状态标签") : "";
  const id = `asset_${createHash("sha256").update([
    "asset-v1", normalizedSeriesId, input.type, role, parentAssetId ?? "", normalizedName, normalizedStateLabel,
  ].join("\0")).digest("hex")}`;
  const now = Date.now();

  database.exec("BEGIN IMMEDIATE");
  try {
    const existing = getAsset(database, id);
    if (existing) {
      if ((existing.state_label ? normalizedText(existing.state_label, "状态标签") : "") !== normalizedStateLabel ||
          existing.description !== description) {
        throw new AssetStoreError(409, "相同资产身份已存在，但显示信息不一致");
      }
      database.exec("COMMIT");
      return resultFor(database, existing);
    }
    const aliasOwner = database.prepare(
      "SELECT asset_id FROM asset_aliases WHERE series_project_id = ? AND normalized_alias = ?",
    ).get(normalizedSeriesId, normalizedName) as { asset_id: string } | undefined;
    if (aliasOwner) throw new AssetStoreError(409, "资产名称或别名已被其他资产使用");

    database.prepare(
      `INSERT INTO assets (
         id, series_project_id, asset_type, asset_role, canonical_name, normalized_name,
         parent_asset_id, state_label, description, created_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(id, normalizedSeriesId, input.type, role, name, normalizedName,
      parentAssetId, stateLabel, description, now);
    database.prepare(
      `INSERT INTO asset_aliases (
         series_project_id, asset_id, alias, normalized_alias, is_primary, created_at
       ) VALUES (?, ?, ?, ?, 1, ?)`,
    ).run(normalizedSeriesId, id, name, normalizedName, now);
    database.exec("COMMIT");
    return resultFor(database, getAsset(database, id)!);
  } catch (error) {
    rollback(database);
    throw error;
  }
}

export function addAssetAliases(database: DatabaseSync, assetId: string, aliases: string[]) {
  const id = displayText(assetId, "资产 ID");
  const asset = getAsset(database, id);
  if (!asset) throw new AssetStoreError(404, "资产不存在");
  if (!Array.isArray(aliases) || aliases.length === 0) {
    throw new AssetStoreError(400, "别名不能为空");
  }
  const unique = new Map<string, string>();
  for (const alias of aliases) {
    const display = displayText(alias, "资产别名");
    unique.set(normalizedText(display, "资产别名"), display);
  }

  database.exec("BEGIN IMMEDIATE");
  try {
    const insert = database.prepare(
      `INSERT INTO asset_aliases (
         series_project_id, asset_id, alias, normalized_alias, is_primary, created_at
       ) VALUES (?, ?, ?, ?, 0, ?)`,
    );
    for (const [normalizedAlias, alias] of unique) {
      const owner = database.prepare(
        "SELECT asset_id FROM asset_aliases WHERE series_project_id = ? AND normalized_alias = ?",
      ).get(asset.series_project_id, normalizedAlias) as { asset_id: string } | undefined;
      if (owner?.asset_id === id) continue;
      if (owner) throw new AssetStoreError(409, "资产名称或别名已被其他资产使用");
      insert.run(asset.series_project_id, id, alias, normalizedAlias, Date.now());
    }
    database.exec("COMMIT");
    return resultFor(database, asset);
  } catch (error) {
    rollback(database);
    throw error;
  }
}

export function listAssets(database: DatabaseSync, seriesId: string): AssetGroup[] {
  const id = requireSeries(database, seriesId);
  const rows = database.prepare(
    `SELECT id, series_project_id, asset_type, asset_role, canonical_name, normalized_name,
            parent_asset_id, state_label, description, created_at
     FROM assets WHERE series_project_id = ?
     ORDER BY asset_type, asset_role, normalized_name, id`,
  ).all(id) as unknown as AssetRow[];
  const aliases = aliasesByAsset(database, rows.map((row) => row.id));
  const states = new Map<string, AssetRecord[]>();
  for (const row of rows.filter((candidate) => candidate.asset_role === "state")) {
    const siblings = states.get(row.parent_asset_id!) ?? [];
    siblings.push(assetResult(row, aliases.get(row.id) ?? []));
    states.set(row.parent_asset_id!, siblings);
  }
  return rows.filter((row) => row.asset_role === "master").map((row) => ({
    ...assetResult(row, aliases.get(row.id) ?? []),
    states: states.get(row.id) ?? [],
  }));
}
