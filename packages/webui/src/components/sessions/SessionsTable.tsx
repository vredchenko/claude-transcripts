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
  durationSplit,
  durationSplitLabel,
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

/**
 * The columns, in the order they're read.
 *
 * A list is scanned left to right, so what identifies a session comes first (when, how
 * long), then where it ran (project, machine), then how big it was. `hint` becomes the
 * header's tooltip — three adjacent duration columns need saying which is which, and a
 * header row has no room to say it in words.
 */
const COLUMNS: { label: string; align?: "right"; hint?: string }[] = [
  { label: "Session" },
  { label: "Started" },
  { label: "Runtime", align: "right", hint: "Wall-clock: first event to last" },
  {
    label: "Active",
    align: "right",
    hint: "Working time — gaps longer than the idle threshold excluded",
  },
  { label: "Idle", align: "right", hint: "Runtime minus active: the session sat open" },
  { label: "Project" },
  { label: "Host", hint: "The machine that recorded the session" },
  { label: "Model" },
  { label: "Source" },
  { label: "Prompts", align: "right" },
  { label: "Events", align: "right" },
  { label: "Tools", align: "right" },
  { label: "Tokens", align: "right" },
  { label: "Transcript", align: "right" },
  { label: "Status" },
];

/**
 * Durations are two short words ("14m 0s") and the columns are narrow enough to break
 * between them, which turns a scannable column of figures into a wall of two-line
 * cells. The table already scrolls; a few more pixels of width costs nothing.
 */
const NOWRAP = { whiteSpace: "nowrap" } as const;

function SessionRow({ s }: { s: SessionSummary }) {
  const theme = useTheme();
  const split = durationSplit(s.durationMs, s.activeMs);
  const splitLabel = durationSplitLabel(s.durationMs, s.activeMs);
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
      {/* One tooltip per duration cell, all three saying the same sentence: whichever
          of the columns the reader questions is the one under the pointer. */}
      <Tooltip title={splitLabel}>
        <TableCell align="right" sx={NOWRAP}>
          {formatDuration(s.durationMs)}
        </TableCell>
      </Tooltip>
      <Tooltip title={splitLabel}>
        <TableCell align="right" sx={NOWRAP}>
          {formatDuration(split.activeMs)}
        </TableCell>
      </Tooltip>
      <Tooltip title={splitLabel}>
        <TableCell align="right" sx={{ ...NOWRAP, color: "text.secondary" }}>
          {formatDuration(split.idleMs)}
        </TableCell>
      </Tooltip>
      <TableCell>
        <Tooltip title={s.cwd || ""}>
          <span>{projectName(s.cwd)}</span>
        </Tooltip>
      </TableCell>
      {/* Next to the project, because the pair is the answer to "where was this?" — the
          same project name on two machines is two different working copies. */}
      <TableCell sx={NOWRAP}>{s.hostname || "—"}</TableCell>
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
            {COLUMNS.map((column) => (
              <TableCell key={column.label} align={column.align}>
                {column.hint ? (
                  <Tooltip title={column.hint}>
                    <span>{column.label}</span>
                  </Tooltip>
                ) : (
                  column.label
                )}
              </TableCell>
            ))}
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
