import { beforeEach, describe, expect, test } from "bun:test";
import { INITIAL_DESIGNS } from "./designs";
import { latestVersion } from "./registry";
import { migrateDown, migrateStatus, migrateUp } from "./runner";
import { type MigrationContext, SCHEMA_VERSION_ID, type SchemaVersionDoc } from "./types";

/** An in-memory CouchDB stand-in — the whole point of the abstract port: the
 *  engine is exercised end-to-end with no real database. */
function makeFake() {
  const store = new Map<string, Record<string, unknown>>();
  const logs: string[] = [];
  let clock = 0;
  const ctx: MigrationContext = {
    async getDoc<T = Record<string, unknown>>(id: string) {
      return (store.get(id) ?? null) as T | null;
    },
    async putDoc(id, doc) {
      store.set(id, { ...doc, _id: id });
    },
    async deleteDoc(id) {
      store.delete(id);
    },
    async allDocs<T = Record<string, unknown>>() {
      return [...store.values()] as T[];
    },
    now: () => `2020-01-01T00:00:${String(clock++).padStart(2, "0")}.000Z`,
    log: (m) => logs.push(m),
  };
  return { ctx, store, logs };
}

function marker(store: Map<string, Record<string, unknown>>): SchemaVersionDoc | undefined {
  return store.get(SCHEMA_VERSION_ID) as SchemaVersionDoc | undefined;
}

describe("migration runner", () => {
  let fake: ReturnType<typeof makeFake>;
  beforeEach(() => {
    fake = makeFake();
  });

  test("status on a pristine database reports every migration pending", async () => {
    const status = await migrateStatus(fake.ctx);
    expect(status.currentVersion).toBe(0);
    expect(status.latestVersion).toBe(latestVersion());
    expect(status.pending.length).toBe(latestVersion());
    expect(status.history).toEqual([]);
  });

  test("up applies all migrations and installs the design views + marker", async () => {
    const result = await migrateUp(fake.ctx);
    expect(result.direction).toBe("up");
    expect(result.fromVersion).toBe(0);
    expect(result.toVersion).toBe(latestVersion());
    expect(result.applied.length).toBe(latestVersion());

    // every design doc is present (v1 initial views + v2 session index)
    for (const d of INITIAL_DESIGNS) {
      expect(fake.store.has(d._id)).toBe(true);
    }
    expect(fake.store.has("_design/session_index")).toBe(true);
    // marker records the applied version + history
    expect(marker(fake.store)?.version).toBe(latestVersion());
    expect(marker(fake.store)?.applied.length).toBe(latestVersion());
  });

  test("up is idempotent — a second run applies nothing", async () => {
    await migrateUp(fake.ctx);
    const second = await migrateUp(fake.ctx);
    expect(second.applied).toEqual([]);
    expect(second.toVersion).toBe(latestVersion());
    expect(marker(fake.store)?.version).toBe(latestVersion());
  });

  test("dry-run reports the plan without touching the store", async () => {
    const result = await migrateUp(fake.ctx, { dryRun: true });
    expect(result.dryRun).toBe(true);
    expect(result.applied.length).toBe(latestVersion());
    // nothing written
    expect(marker(fake.store)).toBeUndefined();
    for (const d of INITIAL_DESIGNS) {
      expect(fake.store.has(d._id)).toBe(false);
    }
  });

  test("down --steps 1 rolls back only the latest migration", async () => {
    await migrateUp(fake.ctx);
    const result = await migrateDown(fake.ctx, { steps: 1 });
    expect(result.direction).toBe("down");
    expect(result.applied.length).toBe(1);
    // v2 (session index) removed, v1 (initial views) kept
    expect(fake.store.has("_design/session_index")).toBe(false);
    for (const d of INITIAL_DESIGNS) {
      expect(fake.store.has(d._id)).toBe(true);
    }
    expect(marker(fake.store)?.version).toBe(latestVersion() - 1);
  });

  test("down rolls back everything, removing every view", async () => {
    await migrateUp(fake.ctx);
    const result = await migrateDown(fake.ctx, { steps: latestVersion() });
    expect(result.applied.length).toBe(latestVersion());
    for (const d of INITIAL_DESIGNS) {
      expect(fake.store.has(d._id)).toBe(false);
    }
    expect(fake.store.has("_design/session_index")).toBe(false);
    expect(marker(fake.store)?.version).toBe(0);
    expect(marker(fake.store)?.applied).toEqual([]);
  });

  test("up → down → up round-trips back to the same schema", async () => {
    await migrateUp(fake.ctx);
    await migrateDown(fake.ctx, { steps: latestVersion() });
    const again = await migrateUp(fake.ctx);
    expect(again.toVersion).toBe(latestVersion());
    for (const d of INITIAL_DESIGNS) {
      expect(fake.store.has(d._id)).toBe(true);
    }
  });

  test("up honours an explicit --to target", async () => {
    const result = await migrateUp(fake.ctx, { to: 0 });
    expect(result.applied).toEqual([]);
    expect(result.toVersion).toBe(0);
  });
});
