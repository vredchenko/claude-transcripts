/**
 * The header menus (Services, Dev, About) and a session's resource links, projected
 * from the app model served at `GET /api/model`.
 *
 * Pure functions over {@link AppModelInfo} so the shape of each menu is testable
 * without rendering, and so nothing here restates a fact the model already holds: a
 * service's name, icon, admin UI and stores all come from `services` + `topology` +
 * `stores`, the Dev entries from `routes`, the About links from `identity.repository`.
 * Add a service, a store or a route to the model and the menus follow.
 */
import type { IconKey, StoreModel } from "@claude-transcripts/shared";
import { type AppModelInfo, couchProxyUrl, fauxtonUrlFor } from "./api/model";

export interface NavLink {
  label: string;
  href: string;
  /** Second line under the label — a path, a URL, a store name. */
  subline?: string;
  /** Tooltip text — the model's one-line summary, where it has one. */
  title?: string;
  /** Opens in a new tab: anything off this origin, and raw JSON/blobs. */
  external?: boolean;
}

/** One store (database, bucket, index or repository) inside a service, with where to look at it. */
export interface StoreEntry {
  kind: keyof StoreModel;
  /** Logical key in the model, e.g. "sessions". */
  key: string;
  /** The real name behind the key. */
  name: string;
  /** Through the read-only proxy, or the service's own endpoint. */
  href?: string;
  /** The same store in the service's admin UI, when one is linked. */
  adminHref?: string;
  /** What that admin UI is called on the link, e.g. "fauxton". */
  adminLabel?: string;
}

export interface ServiceGroup {
  /** The service key, or "other" for operator links no service claims. */
  key: string;
  label: string;
  caption?: string;
  icon?: IconKey;
  links: NavLink[];
  stores: StoreEntry[];
}

/**
 * The Services menu: one group per backing service the topology draws as a store or
 * index, in topology order — CouchDB, Garage, Meilisearch, Fossil for the bundled stack.
 *
 * Each group carries the service's admin UIs (the topology's `admin-ui` nodes that
 * stand for the service or for a service that depends on it) and the stores it holds.
 * A service whose feature is switched off is left out. `servicesMenu` entries no
 * service claims — links an operator added in config — land in a trailing "Other"
 * group rather than being dropped.
 */
export function servicesMenuGroups(model: AppModelInfo | undefined): ServiceGroup[] {
  const services = model?.services ?? [];
  const nodes = model?.topology?.nodes ?? [];
  const menu = model?.servicesMenu ?? {};
  const claimed = new Set<string>();
  const groups: ServiceGroup[] = [];

  for (const node of nodes) {
    if (node.role !== "store" && node.role !== "index") continue;
    if (node.requiresFeature && model?.features?.[node.requiresFeature] === false) continue;
    const svc = services.find((s) => s.key === node.serviceKey);
    if (!svc) continue;

    const links: NavLink[] = [];
    for (const adminNode of nodes) {
      if (adminNode.role !== "admin-ui") continue;
      const adminSvc = services.find((s) => s.key === adminNode.serviceKey);
      if (!adminSvc?.adminUiServiceKey) continue;
      if (adminSvc.key !== svc.key && !adminSvc.dependsOn?.includes(svc.key)) continue;
      const href = menu[adminSvc.adminUiServiceKey];
      if (!href || claimed.has(adminSvc.adminUiServiceKey)) continue;
      claimed.add(adminSvc.adminUiServiceKey);
      links.push({
        label: adminNode.label ?? adminSvc.name,
        href,
        subline: href,
        title: adminNode.summary,
        external: true,
      });
    }
    // A service that is its own UI (Meilisearch serves a dashboard on `/`) has no
    // separate admin-ui node to find it by.
    const ownUrl = svc.adminUiServiceKey ? menu[svc.adminUiServiceKey] : undefined;
    if (svc.adminUiServiceKey && ownUrl && !claimed.has(svc.adminUiServiceKey)) {
      claimed.add(svc.adminUiServiceKey);
      links.push({ label: "Endpoint", href: ownUrl, subline: ownUrl, external: true });
    }

    groups.push({
      key: svc.key,
      label: node.label ?? svc.name,
      caption: node.caption,
      icon: node.icon,
      links,
      stores: storesOf(model, svc.holds, ownUrl),
    });
  }

  const other: NavLink[] = Object.entries(menu)
    .filter(([key]) => !claimed.has(key))
    .map(([key, href]) => ({ label: key, href, subline: href, external: true }));
  if (other.length > 0) groups.push({ key: "other", label: "Other", links: other, stores: [] });

  return groups;
}

