/**
 * Self-built CouchDB migration types (ADR 0021).
 *
 * The engine is vendor-neutral: migrations act on a small abstract
 * {@link MigrationContext} port, not on a concrete CouchDB client. The webapi (the
 * I/O gateway) implements the port against `nano`; the CLI drives the whole thing
 * over the webapi. Keeping the port abstract also makes the engine unit-testable
 * with an in-memory fake.
 */

/** Id of the single marker doc that records the applied schema version. */
export const SCHEMA_VERSION_ID = "schema_version";

/** A record of one applied migration, kept in the marker doc's history. */
export interface AppliedMigration {
  id: number;
  name: string;
  /** ISO timestamp when it was applied (via `ctx.now()`). */
  at: string;
}

/** The marker doc stored in the target database. Mutable by design (ADR 0021). */
export interface SchemaVersionDoc {
  _id: string;
  _rev?: string;
  type: "schema_version";
  /** Highest migration id currently applied (0 = pristine). */
  version: number;
  /** Ordered history of applied migrations (append on up, pop on down). */
  applied: AppliedMigration[];
}

/**
 * The operations a migration may perform. Deliberately minimal — document
 * upsert/read/delete plus a timestamp + log sink. Data-transforming migrations get
 * `allDocs` to iterate; view migrations use `putDoc`/`deleteDoc` on `_design/*`.
 */
export interface MigrationContext {
  /** Read a doc by id, or `null` if it does not exist. */
  getDoc<T = Record<string, unknown>>(id: string): Promise<T | null>;
  /** Upsert a doc by id, carrying `_rev` forward (idempotent). */
  putDoc(id: string, doc: Record<string, unknown>): Promise<void>;
  /** Delete a doc by id if present (no-op when absent). */
  deleteDoc(id: string): Promise<void>;
  /** Iterate all documents (optionally with a startkey/endkey prefix). */
  allDocs<T = Record<string, unknown>>(opts?: { startkey?: string; endkey?: string }): Promise<T[]>;
  /** Current time as an ISO string (injected so the engine stays deterministic-testable). */
  now(): string;
  /** Progress/diagnostic sink (dry-run previews, applied steps). */
  log(message: string): void;
}

/** One ordered, reversible migration. */
export interface Migration {
  /** Monotonic version number; migrations apply in ascending id order. */
  id: number;
  /** Human-readable, kebab-case name (e.g. "initial-schema"). */
  name: string;
  /** Apply the change. Must be idempotent. */
  up(ctx: MigrationContext): Promise<void>;
  /** Reverse the change. Must be idempotent. */
  down(ctx: MigrationContext): Promise<void>;
}

/** A step reported by status/up/down (no side effects implied). */
export interface MigrationStep {
  id: number;
  name: string;
}

/** Result of `migrateStatus`. */
export interface MigrationStatus {
  currentVersion: number;
  latestVersion: number;
  pending: MigrationStep[];
  history: AppliedMigration[];
}

/** Result of `migrateUp` / `migrateDown`. */
export interface MigrationRunResult {
  direction: "up" | "down";
  fromVersion: number;
  toVersion: number;
  applied: MigrationStep[];
  dryRun: boolean;
}
