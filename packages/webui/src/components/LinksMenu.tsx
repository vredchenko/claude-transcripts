import { Button, ListSubheader, Menu, MenuItem } from "@mui/material";
import { useState } from "react";

/**
 * Secondary (links) menu — quick links to the backing-service dashboards, this
 * app's own API surface, the source repo, and the technical docs.
 *
 * The service/API URLs are **placeholders** hard-coded to the bundled dev defaults
 * (the 7650–7661 range). The intended shape is to feed them from the `/api/model`
 * `servicesMenu` (config-driven) so they follow a deployment's real ports/hosts —
 * tracked as #14. App-relative links (`/api/...`) resolve against the current
 * origin, so they work in dev (Vite proxy) and the combined prod image alike.
 *
 * Tech docs are served from the combined image at `/docs` (rendered from `docs/`
 * by scripts/build-docs.ts); app-relative so it works in dev and prod alike.
 */
const REPO_URL = "https://github.com/vredchenko/claude-transcripts";

interface LinkDef {
  label: string;
  href: string;
}
interface LinkGroup {
  heading: string;
  links: LinkDef[];
}

const GROUPS: LinkGroup[] = [
  {
    heading: "This app",
    links: [
      { label: "Technical docs", href: "/docs" },
      { label: "API reference (Scalar)", href: "/api/docs" },
      { label: "OpenAPI spec (JSON)", href: "/api/openapi.json" },
      { label: "App model (JSON)", href: "/api/model" },
    ],
  },
  {
    heading: "Services",
    links: [
      { label: "CouchDB · Fauxton", href: "http://127.0.0.1:7652/_utils/" },
      {
        label: "CouchDB · _all_docs (JSON)",
        href: "http://127.0.0.1:7652/claude-transcripts-sessions/_all_docs?include_docs=true&limit=50",
      },
      { label: "Garage · Web UI", href: "http://127.0.0.1:7655/" },
      { label: "Garage · buckets", href: "http://127.0.0.1:7655/buckets" },
      { label: "Meilisearch · UI", href: "http://127.0.0.1:7657/" },
      { label: "Meilisearch · API", href: "http://127.0.0.1:7656/" },
    ],
  },
  {
    heading: "Project",
    links: [
      { label: "GitHub repository", href: REPO_URL },
      { label: "Docs source (Markdown)", href: `${REPO_URL}/tree/main/docs` },
    ],
  },
];

export function LinksMenu() {
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  const open = Boolean(anchor);

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
      <Menu anchorEl={anchor} open={open} onClose={() => setAnchor(null)}>
        {GROUPS.flatMap((group) => [
          <ListSubheader key={`h-${group.heading}`} disableSticky>
            {group.heading}
          </ListSubheader>,
          ...group.links.map((link) => (
            <MenuItem
              key={link.href}
              component="a"
              href={link.href}
              target="_blank"
              rel="noopener noreferrer"
              onClick={() => setAnchor(null)}
            >
              {link.label}
            </MenuItem>
          )),
        ])}
      </Menu>
    </>
  );
}
