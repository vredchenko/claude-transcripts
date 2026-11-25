# The web UI

A browser app for reading your history, served by the instance at `/app`:
`http://127.0.0.1:7650/app/` on a default install. It is optional. Everything it shows
is also reachable from [the terminal](terminal.md) and [the API](api.md).

It has one theme, dark. To open it from another device, or to install it as an app on
a desktop or a phone, see [HTTPS and installing the web UI](../operate/https.md).

## Sessions

The start page lists every recorded session, in one of two views chosen in the URL
(`/?view=calendar&month=2026-03`):

- **List** (default): grouped by day, newest first, loading more as you scroll. Each
  row shows start time, project with its host and full working directory, runtime with
  an active/idle bar, model, top tools, tokens, status with when it applies (the end
  time of an ended session, the last write of a live or abandoned one), and the short
  session id with a copy button and a `⋯` menu of links to the session's raw data.
  Columns are not sortable.
- **Calendar**: one month as 24-hour lanes per day, bars placed by clock time and
  coloured per project, opacity showing the active share. Each lane is shaded by
  that day's daylight (night, civil twilight, day), worked out for
  [`userSettings.location`](../start/configuration.md#settings) or, if that's unset,
  for your browser's time zone's reference city.

Filters (project directory, model, host, recording source, a date range) live in the
URL and show as removable chips, so a filtered view can be bookmarked or shared.

Status reads **live** (running, a pulsing dot), **abandoned** (the session stopped
without ending cleanly, a hollow ring) or **ended** (a square). Provenance chips read
**live** (recorded by the hook as it happened) or **backfilled** (adopted later by
[`backfill`](../operate/tools.md)). Active time is runtime minus gaps longer than
`system.sessions.idleThresholdMs`; it shows `—` where it couldn't be derived.

## One session

Opening a session shows its metadata (start, total runtime, active and idle time, end
or last-write time, model, host, recording source, end reason, counts, transcript
size), working directory, token usage, tool calls, and the transcript.

The identity bar links the session's raw data: the API's JSON, its events and (once
ended) its summary document, both in Fauxton and through the read-only CouchDB proxy,
and its transcript file through the S3 proxy.

**Export** saves the whole session as Markdown, or opens the print dialog on a
print-ready copy of it (and so "Save as PDF"), with or without tool calls and their
results.

### Reading the transcript

A **Both / User / Claude** toggle picks the speaker. User or Claude shows one side of
the conversation (empty if the instance records without
[`features.couchFullContentChunks`](../start/configuration.md#settings)). Both shows
the full transcript in one of two readers:

- **Timeline** (default): dialogue turns only, labelled User / Claude with times, tools
  called and a subagent chip. Runs of tool calls, results, attachments and system lines
  fold into one line (`› 12 lines · Read ×3, Bash`) that opens in place.
  `<system-reminder>` blocks are hidden from turn text.
- **Raw**: every stored entry on one line, expanding to its text or JSON.

Entries load in blocks of `userSettings.transcriptPageSize` as you scroll and in the
background while the tab is visible. After `userSettings.transcriptAutoLoadMax`
entries a button offers to load the rest. Arriving from a search result opens the
transcript at the matching entry with the search terms highlighted.

A running session can be read while it runs: its transcript is recorded in pieces as
the session goes, not only at the end.

## The omnibox

The box in the header takes several kinds of input, and **Enter** acts on whichever
it recognises. **Shift+Enter** always runs a full-text [search](search.md), and
**Ctrl/Cmd+K** focuses the box from anywhere.

| Type | Enter does |
|------|------------|
| free text | search, and open the results page |
| `project:` `host:` `model:` `source:` followed by a value | filter the session list by that field |
| `today`, `yesterday`, `this week`, `last week`, `this month`, `last month`, or a day such as `aug 19` | filter the session list to that date range |
| a session id | open that session |
| `>` and a command: `open fauxton`, `open meilisearch`, `open garage`, `open fossil` | open that backing service's admin page |

Its dropdown previews search hits, recent searches and saved filters, and shows a hint
when search is off.

## Menus

- **Services**: one section per backing store (CouchDB, Garage, Meilisearch, Fossil)
  with its admin pages and the databases, buckets, indexes and repositories it holds.
  Each CouchDB database lists its views; each Fossil repository links its check-in
  timeline. Where those admin pages live is set by
  [`servicesMenu`](../start/configuration.md#settings).
- **Dev**: the API reference, the OpenAPI spec, the app blueprint, these docs and the
  CLI download.
- **About**: the running version and the project links.
- **Settings**: a placeholder for now.
