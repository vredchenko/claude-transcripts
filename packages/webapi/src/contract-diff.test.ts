import { describe, expect, it } from "bun:test";
import { type ContractChange, diffContract, type OpenApiDoc } from "./contract-diff";

/** A one-operation document, so each test states only the thing it is about. */
function doc(
  operation: Record<string, unknown>,
  schemas: Record<string, unknown> = {},
): OpenApiDoc {
  return {
    paths: { "/api/things": { get: { operationId: "listThings", ...operation } } },
    components: { schemas },
  };
}

/** A JSON response of the given schema, under status 200. */
function responds(schema: Record<string, unknown>) {
  return { responses: { "200": { content: { "application/json": { schema } } } } };
}

/** A JSON request body of the given schema (plus a trivial 200). */
function accepts(schema: Record<string, unknown>) {
  return {
    requestBody: { content: { "application/json": { schema } } },
    responses: { "200": { description: "ok" } },
  };
}

const breaking = (changes: ContractChange[]) => changes.filter((c) => c.breaking);
const kinds = (changes: ContractChange[]) => changes.map((c) => c.kind);

describe("operations", () => {
  it("flags a removed operation", () => {
    const before = doc(responds({ type: "object" }));
    const after: OpenApiDoc = { paths: {} };
    expect(kinds(breaking(diffContract(before, after)))).toEqual(["operation-removed"]);
  });

  it("flags a renamed operationId, even though the route is unchanged", () => {
    // The operationId names the generated function; renaming deletes a symbol.
    const before = doc(responds({ type: "object" }));
    const after = doc({ operationId: "getThings", ...responds({ type: "object" }) });
    expect(kinds(breaking(diffContract(before, after)))).toEqual(["operation-id-changed"]);
  });

  it("does not flag an added operation", () => {
    const before: OpenApiDoc = { paths: {} };
    const after = doc(responds({ type: "object" }));
    expect(breaking(diffContract(before, after))).toEqual([]);
  });
});

describe("responses — the consumer reads, so removing breaks", () => {
  const objectWith = (properties: Record<string, unknown>, required: string[] = []) => ({
    type: "object",
    properties,
    required,
  });

  it("flags a removed property", () => {
    const before = doc(responds(objectWith({ id: { type: "string" }, name: { type: "string" } })));
    const after = doc(responds(objectWith({ id: { type: "string" } })));
    const found = breaking(diffContract(before, after));
    expect(kinds(found)).toEqual(["property-removed"]);
    expect(found[0]!.where).toContain(".name");
  });

  it("flags a guaranteed property becoming optional", () => {
    const before = doc(responds(objectWith({ id: { type: "string" } }, ["id"])));
    const after = doc(responds(objectWith({ id: { type: "string" } }, [])));
    expect(kinds(breaking(diffContract(before, after)))).toEqual(["property-now-optional"]);
  });

  it("does NOT flag an added property", () => {
    // The additive case this check exists to permit — flagging it is how these
    // checks get switched off.
    const before = doc(responds(objectWith({ id: { type: "string" } })));
    const after = doc(responds(objectWith({ id: { type: "string" } }, [])));
    const later = doc(responds(objectWith({ id: { type: "string" }, extra: { type: "number" } })));
    expect(breaking(diffContract(before, after))).toEqual([]);
    expect(breaking(diffContract(before, later))).toEqual([]);
    expect(kinds(diffContract(before, later))).toContain("property-added");
  });

  it("flags a property that may now be null", () => {
    const before = doc(responds(objectWith({ id: { type: "string" } })));
    const after = doc(responds(objectWith({ id: { type: "string", nullable: true } })));
    expect(kinds(breaking(diffContract(before, after)))).toEqual(["now-nullable"]);
  });

  it("flags a new enum variant a consumer has no branch for, not a dropped one", () => {
    const before = doc(responds({ type: "string", enum: ["ended", "running"] }));
    const after = doc(responds({ type: "string", enum: ["ended", "running", "incomplete"] }));
    expect(kinds(breaking(diffContract(before, after)))).toEqual(["enum-value-added"]);
    expect(breaking(diffContract(after, before))).toEqual([]);
  });

  it("flags a removed success status but not a removed error status", () => {
    const before = doc({
      responses: { "200": { description: "ok" }, "500": { description: "boom" } },
    });
    const afterNo500 = doc({ responses: { "200": { description: "ok" } } });
    const afterNo200 = doc({ responses: { "500": { description: "boom" } } });
    expect(breaking(diffContract(before, afterNo500))).toEqual([]);
    expect(kinds(breaking(diffContract(before, afterNo200)))).toEqual(["response-removed"]);
  });
});

