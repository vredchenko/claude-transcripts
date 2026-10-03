/**
 * Screenshot the plugin's terminal surfaces: every statusline state, the statusline at
 * several widths, and the session-start banner (#167).
 *
 *   bun run test:browser:capture:plugin
 *
 * The webui has `capture.ts`; the plugin is a terminal, so there is no page to point a
 * browser at. Instead this renders the real `renderStatusline` / `recordingBanner`
 * output, turns its ANSI colour and OSC 8 links into HTML, and screenshots that in a
 * terminal-styled frame with the same Playwright Chromium. What it shows is exactly what
 * the CLI prints; only the terminal around it is drawn.
 *
 * **Synthetic on purpose**, like `fixtures/corpus.ts`: fixed clock, `example.net` hosts,
 * an invented session id. No real instance is read, so the shots are publishable and a
 * diff between two runs means the rendering changed.
 *
 * Output lands in `tests/browser/.captures/plugin/` (gitignored; `CAPTURE_DIR`
 * overrides the parent): `statusline-states.png`, `statusline-widths.png`, `banner.png`.
 */
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { chromium } from "@playwright/test";
import { NOT_RECORDING_BANNER, recordingBanner } from "../../packages/cli/src/hook/announce";
import type { StoreHealth, Targets } from "../../packages/cli/src/hook/runtime";
import {
  renderStatusline,
  type StatuslineState,
  sessionLink,
} from "../../packages/cli/src/lib/statusline";

const OUT_DIR = join(process.env.CAPTURE_DIR || join(import.meta.dir, ".captures"), "plugin");

const NOW = 1_700_000_000_000;
const VERSION = "v0.4.0";
const SESSION_ID = "3f2a9c1e-7b4d-4e8a-9c2f-5d6e7f8a9b0c";
const counts = { events: 128, prompts: 4, errors: 0, tools: { Bash: 4, Read: 2 } };

const base: Targets = {
  couchUrl: "https://couch.example.net:5984",
  sessionsDb: "claude-transcripts-sessions",
  bucket: "claude-transcripts-sessions",
  webapiUrl: "https://transcripts.example.net",
  features: [],
  mirrors: [],
  lastWriteMs: 0,
  lastFailureMs: 0,
};
const LINK = sessionLink(base.webapiUrl, SESSION_ID);

const store = (kind: StoreHealth["kind"], over: Partial<StoreHealth>): StoreHealth => ({
  label:
    kind === "direct" ? "claude-transcripts-sessions@couch.example.net:5984" : "backup.example.net",
  kind,
  lastWriteMs: 0,
  lastFailureMs: 0,
  ...over,
});
const withStores = (...stores: StoreHealth[]): Targets => ({ ...base, stores });

const state = (over: Partial<StatuslineState>): StatuslineState => ({
  configured: true,
  targets: null,
  counts,
  version: VERSION,
  ...over,
});

const RECORDING = state({ targets: withStores(store("direct", { lastWriteMs: NOW - 2000 })) });

const STATES: [string, StatuslineState][] = [
  ["recording", RECORDING],
  [
    "recording via a mirror",
    state({
      targets: withStores(
        store("direct", { lastWriteMs: NOW - 600_000, lastFailureMs: NOW - 1000 }),
        store("mirror", { lastWriteMs: NOW - 3000 }),
      ),
    }),
  ],
  ["ready", state({ targets: withStores(store("direct", {})) })],
  [
    "stalled",
    state({
      targets: withStores(
        store("direct", { lastWriteMs: NOW - 360_000, lastFailureMs: NOW - 1000 }),
      ),
    }),
  ],
  [
    "stalled · hook silent",
    state({
      targets: withStores(store("direct", { lastWriteMs: NOW - 540_000 })),
      transcriptMtimeMs: NOW - 1000,
    }),
  ],
  ["off", state({ configured: false })],
];

/** The statusline as the CLI prints it into a terminal: coloured and linked. */
const draw = (s: StatuslineState, columns?: number) =>
  renderStatusline(s, NOW, { color: true, link: s.targets ? LINK : null, columns });

// ── ANSI → HTML: only what the renderer emits (SGR 0/2/32/33/36 and OSC 8) ──

