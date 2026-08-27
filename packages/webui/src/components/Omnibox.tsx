/**
 * Multi-mode omnibox: filter, full-text search, id-jump, date phrases, operators,
 * saved filters, recent searches, and commands. Replaces SearchBox.
 *
 * - Enter: narrow the session list (filter)
 * - Shift+Enter: full-text search inside transcripts
 * - Ctrl+K / Cmd+K: focus + select-all
 * - Esc: close dropdown, then clear
 * - Up/Down: navigate dropdown items
 */
import {
  Box,
  Chip,
  ClickAwayListener,
  List,
  ListItemButton,
  ListItemText,
  ListSubheader,
  Paper,
  Popper,
  Stack,
  TextField,
  Typography,
} from "@mui/material";
import { useNavigate } from "@tanstack/react-router";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { getSearchQueryKey, useSearch } from "../api/generated";
import { useAppModel } from "../api/model";
import { useColorMode } from "../color-mode";
import { projectName } from "../format";
import { COMMANDS, type CommandContext } from "../omnibox/commands";
import { OPERATORS, parseOmniboxInput } from "../omnibox/parse";
import { addRecentSearch, getRecentSearches, getSavedFilters } from "../omnibox/storage";
import { MONO } from "../theme";
import { MarkedSnippet } from "./HighlightedText";

const DEBOUNCE_MS = 150;