describe("requests — the consumer writes, so demanding more breaks", () => {
  it("flags a newly required parameter, not a newly optional one", () => {
    const before = doc(responds({ type: "object" }));
    const withParam = (required: boolean) =>
      doc({
        parameters: [{ name: "since", in: "query", required, schema: { type: "string" } }],
        ...responds({ type: "object" }),
      });
    expect(kinds(breaking(diffContract(before, withParam(true))))).toEqual([
      "required-parameter-added",
    ]);
    expect(breaking(diffContract(before, withParam(false)))).toEqual([]);
  });

  it("flags an optional parameter becoming required", () => {
    const param = (required: boolean) => ({
      parameters: [{ name: "limit", in: "query", required, schema: { type: "integer" } }],
      ...responds({ type: "object" }),
    });
    expect(kinds(breaking(diffContract(doc(param(false)), doc(param(true)))))).toEqual([
      "parameter-now-required",
    ]);
  });

  it("does NOT flag a parameter gaining a default or a description", () => {
    const param = (extra: Record<string, unknown>) => ({
      parameters: [
        { name: "limit", in: "query", required: false, schema: { type: "integer", ...extra } },
      ],
      ...responds({ type: "object" }),
    });
    const after = param({ default: 50, description: "Page size." });
    expect(diffContract(doc(param({})), doc(after))).toEqual([]);
  });

  it("flags a removed parameter", () => {
    const before = doc({
      parameters: [{ name: "limit", in: "query", required: false, schema: { type: "integer" } }],
      ...responds({ type: "object" }),
    });
    const after = doc(responds({ type: "object" }));
    expect(kinds(breaking(diffContract(before, after)))).toEqual(["parameter-removed"]);
  });

  it("flags a body property becoming required, but not one becoming optional", () => {
    const body = (required: string[]) =>
      accepts({ type: "object", properties: { id: { type: "string" } }, required });
    expect(kinds(breaking(diffContract(doc(body([])), doc(body(["id"])))))).toEqual([
      "property-now-required",
    ]);
    expect(breaking(diffContract(doc(body(["id"])), doc(body([]))))).toEqual([]);
  });

  it("flags an enum value the server stops accepting, not one it starts accepting", () => {
    const before = doc(accepts({ type: "string", enum: ["a", "b"] }));
    const after = doc(accepts({ type: "string", enum: ["a"] }));
    expect(kinds(breaking(diffContract(before, after)))).toEqual(["enum-value-removed"]);
    expect(breaking(diffContract(after, before))).toEqual([]);
  });
});

describe("shared rules", () => {
  it("reports a changed type once rather than also diffing the innards", () => {
    // Comparing the properties of two different types produces noise, not information.
    const before = doc(responds({ type: "object", properties: { a: { type: "string" } } }));
    const after = doc(responds({ type: "array", items: { type: "string" } }));
    expect(kinds(breaking(diffContract(before, after)))).toEqual(["type-changed"]);
  });

  it("follows $refs into components", () => {
    const before = doc(responds({ $ref: "#/components/schemas/Thing" }), {
      Thing: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
    });
    const after = doc(responds({ $ref: "#/components/schemas/Thing" }), {
      Thing: { type: "object", properties: {}, required: [] },
    });
    const found = breaking(diffContract(before, after));
    expect(kinds(found)).toEqual(["property-removed"]);
    expect(found[0]!.where).toContain("Thing.id");
  });

  it("compares inside arrays", () => {
    const before = doc(
      responds({
        type: "array",
        items: { type: "object", properties: { id: { type: "string" } } },
      }),
    );
    const after = doc(responds({ type: "array", items: { type: "object", properties: {} } }));
    expect(kinds(breaking(diffContract(before, after)))).toEqual(["property-removed"]);
  });

  it("terminates on a self-referential schema", () => {
    // A transcript entry that can contain another would otherwise recurse forever.
    const schemas = {
      Node: {
        type: "object",
        properties: { child: { $ref: "#/components/schemas/Node" }, id: { type: "string" } },
      },
    };
    const before = doc(responds({ $ref: "#/components/schemas/Node" }), schemas);
    const after = doc(responds({ $ref: "#/components/schemas/Node" }), {
      Node: { type: "object", properties: { child: { $ref: "#/components/schemas/Node" } } },
    });
    expect(kinds(breaking(diffContract(before, after)))).toEqual(["property-removed"]);
  });
});
