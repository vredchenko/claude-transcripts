import type { CliSpec } from "./types";

/**
 * Structured CLI spec — the single description of the CLI's commands + args. The
 * CLI renders its help from this (model facet), and it can drive arg parsing,
 * docs, and shell completions later.
 */
export const CLI_SPEC: CliSpec = {
  commands: [
    {
      name: "sessions",
      summary: "List / inspect sessions (via the webapi)",
      args: [
        { name: "id", description: "session id — show detail/transcript (omit to list)" },
        { name: "--limit", description: "rows to list / transcript entries to preview" },
        { name: "--webapi", description: "webapi base URL (default: $CT_WEBAPI_URL)" },
      ],
    },
    {
      name: "search",
      summary: "Search the corpus",
      args: [{ name: "query", required: true, description: "search text" }],
    },
    {
      name: "setup",
      summary: "Install/register the hook + generate runtime config",
      args: [
        { name: "--check", description: "verify an existing install (read-only)" },
        { name: "--no-hook", description: "config + provision stores only (no registration)" },
        { name: "--project", description: "per-repo registration (placeholder — not built)" },
      ],
    },
    {
      name: "export",
      summary: "Export session data to a portable bundle",
      args: [{ name: "path", required: true, description: "destination path" }],
    },
    {
      name: "import",
      summary: "Import session data from a portable bundle",
      args: [{ name: "path", required: true, description: "bundle path" }],
    },
    {
      name: "backfill",
      summary: "Adopt on-disk ~/.claude transcripts as first-class history",
      args: [
        { name: "--dir", description: "transcripts dir (default ~/.claude/projects)" },
        { name: "--host", description: "hostname to attribute (default: this host)" },
        { name: "--actor", description: "actor to attribute the history to" },
        { name: "--chunk-size", description: "entries per chunk doc (default 200)" },
        { name: "--webapi", description: "webapi base URL (default: $CT_WEBAPI_URL)" },
        { name: "--dry-run", description: "preview without writing" },
      ],
    },
    {
      name: "migrate",
      summary: "Run CouchDB migrations",
      args: [{ name: "direction", description: "up | down | status" }],
    },
    {
      name: "doctor",
      summary: "Smoke-test the write/read path end-to-end",
      args: [{ name: "--webapi", description: "webapi base URL (default: $CT_WEBAPI_URL)" }],
    },
  ],
};