export function Omnibox() {
  const [q, setQ] = useState("");
  const [debounced, setDebounced] = useState("");
  const [open, setOpen] = useState(false);
  const anchorRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const navigate = useNavigate();
  const { setPref } = useColorMode();
  const { data: model } = useAppModel();

  // Debounce.
  useEffect(() => {
    const t = setTimeout(() => setDebounced(q.trim()), DEBOUNCE_MS);
    return () => clearTimeout(t);
  }, [q]);

  // Search API for text mode.
  const searchParams = { q: debounced, limit: 8 };
  const { data: searchData, isFetching } = useSearch(searchParams, {
    query: { queryKey: getSearchQueryKey(searchParams), enabled: debounced.length > 0 },
  });

  const parsed = useMemo(() => parseOmniboxInput(debounced), [debounced]);

  const recentSearches = useMemo(() => getRecentSearches(), []);
  const savedFilters = useMemo(() => getSavedFilters(), []);

  // Global keyboard shortcut: Ctrl+K / Cmd+K.
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "k") {
        e.preventDefault();
        inputRef.current?.focus();
        inputRef.current?.select();
        setOpen(true);
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, []);

  const close = useCallback(() => setOpen(false), []);

  const applyFilter = useCallback(() => {
    const trimmed = q.trim();
    if (!trimmed) return;
    addRecentSearch(trimmed);
    setOpen(false);

    if (parsed.mode === "operator" && parsed.operators) {
      // Build URL filter params from operators.
      const params: Record<string, string> = {};
      for (const op of parsed.operators) {
        const keyMap: Record<string, string> = {
          project: "cwd",
          host: "hostname",
          model: "model",
          source: "source",
        };
        const paramKey = keyMap[op.key] ?? op.key;
        params[paramKey] = op.value;
      }
      navigate({ to: "/", search: (old) => ({ ...old, ...params }) });
    } else if (parsed.mode === "date" && parsed.dateRange) {
      navigate({
        to: "/",
        search: (old) => ({ ...old, from: parsed.dateRange!.from, to: parsed.dateRange!.to }),
      });
    } else if (parsed.mode === "id" && parsed.idPrefix) {
      // Try to navigate directly to the session.
      navigate({ to: "/sessions/$id", params: { id: parsed.idPrefix } });
    } else {
      // Text mode: navigate to the session list with the search terms.
      navigate({ to: "/search", search: { q: trimmed } });
    }
  }, [q, parsed, navigate]);

  const searchFullText = useCallback(() => {
    const trimmed = q.trim();
    if (!trimmed) return;
    addRecentSearch(trimmed);
    setOpen(false);
    navigate({ to: "/search", search: { q: trimmed } });
  }, [q, navigate]);

  const runCommand = useCallback(
    (cmd: (typeof COMMANDS)[number]) => {
      const ctx: CommandContext = {
        setColorMode: setPref,
        servicesMenu: model?.servicesMenu,
      };
      cmd.run(ctx);
      setQ("");
      setOpen(false);
    },
    [setPref, model],
  );

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === "Escape") {
        if (open) {
          setOpen(false);
        } else {
          setQ("");
        }
        e.preventDefault();
      } else if (e.key === "Enter" && e.shiftKey) {
        e.preventDefault();
        searchFullText();
      } else if (e.key === "Enter") {
        e.preventDefault();
        if (parsed.mode === "command" && parsed.command) {
          const match = COMMANDS.find((c) => c.match(parsed.command!));
          if (match) {
            runCommand(match);
            return;
          }
        }
        applyFilter();
      }
    },
    [open, parsed, applyFilter, searchFullText, runCommand],
  );

  const showPanel = open;
  const hits = searchData?.hits ?? [];
  const turns = searchData?.turns ?? [];

  return (
    <ClickAwayListener onClickAway={close}>
      <Box ref={anchorRef} sx={{ width: "100%", maxWidth: 660, position: "relative" }}>
        <TextField
          inputRef={inputRef}
          size="small"
          value={q}
          onChange={(e) => {
            setQ(e.target.value);
            setOpen(true);
          }}
          onFocus={() => setOpen(true)}
          onKeyDown={handleKeyDown}
          placeholder="Search, filter, or type > for commands…"
          inputProps={{ "aria-label": "Omnibox" }}
          InputProps={{
            endAdornment: (
              <Typography
                variant="caption"
                color="text.secondary"
                sx={{
                  fontFamily: MONO,
                  fontSize: 10,
                  border: 1,
                  borderColor: "divider",
                  borderRadius: 0.5,
                  px: 0.5,
                  py: 0.125,
                  whiteSpace: "nowrap",
                }}
              >
                ⌘K
              </Typography>
            ),
          }}
          sx={{
            width: "100%",
            "& .MuiInputBase-root": {
              bgcolor: "background.default",
              fontFamily: MONO,
              fontSize: 13,
              height: 34,
              borderRadius: "7px",
            },
            "& .MuiOutlinedInput-root.Mui-focused .MuiOutlinedInput-notchedOutline": {
              borderWidth: "1.5px",
              borderColor: "primary.main",
            },
          }}
        />
        <Popper
          open={showPanel}
          anchorEl={anchorRef.current}
          placement="bottom-start"
          style={{ zIndex: 1300, width: anchorRef.current?.clientWidth }}
        >
          <Paper
            elevation={3}
            sx={{ mt: 0.5, maxHeight: 440, overflowY: "auto", borderRadius: "8px" }}
          >
            {/* Mode-specific content */}
            {parsed.mode === "command" && parsed.command ? (
              <CommandDropdown command={parsed.command} onRun={runCommand} />
            ) : parsed.mode === "date" && parsed.dateRange ? (
              <Box sx={{ p: 2 }}>
                <Typography variant="caption" color="text.secondary">
                  Interpreted as
                </Typography>
                <Typography variant="body2" sx={{ fontFamily: MONO, mt: 0.5 }}>
                  {new Date(parsed.dateRange.from).toLocaleDateString()} –{" "}
                  {new Date(parsed.dateRange.to).toLocaleDateString()}
                </Typography>
                <Typography
                  variant="caption"
                  color="text.secondary"
                  sx={{ mt: 1, display: "block" }}
                >
                  Press Enter to filter sessions to this range.
                </Typography>
              </Box>
            ) : parsed.mode === "id" && parsed.idPrefix ? (
              <Box sx={{ p: 2 }}>
                <Typography variant="body2">
                  Jump to session <strong>{parsed.idPrefix}</strong>
                </Typography>
                <Typography
                  variant="caption"
                  color="text.secondary"
                  sx={{ mt: 0.5, display: "block" }}
                >
                  Press Enter to navigate.
                </Typography>
              </Box>
            ) : debounced.length > 0 ? (
              <TextModeDropdown
                hits={hits}
                turns={turns}
                isFetching={isFetching}
                enabled={searchData?.enabled ?? true}
                debounced={debounced}
                onGo={(sessionId) => {
                  setOpen(false);
                  addRecentSearch(debounced);
                  navigate({
                    to: "/sessions/$id",
                    params: { id: sessionId },
                    search: { q: debounced },
                  });
                }}
                onSeeAll={searchFullText}
              />
            ) : null}

            {/* Persistent sections: saved filters + recent */}
            {savedFilters.length > 0 && (
              <>
                <ListSubheader disableSticky sx={{ fontSize: 10, lineHeight: 2 }}>
                  ★ Saved filters
                </ListSubheader>
                {savedFilters.map((f) => (
                  <ListItemButton
                    key={f.name}
                    dense
                    onClick={() => {
                      setQ(f.query);
                      setDebounced(f.query);
                    }}
                  >
                    <ListItemText
                      primary={f.name}
                      secondary={f.query}
                      secondaryTypographyProps={{ sx: { fontFamily: MONO, fontSize: 10 } }}
                    />
                  </ListItemButton>
                ))}
              </>
            )}
            {recentSearches.length > 0 && (
              <>
                <ListSubheader disableSticky sx={{ fontSize: 10, lineHeight: 2 }}>
                  ↺ Recent
                </ListSubheader>
                {recentSearches.map((r) => (
                  <ListItemButton
                    key={r}
                    dense
                    onClick={() => {
                      setQ(r);
                      setDebounced(r);
                    }}
                  >
                    <ListItemText
                      primary={r}
                      primaryTypographyProps={{ sx: { fontFamily: MONO, fontSize: 12 } }}
                    />
                  </ListItemButton>
                ))}
              </>
            )}

            {/* Operators documentation when in text mode and no results */}
            {debounced.length === 0 && (
              <Box sx={{ px: 2, py: 1.5, borderTop: 1, borderColor: "divider" }}>
                <Typography variant="caption" color="text.secondary" sx={{ fontWeight: 700 }}>
                  OPERATORS
                </Typography>
                <Stack spacing={0.25} sx={{ mt: 0.5 }}>
                  {Object.entries(OPERATORS).map(([key, desc]) => (
                    <Stack key={key} direction="row" spacing={1} alignItems="baseline">
                      <Chip
                        size="small"
                        label={key}
                        variant="outlined"
                        sx={{ fontFamily: MONO, fontSize: 10, height: 18 }}
                        onClick={() => {
                          setQ(key);
                          setDebounced(key);
                          inputRef.current?.focus();
                        }}
                      />
                      <Typography variant="caption" color="text.secondary">
                        {desc}
                      </Typography>
                    </Stack>
                  ))}
                </Stack>
              </Box>
            )}
          </Paper>
        </Popper>
      </Box>
    </ClickAwayListener>
  );
}

