/**
 * The Fossil image's seed script (deploy/fossil/entrypoint.sh), run under the host's
 * POSIX sh with a stub `fossil` on PATH that records its calls. The image runs it under
 * busybox ash; both are POSIX shells and the script uses nothing beyond that.
 */
import { afterEach, describe, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SCRIPT = join(import.meta.dir, "..", "..", "..", "..", "deploy", "fossil", "entrypoint.sh");

// `new … FILE` creates FILE; every call is logged; `server` ends the run.
const STUB = `#!/bin/sh
echo "$*" >> "$STUB_LOG"
if [ "$1" = new ]; then for a; do f="$a"; done; : > "$f"; fi
exit 0
`;

let dirs: string[] = [];
afterEach(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs = [];
});

function run(repositories: string | undefined, prepare?: (museum: string) => void) {
  const root = mkdtempSync(join(tmpdir(), "ct-fossil-seed-"));
  dirs.push(root);
  const museum = join(root, "museum");
  const bin = join(root, "bin");
  Bun.spawnSync(["mkdir", "-p", museum, bin]);
  writeFileSync(join(bin, "fossil"), STUB);
  chmodSync(join(bin, "fossil"), 0o755);
  prepare?.(museum);
  const log = join(root, "calls.log");
  const env: Record<string, string> = {
    PATH: `${bin}:${process.env.PATH}`,
    FOSSIL_MUSEUM: museum,
    FOSSIL_BUSYBOX: "",
    STUB_LOG: log,
  };
  if (repositories !== undefined) env.FOSSIL_REPOSITORIES = repositories;
  // cwd = the museum's parent, which holds files: a glob in a name would match them.
  const p = Bun.spawnSync(["sh", SCRIPT, "--repolist", museum], { env, cwd: root });
  return {
    code: p.exitCode,
    stderr: p.stderr.toString(),
    files: readdirSync(museum).sort(),
    calls: existsSync(log) ? readFileSync(log, "utf8").trim().split("\n") : [],
  };
}

describe("fossil seed", () => {
  test("creates each missing repository, read-only for anonymous, then serves", () => {
    const r = run("claude-transcripts-sessions,second");
    expect(r.code).toBe(0);
    expect(r.files).toEqual(["claude-transcripts-sessions.fossil", "second.fossil"]);
    expect(r.calls.filter((c) => c.startsWith("user capabilities nobody"))).toEqual([
      expect.stringMatching(/^user capabilities nobody ghjorz -R .*sessions\.fossil\.new$/),
      expect.stringMatching(/^user capabilities nobody ghjorz -R .*second\.fossil\.new$/),
    ]);
    expect(r.calls.at(-1)).toMatch(/^server --repolist /);
  });

  test("never touches an existing repository", () => {
    const r = run("kept", (m) => writeFileSync(join(m, "kept.fossil"), "history"));
    expect(r.calls.some((c) => c.startsWith("new"))).toBe(false);
    expect(r.calls).toHaveLength(1); // just `server`
  });

  test("a glob or a bad name is refused, not expanded or created", () => {
    const r = run("*,bad/name,-x,a.b");
    expect(r.files).toEqual([]);
    expect(r.stderr).toContain("skipping '*'");
    expect(r.stderr).toContain("skipping 'bad/name'");
    expect(r.calls).toHaveLength(1);
  });

  test("surrounding whitespace is trimmed, empty entries ignored", () => {
    const r = run(" a ,  b,,\tc\t");
    expect(r.files).toEqual(["a.fossil", "b.fossil", "c.fossil"]);
  });

  test("a stale half-made seed is replaced, and no list means no seed", () => {
    const r = run("x", (m) => writeFileSync(join(m, "x.fossil.new"), "partial"));
    expect(r.files).toEqual(["x.fossil"]);
    expect(run(undefined).files).toEqual([]);
    expect(run("").files).toEqual([]);
  });
});
