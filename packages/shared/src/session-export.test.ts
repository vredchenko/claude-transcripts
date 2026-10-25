import { describe, expect, test } from "bun:test";
import {
  type ChunkEntry,
  exportTimestamp,
  type SessionExportMeta,
  sessionExportBasename,
  sessionExportSections,
  sessionToHtml,
  sessionToMarkdown,
} from "./index";

const meta: SessionExportMeta = {
  sessionId: "1a2b3c4d-0000-4000-8000-000000000000",
  cwd: "/home/dev/my-project",
  model: "claude-test",
  startTimestamp: "2026-10-16T16:00:00.000Z",
  endTimestamp: "2026-10-16T16:05:00.000Z",
  totalTokens: 1234,
};

const plain: ChunkEntry[] = [
  { role: "user", timestamp: "2026-10-16T16:00:01Z", text: "List the files" },
  { role: "assistant", timestamp: "2026-10-16T16:00:02Z", text: "Sure." },
  { role: "assistant", timestamp: "2026-10-16T16:00:03Z", toolUses: [{ name: "Bash" }] },
  { role: "tool_result", timestamp: "2026-10-16T16:00:04Z", text: "a.ts\nb.ts" },
  { role: "assistant", timestamp: "2026-10-16T16:00:05Z", text: "Two files." },
  { role: "other", kind: "attachment:hook_success" },
  { role: "system", kind: "system:turn_duration", text: "12s" },
];

describe("sessionExportSections", () => {
  test("drops non-turn lines and merges consecutive assistant lines", () => {
    const s = sessionExportSections(plain);
    expect(s.map((x) => x.role)).toEqual(["user", "assistant", "tool_result", "assistant"]);
    expect(s[1]).toMatchObject({ text: "Sure.", tools: ["Bash"] });
  });

  test("without tools, results go and the reply merges into one section", () => {
    const s = sessionExportSections(plain, { includeTools: false });
    expect(s.map((x) => x.role)).toEqual(["user", "assistant"]);
    expect(s[1]).toMatchObject({ text: "Sure.\n\nTwo files.", tools: [] });
  });

  test("a tool-only turn disappears when tools are excluded", () => {
    const s = sessionExportSections([{ role: "assistant", toolUses: [{ name: "Read" }] }], {
      includeTools: false,
    });
    expect(s).toEqual([]);
  });

  test("truncates long tool results and counts what it cut", () => {
    const [r] = sessionExportSections([{ role: "tool_result", text: "x".repeat(50) }], {
      toolResultLimit: 20,
    });
    expect(r).toMatchObject({ text: "x".repeat(20), truncated: 30 });
  });

  test("does not merge a subagent reply into the main one", () => {
    const s = sessionExportSections([
      { role: "assistant", text: "main" },
      { role: "assistant", text: "sub", isSidechain: true },
    ]);
    expect(s).toHaveLength(2);
    expect(s[1]?.sidechain).toBe(true);
  });

  test("names a tool result after the call it answers", () => {
    const s = sessionExportSections([
      { role: "assistant", toolUses: [{ name: "Grep", id: "toolu_1" }] },
      { role: "tool_result", toolUseId: "toolu_1", text: "3 matches" },
      { role: "tool_result", toolUseId: "toolu_unknown", text: "?" },
    ]);
    expect(s.map((x) => x.tool)).toEqual([undefined, "Grep", undefined]);
    const md = sessionToMarkdown(meta, [
      { role: "assistant", toolUses: [{ name: "Grep", id: "toolu_1" }] },
      { role: "tool_result", toolUseId: "toolu_1", text: "3 matches", isError: true },
    ]);
    expect(md).toContain("## Grep result (error)");
  });

  test("an empty session has no sections", () => {
    expect(sessionExportSections([])).toEqual([]);
  });
});

describe("sessionToMarkdown", () => {
  test("renders front matter, headings, tools and a collapsed result", () => {
    const md = sessionToMarkdown(meta, plain);
    expect(md).toStartWith('---\nsession: "1a2b3c4d-0000-4000-8000-000000000000"\n');
    expect(md).toContain('project: "/home/dev/my-project"');
    expect(md).toContain("tokens: 1234\n");
    expect(md).toContain('ended: "2026-10-16 16:05:00 UTC"');
    expect(md).toContain("# my-project — 1a2b3c4d");
    expect(md).toContain("## User · 2026-10-16 16:00:01 UTC\n\nList the files");
    expect(md).toContain("Sure.\n\n_Tools: `Bash`_");
    expect(md).toContain("<details>\n<summary>Output</summary>\n\n```\na.ts\nb.ts\n```");
    expect(md).not.toContain("hook_success");
  });

  test("fences tool output longer than any backtick run inside it", () => {
    const md = sessionToMarkdown(meta, [{ role: "tool_result", text: "has ```` inside" }]);
    expect(md).toContain("`````\nhas ```` inside\n`````");
  });

  test("a session that hasn't ended reports its last write, not an end", () => {
    const md = sessionToMarkdown({ ...meta, status: "running" }, []);
    expect(md).toContain('status: "running"');
    expect(md).toContain('last_write: "2026-10-16 16:05:00 UTC"');
    expect(md).not.toContain("ended:");
  });

  test("marks failed tool results", () => {
    const md = sessionToMarkdown(meta, [{ role: "tool_result", text: "boom", isError: true }]);
    expect(md).toContain("## Tool result (error)");
  });

  test("an empty session still yields a header", () => {
    const md = sessionToMarkdown({ sessionId: "abcdef0123" }, []);
    expect(md).toBe('---\nsession: "abcdef0123"\n---\n\n# Session — abcdef01\n');
  });
});

describe("sessionToHtml", () => {
  test("escapes transcript text", () => {
    const html = sessionToHtml(meta, [{ role: "user", text: "<script>alert(1)</script> & co" }]);
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt; &amp; co");
    expect(html).not.toContain("<script>");
  });

  test("titles the document with the file basename", () => {
    expect(sessionToHtml(meta, plain)).toContain("<title>my-project-1a2b3c4d</title>");
  });
});

describe("helpers", () => {
  test("exportTimestamp is UTC and rejects junk", () => {
    expect(exportTimestamp("2026-10-16T18:47:34+02:00")).toBe("2026-10-16 16:47:34 UTC");
    expect(exportTimestamp("nope")).toBeUndefined();
    expect(exportTimestamp(undefined)).toBeUndefined();
  });

  test("basename is filesystem-safe", () => {
    expect(sessionExportBasename({ sessionId: "1a2b3c4d9", cwd: "/x/my proj:v2/" })).toBe(
      "my_proj_v2-1a2b3c4d",
    );
    expect(sessionExportBasename({ sessionId: "1a2b3c4d9" })).toBe("session-1a2b3c4d");
  });
});
