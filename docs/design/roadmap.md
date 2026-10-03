# Roadmap

What is not built yet, by tier ([architecture.md](architecture.md#tiers)). Issue numbers
in parentheses are the original tracking issues. Shipped work is recorded in
[`CHANGELOG.md`](../../CHANGELOG.md).

## Tier 1: known gaps

Tier 1 (capture, browse, search, export/import, one-command install) is built. Open:

- **`reconcile`** — write the missing summary for a session that never fired
  `SessionEnd`, from its chunks or S3 transcript (#4). Until then such sessions stay
  `incomplete`.
- **Restoring a bundle across a document-reshaping migration.** Import refuses that
  case today (`transformsDocs`); the fix is a scoped replay of the migration over the
  restored ids, worth building once such a migration exists
  ([bundles.md](bundles.md#importing-an-older-bundle)).
- **Two spellings of an absent transcript field.** `chunks/entries_by_session` emits
  `toolUses: null`, the S3 path omits the field, so consumers handle both. Converging
  them needs a view migration.
- **Subagent sub-transcripts** are not captured by `backfill` (#6).
- **`upgrade` command** — upgrading is a manual binary swap
  ([installation.md](../start/installation.md#upgrading)).
- **Claude Code compatibility generator** — still a placeholder
  ([compatibility.md](../start/compatibility.md)).
- **Application logging** into its own database — designed, not built
  ([app-logging.md](../operate/app-logging.md)).
- **Secrets masking** (`features.secretsMasking`) — a flag with no implementation (#11).
  It becomes a prerequisite for recall scopes wider than `project`, and for sharing
  bundles.

## Tier 2: make history useful

**Recall and search** (#9, #10)
- Recall skills and the session-start primer are built ([plugin.md](plugin.md)).
  Open: an optional MCP server, typeahead ranking, and a vector index for semantic
  retrieval behind `/api/search` ([database-choice.md](database-choice.md)).
- A webui view over `/api/turns` (one speaker across all sessions). The API exists.
- Cross-project pattern analysis over `speaker_split/by_role_time`: what the user keeps
  asking for (candidates for `CLAUDE.md`), what Claude keeps saying.

**Richer capture**
- **Session metadata** (#3). The `SessionStart` payload carries only `session_id`,
  `transcript_path`, `cwd`, `source` and `model`. CLI version and git branch are in the
  transcript entries; the OS user, loaded instruction files, MCP servers, plugins and
  settings would need a host-side collector posting to a metadata endpoint. Even then,
  the assembled system prompt is exposed nowhere.
- **Attribution across machines and users** (#7): a machine fingerprint and the Claude
  account on every session.
- **More hook events** (#5): `PreToolUse` for tool durations, `InstructionsLoaded`
  (which `CLAUDE.md` files loaded), `Notification`, permission events. Each is an
  action plus a binding ([actions.md](../reference/actions.md)).
- **Memory-save detection** — no hook exists for it; detect `Edit`/`Write` to memory
  paths, `CLAUDE.md` and `AGENTS.md` in `PostToolUse`.
- **Code changes as data** — per-session changed paths, diffs and commits, rather than
  only the tool calls in the transcript.
- **File history.** Claude Code keeps pre-edit snapshots under
  `~/.claude/file-history/<session-id>/`; the transcript holds only pointers to them,
  so that content dies with the machine. Much file mutation happens through `Bash`
  (`sed -i`, generators, `git checkout`), leaving no content in the transcript at all.
  Capturing the directory would close that gap. It includes gitignored files such as
  `.env`, so it must be opt-in and masked.
- **API traffic.** System prompt, tool schemas and raw request/response bodies are not
  in transcripts. An opt-in local proxy (`HTTPS_PROXY` + `NODE_EXTRA_CA_CERTS`) could
  capture them; strictly opt-in and masked.
- **Effective prompt provenance** — which instructions (system prompt, `CLAUDE.md`
  layers, memory) applied to each message.

**Webui** (#8)
- Virtualised lists, configurable columns, server-side sorting, keyboard navigation, a
  visual design pass.

**Analytics** — dashboards and reports over the corpus. Heavy aggregation is CouchDB's
weak point and may need an added analytical store.

## Tier 3: multiplayer and public release

- CouchDB replication between instances, and auth (#15).
- CI that diffs the wired hook events against Claude Code's published list (#13).
- A scheduled-task runner for stats, summaries and anomaly detection over the webapi.
- Session export to Markdown, PDF or JSON.
- Extension points (action plugins, webapi extension routes).
