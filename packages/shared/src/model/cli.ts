import type { CliSpec } from "./types";

/**
 * Structured CLI spec — the single description of the CLI's commands + args. The
 * CLI renders its help from this (model facet), and it can drive arg parsing,
 * docs, and shell completions later.
 */
export const CLI_SPEC: CliSpec = {
  commands: [
    {
      name: "install",
      summary: "Set up everything: stores, app, and the Claude Code hook",
      args: [
        { name: "--port-base", description: "first port of the block (default 7650)" },
        { name: "--meili-key", description: "generate a Meilisearch master key" },
        { name: "--no-hook", description: "skip Claude Code registration" },
        { name: "--no-app", description: "skip the app container (run the webapi yourself)" },
        { name: "--yes", description: "no prompts; take documented defaults" },
      ],
    },
    {
      name: "uninstall",
      summary: "Remove the instance (history is kept unless --purge)",
      args: [
        { name: "--purge", description: "also delete recorded history (destructive)" },
        { name: "--yes", description: "skip the confirmation prompt" },
      ],
    },
    {
      name: "stack",
      summary: "Control the container stack",
      args: [
        { name: "action", description: "up | down | restart | logs | ps" },
        { name: "--app", description: "include the app container" },
        { name: "--volumes", description: "with `down`: delete the data volumes too" },
      ],
    },
    {
      name: "provision",
      summary: "Create the CouchDB databases and the Garage bucket + key",
    },
    {
      name: "hook",
      summary: "The Claude Code hook, and its registration",
      args: [{ name: "action", description: "run | install | uninstall | status" }],
    },
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
      args: [
        { name: "query", required: true, description: "search text" },
        { name: "--limit", description: "results per section (default: the webapi's)" },
        { name: "--offset", description: "skip this many results (paging)" },
        { name: "--cwd", description: "only this project directory" },
        { name: "--model", description: "only this model" },
        { name: "--hostname", description: "only this host" },
        { name: "--source", description: "only this provenance (live | backfill | ...)" },
        { name: "--webapi", description: "webapi base URL (default: $CT_WEBAPI_URL)" },
      ],
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
      args: [
        { name: "dir", required: true, description: "destination directory" },
        { name: "--since", description: "only docs at/after this ISO timestamp" },
        { name: "--session", description: "only this session id" },
        { name: "--no-blobs", description: "skip S3 transcripts (~1/10th the size)" },
        { name: "--webapi", description: "webapi base URL (default: $CT_WEBAPI_URL)" },
      ],
    },
    {
      name: "import",
      summary: "Restore session data from a portable bundle",
      args: [
        { name: "dir", required: true, description: "bundle directory" },
        { name: "--dry-run", description: "verify the bundle without writing" },
        { name: "--no-blobs", description: "skip transcripts; restore docs only" },
        { name: "--webapi", description: "webapi base URL (default: $CT_WEBAPI_URL)" },
      ],
    },
    {
      name: "backfill",
      summary: "Adopt on-disk ~/.claude transcripts as first-class history",
      args: [
        { name: "--dir", description: "transcripts dir (default ~/.claude/projects)" },
        { name: "--host", description: "hostname to attribute (default: this host)" },
        { name: "--actor", description: "actor to attribute the history to" },
        { name: "--chunk-size", description: "entries per chunk doc (default 200)" },
        { name: "--no-content", description: "byte-range chunks only (no turn content)" },
        { name: "--force", description: "re-process sessions already adopted" },
        { name: "--session", description: "with --force: re-process only this session" },
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
      name: "reindex",
      summary: "Rebuild the search indexes from CouchDB",
      args: [{ name: "--webapi", description: "webapi base URL (default: $CT_WEBAPI_URL)" }],
    },
    {
      name: "doctor",
      summary: "Smoke-test the write/read/search path end-to-end",
      args: [
        { name: "--keep", description: "leave the synthetic session behind for inspection" },
        { name: "--webapi", description: "webapi base URL (default: $CT_WEBAPI_URL)" },
      ],
    },
  ],
};
