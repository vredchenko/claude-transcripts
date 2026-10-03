import { describe, expect, test } from "bun:test";
import { ApiRequestError, shouldRetry } from "./http";

// Shipped bug: the default `retry: 1` re-asked an unknown session id after a 1s
// back-off, so the page spun before saying "not found". The 4xx/5xx boundary is the
// part that is easy to get wrong.
describe("shouldRetry", () => {
  test("never retries a 4xx: the server has answered", () => {
    expect(shouldRetry(0, new ApiRequestError("GET /x → 404", 404))).toBe(false);
    expect(shouldRetry(0, new ApiRequestError("GET /x → 400", 400))).toBe(false);
  });

  test("retries a 5xx or a network failure once", () => {
    expect(shouldRetry(0, new ApiRequestError("GET /x → 503", 503))).toBe(true);
    expect(shouldRetry(0, new TypeError("Failed to fetch"))).toBe(true);
    expect(shouldRetry(1, new ApiRequestError("GET /x → 503", 503))).toBe(false);
  });
});
