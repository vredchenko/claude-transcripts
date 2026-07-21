import { AppBar, Box, Toolbar, Typography } from "@mui/material";
import { Link } from "@tanstack/react-router";
import { useAppModel } from "../api/model";
import { MONO } from "../theme";
import { LinksMenu } from "./LinksMenu";
import { SearchBox } from "./SearchBox";
import { SettingsMenu } from "./SettingsMenu";

/**
 * The thin top header: app title + build version (left), a search box (center,
 * placeholder), and the settings + links menus (right). Title/version come from
 * `GET /api/model`, falling back to sensible defaults while it loads.
 */
export function Header() {
  const { data } = useAppModel();
  const title = data?.identity?.title ?? "Claude Transcripts";
  const version = data?.identity?.version;

  return (
    <AppBar
      position="sticky"
      elevation={0}
      color="transparent"
      sx={{ bgcolor: "background.paper", borderBottom: 1, borderColor: "divider" }}
    >
      <Toolbar variant="dense" sx={{ gap: 1, minHeight: 48 }}>
        <Link to="/" style={{ textDecoration: "none", color: "inherit", flexShrink: 0 }}>
          <Box sx={{ display: "flex", alignItems: "baseline", gap: 1 }}>
            <Typography variant="subtitle1" sx={{ fontWeight: 700 }}>
              {title}
            </Typography>
            {version && (
              <Typography variant="caption" color="text.secondary" sx={{ fontFamily: MONO }}>
                v{version}
              </Typography>
            )}
          </Box>
        </Link>

        <Box sx={{ flexGrow: 1, display: "flex", justifyContent: "center", px: { xs: 1, sm: 2 } }}>
          <SearchBox />
        </Box>

        <Box sx={{ display: "flex", alignItems: "center", gap: 0.5, flexShrink: 0 }}>
          <SettingsMenu />
          <LinksMenu />
        </Box>
      </Toolbar>
    </AppBar>
  );
}
