/**
 * `setup`'s half of the double-registration guard.
 *
 * The detector has always been able to see the plugin (`lib/plugin.test.ts` covers
 * it); what was missing was this file asking. `hook install` refused a redundant
 * registration, `setup` did not — and `setup` is the command the docs tell you to run
 * first and the one `install` calls, so the guard sat on the door you reach for
 * second. These tests pin the wiring, not the detection.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isOurCommand } from "./hook";
import { globalRegistrationBlockedBy, loadSetupConfig } from "./setup";

/** A settings.json at a throwaway path, laid out as Claude Code would. */
function settingsWith(contents: unknown): string {
  const path = join(mkdtempSync(join(tmpdir(), "ct-setup-")), "settings.json");
  writeFileSync(path, JSON.stringify(contents));
  return path;
}

describe("globalRegistrationBlockedBy", () => {
  test("a settings file with only hooks → nothing blocks registration", () => {
    // The ordinary CLI-registered machine: `setup` must still be able to re-run.
    const path = settingsWith({ hooks: { SessionStart: [{ hooks: [{ command: "bun run x" }] }] } });
    expect(globalRegistrationBlockedBy(path)).toBeNull();
  });

  test("an enabled plugin blocks registration", () => {
    const path = settingsWith({
      enabledPlugins: { "claude-transcripts@claude-transcripts": true },
    });
    expect(globalRegistrationBlockedBy(path)?.key).toBe("claude-transcripts@claude-transcripts");
  });

  test("malformed settings never block registration", () => {
    // Read opportunistically: an unparseable settings file is not a reason to refuse
    // to set up a machine.
    const path = join(mkdtempSync(join(tmpdir(), "ct-setup-")), "settings.json");
    writeFileSync(path, "{ not json");
    expect(globalRegistrationBlockedBy(path)).toBeNull();
  });

  test("reads enabledPlugins alongside hooks, not instead of them", () => {
    // The actual defect: `readSettings` returned only `hooks`, so `enabledPlugins` was
    // invisible to this file and a plugin-registered machine looked empty.
    const path = settingsWith({
      hooks: { SessionStart: [{ hooks: [{ command: "bun run x" }] }] },
      enabledPlugins: { "claude-transcripts@my-fork": true },
    });
    expect(globalRegistrationBlockedBy(path)?.key).toBe("claude-transcripts@my-fork");
  });
});

describe("setup writes a webapi-only client config (#288)", () => {
  const ENTRY = join(import.meta.dir, "..", "cli.tsx");
  const server = Bun.serve({
    port: 0,
    fetch: (req) =>
      new URL(req.url).pathname === "/health"
        ? Response.json({ ok: true })
        : Response.json({ error: "nope" }, { status: 404 }),
  });
  afterAll(() => server.stop(true));

  async function setup(webapi: string, existing?: unknown) {
    const home = mkdtempSync(join(tmpdir(), "ct-setup-home-"));
    const config = join(home, "config.json");
    if (existing) writeFileSync(config, JSON.stringify(existing));
    const proc = Bun.spawn(["bun", "run", ENTRY, "setup", "--no-hook", "--webapi", webapi], {
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, CT_HOME: home, CT_HOOK_CONFIG: config, FORCE_COLOR: "0" },
    });
    const [out, err, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    return { code, out: out + err, config: JSON.parse(readFileSync(config, "utf8")) };
  }

  test("--webapi points the hook at a remote instance, and setup checks it takes writes", async () => {
    const url = `http://localhost:${server.port}`;
    const r = await setup(`${url}/`, {
      couch: { url: "http://127.0.0.1:5984", auth: "admin:secret" },
      blob: { accessKey: "GK", secretKey: "shh" },
      mirrors: [{ url: "https://backup.example.net" }],
    });
    expect(r.code).toBe(0);
    expect(r.config.webapi).toEqual({ url });
    // The legacy store blocks go, credentials with them; the machine's mirrors stay.
    expect(r.config.couch).toBeUndefined();
    expect(r.config.blob).toBeUndefined();
    expect(r.config.mirrors).toEqual([{ url: "https://backup.example.net" }]);
    expect(r.out).toContain("takes writes");
    // …and it never reached for a store.
    expect(r.out).not.toMatch(/couch db|garage bucket/i);
  }, 20_000);

  test("drops a mirror that is the webapi itself, keeping the others (#306)", async () => {
    const url = `http://localhost:${server.port}`;
    const r = await setup(url, {
      webapi: { url },
      mirrors: [
        { url: `${url.toUpperCase().replace("HTTP:", "http:")}/` },
        { url: "https://b.example" },
      ],
    });
    expect(r.code).toBe(0);
    expect(r.config.mirrors).toEqual([{ url: "https://b.example" }]);
    expect(r.out).toContain("dropped mirror");
  }, 20_000);

  test("an unreachable webapi is written anyway, but setup says so and fails", async () => {
    const r = await setup("http://127.0.0.1:1");
    expect(r.code).toBe(1);
    expect(r.config.webapi).toEqual({ url: "http://127.0.0.1:1" });
    expect(r.out).toContain("unreachable");
    expect(r.out).toContain("backfill");
  }, 20_000);
});

