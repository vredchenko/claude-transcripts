import { Box, Container } from "@mui/material";
import { Outlet } from "@tanstack/react-router";
import { Header } from "../components/Header";

/** App shell: thin header + routed content. */
export function RootLayout() {
  return (
    <Box sx={{ minHeight: "100vh", bgcolor: "background.default" }}>
      <Header />
      <Container maxWidth="xl" sx={{ py: 3 }}>
        <Outlet />
      </Container>
    </Box>
  );
}
