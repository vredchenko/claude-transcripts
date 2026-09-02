import type { CliArgDef, CliSpec } from "./types";

/**
 * Structured CLI spec — the single description of the CLI's commands + args. Four
 * consumers project from it, so an edit here moves all of them together:
 *
 *   - the Ink help screen (packages/cli/src/app.tsx);
 *   - argument validation before dispatch (`validateCliArgs`, cli.tsx);
 *   - the generated command reference (`toCliDocs` → scripts/gen-cli-docs.ts);
 *   - shell completions (not built yet — the spec already carries `choices` for it).
 *
 * `choices` / `default` / `type` are for help + validation; the runners still apply
 * defaults themselves, so a value here must match what the runner does.
 */

const WEBAPI: CliArgDef = {
  name: "--webapi",
  type: "string",
  description: "webapi base URL (default: $CT_WEBAPI_URL)",
};

/** Machine-readable output — what a script, or a Claude Code skill, consumes. */
const JSON_OUT: CliArgDef = {
  name: "--json",
  description: "print the webapi response as JSON instead of a table",
};

export const CLI_SPEC: CliSpec = {
  groups: [
    { key: "lifecycle", title: "Lifecycle" },
    { key: "daily", title: "Daily use" },
    { key: "portability", title: "Portability" },
    { key: "admin", title: "Admin" },
  ],
  globalArgs: [
    WEBAPI,
    { name: "--help", description: "show help for a command (alias: -h)" },
    { name: "--version", description: "print the CLI version (alias: -V)" },
  ],
  commands: [
    // ── Lifecycle ──────────────────────────────────────────────────────────────
    {
      name: "install",
      group: "lifecycle",
      summary: "Set up everything: stores, app, and the Claude Code hook",
      args: [
        {
          name: "--port-base",
          type: "number",
          default: 7650,
          description: "first port of the block",
        },
        { name: "--meili-key", description: "generate a Meilisearch master key" },
        { name: "--no-hook", description: "skip Claude Code registration" },
        { name: "--no-statusline", description: "register the hook but not the statusline" },
        { name: "--no-app", description: "skip the app container (run the webapi yourself)" },
        { name: "--no-prune", description: "keep superseded app images" },
        { name: "--skip-preflight", description: "continue past failed preflight checks" },
        { name: "--yes", description: "no prompts; take documented defaults" },
      ],
      examples: ["install", "install --port-base 7700 --no-hook"],
    },
    {
      name: "uninstall",
      group: "lifecycle",
      summary: "Remove the instance (history is kept unless --purge)",
      args: [
        { name: "--purge", description: "also delete recorded history (destructive)" },
        { name: "--yes", description: "skip the confirmation prompt" },
      ],
      examples: ["uninstall", "uninstall --purge --yes"],
    },
    {
      name: "setup",
      group: "lifecycle",
      summary: "Install/register the hook + generate runtime config",
      args: [
        { name: "--check", description: "verify an existing install (read-only)" },
        { name: "--no-hook", description: "config + provision stores only (no registration)" },
        { name: "--project", description: "per-repo registration (placeholder — not built)" },
      ],
      examples: ["setup --check"],
    },
    {
      name: "provision",
      group: "lifecycle",
      summary: "Create the CouchDB databases and the Garage bucket + key",
      examples: ["provision"],
    },
    {
      name: "stack",
      group: "lifecycle",
      summary: "Control the container stack",
      args: [
        {
          name: "action",
          choices: ["up", "down", "restart", "logs", "ps"],
          default: "ps",
          description: "`logs` takes service names after it",
        },
        { name: "--app", description: "include the app container" },
        { name: "--volumes", description: "with `down`: delete the data volumes too" },
      ],
      examples: ["stack up --app", "stack logs couchdb", "stack down --volumes"],
    },

    // ── Daily use ──────────────────────────────────────────────────────────────
    {
      name: "sessions",
      group: "daily",
      summary: "List / inspect sessions (via the webapi)",
      args: [
        { name: "id", description: "session id — show detail/transcript (omit to list)" },
        {
          name: "--limit",
          type: "number",
          description: "rows to list (default 50) / transcript entries to preview (default 30)",
        },
        JSON_OUT,
      ],
      examples: ["sessions", "sessions --limit 10", "sessions 3f9a2c1e --limit 80 --json"],
    },
    {
      name: "search",
      group: "daily",
      summary: "Search the corpus",
      args: [
        { name: "query", required: true, description: "search text" },
        {
          name: "--limit",
          type: "number",
          description: "results per section (default: the webapi's)",
        },
        { name: "--offset", type: "number", description: "skip this many results (paging)" },
        { name: "--cwd", type: "string", description: "only this project directory" },
        { name: "--model", type: "string", description: "only this model" },
        { name: "--hostname", type: "string", description: "only this host" },
        {
          name: "--source",
          type: "string",
          description: "only this provenance (live | backfill | …)",
        },
        JSON_OUT,
      ],
      examples: ['search "retry policy"', "search deploy --cwd ~/proj --limit 5 --json"],
    },
    {
      name: "turns",
      group: "daily",
      summary: "Speaker-split turns: one session, or one speaker across all sessions",
      args: [
        { name: "session", description: "session id — that session's turns (omit: all sessions)" },
        {
          name: "--role",
          type: "string",
          choices: ["user", "assistant", "tool_result", "system", "other"],
          description: "only this speaker",
        },
        {
          name: "--from",
          type: "string",
          description: "all sessions: only turns at/after this ISO instant",
        },
        {
          name: "--to",
          type: "string",
          description: "all sessions: only turns at/before this ISO instant",
        },
        { name: "--limit", type: "number", default: 50, description: "turns to show" },
        { name: "--skip", type: "number", description: "skip this many (paging)" },
        JSON_OUT,
      ],
      examples: [
        "turns --role user --limit 200",
        "turns --role user --from 2026-08-01 --json",
        "turns 3f9a2c1e --role assistant",
      ],
    },
    {
      name: "backfill",
      group: "daily",
      summary: "Adopt on-disk ~/.claude transcripts as first-class history",
      args: [
        {
          name: "--dir",
          type: "string",
          description: "transcripts dir (default ~/.claude/projects)",
        },
        {
          name: "--host",
          type: "string",
          description: "hostname to attribute (default: this host)",
        },
        { name: "--actor", type: "string", description: "actor to attribute the history to" },
        {
          name: "--chunk-size",
          type: "number",
          default: 200,
          description: "entries per chunk doc",
        },
        { name: "--no-content", description: "byte-range chunks only (no turn content)" },
        {
          name: "--force",
          description: "re-process adopted sessions (deletes their derived docs, then rebuilds)",
        },
        {
          name: "--replace-live",
          description: "with --force: also replace live-recorded sessions (loses hook provenance)",
        },
        {
          name: "--repair",
          description: "add missing chunk docs to adopted sessions; leaves summary + events alone",
        },
        {
          name: "--session",
          type: "string",
          description: "with --force: re-process only this session",
        },
        { name: "--dry-run", description: "preview without writing" },
      ],
      examples: ["backfill --dry-run", "backfill", "backfill --force --session 3f9a2c1e"],
    },

    // ── Portability ────────────────────────────────────────────────────────────
    {
      name: "export",
      group: "portability",
      summary: "Export session data to a portable bundle",
      args: [
        { name: "dir", required: true, description: "destination directory" },
        { name: "--since", type: "string", description: "only docs at/after this ISO timestamp" },
        { name: "--session", type: "string", description: "only this session id" },
        { name: "--no-blobs", description: "skip S3 transcripts (~1/10th the size)" },
      ],
      examples: ["export ./bundle", "export ./bundle --since 2026-01-01 --no-blobs"],
    },
    {
      name: "import",
      group: "portability",
      summary: "Restore session data from a portable bundle",
      args: [
        { name: "dir", required: true, description: "bundle directory" },
        { name: "--dry-run", description: "verify the bundle without writing" },
        { name: "--no-blobs", description: "skip transcripts; restore docs only" },
      ],
      examples: ["import ./bundle --dry-run", "import ./bundle"],
    },

    // ── Admin ──────────────────────────────────────────────────────────────────
    {
      name: "migrate",
      group: "admin",
      summary: "Run CouchDB migrations",
      args: [
        {
          name: "direction",
          choices: ["up", "down", "status"],
          default: "status",
          description: "apply, roll back, or report",
        },
        { name: "--to", type: "number", description: "with `up`: stop at this schema version" },
        {
          name: "--steps",
          type: "number",
          default: 1,
          description: "with `down`: how many to undo",
        },
        { name: "--dry-run", description: "report what would run without writing" },
      ],
      examples: ["migrate status", "migrate up --dry-run", "migrate down --steps 2"],
    },
    {
      name: "reindex",
      group: "admin",
      summary: "Rebuild the search indexes from CouchDB",
      examples: ["reindex"],
    },
    {
      name: "doctor",
      group: "admin",
      summary: "Smoke-test the write/read/search path end-to-end",
      args: [{ name: "--keep", description: "leave the synthetic session behind for inspection" }],
      examples: ["doctor", "doctor --keep"],
    },
    {
      name: "hook",
      group: "admin",
      summary: "The Claude Code hook, and its registration",
      args: [
        {
          name: "action",
          choices: ["run", "install", "uninstall", "status"],
          default: "status",
          description: "`run` reads one event payload from stdin (Claude Code calls this)",
        },
        { name: "--dry-run", description: "with `install`: show the change without writing" },
      ],
      examples: ["hook status", "hook install --dry-run"],
    },
    {
      name: "statusline",
      group: "admin",
      summary: "The Claude Code statusline indicator (recording / off), and its registration",
      args: [
        {
          name: "action",
          choices: ["render", "install", "uninstall", "status"],
          default: "status",
          description:
            "`render` reads Claude Code's statusline JSON from stdin and prints one line (no network)",
        },
        { name: "--dry-run", description: "with `install`: show the change without writing" },
      ],
      examples: ["statusline install", "statusline status"],
    },
  ],
};
