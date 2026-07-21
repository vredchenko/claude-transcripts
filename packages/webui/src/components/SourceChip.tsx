import { Chip, Tooltip } from "@mui/material";

/**
 * Recording provenance: "live" (streamed by the hook as the session happened) vs
 * "backfilled" (adopted after the fact from an on-disk transcript — `backfill`,
 * `doctor`, or any non-live source). Undefined ⇒ unknown, treated as live.
 */
export function SourceChip({ source }: { source?: string }) {
  const live = !source || source === "live";
  return (
    <Tooltip title={live ? "Live-recorded by the hook" : `Backfilled (source: ${source})`}>
      <Chip
        size="small"
        variant="outlined"
        color={live ? "success" : "default"}
        label={live ? "live" : "backfilled"}
      />
    </Tooltip>
  );
}
