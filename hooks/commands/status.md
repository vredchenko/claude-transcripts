---
description: Is this session being recorded by Claude Transcripts, and where? Full status of the hook, the stores and this session.
allowed-tools: Bash(claude-transcripts:*)
---

Report the recording status of Claude Transcripts for this session. Run these, in
order, and summarise — do not paste raw output the user didn't ask for:

1. `claude-transcripts hook status` — where the hook is registered, which config it
   reads, whether any mirrors are configured.
2. `claude-transcripts statusline status` — whether the statusline indicator is wired.
3. `claude-transcripts doctor` — the write → read → search path end to end (this
   talks to the stores; it can take a few seconds).
4. `claude-transcripts sessions --limit 3` — proof that history is readable.

Then tell the user, in a few lines:

- **Recording?** yes / no, and the store(s): the CouchDB database, the S3 bucket if
  any, and mirrors.
- **This session:** its id (`$CLAUDE_SESSION_ID` if set, else the most recent
  running session from step 4) and the webui link `<webapi>/app/sessions/<id>`.
- **Anything wrong**, and the command that fixes it: no config → `claude-transcripts
  install`; hook not registered → `claude-transcripts hook install`; stores down →
  `claude-transcripts stack up`; search empty → `claude-transcripts reindex`.

If `claude-transcripts` itself is not on PATH, say so — that is the answer.
