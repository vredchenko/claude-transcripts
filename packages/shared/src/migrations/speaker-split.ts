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
 * A second view, `by_role_time` (migration v5), re-keys the same turns as
 * `[role, timestamp, session_id, byte_start, entry_index]` for **cross-session**
 * reading — every turn of one speaker across all sessions, in time order:
 *
 *   startkey=["user"],      endkey=["user", {}]       → all my turns, everywhere
 *   startkey=["assistant"], endkey=["assistant", {}]  → all Claude's turns, everywhere
 *
 * (optionally bounded by a from/to timestamp, e.g. `startkey=["user", from]`). Its
 * value carries `sessionId` + `cwd` so cross-session turns keep their project
 * context — the corpus for "what do I repeatedly say / what does Claude repeatedly
 * say" pattern analysis.
 *
 * The values carry the parsed turn (role, timestamp, text, tool info) so the views
 * serve reads directly. That duplicates content into the index (on top of the chunk
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

const BY_ROLE_TIME_MAP = `function (doc) {
  if (doc.type !== "chunk" || !doc.entries) return;
  for (var i = 0; i < doc.entries.length; i++) {
    var e = doc.entries[i];
    if (!e || !e.role) continue;
    emit([e.role, e.timestamp || "", doc.session_id, doc.byte_start, i], {
      sessionId: doc.session_id,
      cwd: doc.cwd || "",
      role: e.role,
      timestamp: e.timestamp || "",
      text: e.text || ""
    });
  }
}`;

export const SPEAKER_SPLIT_DESIGN: DesignDoc = {
  _id: "_design/speaker_split",
  language: "javascript",
  views: {
    by_role: { map: BY_ROLE_MAP, reduce: "_count" },
    by_role_time: { map: BY_ROLE_TIME_MAP, reduce: "_count" },
  },
};
