import { IconButton, Menu, MenuItem, Tooltip, Typography } from "@mui/material";
import { useState } from "react";

/**
 * Settings menu — a gear button opening app settings. A placeholder for now: the
 * light/dark toggle it used to hold went with the light theme, and the settings that
 * replace it (config-driven options, per-user preferences) haven't landed yet.
 */
export function SettingsMenu() {
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
        <MenuItem disabled>
          <Typography variant="body2">Settings — coming soon</Typography>
        </MenuItem>
      </Menu>
    </>
  );
}
