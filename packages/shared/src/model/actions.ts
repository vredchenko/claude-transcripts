import type { ActionDef, HookActionBinding } from "./types";

/**
 * The catalogue of event-handling actions, defined independently of any hook.
 * Hooks bind to actions many-to-many (BINDINGS). `implemented` flags real ones.
 */
export const ACTIONS: ActionDef[] = [
  {
    key: "write-event-marker",
    summary: "Append a light append-only event marker doc",
    implemented: false,
  },
  {
    key: "update-counts",
    summary: "Bump per-session counters (events/prompts/errors/tools)",
    implemented: false,
  },
  {
    key: "flush-transcript-chunk",
    summary: "Tail the transcript → append chunk docs",
    implemented: false,
  },
  { key: "write-summary", summary: "Write summary:<id> at session end", implemented: false },
  {
    key: "upload-blobs",
    summary: "Upload summary.json + transcript.jsonl to S3",
    implemented: false,
  },
  {
    key: "seed-session-start",
    summary: "Reset counters + seed the chunk offset at start",
    implemented: false,
  },
  { key: "enrich-metadata", summary: "Post additional session metadata", implemented: false },
  {
    key: "extract-feature",
    summary: "Map-reduce feature extraction (urls/repos/PRs/…)",
    implemented: false,
  },
  { key: "detect-memory-write", summary: "Flag Edit/Write to memory paths", implemented: false },
  { key: "app-log", summary: "Emit an operational log record (app-logs DB)", implemented: false },
  {
    key: "index-for-search",
    summary: "Push derived content to the search backend",
    implemented: false,
  },
  {
    key: "reconcile-session",
    summary: "Finalize a stale running session from chunks/S3",
    implemented: false,
  },
];

/** Seed mapping (the dispatch REGISTRY). Generalises to a configurable table. */
export const BINDINGS: HookActionBinding[] = [
  { event: "SessionStart", actions: ["seed-session-start", "write-event-marker"] },
  {
    event: "UserPromptSubmit",
    actions: ["write-event-marker", "update-counts", "flush-transcript-chunk"],
  },
  {
    event: "PostToolUse",
    actions: ["write-event-marker", "update-counts", "flush-transcript-chunk"],
  },
  {
    event: "PostToolUseFailure",
    actions: ["write-event-marker", "update-counts", "flush-transcript-chunk"],
  },
  { event: "Stop", actions: ["write-event-marker", "flush-transcript-chunk"] },
  { event: "SubagentStart", actions: ["write-event-marker", "update-counts"] },
  { event: "SubagentStop", actions: ["write-event-marker", "update-counts"] },
  // Abnormal-termination / context-management awareness — marker docs so the corpus
  // can explain why a session's shape looks unusual (relates to the reconcile path).
  { event: "StopFailure", actions: ["write-event-marker", "update-counts"] },
  { event: "PreCompact", actions: ["write-event-marker"] },
  { event: "PostCompact", actions: ["write-event-marker"] },
  { event: "SessionEnd", actions: ["flush-transcript-chunk", "write-summary", "upload-blobs"] },
];
