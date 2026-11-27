import { describe, expect, test } from "bun:test";
import { Resvg } from "@resvg/resvg-js";
import { decodeRgba, optimizePng } from "./png";

const render = (svg: string) => Buffer.from(new Resvg(svg).render().asPng());

/** The optimised PNG must decode to exactly the same pixels. */
function expectLossless(png: Buffer) {
  const out = optimizePng(png);
  const a = decodeRgba(png);
  const b = decodeRgba(out);
  expect([b.width, b.height]).toEqual([a.width, a.height]);
  expect(b.data.equals(a.data)).toBe(true);
  expect(out.length).toBeLessThanOrEqual(png.length);
  return out;
}

describe("optimizePng", () => {
  test("a few flat colours become a palette, same pixels", () => {
    const png = render(
      `<svg xmlns="http://www.w3.org/2000/svg" width="64" height="48"><rect width="64" height="48" fill="#f6f7f9"/><rect x="8" y="8" width="20" height="20" fill="#d97757"/></svg>`,
    );
    const out = expectLossless(png);
    expect(out[25]).toBe(3); // IHDR colour type: palette
  });

  test("many colours and transparency stay lossless", () => {
    const png = render(
      `<svg xmlns="http://www.w3.org/2000/svg" width="300" height="80"><defs><linearGradient id="g"><stop offset="0" stop-color="#000" stop-opacity="0"/><stop offset="1" stop-color="#3af" stop-opacity="1"/></linearGradient></defs><rect width="300" height="80" fill="url(#g)"/><circle cx="150" cy="40" r="30" fill="#d97757" fill-opacity="0.5"/></svg>`,
    );
    expectLossless(png);
  });

  test("not a PNG it understands comes back unchanged", () => {
    const junk = Buffer.from("not a png");
    expect(optimizePng(junk)).toBe(junk);
  });
});
