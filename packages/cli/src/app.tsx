import {
  CLI_SPEC,
  type CliArgDef,
  cliArgHint,
  cliArgLabel,
  cliCommandsByGroup,
  cliUsage,
  isFlag,
} from "@claude-transcripts/shared";
import { Box, Text } from "ink";
import { COMMANDS } from "./commands";

const BIN = "claude-transcripts";

/** Left-column width for a set of labels: the longest plus a gutter. Never hardcoded. */
const column = (labels: string[]): number => Math.max(0, ...labels.map((l) => l.length)) + 2;

function ArgRows({ args, width }: { args: CliArgDef[]; width: number }) {
  return (
    <>
      {args.map((a) => {
        const hint = cliArgHint(a);
        return (
          <Text key={a.name}>
            {"  "}
            <Text color="yellow">{cliArgLabel(a).padEnd(width)}</Text>
            {a.description ?? ""}
            {hint ? <Text color="gray"> {hint}</Text> : null}
          </Text>
        );
      })}
    </>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <Box marginTop={1} flexDirection="column">
      <Text bold>{title}</Text>
      {children}
    </Box>
  );
}

/** One command's help: usage, arguments, options, global options, examples. */
function CommandHelp({ name }: { name: string }) {
  const cmd = CLI_SPEC.commands.find((c) => c.name === name);
  if (!cmd) return null;
  const positionals = (cmd.args ?? []).filter((a) => !isFlag(a));
  const flags = (cmd.args ?? []).filter(isFlag);
  const width = column([...(cmd.args ?? []), ...CLI_SPEC.globalArgs].map(cliArgLabel));

  return (
    <Box flexDirection="column">
      <Box marginTop={1}>
        <Text>
          <Text color="cyan">
            {BIN} {cliUsage(cmd)}
          </Text>
          {"  "}
          {cmd.summary}
        </Text>
      </Box>
      {positionals.length > 0 ? (
        <Section title="ARGUMENTS">
          <ArgRows args={positionals} width={width} />
        </Section>
      ) : null}
      {flags.length > 0 ? (
        <Section title="OPTIONS">
          <ArgRows args={flags} width={width} />
        </Section>
      ) : null}
      <Section title="GLOBAL OPTIONS">
        <ArgRows args={CLI_SPEC.globalArgs} width={width} />
      </Section>
      {cmd.examples?.length ? (
        <Section title="EXAMPLES">
          {cmd.examples.map((e) => (
            <Text key={e}>
              {"  "}
              <Text color="gray">$ </Text>
              {BIN} {e}
            </Text>
          ))}
        </Section>
      ) : null}
      {/* Only say this when it's true — the registry is the fact, not the spec. */}
      {COMMANDS[cmd.name] ? null : (
        <Box marginTop={1}>
          <Text color="gray">(not implemented yet)</Text>
        </Box>
      )}
    </Box>
  );
}

/** The top-level help: commands by group, then the global options. */
function Overview() {
  const groups = cliCommandsByGroup(CLI_SPEC);
  const width = column(CLI_SPEC.commands.map((c) => c.name));
  const optWidth = column(CLI_SPEC.globalArgs.map(cliArgLabel));
  return (
    <Box flexDirection="column">
      <Box marginTop={1}>
        <Text>
          usage: <Text color="cyan">{BIN} &lt;command&gt; [options]</Text>
        </Text>
      </Box>
      {groups.map((g) => (
        <Section key={g.key} title={g.title.toUpperCase()}>
          {g.commands.map((c) => (
            <Text key={c.name}>
              {"  "}
              <Text color="cyan">{c.name.padEnd(width)}</Text>
              {c.summary}
            </Text>
          ))}
        </Section>
      ))}
      <Section title="GLOBAL OPTIONS">
        <ArgRows args={CLI_SPEC.globalArgs} width={optWidth} />
      </Section>
      <Box marginTop={1}>
        <Text color="gray">
          {BIN} &lt;command&gt; --help shows that command's arguments and examples.
        </Text>
      </Box>
    </Box>
  );
}

export interface AppProps {
  /** Show one command's help instead of the overview. */
  command?: string;
  /** The overview, prefixed with an "unknown command" line (rendered to stderr). */
  unknown?: string;
}

/** Help is rendered FROM the model's CLI_SPEC — one source of truth. */
export function App({ command, unknown }: AppProps) {
  return (
    <Box flexDirection="column">
      <Text bold>{BIN}</Text>
      <Text color="gray">Claude Transcripts — CLI</Text>
      {unknown ? <Text color="red">unknown command: {unknown}</Text> : null}
      {command ? <CommandHelp name={command} /> : <Overview />}
    </Box>
  );
}
