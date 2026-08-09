import { Button, ListSubheader, Menu, MenuItem } from "@mui/material";
import { useState } from "react";
import { useAppModel } from "../api/model";

/**
 * Secondary (links) menu — quick links to the backing-service dashboards, this
 * app's own API surface, the source repo, and the technical docs.
 *
 * The backing-service links come from `/api/model`'s `servicesMenu`, which the app
 * model derives from each service's **resolved** host port. They used to be literals
 * pinned to the bundled dev defaults (7652, 7655, …), so on any instance whose ports
 * `install` generated differently — which is most of them — every link in this menu
 * pointed at a closed port.
 *
 * App-relative links (`/api/...`) stay literal: they resolve against the current
 * origin, so they work in dev (Vite proxy) and the combined prod image alike.
 *
 * Tech docs are served from the combined image at `/docs` (rendered from `docs/`
 * by scripts/build-docs.ts); app-relative so it works in dev and prod alike.
 */
/**
 * Display names for the model's `servicesMenu` keys. A key with no entry here still
 * renders — under its own key — so a service added to the model appears in the menu
 * without having to touch this file first.
 */
const SERVICE_LABELS: Record<string, string> = {
  couchdbFauxton: "CouchDB · Fauxton",
  garageWebui: "Garage · Web UI",
  meilisearch: "Meilisearch · API",
  meilisearchUi: "Meilisearch · UI",
};

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
      { label: "Download CLI (binary)", href: "/cli/download" },
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
  const { data: model } = useAppModel();

  // Services come from the model, so they follow this deployment's real ports. The
  // group is omitted entirely when the model is unreachable rather than falling back
  // to defaults — a menu of links that don't work is worse than no menu.
  const serviceLinks: LinkDef[] = Object.entries(model?.servicesMenu ?? {})
    .map(([key, href]) => ({ label: SERVICE_LABELS[key] ?? key, href }))
    .sort((a, b) => a.label.localeCompare(b.label));
  const groups: LinkGroup[] = serviceLinks.length
    ? [GROUPS[0] as LinkGroup, { heading: "Services", links: serviceLinks }, ...GROUPS.slice(1)]
    : GROUPS;

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
        {groups.flatMap((group) => [
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
