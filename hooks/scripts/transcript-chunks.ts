/**
 * Transcript chunking — a BYTE-IDENTICAL copy of `@claude-transcripts/shared`'s
 * `sliceIntoChunks` + `chunkDocId` (the hook ships as a standalone plugin and can't
 * resolve the workspace, same as transcript-tokens.ts). **Keep the function bodies
 * in sync** with packages/shared/src/index.ts.
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
    offsets[i + 1] = offsets[i] + enc.encode(lines[i]).length + newline;
  }
  const slices: ChunkSlice[] = [];
  let startLine = 0;
  let entryCount = 0;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trim().length > 0) entryCount++;
    if (entryCount >= max || (i === lines.length - 1 && entryCount > 0)) {
      slices.push({ byteStart: offsets[startLine], byteEnd: offsets[i + 1], entryCount });
      startLine = i + 1;
      entryCount = 0;
    }
  }
  return slices;
}

export function chunkDocId(sessionId: string, byteStart: number): string {
  return `chunk:${sessionId}:${String(byteStart).padStart(12, "0")}`;
}
