/**
 * Token accounting for the hook (standalone — the hook can't resolve the
 * workspace at install time).
 *
 * INVARIANT: `sumTranscriptTokens` (and its helpers/types) must stay
 * BYTE-IDENTICAL with `packages/shared/src/index.ts`. Change both together.
 */

export interface TokenUsage {
  input: number;
  output: number;
  cacheCreation: number;
  cacheRead: number;
  total: number;
  messages: number;
}

interface UsageBlock {
  input_tokens?: number;
  output_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
}

function usageWeight(u: UsageBlock): number {
  return (
    (u.input_tokens || 0) +
    (u.output_tokens || 0) +
    (u.cache_creation_input_tokens || 0) +
    (u.cache_read_input_tokens || 0)
  );
}

export function sumTranscriptTokens(jsonl: string): TokenUsage {
  const byMessage = new Map<string, UsageBlock>();
  let anonSeq = 0;

  for (const line of jsonl.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let doc: any;
    try {
      doc = JSON.parse(trimmed);
    } catch {
      continue;
    }
    const usage: UsageBlock | undefined = doc?.message?.usage;
    if (!usage) continue;
    const id: string = doc.message?.id || `__anon_${anonSeq++}`;
    const prev = byMessage.get(id);
    if (!prev || usageWeight(usage) > usageWeight(prev)) {
      byMessage.set(id, usage);
    }
  }

  const acc: TokenUsage = {
    input: 0,
    output: 0,
    cacheCreation: 0,
    cacheRead: 0,
    total: 0,
    messages: byMessage.size,
  };

  for (const u of byMessage.values()) {
    acc.input += u.input_tokens || 0;
    acc.output += u.output_tokens || 0;
    acc.cacheCreation += u.cache_creation_input_tokens || 0;
    acc.cacheRead += u.cache_read_input_tokens || 0;
  }
  acc.total = acc.input + acc.output + acc.cacheCreation + acc.cacheRead;

  return acc;
}
