/**
 * Sessions as a table — the densest projection, and the one to reach for when the
 * question is comparative ("which of these used the most tokens").
 *
 * Extracted from the list route unchanged when the timeline and calendar projections
 * arrived, so all three are peers rather than one being the page and the others being
 * modes of it.
 */
import {
  Paper,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow,
  Tooltip,
  Typography,
  useTheme,
} from "@mui/material";
import { Link } from "@tanstack/react-router";
import type { SessionSummary } from "../../api/generated";
import {
  formatBytes,
  formatCount,
  formatDuration,
  formatTimestamp,
  projectName,
  totalTools,
} from "../../format";
import { MONO } from "../../theme";
import { SourceChip } from "../SourceChip";
import { StatusChip } from "../StatusChip";

function SessionRow({ s }: { s: SessionSummary }) {
  const theme = useTheme();
  return (
    <TableRow hover>
      <TableCell>
        <Link
          to="/sessions/$id"
          params={{ id: s.sessionId }}
          style={{ color: theme.palette.primary.main, textDecoration: "none" }}
        >
          <Typography component="span" sx={{ fontFamily: MONO, fontSize: 13 }}>
            {s.sessionId.slice(0, 8)}
          </Typography>
        </Link>
      </TableCell>
      <TableCell>{formatTimestamp(s.startTimestamp ?? s.timestamp)}</TableCell>
      <TableCell align="right">{formatDuration(s.durationMs)}</TableCell>
      <TableCell>
        <Tooltip title={s.cwd || ""}>
          <span>{projectName(s.cwd)}</span>
        </Tooltip>
      </TableCell>
      <TableCell>{s.model ?? "—"}</TableCell>
      <TableCell>
        <SourceChip source={s.source} />
      </TableCell>
      <TableCell align="right">{formatCount(s.promptCount)}</TableCell>
      <TableCell align="right">{formatCount(s.eventCount)}</TableCell>
      <TableCell align="right">{formatCount(totalTools(s.toolCounts))}</TableCell>
      <TableCell align="right">{s.tokenUsage ? formatCount(s.tokenUsage.total) : "—"}</TableCell>
      <TableCell align="right">{formatBytes(s.transcriptSize)}</TableCell>
      <TableCell>
        <StatusChip status={s.status} />
      </TableCell>
    </TableRow>
  );
}

export function SessionsTable({
  sessions,
  dimmed,
}: {
  sessions: SessionSummary[];
  /** True while a new page loads, so the stale one reads as stale. */
  dimmed?: boolean;
}) {
  return (
    <TableContainer component={Paper} sx={{ opacity: dimmed ? 0.6 : 1, maxWidth: "100%" }}>
      <Table size="small" stickyHeader>
        <TableHead>
          <TableRow>
            <TableCell>Session</TableCell>
            <TableCell>Started</TableCell>
            <TableCell align="right">Duration</TableCell>
            <TableCell>Project</TableCell>
            <TableCell>Model</TableCell>
            <TableCell>Source</TableCell>
            <TableCell align="right">Prompts</TableCell>
            <TableCell align="right">Events</TableCell>
            <TableCell align="right">Tools</TableCell>
            <TableCell align="right">Tokens</TableCell>
            <TableCell align="right">Transcript</TableCell>
            <TableCell>Status</TableCell>
          </TableRow>
        </TableHead>
        <TableBody>
          {sessions.map((s) => (
            <SessionRow key={s.sessionId} s={s} />
          ))}
        </TableBody>
      </Table>
    </TableContainer>
  );
}
