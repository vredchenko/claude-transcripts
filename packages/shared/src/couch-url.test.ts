import { describe, expect, test } from "bun:test";
import { resolveCouchUrl, resolveCouchUrlWithAuth, withCouchAuth } from "./index";

describe("resolveCouchUrl", () => {
  test("defaults to the bundled stack when nothing is set", () => {
    expect(resolveCouchUrl({})).toBe("http://127.0.0.1:7652");
  });

  test("builds from COUCHDB_HOST + COUCHDB_PORT", () => {
    expect(resolveCouchUrl({ COUCHDB_HOST: "couchdb", COUCHDB_PORT: "5984" })).toBe(
      "http://couchdb:5984",
    );
  });

  test("COUCHDB_URL wins over host/port, keeping https and a path prefix", () => {
    const url = resolveCouchUrl({
      COUCHDB_URL: "https://couch.example.com/couchdb",
      COUCHDB_HOST: "couchdb",
      COUCHDB_PORT: "5984",
    });
    expect(url).toBe("https://couch.example.com/couchdb");
  });

  test("an empty or blank COUCHDB_URL falls back to host/port", () => {
    expect(resolveCouchUrl({ COUCHDB_URL: "", COUCHDB_HOST: "h", COUCHDB_PORT: "1" })).toBe(
      "http://h:1",
    );
    expect(resolveCouchUrl({ COUCHDB_URL: "   ", COUCHDB_HOST: "h", COUCHDB_PORT: "1" })).toBe(
      "http://h:1",
    );
  });

  test("assumes http:// when the scheme is omitted, and drops trailing slashes", () => {
    expect(resolveCouchUrl({ COUCHDB_URL: "couch.example.com:5984/" })).toBe(
      "http://couch.example.com:5984",
    );
  });
});

describe("withCouchAuth", () => {
  test("returns the url unchanged without a user", () => {
    expect(withCouchAuth("http://127.0.0.1:7652")).toBe("http://127.0.0.1:7652");
    expect(withCouchAuth("http://127.0.0.1:7652", "", "pw")).toBe("http://127.0.0.1:7652");
  });

  test("embeds credentials in the authority without a trailing slash", () => {
    expect(withCouchAuth("http://127.0.0.1:7652", "admin", "secret")).toBe(
      "http://admin:secret@127.0.0.1:7652",
    );
  });

  test("preserves a path prefix", () => {
    expect(withCouchAuth("https://couch.example.com/couchdb", "admin", "secret")).toBe(
      "https://admin:secret@couch.example.com/couchdb",
    );
  });

  test("percent-encodes credentials so `@`, `:` and `%` round-trip", () => {
    const url = withCouchAuth("http://h:1", "a@b", "p:%s");
    expect(url).toBe("http://a%40b:p%3A%25s@h:1");
    const parsed = new URL(url);
    expect(decodeURIComponent(parsed.username)).toBe("a@b");
    expect(decodeURIComponent(parsed.password)).toBe("p:%s");
  });

  test("leaves credentials already present in the url alone", () => {
    expect(withCouchAuth("http://someone:pw@h:1", "admin", "secret")).toBe("http://someone:pw@h:1");
  });
});

describe("resolveCouchUrlWithAuth", () => {
  test("combines resolution and credentials", () => {
    expect(
      resolveCouchUrlWithAuth({
        COUCHDB_URL: "https://couch.example.com/couchdb",
        COUCHDB_USER: "admin",
        COUCHDB_PASSWORD: "secret",
      }),
    ).toBe("https://admin:secret@couch.example.com/couchdb");
  });

  test("bundled stack (no credentials) stays clean", () => {
    expect(resolveCouchUrlWithAuth({})).toBe("http://127.0.0.1:7652");
  });
});
