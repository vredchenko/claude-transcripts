/**
 * `/sessions/$id` — session detail page.
 *
 * Identity bar: back link, project name, 8-char id + copy, status chip, deep links.
 * Metadata strip: horizontal scroll row of fields.
 * Transcript section: speaker filter toggle (Both/You/Claude) + transcript viewer.
 */
import {
  Box,
  Button,
  Chip,
  IconButton,
  Stack,
  ToggleButton,
  ToggleButtonGroup,
  Tooltip,
  Typography,
  useTheme,
} from "@mui/material";
import { Link, useNavigate, useParams, useSearch as useRouterSearch } from "@tanstack/react-router";
import { type ReactNode, useCallback, useState } from "react";
import { useGetSession } from "../api/generated";
import { useAppModel } from "../api/model";
import { SpeakerTurnsView } from "../components/SpeakerTurnsView";
import { StatusChip } from "../components/StatusChip";
import { ErrorState, Loading } from "../components/states";
import { TranscriptView } from "../components/TranscriptView";
import {
  durationSplit,
  formatBytes,
  formatCount,
  formatDuration,
  formatTimestamp,
  projectName,
  totalTools,
} from "../format";
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
  const [copied, setCopied] = useState(false);

  const copyId = useCallback(() => {
    navigator.clipboard.writeText(id);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }, [id]);

  const split = session ? durationSplit(session.durationMs, session.activeMs) : undefined;

  // Deep link URLs built from servicesMenu.
  const fauxtonUrl = model?.servicesMenu?.couchdbFauxton;
  const couchDocUrl = fauxtonUrl ? `${fauxtonUrl}/#/database/sessions/summary:${id}` : undefined;
  const garageUrl = model?.servicesMenu?.garageWebui;
  const apiJsonUrl = `/api/sessions/${id}`;

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
        {isError && <ErrorState error={error} />}

        {session && (
          <>
            <Typography variant="h6" sx={{ fontWeight: 600, fontSize: 15, color: "primary.main" }}>
              {projectName(session.cwd)}
            </Typography>
            <Stack direction="row" spacing={0.5} alignItems="center">
              <Typography sx={{ fontFamily: MONO, fontSize: 13 }}>
                {session.sessionId.slice(0, 8)}
              </Typography>
              <Tooltip title={copied ? "Copied!" : "Copy full ID"}>
                <IconButton size="small" onClick={copyId} sx={{ fontSize: 14 }}>
                  {copied ? "✓" : "⎘"}
                </IconButton>
              </Tooltip>
            </Stack>
            <StatusChip status={session.status} />
            <Box sx={{ flex: 1 }} />
            {/* Deep-link buttons */}
            {couchDocUrl && (
              <Button size="small" href={couchDocUrl} target="_blank" rel="noopener noreferrer">
                CouchDB
              </Button>
            )}
            {garageUrl && (
              <Button size="small" href={`${garageUrl}`} target="_blank" rel="noopener noreferrer">
                Garage
              </Button>
            )}
            <Button size="small" href={apiJsonUrl} target="_blank" rel="noopener noreferrer">
              API JSON
            </Button>
          </>
        )}
      </Stack>

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
