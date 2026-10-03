/**
 * `claude-transcripts completions <bash|zsh|fish>` — print a completion script.
 *
 *   eval "$(claude-transcripts completions bash)"     # ~/.bashrc
 *   eval "$(claude-transcripts completions zsh)"      # ~/.zshrc, after compinit
 *   claude-transcripts completions fish | source      # ~/.config/fish/config.fish
 *
 * A projection of CLI_SPEC (`toCompletions`), so it completes exactly what the
 * validator accepts. It only prints: where the script is sourced from is the user's
 * call, and nothing here edits an rc file. The shell argument is checked against the
 * spec's `choices` before this runs.
 */
import { CLI_SPEC, type CompletionShell, toCompletions } from "@claude-transcripts/shared";
import { parseFlags } from "../lib/args";

const BIN = "claude-transcripts";

export async function runCompletions(argv: string[]): Promise<number> {
  const shell = parseFlags(argv).positionals[0] as CompletionShell;
  process.stdout.write(toCompletions(CLI_SPEC, shell, BIN));
  return 0;
}
