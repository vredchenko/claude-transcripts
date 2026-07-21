import {
  Box,
  Button,
  Paper,
  Stack,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow,
  Tooltip,
  Typography,
} from "@mui/material";
import { Link } from "@tanstack/react-router";
import { useState } from "react";
import { type SessionSummary, useListSessions } from "../api/generated";
import { StatusChip } from "../components/StatusChip";
import { EmptyState, ErrorState, Loading } from "../components/states";
import { formatBytes, formatCount, formatTimestamp, projectName, totalTools } from "../format";
import { MONO } from "../theme";

const PAGE = 50;

function SessionRow({ s }: { s: SessionSummary }) {
  return (
    <TableRow hover>
      <TableCell>
        <Link to="/sessions/$id" params={{ id: s.sessionId }} style={{ color: "#58a6ff" }}>
          <Typography component="span" sx={{ fontFamily: MONO, fontSize: 13 }}>
            {s.sessionId.slice(0, 8)}
          </Typography>
        </Link>
      </TableCell>
      <TableCell>{formatTimestamp(s.timestamp)}</TableCell>
      <TableCell>
        <Tooltip title={s.cwd || ""}>
          <span>{projectName(s.cwd)}</span>
        </Tooltip>
      </TableCell>
      <TableCell>{s.model ?? "—"}</TableCell>
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

/** Root route: the paginated session list. */
export function SessionsListPage() {
  const [skip, setSkip] = useState(0);
  const { data, isPending, isError, error, isPlaceholderData } = useListSessions(
    { limit: PAGE, skip },
    { placeholderData: (prev) => prev },
  );

  if (isPending) return <Loading label="Loading sessions…" />;
  if (isError) return <ErrorState error={error} />;

  const sessions = data?.sessions ?? [];
  const total = data?.totalCount ?? sessions.length;
  const hasMore = skip + PAGE < total;

  return (
    <Box>
      <Stack direction="row" alignItems="baseline" justifyContent="space-between" sx={{ mb: 2 }}>
        <Typography variant="h5">Sessions</Typography>
        <Typography color="text.secondary" variant="body2">
          {formatCount(total)} total
        </Typography>
      </Stack>

      {sessions.length === 0 ? (
        <EmptyState>No sessions recorded yet.</EmptyState>
      ) : (
        <TableContainer component={Paper} sx={{ opacity: isPlaceholderData ? 0.6 : 1 }}>
          <Table size="small" stickyHeader>
            <TableHead>
              <TableRow>
                <TableCell>Session</TableCell>
                <TableCell>Started</TableCell>
                <TableCell>Project</TableCell>
                <TableCell>Model</TableCell>
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
      )}

      <Stack direction="row" spacing={2} justifyContent="center" alignItems="center" sx={{ mt: 2 }}>
        <Button
          disabled={skip === 0 || isPlaceholderData}
          onClick={() => setSkip((n) => Math.max(0, n - PAGE))}
        >
          Previous
        </Button>
        <Typography variant="body2" color="text.secondary">
          {formatCount(skip + 1)}–{formatCount(Math.min(skip + PAGE, total))}
        </Typography>
        <Button disabled={!hasMore || isPlaceholderData} onClick={() => setSkip((n) => n + PAGE)}>
          Next
        </Button>
      </Stack>
    </Box>
  );
}
