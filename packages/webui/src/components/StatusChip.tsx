import { Chip, Tooltip } from "@mui/material";
import type { SessionStatus } from "../api/generated";

const COLOR: Record<SessionStatus, "success" | "warning" | "default"> = {
  ended: "default",
  running: "success",
  incomplete: "warning",
};

/**
 * Human labels for the derived lifecycle. `incomplete` reads as "abandoned" — a
 * session that started but never wrote a clean SessionEnd and has since gone quiet.
 * Status is re-derived from recent activity on every read, so an "abandoned"
 * session that receives new events flips back to "live" automatically.
 */
const LABEL: Record<SessionStatus, string> = {
  ended: "ended",
  running: "live",
  incomplete: "abandoned",
};

const TITLE: Record<SessionStatus, string> = {
  ended: "Ended cleanly (a SessionEnd summary was written).",
  running: "Live — recent activity, no clean exit yet.",
  incomplete: "Abandoned — started but no clean exit, and no recent activity (assumed crashed).",
};

/** Session lifecycle status as a small colored chip with an explanatory tooltip. */
export function StatusChip({ status }: { status: SessionStatus }) {
  return (
    <Tooltip title={TITLE[status]}>
      <Chip size="small" variant="outlined" color={COLOR[status]} label={LABEL[status]} />
    </Tooltip>
  );
}
