/**
 * `_design/speaker_split` — project a session into its individual turns, keyed by
 * speaker (added by migration v4, ADR 0027 follow-up).
 *
 * Maps over **full-content `chunk` docs** (`couchFullContentChunks` — chunks with an
 * `entries[]` array; byte-range-only chunks are skipped). It emits one row per turn,
 * keyed `[session_id, role, byte_start, entry_index]` so a consumer can pull just one
 * side of the conversation for a session in transcript order:
 *
 *   startkey=[id, "user"], endkey=[id, "user", {}]        → the user's turns
 *   startkey=[id, "assistant"], endkey=[id, "assistant",{}] → Claude's turns
 *   startkey=[id], endkey=[id, {}]                         → all turns, grouped by role
 *
 * The `_count` reduce with `group_level=2` gives per-role turn counts.
 *
 * The value carries the parsed turn (role, timestamp, text, tool info) so the view
 * serves reads directly. That duplicates content into the index (on top of the chunk
 * + S3 copies) — acceptable at Tier-1/2 volumes; a leaner variant could emit only
 * `[byte_start, entry_index]` pointers and read text from the chunk. See ADR 0027.
 */
import type { DesignDoc } from "./designs";

const BY_ROLE_MAP = `function (doc) {
  if (doc.type !== "chunk" || !doc.entries) return;
  for (var i = 0; i < doc.entries.length; i++) {
    var e = doc.entries[i];
    if (!e || !e.role) continue;
    emit([doc.session_id, e.role, doc.byte_start, i], {
      role: e.role,
      timestamp: e.timestamp || "",
      text: e.text || "",
      toolUses: e.toolUses || null,
      toolUseId: e.toolUseId || null,
      isError: e.isError || false
    });
  }
}`;

export const SPEAKER_SPLIT_DESIGN: DesignDoc = {
  _id: "_design/speaker_split",
  language: "javascript",
  views: {
    by_role: { map: BY_ROLE_MAP, reduce: "_count" },
  },
};
