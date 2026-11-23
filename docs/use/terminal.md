# From the terminal

The `claude-transcripts` binary that installed the instance is also a client for it.
Three commands read history; all of them take `--json` for scripts and agents. Every
flag is in the [CLI reference](../reference/cli.md).

## List and open sessions

```bash
claude-transcripts sessions                                    # list sessions (50 by default)
claude-transcripts sessions --limit 10
claude-transcripts sessions --cwd ~/dev/api --from 2026-08-01  # one project, since a date
claude-transcripts sessions 3f9a2c1e --limit 80                # one session: detail and transcript preview
```

`--cwd`, `--model`, `--hostname` and `--source` narrow the list to an exact value;
`--from` and `--to` keep the sessions that overlap that period.

## Search

```bash
claude-transcripts search "retry policy"
claude-transcripts search deploy --cwd ~/proj --limit 5
```

What comes back, and what to do when it comes back empty: [Search](search.md).

## One speaker, across sessions

`turns` splits conversations by speaker. With a session id it shows that session's
turns; without one it collects one speaker across every session in time order, which
is the quickest way to read back everything you asked for in a week:

```bash
claude-transcripts turns --role user --from 2026-08-01
claude-transcripts turns --role user --limit 200
claude-transcripts turns 3f9a2c1e --role assistant
```

`--role` is one of `user`, `assistant`, `tool_result`, `system`, `other`.

## Scripting

`--json` prints the API's response unchanged, so a script reads the same shapes the
[API](api.md) documents:

```bash
claude-transcripts sessions --limit 5 --json
claude-transcripts search deploy --json
```

Exit codes are `0` for success, `1` when the command ran and failed, and `2` for a
usage error. `search --json` exits `1` when search is not enabled, so a pipeline can
tell that apart from an empty result.

## Which instance it talks to

The first of these that is set: `--webapi <url>`, `CT_WEBAPI_URL`, `WEBAPI_PORT`, the
`webapi.url` the hook is configured with, the installed instance's port, and finally
`http://127.0.0.1:7650`. So on the machine that runs the instance no flag is needed,
and from another machine one flag is:

```bash
claude-transcripts sessions --webapi https://transcripts.example.net
```

## Shell completion

```bash
eval "$(claude-transcripts completions bash)"   # ~/.bashrc
eval "$(claude-transcripts completions zsh)"    # ~/.zshrc, after compinit
claude-transcripts completions fish | source    # ~/.config/fish/config.fish
```

## Beyond reading

The same binary runs the instance: [`backfill`](../operate/tools.md) adopts sessions
from before you installed, [`export` and `import`](../operate/migrations.md) move
history between machines, and `doctor` checks the whole write and read path.
