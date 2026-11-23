# Search

Full-text search over every recorded session, from [the web UI](web-ui.md),
[the terminal](terminal.md) or [the API](api.md). It is one search behind all three, so
the same query returns the same thing everywhere.

## Two kinds of result

A query comes back as two lists, because they answer different questions:

- **Sessions** whose *metadata* matched: project directory, model, host, end reason,
  tool names. Each says which field matched. `Bash` finds sessions here.
- **Turns**: places in a conversation where the words were actually said, by you, by
  Claude or in a tool result, each with a snippet around the match. `flaky test` finds
  turns.

Other transcript lines (attachments, system entries) are not indexed.

## Where to search

**Web UI.** Type in the omnibox and press Enter, or Shift+Enter to search whatever you
typed. The results page is paged and can be narrowed by project, model, host and
provenance; all of that state is in the URL. Opening a turn hit lands on the matching
entry in the transcript with the terms highlighted.

**Terminal.**

```bash
claude-transcripts search "retry policy"
claude-transcripts search retry policy                  # bare words are joined
claude-transcripts search deploy --cwd ~/proj --limit 5
claude-transcripts search deploy --json                 # the API response, for scripts
```

**API.** `GET /api/search?q=…` with the same filters (`cwd`, `model`, `hostname`,
`source`, plus `limit` and `offset`).

## Filters

Filters are exact matches. `cwd` narrows both lists to one project directory. `model`,
`hostname` and `source` narrow the session list only: turns carry their project and
nothing else.

## How fresh it is

A session becomes searchable as it is recorded: new writes reach the index within
about 20 seconds (`system.search.flushIntervalMs`), so a session still running can be
searched.

## When search is off or missing something

Search is an optional part, provided by Meilisearch
([`features.meilisearch`](../start/configuration.md#settings), on by default). Without
it nothing else changes: the web UI shows a hint in the omnibox, the API answers
`enabled: false`, and the CLI says how to turn it on and exits non-zero so a script
doesn't mistake that for "nothing matched". Conversation text is searchable only while
`features.couchFullContentChunks` is on, which is also the default.

The index is derived from the stored sessions, so it can always be rebuilt:

```bash
claude-transcripts reindex
```

Run it when results look incomplete: for history recorded before search was enabled,
after renaming an index, after deleting sessions, or after an outage of the search
service. Search keeps answering from the old index while the new one is built.
