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
      baseUrl: "/api",
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
      },
    },
  },
});
