/**
 * Sessions as a 9-column CSS grid with day grouping and infinite scroll.
 *
 * Columns: select | time | project+host+cwd | runtime+active bar | model | tool mix |
 * tokens+turns | status+when | id+copy+data links
 *
 * Below `md` the grid gives way to a compact two-line row (see `CompactRow`).
 */
import {
  Box,
  Checkbox,
  Chip,
  Collapse,
  IconButton,
  Stack,
  Tooltip,
  Typography,
  useTheme,
} from "@mui/material";
import { Link, useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import type { SessionSummary } from "../../api/generated";
import {
  durationSplit,
  durationSplitLabel,
  formatCompact,
  formatCount,
  formatDuration,
  projectName,
  statusTime,
  totalTools,
} from "../../format";
import type { DayGroup } from "../../sessions-view";
import { MONO } from "../../theme";
import { SessionIdCopy, SessionLinksButton } from "../SessionIdentity";
import { StatusChip } from "../StatusChip";
import { SessionRowDetails } from "./SessionRowDetails";

/**
 * Grid template for the 8 columns. The project column used to be a bare `1fr` and took
 * every spare pixel for a name and a path that rarely need it, while the tool mix
 * beside it was clipped to two chips. Now the two share the slack, and the host —
 * which says *where* the project ran — sits in the project cell instead of its own.
 */
const GRID_TEMPLATE =
  "28px 52px minmax(200px, 1.3fr) 128px minmax(110px, 160px) minmax(150px, 1fr) 108px 120px 156px";

/** How many tools the mix names before collapsing the rest into "+N". */
const TOOL_MIX_SHOWN = 3;

/** Clock time only — the day is stated by the group header. */
function timeOfDay(iso: string | undefined): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const pad = (x: number) => String(x).padStart(2, "0");
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** The most-used tools from toolCounts + overflow pill. */
function ToolMix({ toolCounts }: { toolCounts: Record<string, number> }) {
  const entries = Object.entries(toolCounts).sort((a, b) => b[1] - a[1]);
  if (entries.length === 0) return <Typography color="text.secondary">—</Typography>;
  const top = entries.slice(0, TOOL_MIX_SHOWN);
  const rest = entries.length - TOOL_MIX_SHOWN;
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

/**
 * Failed tool calls, as a link to the session. A real link (not just the row's click
 * handler) so it can be opened in a new tab and is reachable by keyboard.
 */
function ErrorCount({ sessionId, count }: { sessionId: string; count: number }) {
  return (
    <Tooltip
      title={`${formatCount(count)} failed tool call${count === 1 ? "" : "s"}: open the session`}
    >
      <Link
        to="/sessions/$id"
        params={{ id: sessionId }}
        onClick={(e) => e.stopPropagation()}
        style={{ textDecoration: "none", marginLeft: 14 }}
      >
        <Chip
          size="small"
          color="error"
          variant="outlined"
          label={`${formatCount(count)} err`}
          sx={{ height: 18, fontSize: 10, cursor: "pointer" }}
        />
      </Link>
    </Tooltip>
  );
}

/**
 * Which rows are selected, and how to change that. Toggling takes a list so a day
 * header or the column header can flip all of its rows at once.
 */
export interface RowSelection {
  selected: ReadonlySet<string>;
  onToggle: (sessionIds: string[], on: boolean) => void;
}

/**
 * A checkbox for one row or a set of them: checked when all are selected,
 * indeterminate when some are. Clicks stop here — the row underneath navigates.
 */
function SelectBox({
  ids,
  selection,
  label,
}: {
  ids: string[];
  selection: RowSelection;
  label: string;
}) {
  const count = ids.filter((id) => selection.selected.has(id)).length;
  const all = ids.length > 0 && count === ids.length;
  return (
    <Checkbox
      size="small"
      checked={all}
      indeterminate={count > 0 && !all}
      onClick={(e) => e.stopPropagation()}
      onChange={() => selection.onToggle(ids, !all)}
      slotProps={{ input: { "aria-label": label } }}
      sx={{ p: 0.25 }}
    />
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

/** The chevron that opens a row's details panel. */
function ExpandButton({ expanded, onToggle }: { expanded: boolean; onToggle: () => void }) {
  return (
    <Tooltip title={expanded ? "Hide details" : "Show details"}>
      <IconButton
        size="small"
        aria-label={expanded ? "Hide details" : "Show details"}
        onClick={(e) => {
          e.stopPropagation();
          onToggle();
        }}
        sx={{
          width: 24,
          height: 24,
          fontSize: 12,
          transition: "transform 150ms",
          transform: expanded ? "rotate(180deg)" : undefined,
        }}
      >
        ▾
      </IconButton>
    </Tooltip>
  );
}

/**
 * A session on a narrow screen, in two lines:
 *
 *   ☐ 13:55  atlas                    ● live  ⋯ ▾
 *            35m · 4.2M tokens · 3 turns · @ build-agent-01
 *
 * The grid stacked its cells into a centred column a whole screen tall per session,
 * so a phone showed one or two sessions at a time. This keeps what you scan for —
 * when, which project, whether it's still going — on the first line, and the size of
 * it on the second; the rest is in the details panel or on the detail page.
 */
function CompactRow({
  s,
  selection,
  expanded,
  onToggle,
}: {
  s: SessionSummary;
  selection: RowSelection;
  expanded: boolean;
  onToggle: () => void;
}) {
  const theme = useTheme();
  const facts = [
    formatDuration(s.durationMs),
    s.tokenUsage ? `${formatCompact(s.tokenUsage.total)} tokens` : null,
    `${formatCount(s.promptCount)} turn${s.promptCount === 1 ? "" : "s"}`,
    s.errorCount > 0 ? `${formatCount(s.errorCount)} err` : null,
    s.hostname ? `@ ${s.hostname}` : null,
  ].filter(Boolean);
  return (
    <Box
      sx={{
        display: { xs: "grid", md: "none" },
        gridTemplateColumns: "auto 44px minmax(0, 1fr) auto",
        columnGap: 1,
        alignItems: "center",
      }}
    >
      <SelectBox
        ids={[s.sessionId]}
        selection={selection}
        label={`Select session ${s.sessionId.slice(0, 8)}`}
      />
      <Typography variant="body2" sx={{ fontFamily: MONO, fontSize: 12 }}>
        {timeOfDay(s.startTimestamp ?? s.timestamp)}
      </Typography>
      <Typography
        variant="body2"
        noWrap
        sx={{ fontWeight: 600, color: theme.palette.primary.main, minWidth: 0 }}
      >
        {projectName(s.cwd)}
      </Typography>
      <Stack direction="row" alignItems="center" spacing={0.5}>
        <StatusChip status={s.status} />
        <SessionLinksButton session={s} />
        <ExpandButton expanded={expanded} onToggle={onToggle} />
      </Stack>
      <Typography
        variant="caption"
        color="text.secondary"
        noWrap
        sx={{ gridColumn: "3 / -1", minWidth: 0 }}
      >
        {facts.join(" · ")}
      </Typography>
    </Box>
  );
}

function SessionRow({ s, selection }: { s: SessionSummary; selection: RowSelection }) {
  const theme = useTheme();
  const navigate = useNavigate();
  const isSelected = selection.selected.has(s.sessionId);
  const [expanded, setExpanded] = useState(false);
  const toggle = () => setExpanded((x) => !x);
  return (
    <>
      <Box
        data-testid="session-row"
        aria-selected={isSelected}
        aria-expanded={expanded}
        onClick={() => navigate({ to: "/sessions/$id", params: { id: s.sessionId } })}
        sx={{
          px: 1.5,
          py: 1,
          cursor: "pointer",
          textDecoration: "none",
          color: "text.primary",
          borderBottom: 1,
          borderColor: "divider",
          bgcolor: isSelected ? "action.selected" : undefined,
          "&:hover": { bgcolor: isSelected ? "action.selected" : "action.hover" },
        }}
      >
        <CompactRow s={s} selection={selection} expanded={expanded} onToggle={toggle} />
        <Box
          sx={{
            display: { xs: "none", md: "grid" },
            gridTemplateColumns: GRID_TEMPLATE,
            gap: 1.5,
            alignItems: "center",
          }}
        >
          <SelectBox
            ids={[s.sessionId]}
            selection={selection}
            label={`Select session ${s.sessionId.slice(0, 8)}`}
          />

          {/* Time */}
          <Typography variant="body2" sx={{ fontFamily: MONO, fontSize: 12 }}>
            {timeOfDay(s.startTimestamp ?? s.timestamp)}
          </Typography>

          {/* Project + host + cwd */}
          <Box sx={{ minWidth: 0 }}>
            <Stack direction="row" alignItems="baseline" spacing={1} sx={{ minWidth: 0 }}>
              <Typography
                variant="body2"
                noWrap
                sx={{
                  fontWeight: 600,
                  color: theme.palette.primary.main,
                  flexShrink: 0,
                  maxWidth: "70%",
                }}
              >
                {projectName(s.cwd)}
              </Typography>
              {s.hostname && (
                <Tooltip title={`Host: ${s.hostname}`}>
                  <Typography variant="caption" color="text.secondary" noWrap sx={{ minWidth: 0 }}>
                    @ {s.hostname}
                  </Typography>
                </Tooltip>
              )}
            </Stack>
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

          {/* Model */}
          <Typography
            variant="caption"
            color="text.secondary"
            noWrap
            sx={{ display: { xs: "none", sm: "block" }, minWidth: 0 }}
          >
            {s.model ?? "—"}
          </Typography>

          {/* Tool mix — hidden below md */}
          <Box sx={{ display: { xs: "none", md: "block" }, minWidth: 0 }}>
            <ToolMix toolCounts={s.toolCounts} />
          </Box>

          {/* Tokens + turns */}
          <Box sx={{ textAlign: "right" }}>
            {s.tokenUsage ? (
              <Tooltip title={`${formatCount(s.tokenUsage.total)} tokens`}>
                <Typography variant="body2" sx={{ fontFamily: MONO, fontSize: 12 }}>
                  {formatCompact(s.tokenUsage.total)}
                </Typography>
              </Tooltip>
            ) : (
              <Typography variant="body2" sx={{ fontFamily: MONO, fontSize: 12 }}>
                —
              </Typography>
            )}
            <Typography variant="caption" color="text.secondary">
              {formatCount(s.promptCount)} turn{s.promptCount === 1 ? "" : "s"} ·{" "}
              {formatCount(totalTools(s.toolCounts))} tools
            </Typography>
          </Box>

          {/* Status + when, and how many tool calls failed. The error count used to sit
          under the token figures, where it read as a property of the tokens. */}
          <Stack alignItems="flex-start" spacing={0.25} sx={{ minWidth: 0 }}>
            <StatusChip status={s.status} at={statusTime(s)} reference={s.startTimestamp} />
            {s.errorCount > 0 && <ErrorCount sessionId={s.sessionId} count={s.errorCount} />}
          </Stack>

          {/* Session id + copy + data links */}
          <Stack direction="row" alignItems="center" spacing={0.25} sx={{ justifySelf: "end" }}>
            <SessionIdCopy sessionId={s.sessionId} />
            <SessionLinksButton session={s} />
            <ExpandButton expanded={expanded} onToggle={toggle} />
          </Stack>
        </Box>
      </Box>
      <Collapse in={expanded} unmountOnExit>
        <SessionRowDetails s={s} />
      </Collapse>
    </>
  );
}

/** Day group header with rollup stats. */
function DayHeader({
  group,
  selection,
}: {
  group: DayGroup<SessionSummary>;
  selection: RowSelection;
}) {
  const date = new Date(group.dayStart);
  const activeMs = group.items.reduce((sum, s) => sum + (s.activeMs ?? 0), 0);
  const tokens = group.items.reduce((sum, s) => sum + (s.tokenUsage?.total ?? 0), 0);

  return (
    <Stack
      direction="row"
      spacing={1}
      alignItems="center"
      sx={{ px: 1.5, py: 1, bgcolor: "action.hover", borderBottom: 1, borderColor: "divider" }}
    >
      <SelectBox
        ids={group.items.map((s) => s.sessionId)}
        selection={selection}
        label={`Select every session on ${date.toDateString()}`}
      />
      <Typography variant="subtitle2" sx={{ fontWeight: 700 }}>
        {date.toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short" })}
      </Typography>
      <Typography variant="caption" color="text.secondary">
        {date.getFullYear()}
      </Typography>
      <Typography variant="caption" color="text.secondary">
        {group.items.length} session{group.items.length === 1 ? "" : "s"}
        {activeMs > 0 && ` · ${formatDuration(activeMs)} active`}
        {tokens > 0 && ` · ${formatCompact(tokens)} tokens`}
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
export function SessionsListHeader({
  sessionIds,
  selection,
}: {
  /** Every loaded row, which the header checkbox selects or clears in one go. */
  sessionIds: string[];
  selection: RowSelection;
}) {
  return (
    <Box
      sx={{
        display: { xs: "none", md: "grid" },
        gridTemplateColumns: GRID_TEMPLATE,
        alignItems: "center",
        gap: 1.5,
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
      <SelectBox ids={sessionIds} selection={selection} label="Select every loaded session" />
      <HeaderLabel>Time</HeaderLabel>
      <HeaderLabel>Project · Host</HeaderLabel>
      <HeaderLabel>Runtime</HeaderLabel>
      <HeaderLabel>Model</HeaderLabel>
      <HeaderLabel>Tools</HeaderLabel>
      <HeaderLabel align="right">Tokens</HeaderLabel>
      <HeaderLabel>Status</HeaderLabel>
      <HeaderLabel align="right">Session</HeaderLabel>
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

export function SessionsList({
  dayGroups,
  selection,
}: {
  dayGroups: DayGroup<SessionSummary>[];
  selection: RowSelection;
}) {
  return (
    <Box
      data-testid="sessions-list"
      sx={{ border: 1, borderColor: "divider", borderRadius: 1, bgcolor: "background.paper" }}
    >
      {dayGroups.map((group) => (
        <Box key={group.key}>
          <DayHeader group={group} selection={selection} />
          {group.items.map((s) => (
            <SessionRow key={s.sessionId} s={s} selection={selection} />
          ))}
        </Box>
      ))}
    </Box>
  );
}
