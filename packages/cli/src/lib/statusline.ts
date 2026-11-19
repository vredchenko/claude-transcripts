/**
 * The statusline indicator, rendered from the hook's own per-session scratch state
 * (docs/design/plugin.md, Part 1b).
 *
 *   ● ct@v0.2.0 rec · 128 ev · 6 tools · 2s ago → 127.0.0.1:7650
 *   ● ct@v0.2.0 rec (mirror) · 128 ev · 2s ago → logs.example.net  (instance down, mirror taking writes)
 *   ◐ ct@v0.2.0 stalled · timeout · 128 ev · last write 6m ago · run `claude-transcripts backfill` → …
 *   ◐ ct@v0.2.0 stalled · hook silent · 128 ev · last write 9m ago → …  (session moving, hook not)
 *   ○ ct@v0.2.0 off · no instance configured
 *
 * The version is the **recording binary's own**, not the instance's. Everything is
 * lockstep-versioned (ADR 0023), and `install` pins the app image to the CLI's version
 * — so when a machine drifts, the hook writing the documents is the half you cannot
 * otherwise see, and it is on screen all session. It cannot show the app's version
 * instead: that would need a request, and this renders on every refresh.
 *
 * Runs on every statusline refresh, so it does **no network I/O** — ever. Everything
 * it shows is what the hook already wrote to `/tmp` while recording: the counters
 * (`makeCounts`) and the resolved targets plus last-write time (`makeTargets`). That
 * last field is what separates "recording" from "configured but failing" — and a
 * failure shows from the first rejected write, with its reason and the command that
 * recovers the gap (#288): nothing buffers it, so nobody else will say.
 *
 * Health is read per store, because a machine that reports into a shared instance
 * routinely has a dead primary and a live mirror. Collapsing those into one verdict is
 * wrong in both directions — a permanent red on a machine recording perfectly well, or
 * a green dot labelled with a host that has accepted nothing for weeks — so the label
 * names whichever store is actually taking the writes, and says when that is a mirror.
 *
 * Drawing is a second step (`formatStatusline`): colour by state, an OSC 8 link on the
 * store label, and a fit to the terminal's width. With no options it draws the plain
 * line above, which is what tests, pipes and `NO_COLOR` get.
 */
import { statSync } from "node:fs";
import type { Counts, StoreHealth, Targets } from "../hook/runtime";
import { VERSION } from "./version";

/** What Claude Code pipes to a statusline command. Only the fields we read. */
export interface StatuslineInput {
  session_id?: string;
  /** Its mtime says whether the session is moving. */
  transcript_path?: string;
}

export interface StatuslineState {
  configured: boolean;
  targets: Targets | null;
  counts: Counts | null;
  /** The transcript's mtime; absent/null skips the hook-silent check. */
  transcriptMtimeMs?: number | null;
  /** Defaults to this binary's {@link VERSION}; a test passes its own. */
  version?: string;
}

/** The command that recovers what a failing write lost (#288: nothing is buffered). */
export const RECOVER_HINT = "run `claude-transcripts backfill`";

/**
 * Transcript modified this long after the hook's last attempt → the hook is no longer
 * being invoked (it records no failure, so an aging write alone looks like an idle
 * session). Wide because a tool-less turn gives the hook no event until Stop.
 */
export const HOOK_SILENT_AFTER_MS = 5 * 60_000;

/** The transcript's mtime, or null if it can't be read. Never throws. */
export function transcriptMtimeMs(path: unknown): number | null {
  if (typeof path !== "string" || !path) return null;
  try {
    return statSync(path).mtimeMs;
  } catch {
    return null;
  }
}

/**
 * `lastActivityMs` counts failures too: a rejected write proves the hook ran. No
 * activity at all means no baseline — that is `ready`.
 */
export function hookSilent(lastActivityMs: number, transcriptMs: number | null | undefined) {
  if (!transcriptMs || lastActivityMs <= 0) return false;
  return transcriptMs - lastActivityMs > HOOK_SILENT_AFTER_MS;
}

function lastWrite(ms: number, now: number): string {
  return ms > 0 ? `last write ${ago(ms, now)}` : "no write landed";
}

