import { describe, expect, test } from "bun:test";
import { couchProxyUrl, fauxtonUrlFor } from "./model";

describe("CouchDB link building", () => {
  test("proxy links are origin-relative, so they need no dashboard or host port", () => {
    expect(couchProxyUrl("my-sessions", "summary%3Aabc")).toBe(
      "/api/couch/my-sessions/summary%3Aabc",
    );
  });

  test("Fauxton links use the real database name and tolerate a trailing slash", () => {
    expect(fauxtonUrlFor("https://couch.example/_utils/", "my-sessions", "_design/a")).toBe(
      "https://couch.example/_utils/#/database/my-sessions/_design/a",
    );
    expect(fauxtonUrlFor("https://couch.example/_utils", "my-sessions", "x")).toBe(
      "https://couch.example/_utils/#/database/my-sessions/x",
    );
  });
});
