/**
 * Migration admin routes — drive the self-built CouchDB migration engine (ADR 0021)
 * over the webapi. The CLI's `migrate` command calls these; migrations run on the
 * sessions database. Status is a safe GET; up/down are POSTs and support `dryRun`.
 */

import { migrateDown, migrateStatus, migrateUp } from "@claude-transcripts/shared";
import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import type { AppContext } from "../context";
import { makeMigrationContext } from "../storage/migrations";

const StepSchema = z.object({ id: z.number(), name: z.string() });

const StatusSchema = z.object({
  currentVersion: z.number(),
  latestVersion: z.number(),
  pending: z.array(StepSchema),
  history: z.array(z.object({ id: z.number(), name: z.string(), at: z.string() })),
});

const RunResultSchema = z.object({
  direction: z.enum(["up", "down"]),
  fromVersion: z.number(),
  toVersion: z.number(),
  applied: z.array(StepSchema),
  dryRun: z.boolean(),
  log: z.array(z.string()),
});

const ErrorSchema = z.object({ error: z.string() });

const UpBodySchema = z.object({ to: z.number().optional(), dryRun: z.boolean().optional() });
const DownBodySchema = z.object({ steps: z.number().optional(), dryRun: z.boolean().optional() });

const statusRoute = createRoute({
  method: "get",
  path: "/migrate/status",
  operationId: "migrateStatus",
  responses: {
    200: {
      content: { "application/json": { schema: StatusSchema } },
      description: "Migration status",
    },
    500: { content: { "application/json": { schema: ErrorSchema } }, description: "Error" },
  },
});

const upRoute = createRoute({
  method: "post",
  path: "/migrate/up",
  operationId: "migrateUp",
  request: {
    body: { content: { "application/json": { schema: UpBodySchema } }, required: false },
  },
  responses: {
    200: { content: { "application/json": { schema: RunResultSchema } }, description: "Applied" },
    500: { content: { "application/json": { schema: ErrorSchema } }, description: "Error" },
  },
});

const downRoute = createRoute({
  method: "post",
  path: "/migrate/down",
  operationId: "migrateDown",
  request: {
    body: { content: { "application/json": { schema: DownBodySchema } }, required: false },
  },
  responses: {
    200: {
      content: { "application/json": { schema: RunResultSchema } },
      description: "Rolled back",
    },
    500: { content: { "application/json": { schema: ErrorSchema } }, description: "Error" },
  },
});

export function migrateRoutes(ctx: AppContext) {
  const app = new OpenAPIHono();
  const route = app as unknown as {
    openapi: (r: unknown, h: (c: any) => unknown) => void;
  };

  route.openapi(statusRoute, async (c: any) => {
    const lines: string[] = [];
    const mig = makeMigrationContext(ctx.couch.db("sessions"), (m) => lines.push(m));
    try {
      const status = await migrateStatus(mig);
      return c.json(status);
    } catch (err) {
      return c.json({ error: (err as Error).message }, 500);
    }
  });

  route.openapi(upRoute, async (c: any) => {
    const body = (await c.req.json().catch(() => ({}))) as { to?: number; dryRun?: boolean };
    const lines: string[] = [];
    const mig = makeMigrationContext(ctx.couch.db("sessions"), (m) => lines.push(m));
    try {
      const result = await migrateUp(mig, { to: body.to, dryRun: body.dryRun });
      return c.json({ ...result, log: lines });
    } catch (err) {
      return c.json({ error: (err as Error).message }, 500);
    }
  });

  route.openapi(downRoute, async (c: any) => {
    const body = (await c.req.json().catch(() => ({}))) as { steps?: number; dryRun?: boolean };
    const lines: string[] = [];
    const mig = makeMigrationContext(ctx.couch.db("sessions"), (m) => lines.push(m));
    try {
      const result = await migrateDown(mig, { steps: body.steps, dryRun: body.dryRun });
      return c.json({ ...result, log: lines });
    } catch (err) {
      return c.json({ error: (err as Error).message }, 500);
    }
  });

  return app;
}
