/**
 * A session's id with its copy button, and the menu of links to where its data lives —
 * shared by the session list and the session detail page so both look the same.
 */
import { Box, IconButton, Menu, MenuItem, SvgIcon, Tooltip, Typography } from "@mui/material";
import { type MouseEvent, useState } from "react";
import { useAppModel } from "../api/model";
import { type SessionRef, sessionLinks } from "../nav-menus";
import { MONO } from "../theme";

/** Material's "content copy" glyph. */
function CopyIcon() {
  return (
    <SvgIcon sx={{ fontSize: 16 }}>
      <path d="M16 1H4c-1.1 0-2 .9-2 2v14h2V3h12V1zm3 4H8c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h11c1.1 0 2-.9 2-2V7c0-1.1-.9-2-2-2zm0 16H8V7h11v14z" />
    </SvgIcon>
  );
}

/** Material's "check" glyph — shown for a moment after copying. */
function CheckIcon() {
  return (
    <SvgIcon sx={{ fontSize: 16 }}>
      <path d="M9 16.17 4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z" />
    </SvgIcon>
  );
}

/** Rows are clickable links to the session; clicks inside these controls must not be. */
function stop(e: MouseEvent) {
  e.stopPropagation();
}

/**
 * The short id and a copy button for the full one, grouped in one outlined control
 * so the button reads as belonging to the id rather than floating at the row's edge.
 */
export function SessionIdCopy({ sessionId }: { sessionId: string }) {
  const [copied, setCopied] = useState(false);
  const copy = (e: MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    navigator.clipboard.writeText(sessionId);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };
  return (
    <Tooltip title={copied ? "Copied!" : `Copy session ID ${sessionId}`}>
      <Box
        component="button"
        type="button"
        onClick={copy}
        aria-label="Copy session ID"
        sx={{
          display: "inline-flex",
          alignItems: "center",
          gap: 0.5,
          pl: 0.75,
          pr: 0.5,
          py: 0.25,
          border: 1,
          borderColor: copied ? "success.main" : "divider",
          borderRadius: 1,
          bgcolor: "transparent",
          color: copied ? "success.main" : "text.primary",
          cursor: "pointer",
          font: "inherit",
          "&:hover": { bgcolor: "action.hover", borderColor: "text.secondary" },
        }}
      >
        <Typography component="span" sx={{ fontFamily: MONO, fontSize: 12 }}>
          {sessionId.slice(0, 8)}
        </Typography>
        {copied ? <CheckIcon /> : <CopyIcon />}
      </Box>
    </Tooltip>
  );
}

/** A "⋯" button opening the session's resource links (API, CouchDB, Fauxton, S3). */
export function SessionLinksButton({ session }: { session: SessionRef }) {
  const { data: model } = useAppModel();
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  const links = sessionLinks(model, session);
  return (
    <>
      <Tooltip title="Open this session's raw data">
        <IconButton
          size="small"
          aria-label="Session data links"
          aria-haspopup="true"
          onClick={(e) => {
            e.stopPropagation();
            setAnchor(e.currentTarget);
          }}
          sx={{ fontSize: 16, width: 28, height: 28 }}
        >
          ⋯
        </IconButton>
      </Tooltip>
      <Menu
        anchorEl={anchor}
        open={Boolean(anchor)}
        onClose={() => setAnchor(null)}
        onClick={stop}
        anchorOrigin={{ vertical: "bottom", horizontal: "right" }}
        transformOrigin={{ vertical: "top", horizontal: "right" }}
        MenuListProps={{ dense: true }}
      >
        {links.map((link) => (
          <MenuItem
            key={link.href}
            component="a"
            href={link.href}
            target="_blank"
            rel="noopener noreferrer"
            onClick={() => setAnchor(null)}
            sx={{ fontSize: 13, gap: 2, justifyContent: "space-between" }}
          >
            {link.label}
            <Typography variant="caption" color="text.secondary">
              ↗
            </Typography>
          </MenuItem>
        ))}
      </Menu>
    </>
  );
}
