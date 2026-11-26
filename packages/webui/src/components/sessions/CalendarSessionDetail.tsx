/**
 * What the calendar shows of one session beyond its bar: a hover card with the figures
 * that matter at a glance, and a side panel, opened by clicking the bar, with everything
 * the list's expanded row has. The panel leaves the calendar where it was, so you can
 * click through a day's sessions without losing your place in a long scroll.
 */
import { Box, Button, Drawer, IconButton, Stack, Tooltip, Typography } from "@mui/material";
import { useEffect, useState } from "react";
import type { SessionSummary } from "../../api/generated";
import { type DaylightPlace, daylightShare } from "../../daylight";
import {
  clockTime,
  formatCompact,
  formatCount,
  formatDuration,
  modelsLabel,
  projectName,
  resumeCommand,
  statusTime,
  totalTools,
} from "../../format";
import type { Interval } from "../../sessions-view";
import { MONO } from "../../theme";
import { SessionIdCopy, SessionLinksButton } from "../SessionIdentity";
import { StatusChip } from "../StatusChip";
import { SessionRowDetails } from "./SessionRowDetails";

/** The panel's width from `sm` up; below that it takes the whole screen. */
export const PANEL_WIDTH = 440;

/**
 * The hover card's surface: a card rather than Material's translucent grey tooltip,
 * which is hard to read over the coloured lanes at this much text.
 */
export const HOVER_CARD_SX = {
  maxWidth: 340,
  bgcolor: "background.paper",
  color: "text.primary",
  border: 1,
  borderColor: "divider",
  boxShadow: 4,
  p: 1.25,
} as const;

/** The hover card's content: who, when, how much, and how much of it was in daylight. */
export function SessionHoverCard({
  session: s,
  interval,
  place,
}: {
  session: SessionSummary;
  interval: Interval;
  place: DaylightPlace | undefined;
}) {
  const start = s.startTimestamp ?? s.timestamp;
  const end = statusTime(s)?.iso;
  const light = place ? daylightShare(interval.start, interval.end, place.location) : undefined;
  const line = (text: string, color = "text.secondary") => (
    <Typography variant="caption" component="div" sx={{ color, lineHeight: 1.5 }}>
      {text}
    </Typography>
  );
  return (
    <Box sx={{ py: 0.25 }}>
      <Typography variant="body2" sx={{ fontWeight: 600 }}>
        {projectName(s.cwd)}
        <Box component="span" sx={{ fontWeight: 400, color: "text.secondary" }}>
          {" "}
          @ {s.hostname}
        </Box>
      </Typography>
      <Typography
        variant="caption"
        component="div"
        sx={{ fontFamily: MONO, color: "text.secondary", overflowWrap: "anywhere" }}
      >
        {s.cwd}
      </Typography>
      <Box sx={{ mt: 0.75 }}>
        {line(
          `${clockTime(start)} → ${end ? clockTime(end, start) : "now"} · ${formatDuration(s.durationMs)}` +
            (s.activeMs !== undefined ? ` (${formatDuration(s.activeMs)} active)` : ""),
          "text.primary",
        )}
        {line(
          [
            // A live session has no token count until its summary is written.
            s.tokenUsage ? `${formatCompact(s.tokenUsage.total)} tokens` : null,
            `${formatCount(s.promptCount)} turns`,
            `${formatCount(totalTools(s.toolCounts))} tools`,
          ]
            .filter(Boolean)
            .join(" · "),
        )}
        {s.errorCount > 0 &&
          line(`${formatCount(s.errorCount)} error${s.errorCount === 1 ? "" : "s"}`, "error.main")}
        {line(modelsLabel(s))}
        {light !== undefined && line(`${Math.round(light * 100)}% in daylight`)}
        {s.status !== "ended" && line(s.status === "running" ? "Still running" : "Incomplete")}
      </Box>
      <Typography variant="caption" component="div" sx={{ mt: 0.75, color: "text.secondary" }}>
        Click for details
      </Typography>
    </Box>
  );
}

function CopyResumeButton({ session }: { session: SessionSummary }) {
  const [copied, setCopied] = useState(false);
  const command = resumeCommand(session);
  return (
    <Tooltip title={<Box sx={{ fontFamily: MONO, fontSize: 11 }}>{command}</Box>}>
      <Button
        size="small"
        variant="outlined"
        color={copied ? "success" : "primary"}
        onClick={() => {
          navigator.clipboard.writeText(command);
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        }}
      >
        {copied ? "Copied" : "Copy resume command"}
      </Button>
    </Tooltip>
  );
}

/**
 * The side panel for the selected session. Not modal: the calendar stays scrollable and
 * clickable behind it, and clicking another bar swaps what it shows. Escape closes it.
 */
export function SessionDetailPanel({
  session,
  onClose,
}: {
  session: SessionSummary | undefined;
  onClose: () => void;
}) {
  useEffect(() => {
    if (!session) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [session, onClose]);

  return (
    <Drawer
      variant="persistent"
      anchor="right"
      open={session !== undefined}
      slotProps={{
        paper: {
          "aria-label": "Session details",
          // Below the app bar from `sm` up, as the page's sticky headers are; on a phone
          // the panel takes the screen and brings its own close button.
          sx: {
            width: { xs: "100%", sm: PANEL_WIDTH },
            top: { xs: 0, sm: 49 },
            height: { xs: "100%", sm: "calc(100% - 49px)" },
            borderLeft: 1,
            borderColor: "divider",
          },
        },
      }}
    >
      {session && (
        <Box data-testid="calendar-session-panel">
          <Stack
            direction="row"
            alignItems="flex-start"
            spacing={1}
            sx={{ px: 1.5, pt: 1.5, pb: 1 }}
          >
            <Box sx={{ flex: 1, minWidth: 0 }}>
              <Typography variant="subtitle1" sx={{ fontWeight: 600, lineHeight: 1.3 }}>
                {projectName(session.cwd)}
              </Typography>
              <Typography variant="caption" color="text.secondary">
                @ {session.hostname}
              </Typography>
            </Box>
            <StatusChip
              status={session.status}
              at={statusTime(session)}
              reference={session.startTimestamp ?? session.timestamp}
            />
            <IconButton size="small" aria-label="Close session details" onClick={onClose}>
              ✕
            </IconButton>
          </Stack>
          <Stack
            direction="row"
            alignItems="center"
            spacing={1}
            sx={{ px: 1.5, pb: 1.5, flexWrap: "wrap", rowGap: 1 }}
          >
            <SessionIdCopy sessionId={session.sessionId} />
            <SessionLinksButton session={session} />
            <CopyResumeButton session={session} />
          </Stack>
          <SessionRowDetails s={session} narrow />
        </Box>
      )}
    </Drawer>
  );
}
