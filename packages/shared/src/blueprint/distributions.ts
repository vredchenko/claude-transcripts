import { SERVICES } from "./services";

/**
 * Every artefact the project ships, and what each one bundles — the source of
 * docs/reference/distributions.md (`bun run gen:distributions`).
 *
 * Without this, "what's in the app image" or "does the k8s base carry Fossil" was
 * answered by reading a Dockerfile, a compose file and five workflows. Wherever the
 * answer is already a fact about SERVICES (which images are mirrored, which are built
 * from source, what the compose stack and the kustomize base run), it is derived from
 * SERVICES rather than listed, so adding a service updates the table on its own.
 *
 * A new way of shipping the stack (another image, a chart, a package) adds a row here;
 * distributions.test.ts fails if a published image belongs to no row.
 */

/** A column of the table: a service from SERVICES, or a part that isn't one. */
export type ComponentKey =
  | "webapi"
  | "webui"
  | "docs"
  | "cli"
  | "plugin"
  | "couchdb"
  | "garage"
  | "garage-ui"
  | "fossil"
  | "meilisearch"
  | "meilisearch-ui";

export interface ComponentDef {
  key: ComponentKey;
  label: string;
}

/** The table's columns, in order: the app's own parts, then the backing services. */
export const COMPONENTS: ComponentDef[] = [
  { key: "webapi", label: "webapi" },
  { key: "webui", label: "webui" },
  { key: "docs", label: "docs" },
  { key: "cli", label: "CLI" },
  { key: "plugin", label: "plugin" },
  { key: "couchdb", label: "CouchDB" },
  { key: "garage", label: "Garage" },
  { key: "garage-ui", label: "Garage UI" },
  { key: "fossil", label: "Fossil" },
  { key: "meilisearch", label: "Meilisearch" },
  { key: "meilisearch-ui", label: "Meili UI" },
];

/** Components that are not entries in SERVICES (the rest are, by key). */
export const NON_SERVICE_COMPONENTS: ComponentKey[] = ["docs", "plugin"];

export type DistributionKind = "image" | "compose" | "kubernetes" | "binary" | "npm" | "plugin";

export interface DistributionDef {
  key: string;
  title: string;
  kind: DistributionKind;
  /** What it carries (an image) or runs (a deploy definition). */
  contains: ComponentKey[];
  /** Carried or run only on request (compose's opt-in `app` profile). */
  optional?: ComponentKey[];
  /** The blueprint image names (`image.name`) it publishes, if it publishes images. */
  images?: string[];
  /** Where to get it. `<owner>` is the GitHub owner of the instance's repository. */
  publishedAt: string;
  /** Repo-relative files that build or define it: workflows, scripts, Dockerfiles. */
  builtBy: string[];
  /** Platforms it is built for, or what it runs on. */
  platforms: string;
  note: string;
}

/** The app's own parts, as the app image carries them. */
const APP_PARTS: ComponentKey[] = ["webapi", "webui", "docs", "cli"];

const isComponent = (k: string): k is ComponentKey => COMPONENTS.some((c) => c.key === k);

/** Services with an image, as components (the `app` service expands to its parts). */
function deployed(roles: string[]): ComponentKey[] {
  const out: ComponentKey[] = [];
  for (const s of SERVICES) {
    if (!s.image || !roles.includes(s.role)) continue;
    if (s.role === "app") out.push(...APP_PARTS);
    else if (isComponent(s.key)) out.push(s.key);
  }
  return out;
}

const mirrored = SERVICES.filter((s) => s.image?.upstream);
const built = SERVICES.filter((s) => s.image?.build);
const backing = deployed(["backing", "admin-ui"]);

