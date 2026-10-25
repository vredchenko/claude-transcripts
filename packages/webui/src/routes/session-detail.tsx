/**
 * `/sessions/$id` — session detail page.
 *
 * Identity bar: back link, project name, 8-char id + copy, status, an "Open in…" menu
 * of links to the raw data, export.
 * Metadata strip: horizontal scroll row of fields.
 * Transcript section: speaker filter toggle (Both/User/Claude) + transcript viewer.
 */
import {
  Box,
  Button,
  Chip,
  Menu,
  MenuItem,
  Stack,
  ToggleButton,
  ToggleButtonGroup,
  Typography,
  useTheme,
} from "@mui/material";
import { Link, useNavigate, useParams, useSearch as useRouterSearch } from "@tanstack/react-router";
import { type ReactNode, useState } from "react";
import { useAppBlueprint } from "../api/blueprint";
import { useGetSession } from "../api/generated";
import { ApiRequestError } from "../api/http";
import { ExportMenu } from "../components/ExportMenu";
import { DeleteSessionButton, SessionIdCopy } from "../components/SessionIdentity";
import { SpeakerTurnsView } from "../components/SpeakerTurnsView";
import { StatusChip } from "../components/StatusChip";
import { EmptyState, ErrorState, Loading } from "../components/states";
import { type TranscriptMode, TranscriptView } from "../components/TranscriptView";
import {
  durationSplit,
  formatBytes,
  formatCount,
  formatDuration,
  formatTimestamp,
  projectName,
  statusTime,
  totalTools,
} from "../format";
import { useDocumentTitle } from "../hooks/useDocumentTitle";
import { type NavLink, sessionLinks } from "../nav-menus";
import { MONO } from "../theme";

type SpeakerFilter = "all" | "user" | "assistant";

/** Query-string state this route owns. */
export interface SessionDetailSearch {
  q?: string;
}

/** One labelled fact in the metadata strip. Omitted entirely if value is falsy. */
function MetaField({
  label,
  children,
  wide,
}: {
  label: string;
  children: ReactNode;
  /** A long value (a path) that may wrap rather than hold the row open. */
  wide?: boolean;
}) {
  return (
    <Box sx={wide ? { minWidth: 0, overflowWrap: "anywhere" } : { flexShrink: 0 }}>
      <Typography
        variant="caption"
        component="div"
        color="text.disabled"
        sx={{ textTransform: "uppercase", letterSpacing: 0.5, fontSize: 9.5, lineHeight: 1.4 }}
      >
        {label}
      </Typography>
      <Typography variant="body2" component="div" sx={{ fontFamily: MONO, fontSize: 12 }}>
        {children}
      </Typography>
    </Box>
  );
}

/**
 * The session's raw-data links behind one button. Five inline links (API JSON, CouchDB
 * events, CouchDB summary, Fauxton, S3) competed with Export for the header and wrapped
 * onto three rows on a phone; as a menu they take one slot at every width.
 */
function OpenInMenu({ links }: { links: NavLink[] }) {
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  if (links.length === 0) return null;
  return (
    <>
      <Button
        size="small"
        variant="outlined"
        onClick={(e) => setAnchor(e.currentTarget)}
        aria-haspopup="true"
        aria-expanded={anchor ? "true" : undefined}
      >
        Open in… ▾
      </Button>
      <Menu
        anchorEl={anchor}
        open={Boolean(anchor)}
        onClose={() => setAnchor(null)}
        anchorOrigin={{ vertical: "bottom", horizontal: "right" }}
        transformOrigin={{ vertical: "top", horizontal: "right" }}
        MenuListProps={{ dense: true }}
      >
        {links.map((link) => (
          <MenuItem
            key={link.href}
            component="a"
            href={link.href}
            target="_blank"
            rel="noopener noreferrer"
            onClick={() => setAnchor(null)}
            sx={{ fontSize: 13, gap: 2, justifyContent: "space-between" }}
          >
            {link.label}
            <Typography variant="caption" color="text.secondary">
              ↗
            </Typography>
          </MenuItem>
        ))}
      </Menu>
    </>
  );
}

