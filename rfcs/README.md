# RFCs: proposals and working notes

Ideas that are still being argued about: design proposals, evaluations and dated working
notes. They live with the code, so they're versioned, reviewed through pull requests, and
kept in step across every remote. **They are not documentation.**

`docs/` is the public, published documentation: the docs site on GitHub Pages and `/docs`
in the app. Anything in `docs/` reads as how the project *is*. This folder is how it
*might be*: `scripts/build-docs.ts` never renders it, and nothing in `docs/` should link
here.

## Writing one

- **File name:** `YYYY-MM-DD-short-slug.md`, dated when it was written. Dates don't collide
  across parallel pull requests the way sequence numbers would, and they show at a glance
  how old the thinking is.
- **Header:** a title, the date, and a **Status** line: `Proposed`, `Accepted → ADR NNNN`,
  `Rejected` or `Superseded by …`, with a sentence on why when it isn't Proposed.
- **Links into the repo** are relative to this folder, e.g.
  `../docs/design/decisions/0016-webapi-is-the-io-gateway.md`.
- Treat it as a public file anyway. This repository is public, so the rules in
  [`CLAUDE.md`](../CLAUDE.md) about environment specifics still apply: no hostnames,
  personal paths or secrets.

## When one is decided

- **Accepted:** write the decision as an ADR in `docs/design/decisions/`, with the next
  number, written from the outcome rather than the proposal. Then set the RFC's status to
  `Accepted → ADR NNNN`. The RFC stays here as the record of how the decision was reached.
- **Rejected or superseded:** set the status and say why. Don't delete the file; the
  reasoning is the useful part.
