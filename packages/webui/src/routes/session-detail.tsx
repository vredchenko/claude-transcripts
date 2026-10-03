/**
 * `/sessions/$id` — session detail page.
 *
 * Identity bar: back link, project name, 8-char id + copy, status, links to the raw data.
 * Metadata strip: horizontal scroll row of fields.
 * Transcript section: speaker filter toggle (Both/You/Claude) + transcript viewer.
 */
import {
  Box,
  Button,
  Chip,
  Stack,
  ToggleButton,
  ToggleButtonGroup,
  Typography,
  useTheme,
} from "@mui/material";
import { Link, useNavigate, useParams, useSearch as useRouterSearch } from "@tanstack/react-router";
import { type ReactNode, useState } from "react";
import { useGetSession } from "../api/generated";
import { ApiRequestError } from "../api/http";
import { useAppModel } from "../api/model";
import { SessionIdCopy } from "../components/SessionIdentity";
import { SpeakerTurnsView } from "../components/SpeakerTurnsView";
import { StatusChip } from "../components/StatusChip";
import { EmptyState, ErrorState, Loading } from "../components/states";
import { TranscriptView } from "../components/TranscriptView";
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
import { sessionLinks } from "../nav-menus";
import { MONO } from "../theme";

type SpeakerFilter = "all" | "user" | "assistant";

/** Query-string state this route owns. */
export interface SessionDetailSearch {
  q?: string;
}

/** One labelled fact in the metadata strip. Omitted entirely if value is falsy. */
function MetaField({ label, children }: { label: string; children: ReactNode }) {
  return (
    <Box sx={{ flexShrink: 0 }}>
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

export function SessionDetailPage() {
  const { id } = useParams({ from: "/sessions/$id" });
  const { q } = useRouterSearch({ from: "/sessions/$id" }) as SessionDetailSearch;
  const query = q?.trim() || undefined;
  const { data: session, isPending, isError, error } = useGetSession(id);
  const { data: model } = useAppModel();
  const [speaker, setSpeaker] = useState<SpeakerFilter>("all");
  const navigate = useNavigate();
  const theme = useTheme();
  const split = session ? durationSplit(session.durationMs, session.activeMs) : undefined;

  // Where this session's data lives — the same links the list's row menu offers.
  const links = session ? sessionLinks(model, session) : [];
  const ended = session ? statusTime(session) : undefined;
  // A 404 is an answer about the id, not a failure to report: say which session
  // isn't here and offer the way back, rather than the request line that asked.
  const notFound = isError && error instanceof ApiRequestError && error.status === 404;

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
            {/* Links to the raw data */}
            {links.map((link) => (
              <Button
                key={link.href}
                size="small"
                href={link.href}
                target="_blank"
                rel="noopener noreferrer"
                sx={{ textTransform: "none" }}
              >
                {link.label} ↗
              </Button>
            ))}
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
          {/* Metadata strip — horizontal scroll */}
          <Box
            sx={{
              display: "flex",
              gap: 3,
              overflowX: "auto",
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
            <ToggleButtonGroup
              size="small"
              exclusive
              value={speaker}
              onChange={(_e, v: SpeakerFilter | null) => v && setSpeaker(v)}
              aria-label="speaker filter"
            >
              <ToggleButton value="all">Both</ToggleButton>
              <ToggleButton value="user">You</ToggleButton>
              <ToggleButton value="assistant">Claude</ToggleButton>
            </ToggleButtonGroup>
          </Stack>
          {speaker !== "all" ? (
            <SpeakerTurnsView sessionId={session.sessionId} role={speaker} query={query} />
          ) : session.hasTranscript ? (
            <TranscriptView sessionId={session.sessionId} query={query} />
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