export const DISTRIBUTIONS: DistributionDef[] = [
  {
    key: "app-image",
    title: "App image",
    kind: "image",
    contains: APP_PARTS,
    images: ["app"],
    publishedAt: "ghcr.io/<owner>/claude-transcripts-app",
    builtBy: ["Dockerfile", ".github/workflows/publish-image.yml"],
    platforms: "linux/amd64",
    note: "webapi serving the webui (/app), docs (/docs) and the CLI binary (/cli/download). Release tags, plus `main`.",
  },
  {
    key: "compose",
    title: "Compose stack",
    kind: "compose",
    contains: backing,
    optional: APP_PARTS,
    publishedAt:
      "deploy/ in the repo; `install` writes it under ~/.local/share/claude-transcripts/deploy/",
    builtBy: [
      "scripts/gen-compose.ts",
      "scripts/gen-compose-override.ts",
      "deploy/docker-compose.yml",
      "deploy/docker-compose.upstream.yml",
    ],
    platforms: "whatever its images support",
    note: "The app is the opt-in `app` profile. Pulls the mirror, or the public upstream images with --upstream (what `install` uses).",
  },
  {
    key: "kustomize",
    title: "Kubernetes base (kustomize)",
    kind: "kubernetes",
    contains: deployed(["backing", "admin-ui", "app"]),
    publishedAt: "deploy/k8s/base/ in the repo",
    builtBy: ["scripts/gen-k8s.ts", "deploy/k8s/base/kustomization.yaml"],
    platforms: "whatever its images support",
    note: "`kubectl apply -k`; pinned upstream images, the app at the checkout's release tag. ClusterIP only: exposing it is an overlay's call.",
  },
  {
    key: "mirrored-images",
    title: "Mirrored backing images",
    kind: "image",
    contains: mirrored.map((s) => s.key).filter(isComponent),
    images: mirrored.map((s) => s.image?.name ?? s.key),
    publishedAt: "ghcr.io/<owner>/claude-transcripts-<service>",
    builtBy: ["scripts/mirror-images.ts", ".github/workflows/mirror-images.yml"],
    platforms: "linux/amd64 (the runner's platform, pulled and re-pushed)",
    note: "Upstream images re-tagged under the project's names, so the stack can pull only from your registry (ADR 0024).",
  },
  {
    key: "built-images",
    title: "Backing images built from source",
    kind: "image",
    contains: built.map((s) => s.key).filter(isComponent),
    images: built.map((s) => s.image?.name ?? s.key),
    publishedAt: "ghcr.io/<owner>/claude-transcripts-<service>",
    builtBy: [
      "deploy/fossil/Dockerfile",
      "scripts/mirror-images.ts",
      ".github/workflows/mirror-images.yml",
    ],
    platforms: "linux/amd64",
    note: "For software that publishes no image. `--upstream` and `install` build it locally instead.",
  },
  {
    key: "cli-binaries",
    title: "CLI binaries",
    kind: "binary",
    contains: ["cli"],
    publishedAt: "GitHub Releases, claude-transcripts-<os>-<arch> + .sha256",
    builtBy: [".github/workflows/release-cli.yml", "install.sh"],
    platforms: "linux-x64, linux-arm64, darwin-x64, darwin-arm64",
    note: "Self-contained (Bun runtime embedded). install.sh fetches and verifies one, then runs `install`.",
  },
  {
    key: "npm",
    title: "npm package",
    kind: "npm",
    contains: ["cli"],
    publishedAt: "npm: @claude-transcripts/cli",
    builtBy: ["scripts/build-cli-npm.ts", ".github/workflows/release-cli.yml"],
    platforms: "anywhere Bun runs",
    note: "A bun-runnable bundle, no dependencies (`bunx @claude-transcripts/cli`). Needs Bun; the binaries don't.",
  },
  {
    key: "plugin",
    title: "Claude Code plugin",
    kind: "plugin",
    contains: ["plugin"],
    publishedAt: "this repo as a plugin marketplace (.claude-plugin/marketplace.json → hooks/)",
    builtBy: [".claude-plugin/marketplace.json", "hooks/"],
    platforms: "anywhere Claude Code runs; needs Bun and the CLI",
    note: "A thin shim: every hook event goes to `claude-transcripts hook run`.",
  },
];

/** docs/reference/distributions.md's generated region: the matrix, then the details. */
export function toDistributionsDoc(dists: DistributionDef[] = DISTRIBUTIONS): string {
  const mark = (d: DistributionDef, c: ComponentKey) =>
    d.contains.includes(c) ? "●" : d.optional?.includes(c) ? "○" : "";
  const head = ["Distribution", ...COMPONENTS.map((c) => c.label)];
  const rows = dists.map((d) => [d.title, ...COMPONENTS.map((c) => mark(d, c.key))]);
  // `<owner>` and friends are placeholders, not HTML tags; unescaped they render as nothing.
  const esc = (cell: string) => cell.replaceAll("<", "&lt;").replaceAll(">", "&gt;");
  const line = (cells: string[]) => `| ${cells.map(esc).join(" | ")} |`;
  const matrix = [
    line(head),
    line(head.map((_, i) => (i === 0 ? "---" : ":-:"))),
    ...rows.map(line),
  ];

  const details = [
    line(["Distribution", "Kind", "Platforms", "Published at", "Built by"]),
    line(["---", "---", "---", "---", "---"]),
    ...dists.map((d) =>
      line([
        d.title,
        d.kind,
        d.platforms,
        d.publishedAt,
        d.builtBy.map((f) => `\`${f}\``).join(", "),
      ]),
    ),
  ];

  const notes = dists.map((d) => `- **${d.title}**: ${esc(d.note)}`);

  return [...matrix, "", "● carried or run · ○ on request", "", ...details, "", ...notes].join(
    "\n",
  );
}
