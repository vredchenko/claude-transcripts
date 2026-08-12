/**
 * Comparing two versions of the webapi's OpenAPI document, and deciding which of the
 * differences would break a consumer.
 *
 * The spec is the contract's source of truth ([ADR 0019](../../../docs/design/decisions/0019-openapi-source-of-truth-generated-clients.md)),
 * and consumers are *generated* from it — so a change here doesn't fail at the server,
 * it fails at somebody's next codegen, or silently at runtime for a consumer that
 * hasn't regenerated. That is precisely the kind of break nothing else in this repo can
 * see: the webapi's own tests pass, the clients regenerate cleanly, and the damage only
 * appears in a CLI shipped a version ago.
 *
 * ## Which direction breaks
 *
 * "Breaking" only means something relative to who depends on what, so every comparison
 * is made in a direction:
 *
 * - **Response** data flows server → consumer. The consumer *reads* it, so the server
 *   may add fields freely; taking one away, making a guaranteed one optional, or
 *   introducing an enum variant the consumer has no branch for are all breaks.
 * - **Request** data flows consumer → server. The consumer *writes* it, so the server
 *   may relax what it accepts; demanding a new field, promoting an optional one to
 *   required, or dropping an enum value a caller might still send are all breaks.
 *
 * Getting that backwards is the classic way these checks become useless — flagging
 * every additive change until somebody turns them off.
 *
 * ## Deliberately conservative
 *
 * Only differences confidently attributable to a break are reported as one. A check
 * that cries wolf gets disabled, and a disabled check is worth less than none, because
 * it still looks like coverage. Everything else is reported as informational so a
 * reviewer can still see the contract move.
 */

/** The subset of OpenAPI this compares. Loosely typed: it is parsed JSON. */
export interface OpenApiDoc {
  paths?: Record<string, Record<string, unknown>>;
  components?: { schemas?: Record<string, unknown> };
}

type Schema = Record<string, any>;

/** Whether a consumer reads this data (response) or writes it (request). */
export type Direction = "response" | "request";

export interface ContractChange {
  /** Would this break a consumer generated against the older spec? */
  breaking: boolean;
  /** Machine-ish label, e.g. `operation-removed`, `property-now-required`. */
  kind: string;
  /** Where it happened, e.g. `GET /api/sessions → 200 SessionsResponse.totalCount`. */
  where: string;
  detail: string;
}

/** HTTP methods an OpenAPI path item may carry. */
const METHODS = ["get", "put", "post", "delete", "patch", "head", "options", "trace"];

/** Follow `$ref`s into a document's component schemas. */
function makeResolver(doc: OpenApiDoc) {
  return function resolve(schema: Schema | undefined): Schema {
    let current = schema ?? {};
    // A chain of refs is legal; a cycle is not, so cap the walk rather than trusting
    // the document to be well-formed.
    for (let hops = 0; hops < 20 && typeof current.$ref === "string"; hops++) {
      const name = current.$ref.replace("#/components/schemas/", "");
      current = (doc.components?.schemas?.[name] as Schema) ?? {};
    }
    return current;
  };
}

/** The name a `$ref` points at, for readable `where` strings. */
function refName(schema: Schema | undefined): string | undefined {
  const ref = schema?.$ref;
  return typeof ref === "string" ? ref.replace("#/components/schemas/", "") : undefined;
}

/**
 * Compare two schemas in one direction, appending to `out`.
 *
 * `seen` guards against recursive schemas (a transcript entry that can contain another)
 * by keying on the pair of positions already being compared.
 */
