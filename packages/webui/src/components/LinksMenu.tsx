/**
 * Links popover — quick links to the backing-service dashboards, CouchDB design
 * views, this app's own API surface, the source repo, and the technical docs.
 *
 * Grouped: THIS APP, COUCHDB, SERVICES, PROJECT.
 */
import { Box, Button, Popover, Stack, Typography, useTheme } from "@mui/material";
import { useMemo, useState } from "react";
import { useAppModel } from "../api/model";
import { MONO } from "../theme";

const REPO_URL = "https://github.com/vredchenko/claude-transcripts";

const SERVICE_LABELS: Record<string, string> = {
  couchdbFauxton: "CouchDB · Fauxton",
  garageWebui: "Garage · Web UI",
  meilisearch: "Meilisearch · API",
  meilisearchUi: "Meilisearch · UI",
};

interface LinkItem {
  label: string;
  subline?: string;
  href: string;
  icon?: string;
  external?: boolean;
  indent?: boolean;
}

interface LinkGroup {
  heading: string;
  links: LinkItem[];
}

function LinkRow({ link, onClose }: { link: LinkItem; onClose: () => void }) {
  const theme = useTheme();
  return (
    <Box
      component="a"
      href={link.href}
      target={link.external ? "_blank" : undefined}
      rel={link.external ? "noopener noreferrer" : undefined}
      onClick={onClose}
      sx={{
        display: "flex",
        alignItems: "center",
        gap: 1,
        px: 2,
        py: 0.75,
        ml: link.indent ? 2 : 0,
        textDecoration: "none",
        color: "text.primary",
        borderRadius: 0.5,
        "&:hover": { bgcolor: "action.hover" },
      }}
    >
      {link.icon && (
        <Typography sx={{ fontSize: 14, width: 20, textAlign: "center", flexShrink: 0 }}>
          {link.icon}
        </Typography>
      )}
      <Box sx={{ flex: 1, minWidth: 0 }}>
        <Typography variant="body2" sx={{ lineHeight: 1.4 }}>
          {link.label}
        </Typography>
        {link.subline && (
          <Typography
            variant="caption"
            color="text.secondary"
            sx={{ fontFamily: MONO, fontSize: 10, display: "block" }}
          >
            {link.subline}
          </Typography>
        )}
      </Box>
      {link.external && (
        <Typography sx={{ fontSize: 11, color: theme.palette.text.secondary }}>↗</Typography>
      )}
    </Box>
  );
}

export function LinksMenu() {
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  const open = Boolean(anchor);
  const { data: model } = useAppModel();
  const close = () => setAnchor(null);

  const groups = useMemo(() => {
    const result: LinkGroup[] = [];

    // THIS APP
    result.push({
      heading: "THIS APP",
      links: [
        { label: "Technical docs", subline: "/docs", href: "/docs", icon: "📖" },
        { label: "API reference", subline: "Scalar", href: "/api/docs", icon: "⚡" },
        { label: "OpenAPI spec", subline: "JSON", href: "/api/openapi.json", icon: "{}" },
        { label: "App model", subline: "JSON", href: "/api/model", icon: "🔧" },
        { label: "Download CLI", subline: "binary", href: "/cli/download", icon: "⬇" },
      ],
    });

    // COUCHDB — design view links from servicesMenu
    const fauxtonUrl = model?.servicesMenu?.couchdbFauxton;
    if (fauxtonUrl) {
      const couchLinks: LinkItem[] = [
        {
          label: "Fauxton",
          subline: fauxtonUrl,
          href: fauxtonUrl,
          icon: "🗄",
          external: true,
        },
      ];

      const KNOWN_DESIGNS: Record<string, string[]> = {
        sessions: ["by_date", "by_cwd"],
        events: ["by_session", "by_type"],
        tools: ["usage", "failures", "errors"],
        activity: ["timeline"],
        chunks: ["by_session", "entry_count_by_session", "entries_by_session"],
        session_meta: ["start_meta", "tokens_by_date"],
        session_index: ["aggregate", "event_times"],
      };

      for (const [design, views] of Object.entries(KNOWN_DESIGNS)) {
        for (const view of views) {
          couchLinks.push({
            label: `${design}/${view}`,
            subline: `_design/${design}/_view/${view}`,
            href: `${fauxtonUrl}/#/database/sessions/_design/${design}/_view/${view}`,
            icon: "🔍",
            external: true,
            indent: true,
          });
        }
      }

      result.push({ heading: "COUCHDB", links: couchLinks });
    }

    // SERVICES
    const serviceLinks: LinkItem[] = Object.entries(model?.servicesMenu ?? {})
      .filter(([key]) => key !== "couchdbFauxton")
      .map(([key, href]) => ({
        label: SERVICE_LABELS[key] ?? key,
        subline: href,
        href,
        icon: "🔌",
        external: true,
      }))
      .sort((a, b) => a.label.localeCompare(b.label));

    if (serviceLinks.length > 0) {
      result.push({ heading: "SERVICES", links: serviceLinks });
    }

    // PROJECT
    result.push({
      heading: "PROJECT",
      links: [
        {
          label: "GitHub repository",
          subline: "vredchenko/claude-transcripts",
          href: REPO_URL,
          icon: "📦",
          external: true,
        },
        {
          label: "Docs source",
          subline: "Markdown",
          href: `${REPO_URL}/tree/main/docs`,
          icon: "📄",
          external: true,
        },
      ],
    });

    return result;
  }, [model]);

  return (
    <>
      <Button
        size="small"
        color="inherit"
        onClick={(e) => setAnchor(e.currentTarget)}
        aria-haspopup="true"
        aria-expanded={open ? "true" : undefined}
      >
        Links ▾
      </Button>
      <Popover
        anchorEl={anchor}
        open={open}
        onClose={close}
        anchorOrigin={{ vertical: "bottom", horizontal: "right" }}
        transformOrigin={{ vertical: "top", horizontal: "right" }}
        slotProps={{
          paper: { sx: { width: 360, maxHeight: "80vh", overflow: "auto", py: 1 } },
        }}
      >
        {groups.map((group) => (
          <Box key={group.heading}>
            <Typography
              variant="caption"
              color="text.secondary"
              sx={{
                display: "block",
                px: 2,
                pt: 1.5,
                pb: 0.5,
                fontWeight: 700,
                letterSpacing: 1,
                fontSize: 9.5,
              }}
            >
              {group.heading}
            </Typography>
            <Stack spacing={0}>
              {group.links.map((link) => (
                <LinkRow key={link.href} link={link} onClose={close} />
              ))}
            </Stack>
          </Box>
        ))}
      </Popover>
    </>
  );
}
