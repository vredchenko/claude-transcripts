/**
 * Sessions as an 8-column CSS grid with day grouping and infinite scroll.
 *
 * Columns: time | project+cwd | runtime+active bar | host+model | tool mix |
 * tokens+turns | status | copy
 */
import { Box, Chip, IconButton, Stack, Tooltip, Typography, useTheme } from "@mui/material";
import { useNavigate } from "@tanstack/react-router";
import { useCallback, useState } from "react";
import type { SessionSummary } from "../../api/generated";
import {
  durationSplit,
  durationSplitLabel,
  formatCount,
  formatDuration,
  projectName,
  totalTools,
} from "../../format";
import type { DayGroup } from "../../sessions-view";
import { MONO } from "../../theme";
import { StatusChip } from "../StatusChip";

/** Grid template for the 8 columns. */
const GRID_TEMPLATE = "60px 1fr 150px 118px 128px 104px 84px 30px";

/** Clock time only — the day is stated by the group header. */
function timeOfDay(iso: string | undefined): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const pad = (x: number) => String(x).padStart(2, "0");
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** Top-2 tools from toolCounts + overflow pill. */
function ToolMix({ toolCounts }: { toolCounts: Record<string, number> }) {
  const entries = Object.entries(toolCounts).sort((a, b) => b[1] - a[1]);
  if (entries.length === 0) return <Typography color="text.secondary">—</Typography>;
  const top = entries.slice(0, 2);
  const rest = entries.length - 2;
  return (
    <Stack direction="row" spacing={0.5} sx={{ flexWrap: "wrap", gap: 0.25 }}>
      {top.map(([name, count]) => (
        <Chip
          key={name}
          size="small"
          variant="outlined"
          label={`${name} ${formatCount(count)}`}
          sx={{ fontSize: 10, height: 20 }}
        />
      ))}
      {rest > 0 && (
        <Chip
          size="small"
          variant="outlined"
          label={`+${rest}`}
          sx={{ fontSize: 10, height: 20 }}
        />
      )}
    </Stack>
  );
}

/** Active/idle progress bar. */
function ActiveBar({ durationMs, activeMs }: { durationMs?: number; activeMs?: number }) {
  const split = durationSplit(durationMs, activeMs);
  if (split.totalMs <= 0) return null;
  const pct = split.activePct ?? 100;
  return (
    <Tooltip title={durationSplitLabel(durationMs, activeMs)}>
      <Box sx={{ display: "flex", height: 4, borderRadius: 2, overflow: "hidden", width: "100%" }}>
        <Box sx={{ width: `${pct}%`, bgcolor: "primary.main", opacity: 0.85 }} />
        <Box sx={{ flex: 1, bgcolor: "primary.main", opacity: 0.2 }} />
      </Box>
    </Tooltip>
  );
}

