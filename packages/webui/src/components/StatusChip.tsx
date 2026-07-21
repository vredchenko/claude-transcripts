import { Chip } from "@mui/material";
import type { SessionStatus } from "../api/generated";

const COLOR: Record<SessionStatus, "success" | "warning" | "default"> = {
  ended: "default",
  running: "success",
  incomplete: "warning",
};

/** Session lifecycle status as a small colored chip. */
export function StatusChip({ status }: { status: SessionStatus }) {
  return <Chip size="small" variant="outlined" color={COLOR[status]} label={status} />;
}
