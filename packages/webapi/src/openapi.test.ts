import { describe, expect, it } from "bun:test";
import { buildOpenApiDocument } from "./openapi";

type Param = { name: string; in: string; schema?: { default?: unknown; description?: string } };
type Doc = { paths: Record<string, Record<string, { parameters?: Param[] }>> };

/** The spec, not the handlers, is where a paging default lives (#182). */
describe("openapi.json query parameters", () => {
  const doc = buildOpenApiDocument() as Doc;
  const query = (path: string, name: string) =>
    doc.paths[path]?.get?.parameters?.find((p) => p.in === "query" && p.name === name)?.schema;

  it.each([
    ["/api/sessions", "limit", 50],
    ["/api/sessions", "skip", 0],
    ["/api/sessions/{id}/transcript", "limit", 100],
    ["/api/sessions/{id}/transcript", "offset", 0],
    ["/api/sessions/{id}/turns", "limit", 500],
    ["/api/sessions/{id}/turns", "offset", 0],
    ["/api/turns", "limit", 200],
    ["/api/turns", "skip", 0],
    ["/api/search", "limit", 20],
    ["/api/search", "offset", 0],
  ])("%s ?%s defaults to %d and is described", (path, name, value) => {
    const schema = query(path, name);
    expect(schema?.default).toBe(value);
    expect(schema?.description).toBeTruthy();
  });
});