function compareSchema(
  before: Schema,
  after: Schema,
  ctx: { where: string; direction: Direction },
  resolveBefore: (s?: Schema) => Schema,
  resolveAfter: (s?: Schema) => Schema,
  out: ContractChange[],
  seen: Set<string>,
): void {
  // Cycle guard. A cycle can only close through a `$ref` — inline JSON can't be
  // self-referential — so the key is the pair of component names, *not* the location.
  // Keying on location was the bug: `Node.child.child.child…` is a new location every
  // level, so the guard never fired and a self-referential schema recursed until the
  // stack gave out. Keying on identity also dedupes: the same component compared in
  // two operations is one finding, not two.
  const beforeRef = refName(before);
  const afterRef = refName(after);
  if (beforeRef || afterRef) {
    const key = `${beforeRef ?? ""}→${afterRef ?? ""}|${ctx.direction}`;
    if (seen.has(key)) return;
    seen.add(key);
  }

  const a = resolveBefore(before);
  const b = resolveAfter(after);
  const { where, direction } = ctx;

  // ── Type ────────────────────────────────────────────────────────────────────
  if (a.type && b.type && a.type !== b.type) {
    out.push({
      breaking: true,
      kind: "type-changed",
      where,
      detail: `type ${a.type} → ${b.type}`,
    });
    // Everything below assumes a shared shape; comparing the innards of two
    // different types produces noise, not information.
    return;
  }

  // ── Nullability ─────────────────────────────────────────────────────────────
  // Widening what a reader must handle breaks readers; narrowing what a writer may
  // send breaks writers.
  if (direction === "response" && !a.nullable && b.nullable) {
    out.push({ breaking: true, kind: "now-nullable", where, detail: "may now be null" });
  }
  if (direction === "request" && a.nullable && !b.nullable) {
    out.push({
      breaking: true,
      kind: "no-longer-nullable",
      where,
      detail: "null no longer accepted",
    });
  }

  // ── Enums ───────────────────────────────────────────────────────────────────
  if (Array.isArray(a.enum) && Array.isArray(b.enum)) {
    const gained = b.enum.filter((v: unknown) => !a.enum.includes(v));
    const lost = a.enum.filter((v: unknown) => !b.enum.includes(v));
    if (direction === "response" && gained.length > 0) {
      // A reader that switches exhaustively — or types a lookup as
      // `Record<SessionStatus, …>` — stops compiling, or falls through at runtime.
      out.push({
        breaking: true,
        kind: "enum-value-added",
        where,
        detail: `response may now be ${gained.join(", ")}`,
      });
    }
    if (direction === "request" && lost.length > 0) {
      out.push({
        breaking: true,
        kind: "enum-value-removed",
        where,
        detail: `no longer accepts ${lost.join(", ")}`,
      });
    }
    if (direction === "response" && lost.length > 0) {
      out.push({
        breaking: false,
        kind: "enum-value-removed",
        where,
        detail: `no longer returns ${lost.join(", ")}`,
      });
    }
    if (direction === "request" && gained.length > 0) {
      out.push({
        breaking: false,
        kind: "enum-value-added",
        where,
        detail: `now also accepts ${gained.join(", ")}`,
      });
    }
  }

  // ── Arrays ──────────────────────────────────────────────────────────────────
  if (a.items || b.items) {
    compareSchema(
      a.items ?? {},
      b.items ?? {},
      { where: `${where}[]`, direction },
      resolveBefore,
      resolveAfter,
      out,
      seen,
    );
  }

  // ── Objects ─────────────────────────────────────────────────────────────────
  const beforeProps: Record<string, Schema> = a.properties ?? {};
  const afterProps: Record<string, Schema> = b.properties ?? {};
  const beforeRequired = new Set<string>(a.required ?? []);
  const afterRequired = new Set<string>(b.required ?? []);

  for (const [name, beforeProp] of Object.entries(beforeProps)) {
    const at = `${where}.${name}`;
    const afterProp = afterProps[name];

    if (afterProp === undefined) {
      out.push({
        breaking: true,
        kind: "property-removed",
        where: at,
        detail: direction === "response" ? "consumers may read this" : "callers may send this",
      });
      continue;
    }

    if (direction === "response" && beforeRequired.has(name) && !afterRequired.has(name)) {
      out.push({
        breaking: true,
        kind: "property-now-optional",
        where: at,
        detail: "was always present; consumers must now handle its absence",
      });
    }
    if (direction === "request" && !beforeRequired.has(name) && afterRequired.has(name)) {
      out.push({
        breaking: true,
        kind: "property-now-required",
        where: at,
        detail: "callers that omit it will now be rejected",
      });
    }

    compareSchema(
      beforeProp,
      afterProp,
      { where: at, direction },
      resolveBefore,
      resolveAfter,
      out,
      seen,
    );
  }

  for (const name of Object.keys(afterProps)) {
    if (name in beforeProps) continue;
    const at = `${where}.${name}`;
    // Adding a required field to a request rejects every existing caller. Adding
    // anything else is the additive case this check exists to permit.
    if (direction === "request" && afterRequired.has(name)) {
      out.push({
        breaking: true,
        kind: "required-property-added",
        where: at,
        detail: "existing callers do not send it",
      });
    } else {
      out.push({ breaking: false, kind: "property-added", where: at, detail: "new field" });
    }
  }
}

/** The JSON schema of an operation's request body, if it has one. */
function requestSchema(operation: Schema): Schema | undefined {
  return operation?.requestBody?.content?.["application/json"]?.schema;
}

/** The JSON schema of one response status, if it has one. */
function responseSchema(operation: Schema, status: string): Schema | undefined {
  return operation?.responses?.[status]?.content?.["application/json"]?.schema;
}

/** Index an operation's parameters by `in` + `name`. */
function parametersOf(operation: Schema): Map<string, Schema> {
  const list: Schema[] = Array.isArray(operation?.parameters) ? operation.parameters : [];
  return new Map(list.map((p) => [`${p.in}:${p.name}`, p]));
}

/**
 * Every difference between two versions of the contract, flagged for whether it breaks
 * a consumer built against `before`.
 *
 * Ordered breaking-first, so a report's first line is the one that matters.
 */
