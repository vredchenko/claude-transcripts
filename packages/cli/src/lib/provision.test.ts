import { describe, expect, test } from "bun:test";
import { couchUrl } from "./provision";

describe("couchUrl", () => {
  test("defaults the port instead of writing `undefined`", () => {
    expect(couchUrl({})).toBe("http://127.0.0.1:7652");
  });

  test("normalises an explicit COUCHDB_URL", () => {
    expect(couchUrl({ COUCHDB_URL: "couch.example.net:5984/" })).toBe(
      "http://couch.example.net:5984",
    );
  });
});
