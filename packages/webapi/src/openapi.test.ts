import { expect, test } from "bun:test";
import { buildOpenApiDocument } from "./openapi";

type Param = { name: string; in: string; schema?: { default?: unknown; description?: string } };
type Doc = { paths: Record<string, Record<string, { parameters?: Param[] }>> };

/** The spec, not the handlers, is where a paging default lives (#182). */
test("every paging query parameter carries its default and a description", () => {
  const doc = buildOpenApiDocument() as Doc;
  const paging = Object.entries(doc.paths).flatMap(([path, ops]) =>
    (ops.get?.parameters ?? [])
      .filter((p) => p.in === "query" && ["limit", "skip", "offset"].includes(p.name))
      .map((p) => ({ at: `${path} ?${p.name}`, ...p.schema })),
  );
  expect(paging.length).toBeGreaterThanOrEqual(10);
  for (const p of paging) {
    expect({ at: p.at, hasDefault: typeof p.default === "number" }).toEqual({
      at: p.at,
      hasDefault: true,
    });
    expect({ at: p.at, described: Boolean(p.description) }).toEqual({ at: p.at, described: true });
  }
});