export function ago(ms: number, now: number): string {
  const s = Math.max(0, Math.round((now - ms) / 1000));
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  return `${Math.round(m / 60)}h ago`;
}

/**
 * `ct@v0.2.0`.
 *
 * The version is passed through as every surface spells it, `v` and all:
 * `--version`, `GET /health` and the app image tag `install` pins all say `v0.2.0`
 * (`APP_VERSION`). Trimming the prefix here would make the statusline the one
 * component with its own spelling.
 */
export function versionLabel(version: string = VERSION): string {
  return `ct@${version}`;
}

/**
 * Where this session's writes go, short enough for a statusline: the webapi's
 * `host:port`. A targets file from before #288 named a CouchDB, as `db@host:port`.
 */
export function whereLabel(t: Targets): string {
  const host = (url: string) => url.replace(/^https?:\/\//, "").replace(/\/.*$/, "");
  if (t.webapiUrl) return host(t.webapiUrl);
  return t.couchUrl ? `${t.sessionsDb ?? "?"}@${host(t.couchUrl)}` : "?";
}

/** One store's verdict. `idle` is "nothing tried yet", not "nothing worked". */
export type StoreState = "healthy" | "failing" | "idle";

/**
 * A target is failing as soon as a rejection is newer than its last success — the
 * first failed write, not one that has persisted (#288). With no local queue, every
 * failed write is a gap only `backfill` fills, so the moment to say so is now. A
 * target that has never written is failing only if something was actually rejected;
 * otherwise it is merely idle.
 */
export function storeState(
  s: Pick<StoreHealth, "lastWriteMs" | "lastFailureMs">,
  _now?: number,
): StoreState {
  if (s.lastFailureMs > s.lastWriteMs) return "failing";
  return s.lastWriteMs > 0 ? "healthy" : "idle";
}

/** The state a line reports; it picks the glyph and the colour. */
export type LineState = "rec" | "stalled" | "ready" | "off";

/**
 * What a statusline says, before it is drawn. The renderer decides the content; the
 * formatter decides how much of it fits and how it looks, so the plain line and the
 * coloured, linked, width-limited one can never disagree about the state.
 */
export interface StatuslineLine {
  state: LineState;
  /** `ct@v0.2.0`. */
  version: string;
  /** Qualifies the state word: `(mirror)` after `rec`. */
  qualifier?: string;
  /** The first detail: why it is off, or `hook silent`. */
  note?: string;
  /** Event and tool counts; `tools` absent before the hook has counted any. */
  events?: number;
  tools?: number;
  /** `2s ago`, `last write 6m ago`, `no write yet`. */
  age?: string;
  /** What to run to recover the gap, on a failing line. */
  fix?: string;
  /** The store label, `db@host` or a mirror's host. */
  where?: string;
  /** `+2` when more mirrors are taking writes than the one named. */
  more?: string;
  /**
   * The session's page on the instance. When set, `where` shows this link (scheme
   * dropped, shortened as the width demands) and the drawing makes it clickable.
   */
  href?: string;
}

const GLYPH: Record<LineState, string> = { rec: "●", stalled: "◐", ready: "◌", off: "○" };

/** Where a recorded session can be opened, if the instance has a webapi URL. */
export function sessionLink(webapiUrl: string | undefined, sessionId: string): string | null {
  return webapiUrl ? `${webapiUrl.replace(/\/$/, "")}/app/sessions/${sessionId}` : null;
}

export function renderStatusline(
  state: StatuslineState,
  now = Date.now(),
  opts: FormatOptions = {},
): string {
  return formatStatusline(statuslineLine(state, now), opts);
}

/** Decide what the line says. Every verdict lives here; nothing in it knows about width. */
export function statuslineLine(state: StatuslineState, now = Date.now()): StatuslineLine {
  const version = versionLabel(state.version);
  if (!state.configured) return { state: "off", version, note: "no instance configured" };
  const t = state.targets;
  if (!t) return { state: "off", version, note: "not recording this session" };

  const c = state.counts;
  const counted = c
    ? { events: c.events, tools: Object.values(c.tools).reduce((a, b) => a + b, 0) }
    : { events: 0 };
  const line = (state: LineState, rest: Partial<StatuslineLine>): StatuslineLine => ({
    state,
    version,
    ...counted,
    ...rest,
  });

  // A targets file written by an older binary has no per-store health. Render it exactly
  // as that binary did rather than showing "off" at a session that is recording fine.
  const stores = t.stores?.length ? t.stores : null;
  if (!stores) {
    const where = whereLabel(t);
    const age = lastWrite(t.lastWriteMs, now);
    if (hookSilent(Math.max(t.lastWriteMs, t.lastFailureMs), state.transcriptMtimeMs)) {
      return line("stalled", { note: "hook silent", age, where });
    }
    if (t.lastFailureMs > t.lastWriteMs) return line("stalled", { age, where, fix: RECOVER_HINT });
    if (t.lastWriteMs <= 0) return line("ready", { age: "no write yet", where });
    return line("rec", { age: ago(t.lastWriteMs, now), where });
  }

  // The instance's own webapi (`direct`: the CouchDB a pre-#288 file names).
  const direct = stores.find((s) => s.kind === "webapi" || s.kind === "direct") ?? stores[0];
  const headline = direct ?? { label: whereLabel(t), lastWriteMs: 0, lastFailureMs: 0 };

  // Before any store is called healthy: a silent hook leaves every store frozen as it was.
  const lastActivity = Math.max(...stores.flatMap((s) => [s.lastWriteMs, s.lastFailureMs]));
  if (hookSilent(lastActivity, state.transcriptMtimeMs)) {
    const newest = stores.reduce((a, b) => (b.lastWriteMs > a.lastWriteMs ? b : a), headline);
    return line("stalled", {
      note: "hook silent",
      age: lastWrite(newest.lastWriteMs, now),
      where: newest.label,
    });
  }

  if (direct && storeState(direct, now) === "healthy") {
    return line("rec", { age: ago(direct.lastWriteMs, now), where: direct.label });
  }

  // The primary is not taking writes. If a mirror is, the session IS being recorded —
  // say so, and name the store that has the data rather than the one that does not.
  const healthyMirrors = stores.filter((s) => s !== direct && storeState(s, now) === "healthy");
  const first = healthyMirrors[0];
  if (first) {
    // Recorded, but not on the instance: if it is rejecting writes, that is a gap there
    // only backfill fills, so the line says so even though it is green.
    const instanceFailing = direct && storeState(direct, now) === "failing";
    return line("rec", {
      qualifier: "(mirror)",
      age: ago(first.lastWriteMs, now),
      ...(instanceFailing ? { fix: RECOVER_HINT } : {}),
      where: first.label,
      ...(healthyMirrors.length > 1 ? { more: `+${healthyMirrors.length - 1}` } : {}),
    });
  }

  const failing = stores.find((s) => storeState(s, now) === "failing");
  if (failing) {
    const best = Math.max(...stores.map((s) => s.lastWriteMs));
    const reason = (direct && storeState(direct, now) === "failing" ? direct : failing).lastError;
    return line("stalled", {
      ...(reason ? { note: reason } : {}),
      age: lastWrite(best, now),
      fix: RECOVER_HINT,
      where: headline.label,
    });
  }
  return line("ready", { age: "no write yet", where: headline.label });
}

export interface FormatOptions {
  /** ANSI colour by state. Off by default: tests and pipes get the plain line. */
  color?: boolean;
  /**
   * The session's page on the instance (`sessionLink`). Shown in place of the store
   * label, and clickable (OSC 8) where the terminal supports it — but only on a line
   * naming the instance: a `(mirror)` line's data is not there yet.
   */
  link?: string | null;
  /** Fit the line into this many columns by dropping detail, least useful first. */
  columns?: number;
}

const SGR = {
  reset: "\x1b[0m",
  dim: "\x1b[2m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  cyan: "\x1b[36m",
} as const;

const STATE_COLOR: Record<LineState, string> = {
  rec: SGR.green,
  stalled: SGR.yellow,
  ready: SGR.cyan,
  off: SGR.dim,
};

/**
 * Narrower forms of a line, in the order they are tried: each drops the detail that
 * says least about whether the session is being recorded. The glyph, the state and the
 * version are never dropped — the version is how drift between machines shows.
 */
const SHRINK: ((l: StatuslineLine) => StatuslineLine)[] = [
  ({ tools: _, ...l }) => l,
  ({ fix: _, ...l }) => l,
  (l) => (l.href ? { ...l, where: linkText(l.href, "mid") } : l),
  (l) =>
    l.href
      ? { ...l, where: linkText(l.href, "short") }
      : l.where
        ? { ...l, where: shortWhere(l.where) }
        : l,
  ({ events: _, ...l }) => l,
  ({ age: _, ...l }) => l,
  ({ where: _, more: __, ...l }) => l,
];

/**
 * `db@host:port` → `db`; a mirror's `host.example.net:7650` → `host`. An IP address is
 * kept whole (port dropped): its first octet names nothing.
 */
export function shortWhere(where: string): string {
  const at = where.indexOf("@");
  if (at > 0) return where.slice(0, at);
  const host = where.startsWith("[") ? where.slice(0, where.indexOf("]") + 1) : where.split(":")[0];
  if (!host || host.startsWith("[") || /^\d+(\.\d+){3}$/.test(host)) return host || where;
  return host.split(".")[0] || host;
}

/**
 * A session link as the line shows it: `host:port/app/sessions/<id>` in full, then
 * `host:port/…/<id8>`, then `host/…/<id8>`. Enough to tell which instance and which
 * session at a glance; the click target is always the whole URL.
 */
export function linkText(url: string, form: "full" | "mid" | "short"): string {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return url;
  }
  if (form === "full") return `${u.host}${u.pathname}`;
  const id = (u.pathname.split("/").filter(Boolean).pop() ?? "").slice(0, 8);
  return `${form === "mid" ? u.host : shortWhere(u.host)}/…/${id}`;
}

/** Draw a line. With no options it is the plain line every earlier release printed. */
export function formatStatusline(line: StatuslineLine, opts: FormatOptions = {}): string {
  let l = line;
  if (opts.link && l.where && l.qualifier !== "(mirror)") {
    l = { ...l, href: opts.link, where: linkText(opts.link, "full") };
  }
  if (opts.columns && opts.columns > 0) {
    for (const shrink of SHRINK) {
      // Measured on the plain drawing: escapes take no columns.
      if ([...draw(l, {})].length <= opts.columns) break;
      l = shrink(l);
    }
  }
  return draw(l, opts);
}

function draw(l: StatuslineLine, opts: FormatOptions): string {
  const paint = (code: string, s: string) => (opts.color ? `${code}${s}${SGR.reset}` : s);
  const dim = (s: string) => paint(SGR.dim, s);

  const color = STATE_COLOR[l.state];
  const head = [
    paint(color, `${GLYPH[l.state]}`),
    l.version,
    paint(color, l.state),
    ...(l.qualifier ? [paint(SGR.yellow, l.qualifier)] : []),
  ].join(" ");

  const counts =
    l.events === undefined
      ? undefined
      : l.tools === undefined
        ? `${l.events} ev`
        : `${l.events} ev · ${l.tools} tools`;
  const details = [
    l.note && (l.note === "hook silent" ? paint(SGR.yellow, l.note) : l.note),
    counts && dim(counts),
    l.age && dim(l.age),
    l.fix && paint(SGR.yellow, l.fix),
  ].filter(Boolean);
  const sep = dim(" · ");

  let out = [head, ...details].join(sep);
  if (l.where) {
    const label = l.href && opts.link ? osc8(l.href, l.where) : l.where;
    out += `${dim(" →")} ${label}${l.more ? ` ${l.more}` : ""}`;
  }
  return out;
}

/** An OSC 8 hyperlink: the terminal shows `text` and opens `url` on click. */
function osc8(url: string, text: string): string {
  return `\x1b]8;;${url}\x1b\\${text}\x1b]8;;\x1b\\`;
}