function SessionRow({ s }: { s: SessionSummary }) {
  const theme = useTheme();
  const navigate = useNavigate();
  const [copied, setCopied] = useState(false);

  const copyId = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      e.stopPropagation();
      navigator.clipboard.writeText(s.sessionId);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    },
    [s.sessionId],
  );

  return (
    <Box
      data-testid="session-row"
      onClick={() => navigate({ to: "/sessions/$id", params: { id: s.sessionId } })}
      sx={{
        display: { xs: "flex", md: "grid" },
        flexDirection: { xs: "column", md: undefined },
        gridTemplateColumns: { md: GRID_TEMPLATE },
        gap: { xs: 0.5, md: 1 },
        alignItems: "center",
        px: 1.5,
        py: 1,
        cursor: "pointer",
        textDecoration: "none",
        color: "text.primary",
        borderBottom: 1,
        borderColor: "divider",
        "&:hover": { bgcolor: "action.hover" },
      }}
    >
      {/* Time */}
      <Typography variant="body2" sx={{ fontFamily: MONO, fontSize: 12 }}>
        {timeOfDay(s.startTimestamp ?? s.timestamp)}
      </Typography>

      {/* Project + cwd */}
      <Box sx={{ minWidth: 0 }}>
        <Typography
          variant="body2"
          sx={{
            fontWeight: 600,
            color: theme.palette.primary.main,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
        >
          {projectName(s.cwd)}
        </Typography>
        <Tooltip title={s.cwd}>
          <Typography
            variant="caption"
            color="text.secondary"
            sx={{
              fontFamily: MONO,
              fontSize: 10,
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
              display: "block",
            }}
          >
            {s.cwd}
          </Typography>
        </Tooltip>
      </Box>

      {/* Runtime + active bar */}
      <Box>
        <Typography variant="body2" sx={{ fontFamily: MONO, fontSize: 12 }}>
          {formatDuration(s.durationMs)}
        </Typography>
        <ActiveBar durationMs={s.durationMs} activeMs={s.activeMs} />
      </Box>

      {/* Host + model */}
      <Box sx={{ minWidth: 0, display: { xs: "none", sm: "block" } }}>
        <Typography
          variant="caption"
          sx={{
            display: "block",
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
        >
          {s.hostname || "—"}
        </Typography>
        <Typography
          variant="caption"
          color="text.secondary"
          sx={{
            display: "block",
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
        >
          {s.model ?? "—"}
        </Typography>
      </Box>

      {/* Tool mix — hidden below md */}
      <Box sx={{ display: { xs: "none", md: "block" }, minWidth: 0 }}>
        <ToolMix toolCounts={s.toolCounts} />
      </Box>

      {/* Tokens + turns */}
      <Box sx={{ textAlign: "right" }}>
        <Typography variant="body2" sx={{ fontFamily: MONO, fontSize: 12 }}>
          {s.tokenUsage ? formatCount(s.tokenUsage.total) : "—"}
        </Typography>
        <Typography variant="caption" color="text.secondary">
          {formatCount(s.promptCount)} turn{s.promptCount === 1 ? "" : "s"} ·{" "}
          {formatCount(totalTools(s.toolCounts))} tools
        </Typography>
        {s.errorCount > 0 && (
          <Chip
            size="small"
            color="error"
            label={`${s.errorCount} err`}
            sx={{ ml: 0.5, height: 18, fontSize: 10 }}
          />
        )}
      </Box>

      {/* Status */}
      <StatusChip status={s.status} />

      {/* Copy */}
      <Tooltip title={copied ? "Copied!" : "Copy session ID"}>
        <IconButton size="small" onClick={copyId} sx={{ fontSize: 14 }}>
          {copied ? "✓" : "⎘"}
        </IconButton>
      </Tooltip>
    </Box>
  );
}

/** Day group header with rollup stats. */
function DayHeader({ group }: { group: DayGroup<SessionSummary> }) {
  const date = new Date(group.dayStart);
  const activeMs = group.items.reduce((sum, s) => sum + (s.activeMs ?? 0), 0);
  const tokens = group.items.reduce((sum, s) => sum + (s.tokenUsage?.total ?? 0), 0);

  return (
    <Stack
      direction="row"
      spacing={1}
      alignItems="baseline"
      sx={{ px: 1.5, py: 1, bgcolor: "action.hover", borderBottom: 1, borderColor: "divider" }}
    >
      <Typography variant="subtitle2" sx={{ fontWeight: 700 }}>
        {date.toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short" })}
      </Typography>
      <Typography variant="caption" color="text.secondary">
        {date.getFullYear()}
      </Typography>
      <Typography variant="caption" color="text.secondary">
        {group.items.length} session{group.items.length === 1 ? "" : "s"}
        {activeMs > 0 && ` · ${formatDuration(activeMs)} active`}
        {tokens > 0 && ` · ${formatCount(tokens)} tokens`}
      </Typography>
    </Stack>
  );
}

/**
 * Column header bar.
 *
 * The labels are inert. They were briefly clickable, sorting the loaded rows — but
 * the list is grouped by day and `groupByDay` re-sorts every group by start
 * time, so the chosen order was thrown away before it reached the screen: the arrow
 * moved and the rows did not. A sort that only reordered the pages already fetched
 * would have been misleading anyway, with the next page arriving underneath it in
 * server order. Rather than keep a control that lies, the list has one order —
 * newest first — and the headers say what the columns are.
 */
export function SessionsListHeader() {
  return (
    <Box
      sx={{
        display: { xs: "none", md: "grid" },
        gridTemplateColumns: GRID_TEMPLATE,
        gap: 1,
        px: 1.5,
        py: 0.75,
        borderBottom: 2,
        borderColor: "divider",
        bgcolor: "background.paper",
        position: "sticky",
        top: 0,
        zIndex: 1,
      }}
    >
      <HeaderLabel>Time</HeaderLabel>
      <HeaderLabel>Project</HeaderLabel>
      <HeaderLabel>Runtime</HeaderLabel>
      <HeaderLabel>Host / Model</HeaderLabel>
      <HeaderLabel>Tools</HeaderLabel>
      <HeaderLabel align="right">Tokens</HeaderLabel>
      <HeaderLabel>Status</HeaderLabel>
      <Box />
    </Box>
  );
}

function HeaderLabel({ children, align }: { children: React.ReactNode; align?: "right" }) {
  return (
    <Typography variant="caption" color="text.secondary" sx={{ textAlign: align }}>
      {children}
    </Typography>
  );
}

export function SessionsList({ dayGroups }: { dayGroups: DayGroup<SessionSummary>[] }) {
  return (
    <Box
      data-testid="sessions-list"
      sx={{ border: 1, borderColor: "divider", borderRadius: 1, bgcolor: "background.paper" }}
    >
      {dayGroups.map((group) => (
        <Box key={group.key}>
          <DayHeader group={group} />
          {group.items.map((s) => (
            <SessionRow key={s.sessionId} s={s} />
          ))}
        </Box>
      ))}
    </Box>
  );
}
