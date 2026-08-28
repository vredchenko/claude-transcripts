/**
 * `claude-transcripts turns [session]` — speaker-split turns, through the webapi.
 *
 *   claude-transcripts turns --role user --limit 200            # every prompt, all sessions, in time order
 *   claude-transcripts turns --role user --from 2026-08-01 --json
 *   claude-transcripts turns <session> --role assistant          # one session, one speaker
 *
 * Without a session id this is the cross-session view (`/api/turns`): one speaker's
 * turns across the whole corpus, time-ordered, each carrying its `sessionId` and `cwd`
 * — the corpus for "what do I keep asking for" and "which project did this come from".
 * With one, it is that session's turns (`/api/sessions/{id}/turns`). Both come from
 * full-content chunks, so sessions logged without `couchFullContentChunks` are empty
 * here ([ADR 0027](../../../../docs/design/decisions/0027-full-content-chunks-in-couchdb.md)).
 */
import {
  type CrossSessionTurn,
  getSessionTurns,
  getTurns,
  type SpeakerRole,
  type SpeakerTurn,
} from "../api/generated";
import { setWebapiUrl, webapiUrl } from "../api/http";
import { parseFlags, strOpt } from "../lib/args";
import { num, project, row, when } from "../lib/format";

const ROLE_W = 11;

function textWidth(): number {
  const cols = process.stdout.columns ?? 0;
  const before = 8 + 2 + 16 + 2 + ROLE_W + 2 + 18 + 2;
  return Math.max(40, (cols > 0 ? cols : 120) - before);
}

function oneLine(text: string, width: number): string {
  const t = text.replace(/\s+/g, " ").trim();
  return t.length > width ? `${t.slice(0, width - 1)}…` : t;
}

export function crossTurnLine(t: CrossSessionTurn, width: number = textWidth()): string {
  return row([
    [t.sessionId.slice(0, 8), 8],
    [when(t.timestamp), 16],
    [t.role, ROLE_W],
    [project(t.cwd), 18],
    [oneLine(t.text, width), width],
  ]);
}

export function sessionTurnLine(t: SpeakerTurn, i: number, width: number = textWidth()): string {
  const tools = (t.toolUses ?? []).map((u) => `⚙ ${u.name}`).join(" ");
  const text = t.text ?? "";
  return row([
    [`#${i}`, 5],
    [when(t.timestamp), 16],
    [t.role, ROLE_W],
    [oneLine(text && tools ? `${text} ${tools}` : text || tools, width), width],
  ]);
}

export async function runTurns(argv: string[]): Promise<number> {
  const { positionals, options } = parseFlags(argv);
  const webapiOverride = strOpt(options, "webapi");
  if (webapiOverride) setWebapiUrl(webapiOverride);
  const json = options.json === true;
  const role = strOpt(options, "role") as SpeakerRole | undefined;
  const limitOpt = strOpt(options, "limit");
  const limit = limitOpt ? Number(limitOpt) : 50;
  const id = positionals[0];

  try {
    if (id) {
      const offsetOpt = strOpt(options, "skip");
      const res = await getSessionTurns(id, {
        ...(role ? { role } : {}),
        limit,
        ...(offsetOpt ? { offset: Number(offsetOpt) } : {}),
      });
      if (json) {
        console.log(JSON.stringify(res, null, 2));
        return 0;
      }
      console.log(
        `turns: session ${id.slice(0, 8)} — ${num(res.turns.length)} of ${num(res.totalCount)}${role ? ` (${role})` : ""} (${webapiUrl()})`,
      );
      const width = textWidth();
      console.log(
        row([
          ["#", 5],
          ["WHEN", 16],
          ["WHO", ROLE_W],
          ["TEXT", width],
        ]),
      );
      for (const [i, t] of res.turns.entries()) console.log(sessionTurnLine(t, i, width));
      return 0;
    }

    const skipOpt = strOpt(options, "skip");
    const res = await getTurns({
      ...(role ? { role } : {}),
      ...(strOpt(options, "from") ? { from: strOpt(options, "from") } : {}),
      ...(strOpt(options, "to") ? { to: strOpt(options, "to") } : {}),
      limit,
      ...(skipOpt ? { skip: Number(skipOpt) } : {}),
    });
    if (json) {
      console.log(JSON.stringify(res, null, 2));
      return 0;
    }
    console.log(
      `turns: ${num(res.turns.length)}${res.hasMore ? "+" : ""}${role ? ` (${role})` : ""}, all sessions, time order (${webapiUrl()})`,
    );
    if (res.turns.length === 0) {
      console.log("turns: none — sessions logged without couchFullContentChunks have no turns");
      return 0;
    }
    const width = textWidth();
    console.log(
      row([
        ["SESSION", 8],
        ["WHEN", 16],
        ["WHO", ROLE_W],
        ["PROJECT", 18],
        ["TEXT", width],
      ]),
    );
    for (const t of res.turns) console.log(crossTurnLine(t, width));
    if (res.hasMore) console.log(`\n… more — raise --limit, or page with --skip`);
    return 0;
  } catch (err) {
    console.error(`turns: failed — ${(err as Error).message}`);
    console.error(
      `turns: is the webapi reachable at ${webapiUrl()}? (set --webapi or $CT_WEBAPI_URL)`,
    );
    return 1;
  }
}
