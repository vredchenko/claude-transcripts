import { Alert, Box, CircularProgress, Typography } from "@mui/material";
import type { ReactNode } from "react";

/** Centered spinner for in-flight queries. */
export function Loading({ label }: { label?: string }) {
  return (
    <Box sx={{ display: "flex", alignItems: "center", gap: 2, py: 6, justifyContent: "center" }}>
      <CircularProgress size={22} />
      <Typography color="text.secondary">{label ?? "Loading…"}</Typography>
    </Box>
  );
}

/** Error banner for a failed query. */
export function ErrorState({ error }: { error: Error | null }) {
  return (
    <Alert severity="error" sx={{ my: 2 }}>
      {error?.message ?? "Something went wrong."}
    </Alert>
  );
}

/** Neutral empty-state message. */
export function EmptyState({ children }: { children: ReactNode }) {
  return (
    <Box sx={{ py: 6, textAlign: "center" }}>
      <Typography color="text.secondary">{children}</Typography>
    </Box>
  );
}
