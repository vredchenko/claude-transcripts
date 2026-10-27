#!/usr/bin/env bun
/**
 * Generate deploy/helm/claude-transcripts/ — a Helm chart — from the blueprint. The chart
 * is a PROJECTION (toHelmChart), the sibling of the compose file and the kustomize base:
 * generated, committed, diff-checked by CI. Re-run after changing the blueprint's SERVICES;
 * release.ts re-runs it, as the chart is versioned with the lockstep release.
 *
 *   bun run scripts/gen-helm.ts   (or: bun run gen:helm)
 *
 * The one hand-written input is deploy/helm/provision.ts (the provisioning hook's script),
 * copied into the chart's files/ so the packaged chart is self-contained.
 */
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { buildAppBlueprint, HELM_CHART_NAME, toHelmChart } from "@claude-transcripts/shared";
import { Document, stringify } from "yaml";
import { loadConfigTemplate } from "./lib/config-file";

const ROOT = join(import.meta.dir, "..");
const OUT = join(ROOT, "deploy", "helm", HELM_CHART_NAME);
// The committed template and an empty env, like every generator whose output CI diffs:
// a contributor's own config.json or shell must not change the bytes.
const model = buildAppBlueprint(loadConfigTemplate(ROOT), {});

const files = { "./garage.toml": await Bun.file(join(ROOT, "deploy", "garage.toml")).text() };
const { version: releaseVersion } = (await Bun.file(join(ROOT, "package.json")).json()) as {
  version: string;
};
const chart = toHelmChart(model, { files, releaseVersion });

const HEADER = [
  "GENERATED from the blueprint (@claude-transcripts/shared) by scripts/gen-helm.ts.",
  "Do NOT edit by hand — run `bun run gen:helm` to regenerate, and change the blueprint",
  "(packages/shared/src/blueprint/services.ts, helm.ts) instead. See deploy/helm/README.md.",
];
const hashHeader = HEADER.map((l) => `# ${l}`).join("\n");
// Same serialisation rules as gen-k8s: no anchors, no line folding.
const yaml = (o: unknown) => stringify(o, { aliasDuplicateObjects: false, lineWidth: 0 });

await rm(OUT, { recursive: true, force: true });
await mkdir(join(OUT, "templates"), { recursive: true });
await mkdir(join(OUT, "files"), { recursive: true });

await Bun.write(join(OUT, "Chart.yaml"), `${hashHeader}\n${yaml(chart.chart)}`);

const values = new Document(chart.values, { aliasDuplicateObjects: false });
for (const [path, comment] of Object.entries(chart.valuesComments)) {
  const node = values.getIn(path.split("."), true) as { commentBefore?: string } | undefined;
  const pair = values.contents && "items" in values.contents ? values.contents : undefined;
  const item = pair?.items.find((i) => String((i.key as { value?: unknown })?.value) === path);
  if (item?.key && typeof item.key === "object") {
    (item.key as { commentBefore?: string }).commentBefore = comment;
  } else if (node) node.commentBefore = comment;
}
await Bun.write(join(OUT, "values.yaml"), `${hashHeader}\n\n${values.toString({ lineWidth: 0 })}`);

for (const t of chart.templates) {
  const body = chart.render(t.objects.map(yaml).join("---\n"));
  const wrapped = t.condition ? `{{- if ${t.condition} }}\n${body}{{- end }}\n` : body;
  await Bun.write(join(OUT, "templates", t.name), `${hashHeader}\n${wrapped}`);
}
for (const [name, text] of Object.entries(chart.rawTemplates)) {
  await Bun.write(join(OUT, "templates", name), text);
}

await Bun.write(
  join(OUT, "files", "provision.ts"),
  await Bun.file(join(ROOT, "deploy", "helm", "provision.ts")).text(),
);
await Bun.write(
  join(OUT, ".helmignore"),
  `${hashHeader}\n# Nothing to ignore: every file here belongs in the package.\n`,
);

console.log(
  `[gen-helm] wrote deploy/helm/${HELM_CHART_NAME}/ (${chart.templates.length} templates; v${releaseVersion})`,
);
