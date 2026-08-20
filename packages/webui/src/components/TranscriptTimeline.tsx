/**
 * The conversation reader: dialogue on a timeline, machinery folded away.
 *
 * The raw list renders one row per stored line, which is honest and nearly unreadable —
 * in a real transcript the prompts and replies are a minority of the lines. This view
 * keeps the same entries in the same order but gives the screen to the two things a
 * person came to read: what was asked, and what was answered. Everything between them
 * collapses to a single line naming the tools that ran, and opens in place to the exact
 * rows the raw list would have shown.
 *
 * The folding decisions are in `transcript-timeline.ts`; this file only draws them.
 */
import { Box, Button, Chip, Collapse, Stack, Typography, useTheme } from "@mui/material";
import { useEffect, useRef, useState } from "react";
import type { TranscriptEntry } from "../api/generated";
import { formatCount, formatDuration } from "../format";
import { MONO } from "../theme";
import {
  formatTally,
  type HiddenNode,
  hiddenCount,
  summarizeHidden,
  type TimelineNode,
  type TurnNode,
} from "../transcript-timeline";
import { TermHighlight } from "./HighlightedText";
import { TranscriptEntryRow, useScrollToMatch } from "./TranscriptEntryRow";

/** Below this, "0s later" is noise: turns in the same exchange are seconds apart. */
const GAP_FLOOR_MS = 60_000;

/** Collapsed height of a turn, in lines. Roughly a screenful of a long reply. */
const CLAMP_LINES = 14;

/** The vertical rule the markers sit on — the same spine the session list uses. */
const SPINE_SX = {
  position: "relative",
  pl: 3,
  "&::before": {
    content: '""',
    position: "absolute",
    left: 5,
    top: 0,
    bottom: 0,
    width: "2px",
    bgcolor: "divider",
  },
} as const;

/** Speaker dot: filled for a turn, hollow for a fold, so the eye skips the folds. */
function Marker({ variant }: { variant: "user" | "assistant" | "hidden" }) {
  const theme = useTheme();
  const size = variant === "hidden" ? 7 : 11;
  const color =
    variant === "user"
      ? theme.palette.info.main
      : variant === "assistant"
        ? theme.palette.primary.main
        : theme.palette.divider;
  return (
    <Box
      sx={{
        width: size,
        height: size,
        borderRadius: "50%",
        bgcolor: variant === "hidden" ? "transparent" : color,
        border: variant === "hidden" ? `2px solid ${color}` : "none",
        flexShrink: 0,
        // Nudge each dot onto the spine's centreline; the two sizes need different
        // offsets, and the left inset keeps both centred on the 2px rule.
        mt: variant === "hidden" ? 1.25 : 0.9,
        ml: variant === "hidden" ? "2px" : 0,
        // A ring in the page background separates the dot from the spine it sits on.
        boxShadow: (t) => `0 0 0 3px ${t.palette.background.default}`,
        zIndex: 1,
      }}
    />
  );
}

/** Clock time only — the session's date is stated once, at the top of the page. */
function timeOfDay(iso: string | undefined): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const pad = (x: number) => String(x).padStart(2, "0");
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/**
 * Turn text, clamped to {@link CLAMP_LINES} until asked otherwise.
 *
 * Measured rather than guessed: a turn is long when the browser says the clamped box
 * overflows, which is the only definition that survives a narrow window, a large font
 * or a wall of code. Turns that fit get no control at all.
 */
function TurnText({ text, query }: { text: string; query?: string }) {
  const ref = useRef<HTMLDivElement | null>(null);
  const [expanded, setExpanded] = useState(false);
  const [overflows, setOverflows] = useState(false);

  useEffect(() => {
    const el = ref.current;
    if (!el || expanded) return;
    const check = () => setOverflows(el.scrollHeight - el.clientHeight > 4);
    check();
    // Re-measure on resize: a turn that fits a wide window overflows a narrow one, and
    // the control has to appear and disappear with it.
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(check);
    ro.observe(el);
    return () => ro.disconnect();
  }, [expanded]);

  return (
    <Box>
      <Typography
        ref={ref}
        variant="body2"
        sx={{
          whiteSpace: "pre-wrap",
          overflowWrap: "anywhere",
          // A measure this side of ~90 characters is what makes a wall of text
          // readable; the card itself still spans the page.
          maxWidth: "90ch",
          ...(expanded
            ? {}
            : {
                display: "-webkit-box",
                WebkitBoxOrient: "vertical",
                WebkitLineClamp: CLAMP_LINES,
                overflow: "hidden",
              }),
        }}
      >
        <TermHighlight text={text} query={query} />
      </Typography>
      {(overflows || expanded) && (
        <Button size="small" sx={{ mt: 0.5, px: 0.5 }} onClick={() => setExpanded((v) => !v)}>
          {expanded ? "Show less" : "Show more"}
        </Button>
      )}
    </Box>
  );
}

/** "12m later" between turns, so a pause in the conversation is visible as one. */
function Elapsed({ ms }: { ms: number }) {
  return (
    <Typography
      variant="caption"
      color="text.secondary"
      sx={{ display: "block", fontStyle: "italic", mb: 0.5 }}
    >
      {formatDuration(ms)} later
    </Typography>
  );
}

