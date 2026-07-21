# 3. Vendor-neutral S3 via Bun's S3 client; drop MinIO and rclone

Date: 2026-06-06

## Status

Accepted

## Context

A predecessor logging hook uploaded session blobs with the `rclone` CLI and,
during an infrastructure migration, *dual-wrote* to both MinIO and Garage (a
named-adapter config with per-store `write` toggles). That carried
deployment-specific baggage into a project that is meant to be standalone and run
anywhere:

- a hard dependency on an `rclone` binary + named remotes configured out-of-band;
- two object stores to provision and reason about;
- a config schema (`blob.stores.<name>`) shaped by the migration, not by a
  standalone user's needs.

The template project had already moved to Bun's built-in `S3Client`, accessed
purely through `S3_*` env, with no rclone.

## Decision

Use **one** S3-compatible object store, addressed through Bun's native
`S3Client` (`packages/webapi/src/storage/s3-blob-store.ts` and the hook's
`session-hook.ts`). Configuration is a flat block — endpoint, region, access key,
secret key, bucket — shared by the webapi (`S3_*` env) and the hook
(`config.json.blob`). **MinIO and rclone are removed**; Garage is the reference
backend, but any S3-compatible store (MinIO, R2, AWS) works by changing endpoint
and credentials only.

## Consequences

- No external binary dependency for the hook; it only needs Bun.
- One bucket to provision; bucket creation stays out-of-band (the app/hook never
  create buckets), documented per-backend in `deploy/README.md` and
  `docs/hook-setup.md`.
- The hook and webapi share one mental model and one credential set.
- Dual-write/mirroring is no longer supported in-project. Operators who want
  redundancy do it at the storage layer (replication) or via external tooling.
- The predecessor sources are intentionally left untouched; this is a
  divergence the standalone project owns.
