/**
 * The dispatch contract, exercised through a real process: which stream the text
 * lands on and what the exit code is. Scripts and CI steps depend on exactly this
 * (#73) — a typo must be distinguishable from a command that ran and failed.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ENTRY = join(import.meta.dir, "cli.tsx");

async function run(...args: string[]) {
  const proc = Bun.spawn(["bun", "run", ENTRY, ...args], {
    stdout: "pipe",
    stderr: "pipe",
    stdin: "ignore",
    env: { ...process.env, CT_VERSION: "1.2.3", FORCE_COLOR: "0" },
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { stdout, stderr, code };
}

describe("claude-transcripts dispatch", () => {
  test("--version prints the baked version on stdout, exit 0", async () => {
    const r = await run("--version");
    expect(r.code).toBe(0);
    expect(r.stdout.trim()).toBe("1.2.3");
    expect(r.stderr).toBe("");
  });

  test("unknown command goes to stderr, exit 2, nothing on stdout", async () => {
    const r = await run("nonsense");
    expect(r.code).toBe(2);
    expect(r.stdout).toBe("");
    expect(r.stderr).toContain("unknown command: nonsense");
  });

  test("a write command's --help shows help and does not run it", async () => {
    const r = await run("backfill", "--help");
    expect(r.code).toBe(0);
    expect(r.stdout).not.toContain("backfill:");
  });

  test("a value outside choices is refused before the runner, exit 2", async () => {
    const r = await run("stack", "blah");
    expect(r.code).toBe(2);
    expect(r.stdout).toBe("");
    expect(r.stderr).toContain("usage: claude-transcripts stack");
  });
});

/**
 * Large output through a pipe must arrive whole (#146). Once `process.stdout` is
 * materialised (loading Ink, importing `node:process`, reading `.columns`), Bun's
 * `console.log` to a pipe loses its tail at exit. Each command runs against a stub
 * webapi to a file and to a pipe; the two must match.
 */
describe("large output through a pipe", () => {
  const N = 5000;
  const sessions = Array.from({ length: N }, (_, i) => ({
    sessionId: `session-${String(i).padStart(6, "0")}`,
    cwd: `/srv/project-${i % 17}`,
    prompts: i,
  }));
  const turns = Array.from({ length: N }, (_, i) => ({
    role: "user",
    timestamp: "2026-01-01T00:00:00.000Z",
    text: `turn ${i} `.repeat(20),
  }));
  let server: ReturnType<typeof Bun.serve>;
  let dir: string;

  beforeAll(() => {
    server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch: (req) =>
        new URL(req.url).pathname.endsWith("/turns")
          ? Response.json({ turns, totalCount: N, hasMore: false, role: "all" })
          : Response.json({ totalCount: N, sessions }),
    });
    dir = mkdtempSync(join(tmpdir(), "ct-cli-pipe-"));
  });
  afterAll(() => {
    server.stop(true);
    rmSync(dir, { recursive: true, force: true });
  });

  test.each([
    ["sessions", ["sessions", "--json"]],
    ["turns", ["turns", "abc", "--limit", String(N)]],
  ])(
    "%s: pipe matches file",
    async (name, args) => {
      const argv = ["bun", "run", ENTRY, ...args, "--webapi", `http://127.0.0.1:${server.port}`];
      const env = { ...process.env, FORCE_COLOR: "0" };

      const file = join(dir, `${name}.out`);
      const toFile = Bun.spawn(argv, { stdout: Bun.file(file), stderr: "pipe", env });
      expect(await toFile.exited).toBe(0);
      const expected = readFileSync(file, "utf8");
      expect(expected.length).toBeGreaterThan(256 * 1024); // well past a pipe buffer

      const toPipe = Bun.spawn(argv, { stdout: "pipe", stderr: "pipe", env });
      const [piped, code] = await Promise.all([new Response(toPipe.stdout).text(), toPipe.exited]);
      expect(code).toBe(0);
      expect(piped.length).toBe(expected.length);
      expect(piped).toBe(expected);
    },
    30_000,
  );
});
