import { InputAdornment, TextField, Tooltip } from "@mui/material";
import { useState } from "react";

/**
 * Header search box. **Placeholder for now** — full-text search is Phase 2 (backed
 * by Meilisearch, [ADR 0009]), so this captures input but does not query yet. Kept
 * enabled (not disabled) so the header reads as intended; submitting is a no-op.
 */
export function SearchBox() {
  const [q, setQ] = useState("");
  return (
    <Tooltip title="Full-text search is coming soon (Meilisearch, Phase 2)">
      <TextField
        size="small"
        value={q}
        onChange={(e) => setQ(e.target.value)}
        onKeyDown={(e) => {
          // No search backend yet — swallow Enter so it doesn't feel broken.
          if (e.key === "Enter") e.preventDefault();
        }}
        placeholder="Search sessions…"
        inputProps={{ "aria-label": "Search sessions" }}
        InputProps={{
          startAdornment: <InputAdornment position="start">🔍</InputAdornment>,
        }}
        sx={{
          width: "100%",
          maxWidth: 420,
          "& .MuiInputBase-root": { bgcolor: "background.default" },
        }}
      />
    </Tooltip>
  );
}