function TurnCard({ node, query, isMatch }: { node: TurnNode; query?: string; isMatch: boolean }) {
  const theme = useTheme();
  const ref = useScrollToMatch(isMatch);
  const isUser = node.speaker === "user";

  return (
    <Box ref={ref} data-testid="timeline-turn" data-speaker={node.speaker}>
      {node.sincePrevMs !== undefined && node.sincePrevMs >= GAP_FLOOR_MS && (
        <Elapsed ms={node.sincePrevMs} />
      )}
      <Stack direction="row" spacing={1.5} alignItems="flex-start">
        <Marker variant={node.speaker} />
        <Box
          sx={{
            flex: 1,
            minWidth: 0,
            p: 1.5,
            borderRadius: 1,
            border: 1,
            borderColor: "divider",
            // The prompt is the thing a reader scans for, so it gets the tint and the
            // coloured edge; Claude's replies are the bulk of the text and stay plain.
            bgcolor: isUser ? "action.hover" : "background.paper",
            borderLeft: 3,
            borderLeftColor: isUser ? "info.main" : "primary.main",
            ...(isMatch
              ? { outline: `2px solid ${theme.palette.warning.main}`, outlineOffset: -2 }
              : {}),
          }}
        >
          <Stack
            direction="row"
            spacing={1}
            alignItems="center"
            sx={{ mb: 0.5, flexWrap: "wrap", gap: 0.5 }}
          >
            <Typography variant="caption" sx={{ fontWeight: 700 }}>
              {isUser ? "You" : "Claude"}
            </Typography>
            <Typography variant="caption" color="text.secondary" sx={{ fontFamily: MONO }}>
              {timeOfDay(node.timestamp)}
            </Typography>
            {node.sidechain && <Chip size="small" variant="outlined" label="subagent" />}
            <Box sx={{ flex: 1 }} />
            <Typography variant="caption" color="text.secondary" sx={{ fontFamily: MONO }}>
              #{node.index}
            </Typography>
          </Stack>

          <TurnText text={node.text} query={query} />

          {/* Tools the turn itself called. The results are folded into the next run;
              naming the calls here is what connects the prose to it. */}
          {node.tools.length > 0 && (
            <Stack direction="row" spacing={0.5} sx={{ mt: 1, flexWrap: "wrap", gap: 0.5 }}>
              {node.tools.map((t) => (
                <Chip key={t.name} size="small" variant="outlined" label={`⚙ ${formatTally(t)}`} />
              ))}
            </Stack>
          )}
        </Box>
      </Stack>
    </Box>
  );
}

/**
 * A folded run of everything that wasn't dialogue: one quiet line that says what
 * happened, opening in place to the raw rows.
 */
function HiddenRun({
  node,
  query,
  matchIndex,
}: {
  node: HiddenNode;
  query?: string;
  /** Entry index of the search match inside this run, or -1. Opens the run. */
  matchIndex: number;
}) {
  const [open, setOpen] = useState(matchIndex >= 0);
  const count = hiddenCount(node);
  const summary = summarizeHidden(node);

  return (
    <Stack direction="row" spacing={1.5} alignItems="flex-start">
      <Marker variant="hidden" />
      <Box sx={{ flex: 1, minWidth: 0 }}>
        <Stack
          component="button"
          type="button"
          direction="row"
          spacing={1}
          alignItems="center"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
          data-testid="timeline-fold"
          aria-label={`${formatCount(count)} folded line${count === 1 ? "" : "s"}: ${summary}`}
          sx={{
            width: "100%",
            minWidth: 0,
            px: 1,
            py: 0.25,
            border: 0,
            borderRadius: 1,
            bgcolor: "transparent",
            color: "text.secondary",
            cursor: "pointer",
            textAlign: "left",
            font: "inherit",
            "&:hover": { bgcolor: "action.hover" },
          }}
        >
          <Typography variant="caption" sx={{ fontFamily: MONO, flexShrink: 0 }}>
            {open ? "⌄" : "›"} {formatCount(count)} line{count === 1 ? "" : "s"}
          </Typography>
          <Typography
            variant="caption"
            sx={{
              flex: 1,
              minWidth: 0,
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
          >
            {summary}
          </Typography>
          {node.errorCount > 0 && (
            <Chip
              size="small"
              color="error"
              variant="outlined"
              label={`${node.errorCount} error${node.errorCount === 1 ? "" : "s"}`}
            />
          )}
        </Stack>
        <Collapse in={open} unmountOnExit>
          <Stack spacing={0.5} sx={{ my: 0.5 }}>
            {node.entries.map(({ index, entry }: { index: number; entry: TranscriptEntry }) => (
              <TranscriptEntryRow
                key={index}
                entry={entry}
                index={index}
                query={query}
                isFirstMatch={index === matchIndex}
              />
            ))}
          </Stack>
        </Collapse>
      </Box>
    </Stack>
  );
}

export function TranscriptTimeline({
  nodes,
  query,
  firstMatch,
}: {
  nodes: TimelineNode[];
  query?: string;
  /** Entry index the search sent us to, or -1. */
  firstMatch: number;
}) {
  return (
    <Stack spacing={1} sx={SPINE_SX} data-testid="transcript-timeline">
      {nodes.map((node) =>
        node.type === "turn" ? (
          <TurnCard
            key={`t${node.index}`}
            node={node}
            query={query}
            isMatch={node.index === firstMatch}
          />
        ) : (
          <HiddenRun
            key={`h${node.index}`}
            node={node}
            query={query}
            matchIndex={node.entries.some((e) => e.index === firstMatch) ? firstMatch : -1}
          />
        ),
      )}
    </Stack>
  );
}
