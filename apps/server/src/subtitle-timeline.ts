export const SUBTITLE_TIMELINE_CONTRACT = "subtitle-timeline-v2";
export const SUBTITLE_LINE_LIMIT = 16;

export interface SubtitleUnit {
  speechText: string;
  subtitleText: string;
}

export interface SubtitleCue {
  index: number;
  startMs: number;
  endMs: number;
  text: string;
}

export interface SubtitleRenderProfile {
  width: number;
  height: number;
}

const MAX_UNIT_LENGTH = SUBTITLE_LINE_LIMIT * 2;
const SPEAKABLE_TEXT = /[\p{L}\p{N}]/u;
const SENTENCE_END = /[。！？!?；;…]/u;
const SOFT_BREAK = /[，,、：:]/u;
const PUNCTUATION = /[，。！？；：、,.!?;:…）》】」』]/u;

function codePoints(text: string) {
  return [...text];
}

function wrapSubtitle(text: string) {
  const characters = codePoints(text);
  if (characters.length <= SUBTITLE_LINE_LIMIT) return text;
  let best = Math.ceil(characters.length / 2);
  let bestScore = Number.POSITIVE_INFINITY;
  const first = Math.max(1, characters.length - SUBTITLE_LINE_LIMIT);
  const last = Math.min(SUBTITLE_LINE_LIMIT, characters.length - 1);
  for (let split = first; split <= last; split += 1) {
    const score = Math.abs(split - (characters.length - split)) +
      (PUNCTUATION.test(characters[split]!) ? 100 : 0);
    if (score < bestScore) { best = split; bestScore = score; }
  }
  return `${characters.slice(0, best).join("")}\n${characters.slice(best).join("")}`;
}

function mergeUnspeakableUnits(units: string[]) {
  if (!units.some((unit) => SPEAKABLE_TEXT.test(unit))) return [];
  const merged: string[] = [];
  for (let index = 0; index < units.length; index += 1) {
    const unit = units[index];
    if (!unit) continue;
    if (SPEAKABLE_TEXT.test(unit)) {
      merged.push(unit);
    } else if (merged.length > 0) {
      merged[merged.length - 1] += unit;
    } else {
      const next = units.slice(index + 1).findIndex((candidate) => SPEAKABLE_TEXT.test(candidate));
      if (next >= 0) units[index + 1 + next] = `${unit}${units[index + 1 + next]!}`;
    }
  }
  return merged;
}

export function splitNarration(text: string): SubtitleUnit[] {
  const normalized = text.trim().replace(/\s+/gu, " ");
  if (!normalized) return [];
  const tokens: string[] = [];
  let token = "";
  const characters = codePoints(normalized);
  for (let index = 0; index < characters.length; index += 1) {
    token += characters[index]!;
    if (!SENTENCE_END.test(characters[index]!)) continue;
    while (index + 1 < characters.length && SENTENCE_END.test(characters[index + 1]!)) token += characters[++index]!;
    tokens.push(token);
    token = "";
  }
  if (token) tokens.push(token);

  const speechUnits = tokens.flatMap((value) => {
    const parts = codePoints(value);
    const result: string[] = [];
    for (let offset = 0; offset < parts.length;) {
      const maximum = Math.min(offset + MAX_UNIT_LENGTH, parts.length);
      let end = maximum;
      if (maximum < parts.length) {
        for (let candidate = maximum - 1; candidate >= offset; candidate -= 1) {
          if (SOFT_BREAK.test(parts[candidate]!)) { end = candidate + 1; break; }
        }
      }
      result.push(parts.slice(offset, end).join(""));
      offset = end;
    }
    return result;
  });
  return mergeUnspeakableUnits(speechUnits).map((speechText) => ({ speechText, subtitleText: wrapSubtitle(speechText) }));
}

function srtTimestamp(ms: number) {
  const hours = Math.floor(ms / 3_600_000);
  const minutes = Math.floor(ms / 60_000) % 60;
  const seconds = Math.floor(ms / 1_000) % 60;
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")},${String(ms % 1_000).padStart(3, "0")}`;
}

function assTimestamp(ms: number, end: boolean) {
  const value = end ? Math.ceil(ms / 10) : Math.floor(ms / 10);
  return `${Math.floor(value / 360_000)}:${String(Math.floor(value / 6_000) % 60).padStart(2, "0")}:` +
    `${String(Math.floor(value / 100) % 60).padStart(2, "0")}.${String(value % 100).padStart(2, "0")}`;
}

export function escapeSrtText(text: string) {
  return text.replace(/&/gu, "&amp;").replace(/</gu, "&lt;").replace(/>/gu, "&gt;");
}

export function escapeAssText(text: string) {
  return text.replace(/\\/gu, "\\\\").replace(/\{/gu, "｛").replace(/\}/gu, "｝").replace(/\r?\n/gu, "\\N");
}

export function renderAss(cues: SubtitleCue[], offsetMs = 0, profile: SubtitleRenderProfile = { width: 1080, height: 1920 }) {
  const events = cues.map((cue) =>
    `Dialogue: 0,${assTimestamp(cue.startMs - offsetMs, false)},${assTimestamp(cue.endMs - offsetMs, true)},Default,,0,0,0,,${escapeAssText(cue.text)}`,
  ).join("\n");
  return `[Script Info]\nScriptType: v4.00+\nPlayResX: ${profile.width}\nPlayResY: ${profile.height}\nWrapStyle: 2\n\n[V4+ Styles]\nFormat: Name,Fontname,Fontsize,PrimaryColour,SecondaryColour,OutlineColour,BackColour,Bold,Italic,Underline,StrikeOut,ScaleX,ScaleY,Spacing,Angle,BorderStyle,Outline,Shadow,Alignment,MarginL,MarginR,MarginV,Encoding\nStyle: Default,Microsoft YaHei,54,&H00FFFFFF,&H000000FF,&H00181818,&H80000000,-1,0,0,0,100,100,0,0,1,3,2,2,80,80,180,1\n\n[Events]\nFormat: Layer,Start,End,Style,Name,MarginL,MarginR,MarginV,Effect,Text\n${events}\n`;
}

export function renderSubtitleFiles(cues: SubtitleCue[], profile: SubtitleRenderProfile = { width: 1080, height: 1920 }) {
  const srt = cues.map((cue) =>
    `${cue.index + 1}\n${srtTimestamp(cue.startMs)} --> ${srtTimestamp(cue.endMs)}\n${escapeSrtText(cue.text)}\n`,
  ).join("\n");
  return { srt, ass: renderAss(cues, 0, profile) };
}
