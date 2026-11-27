import { deflateSync, inflateSync } from "node:zlib";

/**
 * Lossless PNG recompression, dependency-free.
 *
 * The stack diagram's renders are committed, so every redraw adds them to git history
 * again; a browser screenshot is encoded for speed, not size. This re-encodes one the way
 * `oxipng` would at its simplest — the same pixels, fewer bytes — without asking a
 * contributor to install another tool:
 *
 *  - drops the alpha channel when every pixel is opaque;
 *  - switches to a palette when the image has at most 256 colours;
 *  - picks the best of the five PNG row filters per row (minimum sum of absolute
 *    differences, the heuristic libpng uses), or none for a palette;
 *  - deflates at level 9 and keeps only the critical chunks.
 *
 * Handles 8-bit, non-interlaced RGB, RGBA and palette images, which is what Chromium
 * screenshots are. Anything else, or a result that isn't smaller, comes back unchanged.
 */

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

interface Chunk {
  type: string;
  data: Buffer;
}

function readChunks(png: Buffer): Chunk[] {
  if (!png.subarray(0, 8).equals(SIGNATURE)) throw new Error("not a PNG");
  const chunks: Chunk[] = [];
  let at = 8;
  while (at < png.length) {
    const len = png.readUInt32BE(at);
    const type = png.toString("latin1", at + 4, at + 8);
    chunks.push({ type, data: png.subarray(at + 8, at + 8 + len) });
    at += 12 + len;
    if (type === "IEND") break;
  }
  return chunks;
}

function chunk(type: string, data: Buffer): Buffer {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, "latin1");
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(Bun.hash.crc32(Buffer.concat([head.subarray(4), data])) >>> 0, 0);
  return Buffer.concat([head, data, crc]);
}

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
}

/** Undo the per-row filters: `raw` is the inflated IDAT, `bpp` bytes per pixel. */
function unfilter(raw: Buffer, height: number, stride: number, bpp: number): Buffer {
  const out = Buffer.alloc(height * stride);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)]!;
    const src = y * (stride + 1) + 1;
    const row = y * stride;
    const prev = row - stride;
    for (let x = 0; x < stride; x++) {
      const a = x >= bpp ? out[row + x - bpp]! : 0;
      const b = y > 0 ? out[prev + x]! : 0;
      const c = x >= bpp && y > 0 ? out[prev + x - bpp]! : 0;
      const v = raw[src + x]!;
      const pred = [0, a, b, (a + b) >> 1, paeth(a, b, c)][filter];
      if (pred === undefined) throw new Error(`bad PNG filter ${filter}`);
      out[row + x] = (v + pred) & 0xff;
    }
  }
  return out;
}

/** Apply the best filter per row; `none` forces filter 0 (right for palettes). */
function filter(pixels: Buffer, height: number, stride: number, bpp: number, none: boolean) {
  const out = Buffer.alloc(height * (stride + 1));
  const candidate = Buffer.alloc(stride);
  for (let y = 0; y < height; y++) {
    const row = y * stride;
    const prev = row - stride;
    let bestScore = Number.POSITIVE_INFINITY;
    for (let f = 0; f <= (none ? 0 : 4); f++) {
      let score = 0;
      for (let x = 0; x < stride; x++) {
        const a = x >= bpp ? pixels[row + x - bpp]! : 0;
        const b = y > 0 ? pixels[prev + x]! : 0;
        const c = x >= bpp && y > 0 ? pixels[prev + x - bpp]! : 0;
        const pred =
          f === 0 ? 0 : f === 1 ? a : f === 2 ? b : f === 3 ? (a + b) >> 1 : paeth(a, b, c);
        const v = (pixels[row + x]! - pred) & 0xff;
        candidate[x] = v;
        score += v < 128 ? v : 256 - v;
      }
      if (score < bestScore) {
        bestScore = score;
        out[y * (stride + 1)] = f;
        candidate.copy(out, y * (stride + 1) + 1);
      }
    }
  }
  return out;
}

export interface Rgba {
  width: number;
  height: number;
  /** Row-major RGBA, 4 bytes a pixel. */
  data: Buffer;
}

