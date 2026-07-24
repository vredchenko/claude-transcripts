import {
  Box,
  ClickAwayListener,
  InputAdornment,
  List,
  ListItemButton,
  ListItemText,
  Paper,
  Popper,
  TextField,
  Typography,
} from "@mui/material";
import { useNavigate } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import { useSearch } from "../api/generated";
import { projectName } from "../format";
import { MONO } from "../theme";

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
  const showPanel = open && debounced.length > 0;

  const go = (sessionId: string) => {
    setOpen(false);
    navigate({ to: "/sessions/$id", params: { id: sessionId } });
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
          <Paper elevation={3} sx={{ mt: 0.5, maxHeight: 360, overflowY: "auto" }}>
            {data && !data.enabled ? (
              <Typography variant="body2" color="text.secondary" sx={{ p: 2 }}>
                Search is unavailable — Meilisearch isn't configured.
              </Typography>
            ) : hits.length === 0 ? (
              <Typography variant="body2" color="text.secondary" sx={{ p: 2 }}>
                {isFetching ? "Searching…" : "No matches."}
              </Typography>
            ) : (
              <List dense disablePadding>
                {hits.map((h) => (
                  <ListItemButton key={h.sessionId} onClick={() => go(h.sessionId)}>
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
              </List>
            )}
          </Paper>
        </Popper>
      </Box>
    </ClickAwayListener>
  );
}
