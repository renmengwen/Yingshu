import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

export interface BookPromptProfileContent {
  sharedInstructions: string;
  chapterAnalysisInstructions: string;
  storyBibleInstructions: string;
  episodePlanningInstructions: string;
  narrationInstructions: string;
  assetInstructions: string;
}

export interface BookPromptProfile extends BookPromptProfileContent {
  bookId: string;
  revision: number;
  profileHash: string;
  createdAt: number;
}

const FIELDS = ["sharedInstructions", "chapterAnalysisInstructions", "storyBibleInstructions",
  "episodePlanningInstructions", "narrationInstructions", "assetInstructions"] as const;

export const EMPTY_BOOK_PROMPT_PROFILE: BookPromptProfileContent = {
  sharedInstructions: "",
  chapterAnalysisInstructions: "",
  storyBibleInstructions: "",
  episodePlanningInstructions: "",
  narrationInstructions: "",
  assetInstructions: "",
};

function normalize(input: BookPromptProfileContent) {
  if (!input || typeof input !== "object" || Array.isArray(input) ||
      Object.keys(input).sort().join(",") !== [...FIELDS].sort().join(",")) {
    throw new Error("本书专属提示词字段集合无效");
  }
  return Object.fromEntries(FIELDS.map((field) => {
    const value = input?.[field];
    if (typeof value !== "string" || value.length > 20_000) throw new Error("本书专属提示词字段必须是不超过 20000 字的文本");
    return [field, value.replace(/\r\n?/gu, "\n").trim()];
  })) as unknown as BookPromptProfileContent;
}

export function bookPromptProfileHash(content: BookPromptProfileContent) {
  return createHash("sha256").update(JSON.stringify(normalize(content))).digest("hex");
}

function rowResult(row: Record<string, unknown>): BookPromptProfile {
  return {
    bookId: String(row.book_id), revision: Number(row.revision),
    sharedInstructions: String(row.shared_instructions),
    chapterAnalysisInstructions: String(row.chapter_analysis_instructions),
    storyBibleInstructions: String(row.story_bible_instructions),
    episodePlanningInstructions: String(row.episode_planning_instructions),
    narrationInstructions: String(row.narration_instructions), assetInstructions: String(row.asset_instructions),
    profileHash: String(row.profile_hash), createdAt: Number(row.created_at),
  };
}

export function getBookPromptProfile(database: DatabaseSync, bookId: string) {
  const row = database.prepare(
    "SELECT * FROM book_prompt_profiles WHERE book_id = ? ORDER BY revision DESC LIMIT 1",
  ).get(bookId) as Record<string, unknown> | undefined;
  return row ? rowResult(row) : undefined;
}

export function getBookPromptProfileRevision(database: DatabaseSync, bookId: string, revision: number) {
  const row = database.prepare(
    "SELECT * FROM book_prompt_profiles WHERE book_id = ? AND revision = ?",
  ).get(bookId, revision) as Record<string, unknown> | undefined;
  return row ? rowResult(row) : undefined;
}

export function bookPromptInstructions(profile: BookPromptProfile, stage: keyof Omit<BookPromptProfileContent,
  "sharedInstructions">) {
  return [profile.sharedInstructions, profile[stage]].filter(Boolean).join("\n\n");
}

export function saveBookPromptProfile(
  database: DatabaseSync, bookId: string, input: BookPromptProfileContent, now = Date.now(),
) {
  if (!database.prepare("SELECT 1 FROM books WHERE id = ?").get(bookId)) throw new Error("书籍不存在");
  const content = normalize(input);
  const profileHash = bookPromptProfileHash(content);
  const current = getBookPromptProfile(database, bookId);
  if (current?.profileHash === profileHash) return current;
  const revision = (current?.revision ?? 0) + 1;
  database.prepare(
    `INSERT INTO book_prompt_profiles (
       book_id, revision, shared_instructions, chapter_analysis_instructions, story_bible_instructions,
       episode_planning_instructions, narration_instructions, asset_instructions, profile_hash, created_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(bookId, revision, content.sharedInstructions, content.chapterAnalysisInstructions,
    content.storyBibleInstructions, content.episodePlanningInstructions, content.narrationInstructions,
    content.assetInstructions, profileHash, now);
  return getBookPromptProfile(database, bookId)!;
}

export function getOrCreateBookPromptProfile(database: DatabaseSync, bookId: string, now = Date.now()) {
  return getBookPromptProfile(database, bookId) ?? saveBookPromptProfile(database, bookId, EMPTY_BOOK_PROMPT_PROFILE, now);
}