/** Decode an 8-bit, non-interlaced RGB/RGBA/palette PNG to RGBA. */
export function decodeRgba(png: Buffer): Rgba {
  const chunks = readChunks(png);
  const ihdr = chunks.find((c) => c.type === "IHDR")!.data;
  const width = ihdr.readUInt32BE(0);
  const height = ihdr.readUInt32BE(4);
  const [depth, colorType, , , interlace] = [ihdr[8], ihdr[9], ihdr[10], ihdr[11], ihdr[12]];
  if (depth !== 8 || interlace !== 0 || ![2, 3, 6].includes(colorType!)) {
    throw new Error(`unsupported PNG (depth ${depth}, colour type ${colorType})`);
  }
  const channels = colorType === 6 ? 4 : colorType === 2 ? 3 : 1;
  const raw = inflateSync(
    Buffer.concat(chunks.filter((c) => c.type === "IDAT").map((c) => c.data)),
  );
  const pixels = unfilter(raw, height, width * channels, channels);
  const data = Buffer.alloc(width * height * 4);
  const plte = chunks.find((c) => c.type === "PLTE")?.data;
  const trns = chunks.find((c) => c.type === "tRNS")?.data;
  for (let i = 0; i < width * height; i++) {
    if (colorType === 3) {
      const idx = pixels[i]!;
      plte!.copy(data, i * 4, idx * 3, idx * 3 + 3);
      data[i * 4 + 3] = trns && idx < trns.length ? trns[idx]! : 255;
    } else {
      pixels.copy(data, i * 4, i * channels, i * channels + 3);
      data[i * 4 + 3] = channels === 4 ? pixels[i * 4 + 3]! : 255;
    }
  }
  return { width, height, data };
}

/** Re-encode `png` losslessly and as small as this can make it. */
export function optimizePng(png: Buffer): Buffer {
  let img: Rgba;
  try {
    img = decodeRgba(png);
  } catch {
    return png;
  }
  const { width, height, data } = img;
  const n = width * height;

  let opaque = true;
  const palette = new Map<number, number>();
  for (let i = 0; i < n; i++) {
    if (data[i * 4 + 3] !== 255) opaque = false;
    if (palette.size <= 256) {
      const key = data.readUInt32BE(i * 4);
      if (!palette.has(key)) palette.set(key, palette.size);
    }
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  const extra: Buffer[] = [];
  let pixels: Buffer;
  let bpp: number;

  if (palette.size <= 256) {
    ihdr[9] = 3;
    bpp = 1;
    // Opaque entries last, so tRNS can stop before them.
    const entries = [...palette.keys()].sort((a, b) => (a & 0xff) - (b & 0xff));
    const index = new Map(entries.map((k, i) => [k, i]));
    const plte = Buffer.alloc(entries.length * 3);
    const alphas: number[] = [];
    entries.forEach((k, i) => {
      plte[i * 3] = k >>> 24;
      plte[i * 3 + 1] = (k >>> 16) & 0xff;
      plte[i * 3 + 2] = (k >>> 8) & 0xff;
      if ((k & 0xff) !== 255) alphas.push(k & 0xff);
    });
    extra.push(chunk("PLTE", plte));
    if (alphas.length) extra.push(chunk("tRNS", Buffer.from(alphas)));
    pixels = Buffer.alloc(n);
    for (let i = 0; i < n; i++) pixels[i] = index.get(data.readUInt32BE(i * 4))!;
  } else if (opaque) {
    ihdr[9] = 2;
    bpp = 3;
    pixels = Buffer.alloc(n * 3);
    for (let i = 0; i < n; i++) data.copy(pixels, i * 3, i * 4, i * 4 + 3);
  } else {
    ihdr[9] = 6;
    bpp = 4;
    pixels = data;
  }

  const filtered = filter(pixels, height, width * bpp, bpp, bpp === 1);
  const idat = deflateSync(filtered, { level: 9, memLevel: 9 });
  const out = Buffer.concat([
    SIGNATURE,
    chunk("IHDR", ihdr),
    ...extra,
    chunk("IDAT", idat),
    chunk("IEND", Buffer.alloc(0)),
  ]);
  return out.length < png.length ? out : png;
}
