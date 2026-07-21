import { Box, Chip, Tooltip } from "@mui/material";
import type { TokenUsage } from "../api/generated";
import { formatCount } from "../format";

/** Token usage broken out as labelled chips; total is emphasised. */
export function TokenUsageChips({ usage }: { usage: TokenUsage | undefined }) {
  if (!usage) return <span>—</span>;
  return (
    <Box sx={{ display: "flex", flexWrap: "wrap", gap: 0.5 }}>
      <Tooltip title="Total tokens (deduped by message id)">
        <Chip size="small" color="primary" label={`Σ ${formatCount(usage.total)}`} />
      </Tooltip>
      <Chip size="small" variant="outlined" label={`in ${formatCount(usage.input)}`} />
      <Chip size="small" variant="outlined" label={`out ${formatCount(usage.output)}`} />
      <Tooltip title="Cache creation / cache read">
        <Chip
          size="small"
          variant="outlined"
          label={`cache ${formatCount(usage.cacheCreation)}/${formatCount(usage.cacheRead)}`}
        />
      </Tooltip>
    </Box>
  );
}