const ESC = "\x1b";
const SGR_STYLE: Record<string, string> = {
  "2": "opacity:.55",
  "32": "color:var(--green)",
  "33": "color:var(--yellow)",
  "36": "color:var(--cyan)",
};
const escapeHtml = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

function ansiToHtml(s: string): string {
  let out = "";
  let open = 0;
  let i = 0;
  while (i < s.length) {
    if (s.startsWith(`${ESC}]8;;`, i)) {
      const end = s.indexOf(`${ESC}\\`, i);
      const url = s.slice(i + 5, end);
      out += url ? `<a href="${escapeHtml(url)}">` : "</a>";
      i = end + 2;
    } else if (s.startsWith(`${ESC}[`, i)) {
      const end = s.indexOf("m", i);
      const code = s.slice(i + 2, end);
      if (code === "0") {
        out += "</span>".repeat(open);
        open = 0;
      } else {
        out += `<span style="${SGR_STYLE[code] ?? ""}">`;
        open++;
      }
      i = end + 1;
    } else {
      out += escapeHtml(s[i] ?? "");
      i++;
    }
  }
  return out + "</span>".repeat(open);
}

// ── Pages ──

const CSS = `
:root{--bg:#0d1117;--term:#010409;--fg:#c9d1d9;--muted:#8b949e;--line:#30363d;
  --green:#7ee787;--yellow:#e3b341;--cyan:#56d4dd;--link:#58a6ff}
body{margin:0;background:var(--bg);color:var(--fg);font:14px/1.5 "JetBrains Mono","DejaVu Sans Mono",monospace}
#shot{display:inline-block;padding:18px;background:var(--bg)}
h3{font:600 12px system-ui;color:var(--muted);margin:14px 0 4px;text-transform:uppercase;letter-spacing:.05em}
.term{border:1px solid var(--line);border-radius:8px;padding:10px 14px;background:var(--term)}
.row,.note{white-space:pre;padding:2px 0}
.label{display:inline-block;width:200px;color:var(--muted);font-size:12px}
.prompt{border:1px solid var(--line);border-radius:6px;padding:6px 10px;color:var(--muted);margin:8px 0 4px}
a{color:inherit;text-decoration:underline;text-decoration-color:var(--link)}`;

const page = (body: string) =>
  `<html><head><style>${CSS}</style></head><body><div id="shot">${body}</div></body></html>`;
const row = (label: string, html: string) =>
  `<div class="row"><span class="label">${escapeHtml(label)}</span>${html}</div>`;

/** A banner the way Claude Code shows it: above the prompt, the statusline below. */
function session(banner: string, status: string): string {
  const note = escapeHtml(banner).replace(
    /https?:\/\/\S+/g,
    (url) => `<a href="${url}">${url}</a>`,
  );
  return `<div class="term"><div class="note">${note}</div><div class="prompt">&gt; </div><div class="row">${ansiToHtml(status)}</div></div>`;
}

const PAGES: Record<string, string> = {
  "statusline-states": page(
    `<div class="term">${STATES.map(([name, s]) => row(name, ansiToHtml(draw(s)))).join("")}</div>`,
  ),
  "statusline-widths": page(
    `<div class="term">${[120, 80, 64, 50, 30]
      .map((c) => row(`COLUMNS=${c}`, ansiToHtml(draw(RECORDING, c))))
      .join("")}</div>`,
  ),
  banner: page(
    `<h3>recording</h3>${session(
      recordingBanner({ ...base, mirrors: ["https://backup.example.net"] }, SESSION_ID),
      draw(RECORDING),
    )}<h3>not configured</h3>${session(NOT_RECORDING_BANNER, draw(state({ configured: false })))}`,
  ),
};

await mkdir(OUT_DIR, { recursive: true });
const browser = await chromium.launch();
try {
  const tab = await browser.newPage({
    deviceScaleFactor: 2,
    viewport: { width: 1600, height: 400 },
  });
  for (const [name, html] of Object.entries(PAGES)) {
    await tab.setContent(html);
    const path = join(OUT_DIR, `${name}.png`);
    await tab.locator("#shot").screenshot({ path });
    console.log(path);
  }
} finally {
  await browser.close();
}
