/**
 * The header's Services, Dev and About menus. Everything listed is projected from the
 * app model (see `nav-menus.ts`); this file only lays it out.
 */
import { Box, Button, Chip, Popover, Stack, Tooltip, Typography } from "@mui/material";
import { useQuery } from "@tanstack/react-query";
import { type ReactNode, useState } from "react";
import { couchProxyUrl, useAppModel } from "../../api/model";
import { displayVersion } from "../../format";
import {
  aboutLinks,
  devMenuSections,
  type NavLink,
  type ServiceGroup,
  type StoreEntry,
  servicesMenuGroups,
} from "../../nav-menus";
import { MONO } from "../../theme";
import { ServiceIcon } from "./ServiceIcon";

/** A header button that opens a popover panel; the panel closes on any link click. */
function HeaderMenu({
  label,
  width,
  children,
}: {
  label: string;
  width: number;
  children: (close: () => void) => ReactNode;
}) {
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  const open = Boolean(anchor);
  const close = () => setAnchor(null);
  return (
    <>
      <Button
        size="small"
        color="inherit"
        onClick={(e) => setAnchor(e.currentTarget)}
        aria-haspopup="true"
        aria-expanded={open ? "true" : undefined}
        sx={{ textTransform: "none", fontWeight: 500, minWidth: 0, px: 1 }}
      >
        {label} ▾
      </Button>
      <Popover
        anchorEl={anchor}
        open={open}
        onClose={close}
        anchorOrigin={{ vertical: "bottom", horizontal: "right" }}
        transformOrigin={{ vertical: "top", horizontal: "right" }}
        slotProps={{
          paper: {
            sx: {
              width,
              maxWidth: "calc(100vw - 32px)",
              maxHeight: "80vh",
              overflow: "auto",
              py: 0.5,
              border: 1,
              borderColor: "divider",
            },
          },
        }}
      >
        {children(close)}
      </Popover>
    </>
  );
}

function SectionHeading({ children, icon }: { children: ReactNode; icon?: ReactNode }) {
  return (
    <Stack direction="row" alignItems="center" spacing={1} sx={{ px: 1.5, pt: 1, pb: 0.25 }}>
      {icon}
      <Typography
        variant="caption"
        color="text.secondary"
        sx={{ fontWeight: 700, letterSpacing: 0.8, fontSize: 10, textTransform: "uppercase" }}
      >
        {children}
      </Typography>
    </Stack>
  );
}

/** One link on a single line: label left, subline right, both truncating. */
function LinkRow({
  link,
  onClose,
  icon,
}: {
  link: NavLink;
  onClose: () => void;
  icon?: ReactNode;
}) {
  const row = (
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
        px: 1.5,
        py: 0.5,
        mx: 0.5,
        borderRadius: 1,
        textDecoration: "none",
        color: "text.primary",
        "&:hover": { bgcolor: "action.hover" },
      }}
    >
      {icon}
      <Typography variant="body2" noWrap sx={{ flexShrink: 0 }}>
        {link.label}
      </Typography>
      <Typography
        variant="caption"
        color="text.secondary"
        noWrap
        sx={{ fontFamily: MONO, fontSize: 10.5, flex: 1, minWidth: 0, textAlign: "right" }}
      >
        {link.subline}
      </Typography>
      {link.external && (
        <Typography variant="caption" color="text.secondary" sx={{ flexShrink: 0 }}>
          ↗
        </Typography>
      )}
    </Box>
  );
  return link.title ? (
    <Tooltip title={link.title} placement="left" enterDelay={600}>
      {row}
    </Tooltip>
  ) : (
    row
  );
}

/** A small link styled as a chip — views and per-store shortcuts. */
function LinkChip({ label, href, onClose }: { label: string; href: string; onClose: () => void }) {
  return (
    <Chip
      component="a"
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      onClick={onClose}
      clickable
      size="small"
      variant="outlined"
      label={label}
      sx={{ fontFamily: MONO, fontSize: 10.5, height: 22 }}
    />
  );
}

interface DesignDocsResponse {
  rows?: { doc?: { _id?: string; views?: Record<string, unknown> } }[];
}

/**
 * A database's design views, read from the database itself through the read-only
 * proxy — so the list is whatever the migrations actually installed, not a copy of
 * it. Fetched only while the menu is open (the popover mounts its content lazily).
 */