export function SessionDetailPage() {
  const { id } = useParams({ from: "/sessions/$id" });
  const { q } = useRouterSearch({ from: "/sessions/$id" }) as SessionDetailSearch;
  const query = q?.trim() || undefined;
  const { data: session, isPending, isError, error } = useGetSession(id);
  const { data: model } = useAppBlueprint();
  const [speaker, setSpeaker] = useState<SpeakerFilter>("all");
  const [mode, setMode] = useState<TranscriptMode>("timeline");
  const navigate = useNavigate();
  const theme = useTheme();
  const split = session ? durationSplit(session.durationMs, session.activeMs) : undefined;

  // Where this session's data lives — the same links the list's row menu offers.
  const links = session ? sessionLinks(model, session, window.location.origin) : [];
  const ended = session ? statusTime(session) : undefined;
  // A 404 is an answer about the id, not a failure to report: say which session
  // isn't here and offer the way back, rather than the request line that asked.
  const notFound = isError && error instanceof ApiRequestError && error.status === 404;
  useDocumentTitle(
    session
      ? `${projectName(session.cwd)} ${session.sessionId.slice(0, 8)}`
      : notFound
        ? "Session not found"
        : undefined,
  );

  return (
    <Box>
      {/* Identity bar */}
      <Stack
        direction="row"
        alignItems="center"
        spacing={1}
        sx={{ mb: 1.5, flexWrap: "wrap", gap: 0.5 }}
      >
        <Link to="/" style={{ color: theme.palette.primary.main, textDecoration: "none" }}>
          ← All sessions
        </Link>

        {isPending && <Loading label="Loading session…" />}
        {isError && !notFound && <ErrorState error={error} />}

        {session && (
          <>
            <Typography variant="h6" sx={{ fontWeight: 600, fontSize: 15, color: "primary.main" }}>
              {projectName(session.cwd)}
            </Typography>
            <SessionIdCopy sessionId={session.sessionId} />
            <StatusChip status={session.status} />
            <Box sx={{ flex: 1 }} />
            <OpenInMenu links={links} />
            <ExportMenu session={session} />
            <DeleteSessionButton />
          </>
        )}
      </Stack>

      {notFound && (
        <EmptyState
          title="Session not found"
          action={
            <Button component={Link} to="/" variant="outlined" size="small">
              Back to all sessions
            </Button>
          }
        >
          No session with id{" "}
          <Box component="span" sx={{ fontFamily: MONO, wordBreak: "break-all" }}>
            {id}
          </Box>{" "}
          is recorded here.
        </EmptyState>
      )}

      {session && (
        <>
          {/* Metadata strip. It wraps rather than scrolling sideways: on a phone a
              horizontal scroller hid two thirds of the fields with no sign they were
              there. */}
          <Box
            sx={{
              display: "flex",
              flexWrap: "wrap",
              columnGap: 3,
              rowGap: 1.5,
              py: 1.5,
              px: 1,
              mb: 2,
              borderTop: 1,
              borderBottom: 1,
              borderColor: "divider",
            }}
          >
            <MetaField label="STARTED">
              {formatTimestamp(session.startTimestamp ?? session.timestamp)}
            </MetaField>
            {ended && (
              <MetaField label={ended.label === "ended" ? "ENDED" : "LAST WRITE"}>
                {formatTimestamp(ended.iso)}
              </MetaField>
            )}
            {split && split.totalMs > 0 && (
              <MetaField label="RUNTIME">{formatDuration(split.totalMs)}</MetaField>
            )}
            {split?.activeMs !== undefined && (
              <MetaField label="ACTIVE">{formatDuration(split.activeMs)}</MetaField>
            )}
            {session.model && <MetaField label="MODEL">{session.model}</MetaField>}
            {session.hostname && <MetaField label="HOST">{session.hostname}</MetaField>}
            {session.cwd && (
              <MetaField label="DIRECTORY" wide>
                {session.cwd}
              </MetaField>
            )}
            {session.tokenUsage && (
              <MetaField label="TOKENS">{formatCount(session.tokenUsage.total)}</MetaField>
            )}
            {session.promptCount > 0 && (
              <MetaField label="PROMPTS">{formatCount(session.promptCount)}</MetaField>
            )}
            {totalTools(session.toolCounts) > 0 && (
              <MetaField label="TOOLS">{formatCount(totalTools(session.toolCounts))}</MetaField>
            )}
            {session.errorCount > 0 && (
              <MetaField label="ERRORS">{formatCount(session.errorCount)}</MetaField>
            )}
            {session.transcriptSize && session.transcriptSize > 0 && (
              <MetaField label="SIZE">{formatBytes(session.transcriptSize)}</MetaField>
            )}
          </Box>

          {/* Transcript toolbar */}
          <Stack
            direction="row"
            spacing={1}
            alignItems="center"
            justifyContent="space-between"
            sx={{ mb: 1, flexWrap: "wrap", gap: 1 }}
          >
            <Stack direction="row" spacing={1} alignItems="baseline" sx={{ flexWrap: "wrap" }}>
              <Typography variant="h6">Transcript</Typography>
              {query && (
                <Chip
                  size="small"
                  color="warning"
                  variant="outlined"
                  label={`matches for "${query}"`}
                  onDelete={() => navigate({ to: "/sessions/$id", params: { id }, search: {} })}
                />
              )}
            </Stack>
            {/* Both controls on one row. The reader toggle only applies to the full
                transcript, so it's disabled while one speaker is showing. */}
            <Stack direction="row" spacing={1} sx={{ flexWrap: "wrap", gap: 1 }}>
              <ToggleButtonGroup
                size="small"
                exclusive
                value={speaker}
                onChange={(_e, v: SpeakerFilter | null) => v && setSpeaker(v)}
                aria-label="speaker filter"
              >
                <ToggleButton value="all">Both</ToggleButton>
                <ToggleButton value="user">User</ToggleButton>
                <ToggleButton value="assistant">Claude</ToggleButton>
              </ToggleButtonGroup>
              <ToggleButtonGroup
                size="small"
                exclusive
                value={mode}
                disabled={speaker !== "all"}
                onChange={(_e, v: TranscriptMode | null) => v && setMode(v)}
                aria-label="transcript reader"
              >
                <ToggleButton value="timeline">Timeline</ToggleButton>
                <ToggleButton value="raw">Raw</ToggleButton>
              </ToggleButtonGroup>
            </Stack>
          </Stack>
          {speaker !== "all" ? (
            <SpeakerTurnsView sessionId={session.sessionId} role={speaker} query={query} />
          ) : session.hasTranscript ? (
            <TranscriptView sessionId={session.sessionId} query={query} mode={mode} />
          ) : (
            <Typography color="text.secondary" variant="body2">
              No transcript was stored for this session.
            </Typography>
          )}
        </>
      )}
    </Box>
  );
}