describe("loadSetupConfig (#306)", () => {
  test("with no checkout (a release binary), falls back instead of reading the disk", () => {
    // In a compiled binary the repo root resolves to `/`, which has no `config/`.
    const root = mkdtempSync(join(tmpdir(), "ct-setup-nocheckout-"));
    const app = loadSetupConfig(root);
    expect(app.system.logging.chunk.maxEntriesPerChunk).toBeGreaterThan(0);
    expect(app.features).toBeDefined();
  });

  test("prefers the checkout's live config over its template", () => {
    const root = mkdtempSync(join(tmpdir(), "ct-setup-checkout-"));
    mkdirSync(join(root, "config"));
    writeFileSync(join(root, "config", "config.template.json"), JSON.stringify({ tag: "t" }));
    writeFileSync(join(root, "config", "config.json"), JSON.stringify({ tag: "live" }));
    expect((loadSetupConfig(root) as unknown as { tag: string }).tag).toBe("live");
  });
});

describe("setup registers the hook the way `hook install` does (#308)", () => {
  const ENTRY = join(import.meta.dir, "..", "cli.tsx");
  // What `setup` used to write: the plugin shim, from a checkout a binary doesn't have.
  const LEGACY = 'cd / && bun run "/src/claude-transcripts/hooks/scripts/dispatch.ts"';

  test("the legacy dispatch form counts as ours; other tools' hooks don't", () => {
    expect(isOurCommand(LEGACY)).toBe(true);
    expect(isOurCommand('bun run "/opt/other-tool/scripts/dispatch.ts"')).toBe(false);
    // The plugin's own command, its root variable unexpanded as in hooks.json.
    const plugin = ['cd / && bun run "$', '{CLAUDE_PLUGIN_ROOT}/scripts/dispatch.ts"'].join("");
    expect(isOurCommand(plugin)).toBe(false);
  });

  test("registers `hook run`, replacing a legacy registration instead of adding to it", async () => {
    const home = mkdtempSync(join(tmpdir(), "ct-setup-reg-"));
    const settings = join(home, "claude", "settings.json");
    mkdirSync(join(home, "claude"));
    writeFileSync(
      settings,
      JSON.stringify({
        hooks: {
          SessionStart: [
            { hooks: [{ type: "command", command: LEGACY }] },
            { hooks: [{ type: "command", command: "other-tool --start" }] },
          ],
        },
      }),
    );
    const proc = Bun.spawn(["bun", "run", ENTRY, "setup", "--webapi", "http://127.0.0.1:1"], {
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, CT_HOME: home, CT_HOOK_CONFIG: join(home, "c.json") },
    });
    await proc.exited;
    const hooks = JSON.parse(readFileSync(settings, "utf8")).hooks as Record<
      string,
      { hooks: { command: string }[] }[]
    >;
    const commands = Object.values(hooks).flatMap((gs) =>
      gs.flatMap((g) => g.hooks.map((h) => h.command)),
    );
    expect(commands).not.toContain(LEGACY);
    expect(commands).toContain("other-tool --start");
    const ours = commands.filter((c) => c.includes("hook run"));
    expect(ours.length).toBe(Object.keys(hooks).length);
    expect(new Set(ours).size).toBe(1);
  }, 20_000);
});
