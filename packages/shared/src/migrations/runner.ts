/**
 * The migration runner — pure orchestration over a {@link MigrationContext}.
 *
 * The marker doc ({@link SchemaVersionDoc}) is the source of truth for what has
 * been applied. Up/down write the marker after **each** step, so an interrupted
 * run leaves a consistent version (every migration is itself idempotent, so a
 * re-run is safe). `dryRun` computes the plan without any side effects.
 */
import { latestVersion, MIGRATIONS } from "./registry";
import {
  type Migration,
  type MigrationContext,
  type MigrationRunResult,
  type MigrationStatus,
  type MigrationStep,
  SCHEMA_VERSION_ID,
  type SchemaVersionDoc,
} from "./types";

const EMPTY_MARKER: Omit<SchemaVersionDoc, "_rev"> = {
  _id: SCHEMA_VERSION_ID,
  type: "schema_version",
  version: 0,
  applied: [],
};

/** Read the marker doc, defaulting to a pristine (version 0) marker. */
async function readMarker(ctx: MigrationContext): Promise<SchemaVersionDoc> {
  const doc = await ctx.getDoc<SchemaVersionDoc>(SCHEMA_VERSION_ID);
  if (!doc) return { ...EMPTY_MARKER };
  // Defensive: tolerate an older/partial marker shape.
  return {
    ...EMPTY_MARKER,
    ...doc,
    applied: Array.isArray(doc.applied) ? doc.applied : [],
    version: typeof doc.version === "number" ? doc.version : 0,
  };
}

async function writeMarker(ctx: MigrationContext, marker: SchemaVersionDoc): Promise<void> {
  const { _id, _rev, ...body } = marker;
  await ctx.putDoc(SCHEMA_VERSION_ID, body as Record<string, unknown>);
}

function byId(id: number): Migration {
  const m = MIGRATIONS.find((x) => x.id === id);
  if (!m) throw new Error(`Migration ${id} is in the applied history but not in the registry`);
  return m;
}

function step(m: { id: number; name: string }): MigrationStep {
  return { id: m.id, name: m.name };
}

/** Migrations not yet applied, ascending, capped at `target`. */
function pendingUpTo(current: number, target: number): Migration[] {
  return MIGRATIONS.filter((m) => m.id > current && m.id <= target).sort((a, b) => a.id - b.id);
}

/** Current version + pending list + applied history. */
export async function migrateStatus(ctx: MigrationContext): Promise<MigrationStatus> {
  const marker = await readMarker(ctx);
  const latest = latestVersion();
  return {
    currentVersion: marker.version,
    latestVersion: latest,
    pending: pendingUpTo(marker.version, latest).map(step),
    history: marker.applied,
  };
}

/** Apply pending migrations up to `to` (default: the latest registered version). */
export async function migrateUp(
  ctx: MigrationContext,
  opts: { to?: number; dryRun?: boolean } = {},
): Promise<MigrationRunResult> {
  const dryRun = opts.dryRun === true;
  const marker = await readMarker(ctx);
  const from = marker.version;
  const target = opts.to ?? latestVersion();
  const plan = pendingUpTo(from, target);

  if (dryRun) {
    for (const m of plan) ctx.log(`would apply up ${m.id} ${m.name}`);
    const lastPlanned = plan[plan.length - 1];
    return {
      direction: "up",
      fromVersion: from,
      toVersion: lastPlanned ? lastPlanned.id : from,
      applied: plan.map(step),
      dryRun: true,
    };
  }

  const applied: MigrationStep[] = [];
  for (const m of plan) {
    ctx.log(`applying up ${m.id} ${m.name}`);
    await m.up(ctx);
    marker.applied.push({ id: m.id, name: m.name, at: ctx.now() });
    marker.version = m.id;
    await writeMarker(ctx, marker);
    applied.push(step(m));
  }

  return { direction: "up", fromVersion: from, toVersion: marker.version, applied, dryRun: false };
}

/** Roll back the last `steps` applied migrations (default 1), highest id first. */
export async function migrateDown(
  ctx: MigrationContext,
  opts: { steps?: number; dryRun?: boolean } = {},
): Promise<MigrationRunResult> {
  const dryRun = opts.dryRun === true;
  const steps = Math.max(0, opts.steps ?? 1);
  const marker = await readMarker(ctx);
  const from = marker.version;

  // The last `steps` applied migrations, highest id first.
  const toRollBack = [...marker.applied].sort((a, b) => b.id - a.id).slice(0, steps);

  if (dryRun) {
    for (const a of toRollBack) ctx.log(`would apply down ${a.id} ${a.name}`);
    const remaining = marker.applied
      .filter((a) => !toRollBack.some((r) => r.id === a.id))
      .reduce((max, a) => Math.max(max, a.id), 0);
    return {
      direction: "down",
      fromVersion: from,
      toVersion: remaining,
      applied: toRollBack.map(step),
      dryRun: true,
    };
  }

  const applied: MigrationStep[] = [];
  for (const a of toRollBack) {
    const m = byId(a.id);
    ctx.log(`applying down ${m.id} ${m.name}`);
    await m.down(ctx);
    marker.applied = marker.applied.filter((x) => x.id !== a.id);
    marker.version = marker.applied.reduce((max, x) => Math.max(max, x.id), 0);
    await writeMarker(ctx, marker);
    applied.push(step(m));
  }

  return {
    direction: "down",
    fromVersion: from,
    toVersion: marker.version,
    applied,
    dryRun: false,
  };
}
