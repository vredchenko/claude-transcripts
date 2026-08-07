/**
 * Request-validation failures, shaped like every other error the webapi returns.
 *
 * `@hono/zod-openapi` validates requests against each route's zod schemas, but with no
 * hook it answers a failure by serialising the raw `ZodError` — `{ success, error:
 * { issues: [...], name: "ZodError" } }`. That is a different shape from the `{ error }`
 * body the API returns everywhere else, so a client that knows how to read an error
 * can't read this one, and the OpenAPI document (which declares `ApiError`) doesn't
 * describe it.
 *
 * This hook makes a 400 look like the rest of the API and say which parameter was
 * wrong.
 */
import type { Hook } from "@hono/zod-openapi";
import type { ZodError, ZodIssue } from "zod";

/** "limit: Expected number, received nan" — the path, when there is one, then why. */
function describe(issue: ZodIssue): string {
  const path = issue.path.join(".");
  return path ? `${path}: ${issue.message}` : issue.message;
}

/**
 * `defaultHook` for an `OpenAPIHono`: on a validation failure, answer 400 with
 * `{ error }`. Passing validation is a no-op — the handler runs as usual.
 */
export const validationHook: Hook<any, any, any, any> = (result, c) => {
  if (result.success) return;
  const issues = (result.error as ZodError).issues ?? [];
  const detail = issues.map(describe).join("; ");
  return c.json({ error: detail ? `invalid request — ${detail}` : "invalid request" }, 400);
};
