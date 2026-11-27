# @claude-transcripts/shared

What every other package imports: the app blueprint, the migrations, the CouchDB
document schemas, and the cross-cutting types and helpers. Pure TypeScript with one
dependency (zod), so the Bun server and the React client both use it.

| Path (`src/`) | Holds |
|---------------|-------|
| `blueprint/` | The central description of the system: services and ports, stores, hook events, actions and bindings, routes, env schema, the CLI spec (`cli.ts`), the recall policy. Built once from `config/` and the environment (`buildAppBlueprint`) and projected into the manifest at `/`, the Compose files, the k8s base, the plugin's `hooks.json` and the CLI reference. Extend it; don't re-derive its facts elsewhere. |
| `migrations/` | The self-built CouchDB migrations: the registry, the runner, and the design documents (views) they install ([ADR 0021](../../docs/design/decisions/0021-self-built-couchdb-migrations.md)). |
| `docs/` | The CouchDB document schemas (zod), exported as `@claude-transcripts/shared/docs`. Defined once here, validated at the webapi on write; the CLI's document types derive from them. |
| `claude-code-spec.ts` | Claude Code's hook surface as data, and the drift check against our catalogue. |
| `highlight.ts` | The search-highlight marks and their readers. The webapi writes the marks and the webui reads them, so the delimiters live in one place. |
| `session-export.ts` | A session as Markdown or printable HTML. |
| `version.ts` | The lockstep app version, read from `package.json`. |
| `index.ts` | Cross-cutting types (`TokenUsage`, `SessionStatus`, `SessionSummary`, ...) and `sumTranscriptTokens`. |

`sumTranscriptTokens(jsonl)` sums token usage from a transcript, deduplicating by
`message.id` and keeping the largest usage block per id, so streamed duplicates aren't
counted twice. The webapi and the hook import the same copy; there is no second one to
keep in step. The webui and CLI take their wire types from the generated clients.

How the pieces fit together: [docs/design/architecture.md](../../docs/design/architecture.md).