function DatabaseViews({ db, onClose }: { db: string; onClose: () => void }) {
  const { data } = useQuery({
    queryKey: ["couch-design-docs", db],
    queryFn: async () => {
      const path = `_all_docs?startkey=${encodeURIComponent('"_design/"')}&endkey=${encodeURIComponent('"_design0"')}&include_docs=true`;
      const res = await fetch(couchProxyUrl(db, path));
      if (!res.ok) throw new Error(`${res.status}`);
      return (await res.json()) as DesignDocsResponse;
    },
    staleTime: 5 * 60_000,
    retry: false,
  });
  const views = (data?.rows ?? []).flatMap((r) => {
    const design = r.doc?._id?.replace(/^_design\//, "");
    return design ? Object.keys(r.doc?.views ?? {}).map((v) => ({ design, view: v })) : [];
  });
  if (views.length === 0) return null;
  return (
    <Box sx={{ display: "flex", flexWrap: "wrap", gap: 0.5, px: 2, pt: 0.5, pb: 0.75 }}>
      {views.map(({ design, view }) => (
        <LinkChip
          key={`${design}/${view}`}
          label={`${design}/${view}`}
          href={couchProxyUrl(db, `_design/${design}/_view/${view}?limit=100`)}
          onClose={onClose}
        />
      ))}
    </Box>
  );
}

const STORE_NOUN: Record<StoreEntry["kind"], string> = {
  databases: "database",
  buckets: "bucket",
  indexes: "index",
  repositories: "repo",
};

function StoreRow({ store, onClose }: { store: StoreEntry; onClose: () => void }) {
  return (
    <Box sx={{ mx: 0.5 }}>
      <Stack direction="row" alignItems="center" spacing={1} sx={{ px: 1.5, py: 0.25 }}>
        <Typography variant="caption" color="text.secondary" sx={{ flexShrink: 0, width: 56 }}>
          {STORE_NOUN[store.kind]}
        </Typography>
        <Tooltip title={`${store.key} → ${store.name}`} placement="left" enterDelay={600}>
          <Typography
            variant="caption"
            noWrap
            sx={{ fontFamily: MONO, fontSize: 11, flex: 1, minWidth: 0 }}
          >
            {store.name}
          </Typography>
        </Tooltip>
        {store.href && <LinkChip label="json" href={store.href} onClose={onClose} />}
        {store.adminHref && (
          <LinkChip label={store.adminLabel ?? "admin"} href={store.adminHref} onClose={onClose} />
        )}
      </Stack>
      {store.kind === "databases" && <DatabaseViews db={store.name} onClose={onClose} />}
    </Box>
  );
}

function ServiceSection({ group, onClose }: { group: ServiceGroup; onClose: () => void }) {
  return (
    <Box sx={{ pb: 0.5, "& + &": { borderTop: 1, borderColor: "divider" } }}>
      <Stack direction="row" alignItems="center" spacing={1} sx={{ px: 1.5, pt: 1, pb: 0.5 }}>
        {group.icon && <ServiceIcon icon={group.icon} />}
        <Typography variant="subtitle2" sx={{ fontWeight: 700 }}>
          {group.label}
        </Typography>
        {group.caption && (
          <Typography variant="caption" color="text.secondary">
            {group.caption}
          </Typography>
        )}
      </Stack>
      {group.links.map((link) => (
        <LinkRow key={link.href} link={link} onClose={onClose} />
      ))}
      {group.stores.map((store) => (
        <StoreRow key={`${store.kind}:${store.key}`} store={store} onClose={onClose} />
      ))}
    </Box>
  );
}

export function ServicesMenu() {
  const { data: model } = useAppModel();
  const groups = servicesMenuGroups(model);
  return (
    <HeaderMenu label="Services" width={460}>
      {(close) =>
        groups.length > 0 ? (
          groups.map((g) => <ServiceSection key={g.key} group={g} onClose={close} />)
        ) : (
          <Typography variant="body2" color="text.secondary" sx={{ px: 2, py: 1 }}>
            No services described by the app model.
          </Typography>
        )
      }
    </HeaderMenu>
  );
}

export function DevMenu() {
  const { data: model } = useAppModel();
  const sections = devMenuSections(model);
  return (
    <HeaderMenu label="Dev" width={340}>
      {(close) => (
        <>
          {sections.map((section) => (
            <Box key={section.heading}>
              <SectionHeading>{section.heading}</SectionHeading>
              {section.links.map((link) => (
                <LinkRow key={link.href} link={link} onClose={close} />
              ))}
            </Box>
          ))}
          {/* Placeholder until the plugin has a page of its own to link to. */}
          {!sections.some((s) => s.heading === "Install") && (
            <SectionHeading>Install</SectionHeading>
          )}
          <Stack
            direction="row"
            alignItems="center"
            spacing={1}
            sx={{ px: 1.5, mx: 0.5, py: 0.5, opacity: 0.6 }}
          >
            <ServiceIcon icon="claude" size={14} />
            <Typography variant="body2">Claude Code plugin</Typography>
            <Typography
              variant="caption"
              color="text.secondary"
              sx={{ flex: 1, textAlign: "right", fontSize: 10.5 }}
            >
              coming soon
            </Typography>
          </Stack>
        </>
      )}
    </HeaderMenu>
  );
}

export function AboutMenu() {
  const { data: model } = useAppModel();
  const links = aboutLinks(model);
  const title = model?.identity?.title ?? "Claude Transcripts";
  const version = model?.identity?.version;
  return (
    <HeaderMenu label="About" width={340}>
      {(close) => (
        <>
          <Stack
            direction="row"
            alignItems="center"
            spacing={1.25}
            sx={{ px: 1.5, pt: 1, pb: 0.5 }}
          >
            <ServiceIcon icon="mark" size={28} />
            <Box sx={{ minWidth: 0 }}>
              <Stack direction="row" alignItems="baseline" spacing={0.75}>
                <Typography variant="subtitle2" sx={{ fontWeight: 700, lineHeight: 1.3 }}>
                  {title}
                </Typography>
                {version && (
                  <Typography variant="caption" color="text.secondary" sx={{ fontFamily: MONO }}>
                    {displayVersion(version)}
                  </Typography>
                )}
              </Stack>
              <Typography variant="caption" color="text.secondary" sx={{ display: "block" }}>
                Self-hosted history for Claude Code sessions
              </Typography>
            </Box>
          </Stack>
          {links.length > 0 && <SectionHeading>Project</SectionHeading>}
          {links.map((link) => (
            <LinkRow key={link.href} link={link} onClose={close} />
          ))}
        </>
      )}
    </HeaderMenu>
  );
}