function CommandDropdown({
  command,
  onRun,
}: {
  command: string;
  onRun: (cmd: (typeof COMMANDS)[number]) => void;
}) {
  const matching = COMMANDS.filter((c) => c.match(command));
  if (matching.length === 0) {
    return (
      <Typography variant="body2" color="text.secondary" sx={{ p: 2 }}>
        No matching commands.
      </Typography>
    );
  }
  return (
    <List dense disablePadding>
      <ListSubheader disableSticky>Commands</ListSubheader>
      {matching.map((cmd) => (
        <ListItemButton key={cmd.name} onClick={() => onRun(cmd)}>
          <ListItemText
            primary={cmd.name}
            secondary={cmd.description}
            primaryTypographyProps={{ sx: { fontFamily: MONO, fontSize: 12 } }}
          />
        </ListItemButton>
      ))}
    </List>
  );
}

function TextModeDropdown({
  hits,
  turns,
  isFetching,
  enabled,
  debounced,
  onGo,
  onSeeAll,
}: {
  hits: { sessionId: string; cwd?: string; model?: string }[];
  turns: { sessionId: string; snippet: string; role: string; cwd?: string }[];
  isFetching: boolean;
  enabled: boolean;
  debounced: string;
  onGo: (sessionId: string) => void;
  onSeeAll: () => void;
}) {
  if (!enabled) {
    return (
      <Typography variant="body2" color="text.secondary" sx={{ p: 2 }}>
        Search is unavailable — Meilisearch isn't configured.
      </Typography>
    );
  }

  return (
    <List dense disablePadding>
      {/* Action items */}
      <ListItemButton onClick={onSeeAll}>
        <ListItemText
          primary={
            <Typography variant="body2" color="primary">
              Search inside transcripts for "{debounced}" →
            </Typography>
          }
          secondary="Shift+Enter"
        />
      </ListItemButton>

      {hits.length === 0 && turns.length === 0 ? (
        <Typography variant="body2" color="text.secondary" sx={{ p: 2 }}>
          {isFetching ? "Searching…" : "No matches."}
        </Typography>
      ) : (
        <>
          {hits.length > 0 && <ListSubheader disableSticky>Sessions</ListSubheader>}
          {hits.map((h) => (
            <ListItemButton key={`s-${h.sessionId}`} onClick={() => onGo(h.sessionId)}>
              <ListItemText
                primary={projectName(h.cwd)}
                secondary={
                  <span style={{ fontFamily: MONO, fontSize: 11 }}>
                    {h.sessionId.slice(0, 8)}
                    {h.model ? ` · ${h.model}` : ""}
                  </span>
                }
              />
            </ListItemButton>
          ))}
          {turns.length > 0 && <ListSubheader disableSticky>In conversations</ListSubheader>}
          {turns.map((t, i) => (
            <ListItemButton key={`t-${i}`} onClick={() => onGo(t.sessionId)}>
              <ListItemText
                primary={
                  <Box component="span" sx={{ overflowWrap: "anywhere" }}>
                    <Chip
                      component="span"
                      size="small"
                      label={t.role}
                      sx={{ mr: 1, height: 18, fontSize: 10 }}
                    />
                    <MarkedSnippet snippet={t.snippet} />
                  </Box>
                }
              />
            </ListItemButton>
          ))}
        </>
      )}
    </List>
  );
}
