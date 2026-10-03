import { AppBar, Box, Toolbar, Typography } from "@mui/material";
import { Link } from "@tanstack/react-router";
import { useAppModel } from "../api/model";
import logoMark from "../assets/logo-mark.svg";
import { displayVersion } from "../format";
import { MONO } from "../theme";
import { AboutMenu, DevMenu, ServicesMenu } from "./nav/HeaderMenus";
import { Omnibox } from "./Omnibox";
import { SettingsMenu } from "./SettingsMenu";

/**
 * The thin top header: app title + build version (left), a search box (center,
 * placeholder), and the Services / Dev / About menus + settings (right). Title/version come from
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
      {/* Below `sm` the three cells don't fit on one line: shrinking the search field
          to make them fit leaves a ~20px input jammed against the settings button.
          So the toolbar wraps and the search takes a full-width second row, which is
          also where a phone user expects it. Above `sm` it stays inline and centred. */}
      <Toolbar
        variant="dense"
        sx={{
          gap: 1,
          rowGap: 1,
          minHeight: 48,
          flexWrap: { xs: "wrap", sm: "nowrap" },
          py: { xs: 1, sm: 0 },
        }}
      >
        <Box sx={{ order: 1, flexShrink: 0, flexGrow: { xs: 1, sm: 0 }, minWidth: 0 }}>
          <Link to="/" style={{ textDecoration: "none", color: "inherit" }}>
            <Box sx={{ display: "flex", alignItems: "baseline", gap: 1 }}>
              <Box
                component="img"
                src={logoMark}
                alt=""
                sx={{ width: 22, height: 22, display: "block", alignSelf: "center" }}
              />
              <Typography variant="subtitle1" sx={{ fontWeight: 700 }}>
                {title}
              </Typography>
              {version && (
                <Typography variant="caption" color="text.secondary" sx={{ fontFamily: MONO }}>
                  {displayVersion(version)}
                </Typography>
              )}
            </Box>
          </Link>
        </Box>

        {/* `minWidth: 0` is load-bearing above `sm`: without it this flex cell won't
            shrink below the search field's intrinsic width, so it pushed the settings
            and links menus off the right edge and made every page scroll sideways. */}
        <Box
          sx={{
            order: { xs: 3, sm: 2 },
            flexGrow: 1,
            minWidth: 0,
            width: { xs: "100%", sm: "auto" },
            display: "flex",
            justifyContent: "center",
            px: { xs: 0, sm: 2 },
          }}
        >
          <Omnibox />
        </Box>

        <Box
          sx={{
            order: { xs: 2, sm: 3 },
            display: "flex",
            alignItems: "center",
            gap: 0.5,
            flexShrink: 0,
          }}
        >
          <ServicesMenu />
          <DevMenu />
          <AboutMenu />
          <SettingsMenu />
        </Box>
      </Toolbar>
    </AppBar>
  );
}
