/**
 * Which app images an upgrade may delete.
 *
 * Every case here is one that would otherwise be found by a user who cannot start
 * their instance: the selection runs unattended, after the install has already
 * succeeded, and deleting the wrong image produces no error until the next `up`.
 */
import { describe, expect, test } from "bun:test";
import {
  type AppImage,
  appImageRepo,
  imageRef,
  parseImageList,
  renderPruneReport,
  selectImagesToRemove,
} from "./images";

const REPO = "ghcr.io/vredchenko/claude-transcripts-app";
const img = (tag: string, id: string): AppImage => ({ tag, id });

describe("selectImagesToRemove", () => {
  test("keeps the installed tag and the one it replaced, removes the rest", () => {
    const images = [
      img("v0.0.8", "aaa"),
      img("v0.0.7", "bbb"),
      img("v0.0.6", "ccc"),
      img("v0.0.5", "ddd"),
    ];
    const removed = selectImagesToRemove(images, ["v0.0.8", "v0.0.7"]);
    expect(removed.map((i) => i.tag)).toEqual(["v0.0.6", "v0.0.5"]);
  });

  test("never removes the running tag when there is no predecessor", () => {
    // First install: nothing was replaced, so the keep list is a single tag.
    const removed = selectImagesToRemove([img("v0.0.8", "aaa")], ["v0.0.8"]);
    expect(removed).toEqual([]);
  });

  test("a re-run at the same version still reclaims older images", () => {
    // Prior tag equals the current one — the keep list collapses to one entry, and the
    // backlog from earlier upgrades is what gets cleared.
    const images = [img("v0.0.8", "aaa"), img("v0.0.6", "ccc")];
    const removed = selectImagesToRemove(images, ["v0.0.8", "v0.0.8"]);
    expect(removed.map((i) => i.tag)).toEqual(["v0.0.6"]);
  });

  test("keeps every tag pointing at a kept image", () => {
    // `latest` and `v0.0.8` on one build: selecting by tag, not ID, is what stops the
    // second reference from being collected as if it were a separate image.
    const images = [img("v0.0.8", "aaa"), img("latest", "aaa"), img("v0.0.6", "ccc")];
    const removed = selectImagesToRemove(images, ["v0.0.8", "latest"]);
    expect(removed.map((i) => i.tag)).toEqual(["v0.0.6"]);
  });

  test("removes untagged leftovers", () => {
    // Re-pulling a moving tag leaves the previous build untagged and unreachable.
    const images = [img("main", "new"), img("<none>", "old")];
    const removed = selectImagesToRemove(images, ["main"]);
    expect(removed.map((i) => i.id)).toEqual(["old"]);
  });

  test("does not remove an untagged row sharing an ID with a kept tag", () => {
    // Same build listed twice; deleting by ID here would take the kept tag with it.
    const images = [img("v0.0.8", "aaa"), img("<none>", "aaa")];
    expect(selectImagesToRemove(images, ["v0.0.8"])).toEqual([]);
  });

  test("ignores empty keep entries rather than matching an empty tag", () => {
    const images = [img("v0.0.8", "aaa"), img("v0.0.6", "ccc")];
    const removed = selectImagesToRemove(images, ["v0.0.8", ""]);
    expect(removed.map((i) => i.tag)).toEqual(["v0.0.6"]);
  });

  test("nothing to do on an empty list", () => {
    expect(selectImagesToRemove([], ["v0.0.8"])).toEqual([]);
  });
});

describe("imageRef", () => {
  test("addresses tagged images by tag and untagged ones by id", () => {
    expect(imageRef(REPO, img("v0.0.6", "ccc"))).toBe(`${REPO}:v0.0.6`);
    expect(imageRef(REPO, img("<none>", "ccc"))).toBe("ccc");
  });
});

describe("parseImageList", () => {
  test("reads docker's tab-separated output", () => {
    expect(parseImageList("v0.0.8\taaa111\nv0.0.7\tbbb222\n")).toEqual([
      { tag: "v0.0.8", id: "aaa111" },
      { tag: "v0.0.7", id: "bbb222" },
    ]);
  });

  test("drops blank lines and rows with no id", () => {
    // `docker images` on a repo with nothing to show prints an empty string.
    expect(parseImageList("\n  \n")).toEqual([]);
    expect(parseImageList("v0.0.8\t\n")).toEqual([]);
  });
});

describe("appImageRepo", () => {
  test("follows the instance's namespace", () => {
    expect(appImageRepo({ IMAGE_NS: "ghcr.io/someone" })).toBe(
      "ghcr.io/someone/claude-transcripts-app",
    );
  });

  test("falls back to the published namespace", () => {
    expect(appImageRepo({})).toBe(REPO);
  });
});

describe("renderPruneReport", () => {
  test("names what went, without the repo prefix", () => {
    const line = renderPruneReport({ removed: [`${REPO}:v0.0.6`], skipped: [] }, REPO);
    expect(line).toContain("reclaimed 1 superseded app image(s): v0.0.6");
  });

  test("says so when there was nothing to reclaim", () => {
    expect(renderPruneReport({ removed: [], skipped: [] }, REPO)).toContain("no superseded");
  });

  test("reports what was kept and why", () => {
    const line = renderPruneReport(
      { removed: [], skipped: [{ ref: `${REPO}:v0.0.7`, reason: "image is being used" }] },
      REPO,
    );
    expect(line).toContain("kept v0.0.7 — image is being used");
  });

  test("a failed listing is reported, not thrown", () => {
    const line = renderPruneReport({ removed: [], skipped: [], error: "docker not found" }, REPO);
    expect(line).toContain("skipped (docker not found)");
  });
});
