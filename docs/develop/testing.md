# Testing

| Layer | Run with | Needs |
|-------|----------|-------|
| Unit | `bun test` | nothing |
| End to end | `bun run test:e2e` | the stack and a webapi running |
| Browser (webui) | `bun run test:browser` (first `bun run test:browser:install`) | nothing; `/api` is answered from a synthetic corpus |
| API contract | `bun run check:contract` | `origin/main` fetched (`CONTRACT_BASE=<ref>` compares against another ref) |
| Smoke test | `claude-transcripts doctor` | a running instance |

## What earns a unit test

A test has to catch a regression that nothing else would: not typecheck, not the
`gen:all` diff CI runs on committed generated files, not the contract check, not another
test. Good reasons: logic that is easy to get subtly wrong (offsets, token sums,
migration up/down, comparison direction), a bug that actually shipped (name the issue
or commit in the test), or two sources of truth that must stay equal. Bad reasons:
restating a constant or a lookup table, exact copy of help text or log lines, library
behaviour, a call that merely doesn't throw, or another literal down a branch already
covered. If a test keeps changing whenever the wording does, it is pinning the wrong
thing.

## End to end

`tests/e2e/` fakes Claude Code sessions ([scenarios](../../tests/e2e/README.md)): it
synthesises the hook event stream and a transcript, drives them through the real write
path, then asserts through the webapi (sessions list, detail, transcript, the
`/api/couch` and `/api/s3` proxies) on counts, token usage, tool usage, status and
transcript round-trip. It skips itself when the stack is down and deletes the sessions
it creates (`CT_KEEP_FIXTURES=1` keeps them).

`doctor` is the single-session version for a live instance: it writes one synthetic
session, checks the rollups and search, and deletes it (`--keep` to inspect).

Not covered yet: resumed sessions and `backfill` parity.

## Browser

Playwright over Chromium and Firefox at two widths. Besides rendering checks it audits
layout geometry (content escaping its container, pages scrolling sideways). Set
`E2E_BASE_URL` to run it against a real instance. `bun run test:browser:capture` saves
screenshots and a report under `tests/browser/.captures/`.

## Contract

`openapi.json` is committed. `check:contract` diffs the working tree's spec against the
one at `origin/main` and fails on changes that would break a client generated from the older spec.
Adding response fields or relaxing request rules passes. A deliberate break passes when
a commit declares it (`type!:` or a `BREAKING CHANGE:` footer)
([ADR 0019](../design/decisions/0019-openapi-source-of-truth-generated-clients.md#amendment-the-spec-is-committed-and-compatibility-is-checked)).