export function diffContract(before: OpenApiDoc, after: OpenApiDoc): ContractChange[] {
  const out: ContractChange[] = [];
  const resolveBefore = makeResolver(before);
  const resolveAfter = makeResolver(after);
  const seen = new Set<string>();

  const beforePaths = before.paths ?? {};
  const afterPaths = after.paths ?? {};

  for (const [path, beforeItem] of Object.entries(beforePaths)) {
    const afterItem = afterPaths[path];

    for (const method of METHODS) {
      const beforeOp = (beforeItem as Schema)[method] as Schema | undefined;
      if (!beforeOp) continue;
      const label = `${method.toUpperCase()} ${path}`;
      const afterOp = afterItem ? ((afterItem as Schema)[method] as Schema | undefined) : undefined;

      if (!afterOp) {
        out.push({
          breaking: true,
          kind: "operation-removed",
          where: label,
          detail: "consumers generated against the old spec call this",
        });
        continue;
      }

      // The operationId names the generated function. Renaming it deletes one symbol
      // and adds another, which is a break even though the route is untouched.
      if (beforeOp.operationId && beforeOp.operationId !== afterOp.operationId) {
        out.push({
          breaking: true,
          kind: "operation-id-changed",
          where: label,
          detail: `${beforeOp.operationId} → ${afterOp.operationId ?? "(none)"}`,
        });
      }

      // ── Parameters ──────────────────────────────────────────────────────────
      const beforeParams = parametersOf(beforeOp);
      const afterParams = parametersOf(afterOp);

      for (const [key, beforeParam] of beforeParams) {
        const at = `${label} ?${beforeParam.name}`;
        const afterParam = afterParams.get(key);
        if (!afterParam) {
          out.push({
            breaking: true,
            kind: "parameter-removed",
            where: at,
            detail: "callers pass this today",
          });
          continue;
        }
        if (!beforeParam.required && afterParam.required) {
          out.push({
            breaking: true,
            kind: "parameter-now-required",
            where: at,
            detail: "callers that omit it will now be rejected",
          });
        }
        compareSchema(
          beforeParam.schema ?? {},
          afterParam.schema ?? {},
          { where: at, direction: "request" },
          resolveBefore,
          resolveAfter,
          out,
          seen,
        );
      }

      for (const [key, afterParam] of afterParams) {
        if (beforeParams.has(key)) continue;
        const at = `${label} ?${afterParam.name}`;
        if (afterParam.required) {
          out.push({
            breaking: true,
            kind: "required-parameter-added",
            where: at,
            detail: "existing callers do not send it",
          });
        } else {
          out.push({ breaking: false, kind: "parameter-added", where: at, detail: "optional" });
        }
      }

      // ── Request body ────────────────────────────────────────────────────────
      const beforeBody = requestSchema(beforeOp);
      const afterBody = requestSchema(afterOp);
      if (beforeBody || afterBody) {
        compareSchema(
          beforeBody ?? {},
          afterBody ?? {},
          { where: `${label} body${nameSuffix(beforeBody, afterBody)}`, direction: "request" },
          resolveBefore,
          resolveAfter,
          out,
          seen,
        );
      }

      // ── Responses ───────────────────────────────────────────────────────────
      const beforeStatuses = Object.keys(beforeOp.responses ?? {});
      for (const status of beforeStatuses) {
        const afterStatus = afterOp.responses?.[status];
        if (!afterStatus) {
          // Only success statuses are load-bearing for a consumer: an error status
          // that stops being produced is the server getting better, not worse.
          out.push({
            breaking: status.startsWith("2"),
            kind: "response-removed",
            where: `${label} → ${status}`,
            detail: "no longer produced",
          });
          continue;
        }
        const beforeSchema = responseSchema(beforeOp, status);
        const afterSchema = responseSchema(afterOp, status);
        if (!beforeSchema && !afterSchema) continue;
        compareSchema(
          beforeSchema ?? {},
          afterSchema ?? {},
          {
            where: `${label} → ${status}${nameSuffix(beforeSchema, afterSchema)}`,
            direction: "response",
          },
          resolveBefore,
          resolveAfter,
          out,
          seen,
        );
      }
    }
  }

  for (const [path, afterItem] of Object.entries(afterPaths)) {
    for (const method of METHODS) {
      if (!(afterItem as Schema)[method]) continue;
      const beforeOp = beforePaths[path]
        ? ((beforePaths[path] as Schema)[method] as Schema | undefined)
        : undefined;
      if (beforeOp) continue;
      out.push({
        breaking: false,
        kind: "operation-added",
        where: `${method.toUpperCase()} ${path}`,
        detail: "new route",
      });
    }
  }

  return [...out.filter((c) => c.breaking), ...out.filter((c) => !c.breaking)];
}

/** ` (SessionsResponse)` when the schema is a named component, else empty. */
function nameSuffix(before?: Schema, after?: Schema): string {
  const name = refName(before) ?? refName(after);
  return name ? ` ${name}` : "";
}

/** Render changes as lines for a terminal or a CI log. */
export function formatChanges(changes: ContractChange[]): string {
  return changes
    .map((c) => `${c.breaking ? "BREAKING" : "ok      "}  ${c.kind}  ${c.where} — ${c.detail}`)
    .join("\n");
}
