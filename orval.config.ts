import { defineConfig } from "orval";

/**
 * Generate typed API clients from the webapi OpenAPI spec into the two consumers
 * (CLI + webui). One contract, two generated clients (ADR 0019).
 * Driven by scripts/regenerate-api-clients.ts.
 */
export default defineConfig({
  webui: {
    input: "./openapi.json",
    output: {
      mode: "single",
      target: "packages/webui/src/api/generated.ts",
      client: "react-query",
      httpClient: "fetch",
      // No `baseUrl`: the spec's paths already start with `/api`, and the webui is
      // served same-origin with `/api` proxied to the webapi — setting one produces
      // `/api/api/...`.
      override: {
        // Same arrangement as the CLI: the mutator owns transport (unwrapping orval's
        // `{data, status, headers}` envelope and throwing on non-2xx so react-query can
        // see failures), leaving the generated file to describe only the contract.
        mutator: { path: "packages/webui/src/api/http.ts", name: "customFetch" },
        // Return the response body, not `{data, status, headers}` — otherwise the
        // generated types describe an envelope the mutator has already unwrapped, and
        // every consumer reads `.data.data`.
        fetch: { includeHttpResponseReturnType: false },
      },
    },
  },
  cli: {
    input: "./openapi.json",
    output: {
      mode: "single",
      target: "packages/cli/src/api/generated.ts",
      client: "fetch",
      // Custom fetch mutator: injects the configurable webapi base URL (the CLI is
      // off-origin, unlike the webui) + unwraps responses. Hand-written, idiomatic.
      override: {
        mutator: { path: "packages/cli/src/api/http.ts", name: "customFetch" },
        // As for the webui: the mutator already returns the body, so the generated
        // types must not also describe the `{data, status, headers}` envelope.
        fetch: { includeHttpResponseReturnType: false },
      },
    },
  },
});
