import { CLI_SPEC } from "@claude-transcripts/shared";
import { Box, Text } from "ink";

/** Render command usage from a CLI command spec entry. */
function usage(name: string, args?: { name: string; required?: boolean }[]): string {
  const parts = (args ?? []).map((a) => (a.required ? `<${a.name}>` : `[${a.name}]`));
  return [name, ...parts].join(" ");
}

export function App({ command }: { command?: string; args: string[] }) {
  // Help is rendered FROM the model's cliSpec (CLI_SPEC) — one source of truth.
  const cmd = command ? CLI_SPEC.commands.find((c) => c.name === command) : undefined;

  return (
    <Box flexDirection="column">
      <Text bold>claude-transcripts</Text>
      <Text color="gray">Claude Transcripts — CLI</Text>

      {cmd ? (
        <Box marginTop={1} flexDirection="column">
          <Text>
            <Text color="cyan">{usage(cmd.name, cmd.args)}</Text> — {cmd.summary}
          </Text>
          {(cmd.args ?? []).map((a) => (
            <Text key={a.name}>
              {"  "}
              <Text color="yellow">{a.name.padEnd(14)}</Text>
              {a.description ?? ""}
            </Text>
          ))}
          <Box marginTop={1}>
            <Text color="gray">(not implemented yet)</Text>
          </Box>
        </Box>
      ) : (
        <Box marginTop={1} flexDirection="column">
          {command ? <Text color="red">unknown command: {command}</Text> : null}
          {CLI_SPEC.commands.map((c) => (
            <Text key={c.name}>
              <Text color="cyan">{c.name.padEnd(12)}</Text>
              {c.summary}
            </Text>
          ))}
        </Box>
      )}
    </Box>
  );
}
