import { AppBar, Box, Container, Toolbar, Typography } from "@mui/material";
import { Link, Outlet } from "@tanstack/react-router";
import { ServicesMenu } from "../components/ServicesMenu";

/** App shell: top bar + routed content. */
export function RootLayout() {
  return (
    <Box sx={{ minHeight: "100vh", bgcolor: "background.default" }}>
      <AppBar
        position="sticky"
        elevation={0}
        sx={{ borderBottom: "1px solid rgba(0,0,0,0.08)", bgcolor: "background.paper" }}
        color="transparent"
      >
        <Toolbar variant="dense">
          <Link to="/" style={{ textDecoration: "none", color: "inherit" }}>
            <Typography variant="h6" sx={{ fontWeight: 600 }}>
              Claude Transcripts
            </Typography>
          </Link>
          <Box sx={{ flexGrow: 1 }} />
          <ServicesMenu />
        </Toolbar>
      </AppBar>
      <Container maxWidth="xl" sx={{ py: 3 }}>
        <Outlet />
      </Container>
    </Box>
  );
}