function storesOf(
  model: AppModelInfo | undefined,
  kind: keyof StoreModel | undefined,
  serviceUrl: string | undefined,
): StoreEntry[] {
  if (!kind) return [];
  const fauxton = model?.servicesMenu?.couchdbFauxton;
  return Object.entries(model?.stores?.[kind] ?? {}).map(([key, name]) => {
    const entry: StoreEntry = { kind, key, name };
    if (kind === "databases") {
      entry.href = couchProxyUrl(name, "");
      if (fauxton) {
        entry.adminHref = fauxtonUrlFor(fauxton, name, "_all_docs");
        entry.adminLabel = "fauxton";
      }
    } else if (kind === "indexes" && serviceUrl) {
      entry.href = `${serviceUrl.replace(/\/+$/, "")}/indexes/${encodeURIComponent(name)}`;
    } else if (kind === "repositories") {
      // The JSON proxy is keyed by the logical key, like the S3 one; Fossil itself serves
      // each repository's web UI at /<name>/.
      entry.href = `/api/fossil/${encodeURIComponent(key)}/json/timeline/checkin`;
      if (serviceUrl) {
        entry.adminHref = `${serviceUrl.replace(/\/+$/, "")}/${encodeURIComponent(name)}/`;
        entry.adminLabel = "web ui";
      }
    }
    // Buckets have no browsable URL: the S3 proxy serves objects, not listings.
    return entry;
  });
}

export interface NavSection {
  heading: string;
  links: NavLink[];
}

/** The Dev menu: the gateway's browsable routes (those the model marks `nav`), by section. */
export function devMenuSections(model: AppModelInfo | undefined): NavSection[] {
  const sections = new Map<string, NavLink[]>();
  for (const route of model?.routes ?? []) {
    if (!route.nav) continue;
    const links = sections.get(route.nav.section) ?? [];
    links.push({
      label: route.nav.label,
      href: route.path,
      subline: route.path,
      title: route.serves,
    });
    sections.set(route.nav.section, links);
  }
  return [...sections].map(([heading, links]) => ({ heading, links }));
}

/** The About menu's project links, all derived from the repository URL. */
export function aboutLinks(model: AppModelInfo | undefined): NavLink[] {
  const repo = model?.identity?.repository?.replace(/\/+$/, "");
  if (!repo) return [];
  const short = repo.replace(/^https?:\/\/(www\.)?github\.com\//, "");
  return [
    { label: "Source repository", href: repo, subline: short, external: true },
    { label: "Issues", href: `${repo}/issues`, subline: `${short}/issues`, external: true },
    { label: "Docs source", href: `${repo}/tree/main/docs`, subline: "Markdown", external: true },
    { label: "License", href: `${repo}/blob/main/LICENSE`, subline: "LICENSE", external: true },
  ];
}

/** What a session's resource links need to know about it. */
export interface SessionRef {
  sessionId: string;
  status: string;
  hasTranscript: boolean;
}

/**
 * Where one session's data lives, as links: the API's view of it, its raw CouchDB
 * documents through the read-only proxy (and in Fauxton when linked), and its
 * transcript blob through the S3 proxy.
 *
 * The summary doc is only written at SessionEnd, so a live or abandoned session gets
 * its events instead — linking a summary that doesn't exist yet would be a 404. The
 * transcript link likewise waits for `hasTranscript`.
 */
export function sessionLinks(model: AppModelInfo | undefined, s: SessionRef): NavLink[] {
  const id = s.sessionId;
  const links: NavLink[] = [
    { label: "API JSON", href: `/api/sessions/${encodeURIComponent(id)}`, external: true },
  ];

  const db = model?.stores?.databases?.sessions;
  if (db) {
    const events = `_design/events/_view/by_session?startkey=${encodeURIComponent(
      JSON.stringify([id]),
    )}&endkey=${encodeURIComponent(JSON.stringify([id, {}]))}`;
    links.push({ label: "CouchDB events", href: couchProxyUrl(db, events), external: true });
    if (s.status === "ended") {
      const summaryId = encodeURIComponent(`summary:${id}`);
      links.push({
        label: "CouchDB summary",
        href: couchProxyUrl(db, summaryId),
        external: true,
      });
      const fauxton = model?.servicesMenu?.couchdbFauxton;
      if (fauxton) {
        links.push({
          label: "Fauxton",
          href: fauxtonUrlFor(fauxton, db, summaryId),
          external: true,
        });
      }
    }
  }

  if (s.hasTranscript && model?.stores?.buckets?.sessions) {
    links.push({
      label: "Transcript (S3)",
      href: `/api/s3/sessions/${encodeURIComponent(id)}/transcript.jsonl`,
      external: true,
    });
  }
  return links;
}
