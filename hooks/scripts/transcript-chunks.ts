/**
 * Transcript chunking — a BYTE-IDENTICAL copy of `@claude-transcripts/shared`'s
 * `sliceIntoChunks` + `chunkDocId` + `buildChunkEntries` (the hook ships as a
 * standalone plugin and can't resolve the workspace, same as transcript-tokens.ts).
 * **Keep the function bodies in sync** with packages/shared/src/index.ts.
 */
export const DEFAULT_MAX_ENTRIES_PER_CHUNK = 200;

export interface ChunkSlice {
  byteStart: number;
  byteEnd: number;
  entryCount: number;
}

export function sliceIntoChunks(
  jsonl: string,
  maxEntriesPerChunk: number = DEFAULT_MAX_ENTRIES_PER_CHUNK,
): ChunkSlice[] {
  const max = Math.max(1, maxEntriesPerChunk);
  const enc = new TextEncoder();
  const lines = jsonl.split("\n");
  // Byte offset where each line begins; offsets[lines.length] = total byte length.
  const offsets = new Array<number>(lines.length + 1);
  offsets[0] = 0;
  for (let i = 0; i < lines.length; i++) {
    const newline = i < lines.length - 1 ? 1 : 0; // split() implies a \n between lines
    offsets[i + 1] = offsets[i]! + enc.encode(lines[i]).length + newline;
  }
  const slices: ChunkSlice[] = [];
  let startLine = 0;
  let entryCount = 0;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i]!.trim().length > 0) entryCount++;
    if (entryCount >= max || (i === lines.length - 1 && entryCount > 0)) {
      slices.push({ byteStart: offsets[startLine]!, byteEnd: offsets[i + 1]!, entryCount });
      startLine = i + 1;
      entryCount = 0;
    }
  }
  return slices;
}

export function chunkDocId(sessionId: string, byteStart: number): string {
  return `chunk:${sessionId}:${String(byteStart).padStart(12, "0")}`;
}

// ── Content chunks (ADR 0027) — byte-identical copy; see shared/src/index.ts. ───

export type ChunkEntryRole = "user" | "assistant" | "tool_result" | "system" | "other";

export interface ChunkEntry {
  role: ChunkEntryRole;
  timestamp?: string;
  text?: string;
  toolUses?: { name: string; id?: string }[];
  toolUseId?: string;
  isError?: boolean;
  isSidechain?: boolean;
}

/** Flatten a message/tool_result content field to text (`onlyType` filters items). */
function flattenEntryText(content: any, onlyType?: string): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  let out = "";
  for (const item of content) {
    if (onlyType && item?.type !== onlyType) continue;
    if (typeof item?.text === "string") out += item.text;
  }
  return out;
}

/** Project one parsed JSONL doc into a pruned `ChunkEntry`. */
function projectChunkEntry(doc: any): ChunkEntry {
  const type: string = typeof doc?.type === "string" ? doc.type : "other";
  const content = doc?.message?.content;
  const timestamp: string | undefined =
    typeof doc?.timestamp === "string" ? doc.timestamp : undefined;
  const sidechain = doc?.isSidechain === true;

  if (type === "assistant") {
    const toolUses: { name: string; id?: string }[] = [];
    if (Array.isArray(content)) {
      for (const item of content) {
        if (item?.type === "tool_use" && typeof item.name === "string") {
          toolUses.push(item.id ? { name: item.name, id: String(item.id) } : { name: item.name });
        }
      }
    }
    const text = flattenEntryText(content, "text");
    const entry: ChunkEntry = { role: "assistant" };
    if (timestamp) entry.timestamp = timestamp;
    if (text) entry.text = text;
    if (toolUses.length) entry.toolUses = toolUses;
    if (sidechain) entry.isSidechain = true;
    return entry;
  }

  if (type === "user") {
    const toolResult = Array.isArray(content)
      ? content.find((i: any) => i?.type === "tool_result")
      : undefined;
    if (toolResult) {
      const entry: ChunkEntry = { role: "tool_result" };
      if (timestamp) entry.timestamp = timestamp;
      const text = flattenEntryText(toolResult.content);
      if (text) entry.text = text;
      if (typeof toolResult.tool_use_id === "string") entry.toolUseId = toolResult.tool_use_id;
      if (toolResult.is_error === true) entry.isError = true;
      if (sidechain) entry.isSidechain = true;
      return entry;
    }
    const entry: ChunkEntry = { role: "user" };
    if (timestamp) entry.timestamp = timestamp;
    const text = flattenEntryText(content, "text");
    if (text) entry.text = text;
    if (sidechain) entry.isSidechain = true;
    return entry;
  }

  const entry: ChunkEntry = { role: type === "system" ? "system" : "other" };
  if (timestamp) entry.timestamp = timestamp;
  const text = flattenEntryText(content, "text");
  if (text) entry.text = text;
  if (sidechain) entry.isSidechain = true;
  return entry;
}

export function buildChunkEntries(jsonl: string): ChunkEntry[] {
  const out: ChunkEntry[] = [];
  for (const line of jsonl.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      out.push(projectChunkEntry(JSON.parse(trimmed)));
    } catch {
      out.push({ role: "other" }); // keep 1:1 with sliceIntoChunks' entry count
    }
  }
  return out;
}
