import {
  Box,
  Chip,
  ClickAwayListener,
  InputAdornment,
  List,
  ListItemButton,
  ListItemText,
  ListSubheader,
  Paper,
  Popper,
  TextField,
  Typography,
} from "@mui/material";
import { useNavigate } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import { useSearch } from "../api/generated";
import { formatTimestamp, projectName } from "../format";
import { MONO } from "../theme";
import { MarkedSnippet } from "./HighlightedText";

/**
 * Header search box → full-text session search (Meilisearch, `GET /api/search`).
 * The debounced query drives a results dropdown that links to sessions; it degrades
 * to a hint when search is disabled/unavailable rather than erroring.
 */
export function SearchBox() {
  const [q, setQ] = useState("");
  const [debounced, setDebounced] = useState("");
  const [open, setOpen] = useState(false);
  const anchorRef = useRef<HTMLDivElement | null>(null);
  const navigate = useNavigate();

  // Debounce so we don't hit the API on every keystroke.
  useEffect(() => {
    const t = setTimeout(() => setDebounced(q.trim()), 250);
    return () => clearTimeout(t);
  }, [q]);

  const { data, isFetching } = useSearch({ q: debounced, limit: 8 });
  const hits = data?.hits ?? [];
  const turns = data?.turns ?? [];
  const showPanel = open && debounced.length > 0;

  /**
   * Open a session, carrying the query so it lands on the match with the terms
   * marked — the dropdown's whole job is "take me to where that was said".
   */
  const go = (sessionId: string) => {
    setOpen(false);
    navigate({ to: "/sessions/$id", params: { id: sessionId }, search: { q: debounced } });
  };

  /** Hand the query to the results page — this dropdown is capped and unfiltered. */
  const seeAll = () => {
    setOpen(false);
    navigate({ to: "/search", search: { q: debounced } });
  };

  return (
    <ClickAwayListener onClickAway={() => setOpen(false)}>
      <Box ref={anchorRef} sx={{ width: "100%", maxWidth: 420, position: "relative" }}>
        <TextField
          size="small"
          value={q}
          onChange={(e) => {
            setQ(e.target.value);
            setOpen(true);
          }}
          onFocus={() => setOpen(true)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && debounced) seeAll();
          }}
          placeholder="Search sessions…"
          inputProps={{ "aria-label": "Search sessions" }}
          InputProps={{
            startAdornment: <InputAdornment position="start">🔍</InputAdornment>,
          }}
          sx={{ width: "100%", "& .MuiInputBase-root": { bgcolor: "background.default" } }}
        />
        <Popper
          open={showPanel}
          anchorEl={anchorRef.current}
          placement="bottom-start"
          style={{ zIndex: 1300, width: anchorRef.current?.clientWidth }}
        >
          <Paper elevation={3} sx={{ mt: 0.5, maxHeight: 420, overflowY: "auto" }}>
            {data && !data.enabled ? (
              <Typography variant="body2" color="text.secondary" sx={{ p: 2 }}>
                Search is unavailable — Meilisearch isn't configured.
              </Typography>
            ) : hits.length === 0 && turns.length === 0 ? (
              <Typography variant="body2" color="text.secondary" sx={{ p: 2 }}>
                {isFetching ? "Searching…" : "No matches."}
              </Typography>
            ) : (
              <List dense disablePadding>
                {hits.length > 0 && <ListSubheader disableSticky>Sessions</ListSubheader>}
                {hits.map((h) => (
                  <ListItemButton key={`s-${h.sessionId}`} onClick={() => go(h.sessionId)}>
                    <ListItemText
                      primary={projectName(h.cwd)}
                      secondary={
                        <span style={{ fontFamily: MONO, fontSize: 11 }}>
                          {h.sessionId}
                          {h.model ? ` · ${h.model}` : ""}
                        </span>
                      }
                    />
                  </ListItemButton>
                ))}
                {turns.length > 0 && <ListSubheader disableSticky>In conversations</ListSubheader>}
                {turns.map((t, i) => (
                  // Turns lack a stable client id; index within the result set is fine.
                  <ListItemButton key={`t-${i}`} onClick={() => go(t.sessionId)}>
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
                      secondary={
                        <span style={{ fontFamily: MONO, fontSize: 11 }}>
                          {projectName(t.cwd)}
                          {t.timestamp ? ` · ${formatTimestamp(t.timestamp)}` : ""}
                        </span>
                      }
                    />
                  </ListItemButton>
                ))}
                <ListItemButton onClick={seeAll} sx={{ borderTop: 1, borderColor: "divider" }}>
                  <ListItemText
                    primary={
                      <Typography variant="body2" color="primary">
                        See all results for “{debounced}” →
                      </Typography>
                    }
                  />
                </ListItemButton>
              </List>
            )}
          </Paper>
        </Popper>
      </Box>
    </ClickAwayListener>
  );
}
