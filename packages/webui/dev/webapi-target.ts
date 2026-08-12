/**
 * Which webapi the dev server proxies `/api` to — and whether anything is there.
 *
 * The dev server serves a page; the page's data comes from a webapi somewhere else.
 * When those two disagree about a port, Vite's proxy reports the refused connection as
 * a **500 on every `/api` call**, which reads like an application bug and sends you
 * looking in the wrong place entirely. Both halves of this module exist to stop that:
 * find the webapi when we reasonably can, and say so plainly when we can't.
 *
 * Resolution mirrors the CLI's {@link resolveWebapiUrl} (packages/cli/src/api/http.ts)
 * on purpose — a checkout's two clients should not disagree about where the webapi is:
 *
 *   1. `WEBAPI_PORT` when set — an explicit value is never second-guessed.
 *   2. The installed instance's `instance.env`, because `install` allocates a port per
 *      instance and an install is frequently *not* on 7650.
 *   3. The documented default.
 *
 * Step 2 only gets a turn when step 1 is absent, which is why `.env.template` ships
 * `WEBAPI_PORT` commented out: a value copied from a template is indistinguishable from
 * one a developer meant, and silently overriding either would be worse than the 500.
 *
 * The **port** is what pins the target; `WEBAPI_HOST` only chooses the host for it.
 * That split matters because the template does ship a `WEBAPI_HOST` — it is the address
 * a host-run webapi *binds*, and letting it double as "the developer named a target"
 * would suppress step 2 for everyone who ever copied the template.
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** The documented dev-range default (`.env.template`, docs/start/installation.md). */
export const DEFAULT_WEBAPI_PORT = "7650";
export const DEFAULT_WEBAPI_ORIGIN = `http://127.0.0.1:${DEFAULT_WEBAPI_PORT}`;

export type TargetSource = "configured" | "instance" | "default";

export interface ProxyTarget {
  /** Origin the proxy should forward `/api` to. */
  origin: string;
  /** Where {@link origin} came from — reported at startup so the choice is visible. */
  source: TargetSource;
  /** Whether something answered on {@link origin}. */
  reachable: boolean;
  /**
   * An installed instance that IS listening, when {@link origin} is not. This is the
   * whole payload of the diagnostic: it turns "500" into "you want port 7658".
   */
  alternative: string | null;
}

/**
 * Path to the installed instance's generated env.
 *
 * Duplicated from the CLI's `installPaths()` rather than imported: the webui does not
 * depend on the CLI package, and a dev-server config is a poor reason to make it. Keep
 * the two in step — `CT_HOME` included, since that is how a sandboxed install relocates.
 */
export function instanceEnvPath(): string {
  const ctHome = process.env.CT_HOME;
  if (ctHome) return join(ctHome, "config", "instance.env");
  // Blank-checked but otherwise taken verbatim — padding included — because that is
  // what the CLI does, and the two resolving one path differently is the failure this
  // mirrors against (see dev/instance-path-parity.test.ts).
  const xdg = process.env.XDG_CONFIG_HOME;
  const configHome = xdg?.trim() ? xdg : join(homedir(), ".config");
  return join(configHome, "claude-transcripts", "instance.env");
}

/** The installed instance's webapi origin, or null if there is no readable install. */
export function instanceOrigin(path = instanceEnvPath()): string | null {
  try {
    const raw = readFileSync(path, "utf8");
    const port = /^WEBAPI_PORT=(\d+)\s*$/m.exec(raw)?.[1];
    if (!port) return null;
    const host = /^WEBAPI_HOST=(\S+)\s*$/m.exec(raw)?.[1] ?? "127.0.0.1";
    // The instance binds 0.0.0.0 inside its container; from the host it is localhost.
    return `http://${host === "0.0.0.0" ? "127.0.0.1" : host}:${port}`;
  } catch {
    return null;
  }
}

/**
 * Is anything listening? Any HTTP response counts, including a 404 — we are asking
 * whether the port is served at all, not whether it is the webapi we hoped for. A
 * wrong-but-live port produces API errors that explain themselves; a dead one does not.
 */
export async function probe(origin: string, timeoutMs = 500): Promise<boolean> {
  try {
    await fetch(`${origin}/health`, { signal: AbortSignal.timeout(timeoutMs) });
    return true;
  } catch {
    return false;
  }
}

export interface ResolveOptions {
  /** `WEBAPI_HOST` as Vite loaded it — the host to use, not a target in itself. */
  host?: string;
  /** `WEBAPI_PORT` as Vite loaded it; absent when unset, which is what enables lookup. */
  port?: string;
  /** Injected in tests. */
  readInstance?: () => string | null;
  probeOrigin?: (origin: string) => Promise<boolean>;
}

export async function resolveProxyTarget(opts: ResolveOptions = {}): Promise<ProxyTarget> {
  const readInstance = opts.readInstance ?? (() => instanceOrigin());
  const probeOrigin = opts.probeOrigin ?? probe;
  const installed = readInstance();

  const host = opts.host || "127.0.0.1";
  let origin: string;
  let source: TargetSource;
  if (opts.port) {
    origin = `http://${host}:${opts.port}`;
    source = "configured";
  } else if (installed) {
    origin = installed;
    source = "instance";
  } else {
    origin = `http://${host}:${DEFAULT_WEBAPI_PORT}`;
    source = "default";
  }

  const reachable = await probeOrigin(origin);
  // Only worth naming an alternative when it is somewhere else AND actually serving.
  const alternative =
    !reachable && installed && installed !== origin && (await probeOrigin(installed))
      ? installed
      : null;

  return { origin, source, reachable, alternative };
}

/**
 * The sentence a developer needs, in the two places it helps: printed once at startup,
 * and returned as the body of every failed proxy call so it is visible in the browser
 * rather than only in a terminal that may be scrolled away.
 */
export function describeTarget(t: ProxyTarget): string {
  const from = {
    configured: "WEBAPI_PORT",
    instance: "the installed instance",
    default: "the default",
  }[t.source];

  if (t.reachable) return `webui: proxying /api → ${t.origin} (from ${from})`;

  const lines = [
    `webui: nothing is listening on ${t.origin} (from ${from}) — /api calls will fail.`,
  ];
  if (t.alternative) {
    lines.push(
      `  An installed instance IS serving on ${t.alternative}.`,
      `  Use it:   WEBAPI_PORT=${new URL(t.alternative).port} bun run dev:webui`,
      "  (or set WEBAPI_PORT in .env to make it stick)",
    );
  }
  lines.push("  Running the webapi from source instead?   bun run dev:webapi");
  return lines.join("\n");
}
