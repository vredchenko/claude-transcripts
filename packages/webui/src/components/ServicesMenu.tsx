import { Button, ListSubheader, Menu, MenuItem } from "@mui/material";
import { useState } from "react";

/**
 * Header "Services" dropdown — quick links to the backing-service dashboards and
 * the app's own API surface. **Placeholders for now**: the URLs are hard-coded to
 * the bundled dev defaults (the 7650–7661 range). The intended shape is to feed
 * this from the `/` app manifest's `servicesMenu` (config-driven) so it follows
 * whatever ports/hosts a deployment actually uses — tracked as #14.
 *
 * App-relative links (`/api/...`) resolve against the current origin, so they work
 * in dev (Vite proxy) and in the combined prod image alike.
 */
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
      { label: "API reference (Scalar)", href: "/api/docs" },
      { label: "OpenAPI spec (JSON)", href: "/api/openapi.json" },
      { label: "App manifest (/)", href: "/" },
    ],
  },
  {
    heading: "CouchDB",
    links: [
      { label: "Fauxton admin UI", href: "http://127.0.0.1:7652/_utils/" },
      {
        label: "Sessions · _all_docs (JSON)",
        href: "http://127.0.0.1:7652/claude-transcripts-sessions/_all_docs?include_docs=true&limit=50",
      },
    ],
  },
  {
    heading: "Garage (S3)",
    links: [
      { label: "Garage Web UI", href: "http://127.0.0.1:7655/" },
      { label: "Sessions bucket", href: "http://127.0.0.1:7655/buckets" },
    ],
  },
  {
    heading: "Meilisearch",
    links: [
      { label: "Meilisearch UI", href: "http://127.0.0.1:7657/" },
      { label: "Search API", href: "http://127.0.0.1:7656/" },
    ],
  },
];

export function ServicesMenu() {
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
        Services ▾
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
