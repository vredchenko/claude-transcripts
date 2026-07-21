import {
  IconButton,
  ListItemIcon,
  ListItemText,
  ListSubheader,
  Menu,
  MenuItem,
  Tooltip,
} from "@mui/material";
import { useState } from "react";
import { type ColorModePref, useColorMode } from "../color-mode";

/**
 * Primary (settings) menu — a gear button opening app settings. Currently: the
 * theme mode toggle (light / dark / follow system). More config options land here
 * later (config-driven services menu, user settings, …).
 */
const THEME_OPTIONS: { pref: ColorModePref; label: string }[] = [
  { pref: "light", label: "Light" },
  { pref: "dark", label: "Dark" },
  { pref: "system", label: "Follow system" },
];

export function SettingsMenu() {
  const { pref, setPref } = useColorMode();
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  const open = Boolean(anchor);

  return (
    <>
      <Tooltip title="Settings">
        <IconButton
          size="small"
          color="inherit"
          onClick={(e) => setAnchor(e.currentTarget)}
          aria-haspopup="true"
          aria-expanded={open ? "true" : undefined}
          aria-label="Settings"
        >
          ⚙
        </IconButton>
      </Tooltip>
      <Menu anchorEl={anchor} open={open} onClose={() => setAnchor(null)}>
        <ListSubheader disableSticky>Theme</ListSubheader>
        {THEME_OPTIONS.map((opt) => (
          <MenuItem
            key={opt.pref}
            selected={pref === opt.pref}
            onClick={() => {
              setPref(opt.pref);
              setAnchor(null);
            }}
          >
            <ListItemIcon sx={{ minWidth: 28 }}>{pref === opt.pref ? "✓" : ""}</ListItemIcon>
            <ListItemText>{opt.label}</ListItemText>
          </MenuItem>
        ))}
        <ListSubheader disableSticky>More</ListSubheader>
        <MenuItem disabled>Config options — coming soon</MenuItem>
      </Menu>
    </>
  );
}
