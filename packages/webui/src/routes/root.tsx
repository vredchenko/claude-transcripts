import { Box, Container } from "@mui/material";
import { Outlet } from "@tanstack/react-router";
import { Header } from "../components/Header";

/**
 * App shell: thin header + routed content.
 *
 * The content is fluid: no `maxWidth` cap. The list and the calendar are wide tables
 * that cut off hosts, paths and timestamps when squeezed, and a 1536px cap left a
 * fifth of a 1920px screen as empty margin beside them. Long prose (transcript
 * messages) keeps a readable measure where it's drawn, not here.
 */
export function RootLayout() {
  return (
    <Box sx={{ minHeight: "100vh", bgcolor: "background.default" }}>
      <Header />
      <Container maxWidth={false} sx={{ py: 3 }}>
        <Outlet />
      </Container>
    </Box>
  );
}
