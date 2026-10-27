/**
 * Where `provision` finds Garage. On a workstation that's loopback at GARAGE_ADMIN_PORT;
 * anywhere else (a Kubernetes Job, an external Garage) GARAGE_ADMIN_URL says where, the
 * way COUCHDB_URL does for CouchDB. A fake admin API stands in for Garage.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { provisionGarage } from "./provision";

const seen: string[] = [];
let server: ReturnType<typeof Bun.serve>;
let dir: string;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "ct-provision-"));
  server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch(req) {
      const { pathname } = new URL(req.url);
      seen.push(pathname);
      const json = (body: unknown) => Response.json(body);
      switch (pathname) {
        case "/admin/v2/GetClusterStatus":
          return json({ nodes: [{ id: "n1", isUp: true }] });
        case "/admin/v2/GetClusterLayout":
          return json({ version: 1, roles: [{ id: "n1", capacity: 1 }] });
        case "/admin/v2/CreateBucket":
          return json({ id: "b1" });
        case "/admin/v2/CreateKey":
          return json({ accessKeyId: "GKtest", secretAccessKey: "s3cret" });
        case "/admin/v2/AllowBucketKey":
          return json({});
        case "/admin/v2/ListKeys":
          return json([]);
        default:
          return new Response("not found", { status: 404 });
      }
    },
  });
});

afterAll(() => {
  server.stop(true);
  rmSync(dir, { recursive: true, force: true });
});

describe("provisionGarage", () => {
  test("GARAGE_ADMIN_URL wins over the loopback port, trailing slash and all", async () => {
    const envPath = join(dir, "instance.env");
    writeFileSync(envPath, "S3_ACCESS_KEY=\nS3_SECRET_KEY=\n");
    const { steps, env } = await provisionGarage(
      {
        GARAGE_ADMIN_URL: `http://127.0.0.1:${server.port}/admin/`,
        // Nothing listens here: a request to it would fail the test.
        GARAGE_ADMIN_PORT: "1",
        GARAGE_ADMIN_TOKEN: "t",
      },
      "sessions",
      envPath,
    );
    expect(steps.every((s) => s.ok)).toBe(true);
    expect(seen).toContain("/admin/v2/CreateKey");
    expect(env.S3_ACCESS_KEY).toBe("GKtest");
    expect(readFileSync(envPath, "utf8")).toContain("S3_SECRET_KEY=s3cret");
  });
});
