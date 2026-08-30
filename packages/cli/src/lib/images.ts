/**
 * Reclaiming superseded app images.
 *
 * An upgrade pulls a new combined app image and leaves the old one on disk. Compose
 * pulls; it never prunes — so nothing in the normal path ever removes the predecessor,
 * and a few releases in, a machine is carrying several hundred megabytes per version it
 * has passed through. That is not a tidiness problem: the next upgrade needs room for a
 * fresh pull, and the failure mode when it doesn't have it is a half-extracted layer.
 *
 * Three deliberate limits on what this touches:
 *
 * - **Only `${IMAGE_NS}/claude-transcripts-app`** — the image the installer itself
 *   pulls. A locally built `claude-transcripts-app:local` is a contributor's own
 *   artifact and not ours to delete, and `docker image prune` would reach clean out of
 *   this instance into whatever else the machine runs.
 * - **Never the tag just installed, nor the one it replaced.** Keeping the predecessor
 *   means a rollback is an `APP_TAG` edit rather than a re-pull, which matters most on
 *   exactly the connection where re-pulling hurts.
 * - **Never forced.** `docker rmi` refuses to remove an image a container still
 *   references, and that refusal is a feature — it is the check that stops this from
 *   pulling the floor out from under a running instance.
 *
 * Removal goes by `repo:tag` rather than image ID, because one ID can carry several
 * tags: deleting `v0.0.8` by ID would take `latest` with it when they point at the same
 * build. Untagged leftovers have no such reference and are removed by ID.
 */

import { RELEASE_IMAGE_NS } from "@claude-transcripts/shared";
import { $ } from "bun";
import type { EnvMap } from "./instance-env";

/** One row of `docker images <repo>`; `tag` is `<none>` for an untagged leftover. */
export interface AppImage {
  tag: string;
  id: string;
}

export interface PruneReport {
  /** Successfully removed, as passed to `docker rmi`. */
  removed: string[];
  /** Left alone, with docker's reason — almost always "still in use". */
  skipped: { ref: string; reason: string }[];
  /** Set when the image list itself could not be read; nothing was attempted. */
  error?: string;
}

const UNTAGGED = "<none>";

/** The app image repository for an instance, matching what the compose files pull. */
export function appImageRepo(env: EnvMap): string {
  return `${env.IMAGE_NS ?? RELEASE_IMAGE_NS}/claude-transcripts-app`;
}

/**
 * Which images to remove, given everything present and the tags worth keeping.
 *
 * Pure, and tested as such: the shell-out around it is trivial, but a mistake *here*
 * deletes the running instance's image or its rollback target, and neither announces
 * itself at the time.
 */
export function selectImagesToRemove(images: AppImage[], keepTags: string[]): AppImage[] {
  const keep = new Set(keepTags.filter((t) => t.length > 0));
  // An untagged row is never "kept": it has no tag anyone could have pinned. But it may
  // share an ID with one that is — a re-pulled `main` leaves the old build untagged
  // while the new one holds the tag — and those are genuinely separate images.
  const keptIds = new Set(images.filter((i) => keep.has(i.tag)).map((i) => i.id));
  return images.filter((i) => {
    if (i.tag !== UNTAGGED) return !keep.has(i.tag);
    return !keptIds.has(i.id);
  });
}

/** How to address an image in `docker rmi` — see the note on tags vs IDs above. */
export function imageRef(repo: string, image: AppImage): string {
  return image.tag === UNTAGGED ? image.id : `${repo}:${image.tag}`;
}

export function parseImageList(text: string): AppImage[] {
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => {
      const [tag = UNTAGGED, id = ""] = line.split("\t");
      return { tag, id };
    })
    .filter((i) => i.id.length > 0);
}

async function listAppImages(repo: string): Promise<AppImage[]> {
  const format = "{{.Tag}}\t{{.ID}}";
  const res = await $`docker images ${repo} --format ${format}`.quiet().nothrow();
  if (res.exitCode !== 0) throw new Error(res.stderr.toString().trim() || "docker images failed");
  return parseImageList(res.stdout.toString());
}

/**
 * Remove superseded app images. Never throws: this is cleanup running after a
 * successful upgrade, and a machine that won't let us reclaim disk is not a reason to
 * fail an install that has already worked.
 */
export async function pruneAppImages(opts: {
  repo: string;
  keepTags: string[];
}): Promise<PruneReport> {
  const report: PruneReport = { removed: [], skipped: [] };

  let images: AppImage[];
  try {
    images = await listAppImages(opts.repo);
  } catch (err) {
    return { ...report, error: (err as Error).message };
  }

  for (const image of selectImagesToRemove(images, opts.keepTags)) {
    const ref = imageRef(opts.repo, image);
    const res = await $`docker rmi ${ref}`.quiet().nothrow();
    if (res.exitCode === 0) {
      report.removed.push(ref);
    } else {
      // The common case is an image a container still holds, which is exactly what we
      // want left alone. Docker says so on stderr; pass it through rather than guess.
      const reason = res.stderr.toString().trim().split("\n")[0] ?? "unknown";
      report.skipped.push({ ref, reason });
    }
  }
  return report;
}

/**
 * One line for the install log.
 *
 * Reports counts and tags, not bytes: images share base layers, so the per-image sizes
 * `docker images` prints sum to far more than removing them frees, and a reclaimed
 * figure derived that way would simply be wrong.
 */
export function renderPruneReport(report: PruneReport, repo: string): string {
  if (report.error) return `  – image prune skipped (${report.error})`;
  const lines: string[] = [];
  if (report.removed.length > 0) {
    const tags = report.removed.map((r) => r.replace(`${repo}:`, "")).join(", ");
    lines.push(`  ✓ reclaimed ${report.removed.length} superseded app image(s): ${tags}`);
  } else {
    lines.push("  – no superseded app images to reclaim");
  }
  for (const s of report.skipped) {
    lines.push(`    kept ${s.ref.replace(`${repo}:`, "")} — ${s.reason}`);
  }
  return lines.join("\n");
}
