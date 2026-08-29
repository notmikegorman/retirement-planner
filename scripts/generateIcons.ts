/**
 * PWA ICON GENERATOR — `npx tsx scripts/generateIcons.ts` regenerates the
 * three PNGs in public/ (icon-192, icon-512, icon-512-maskable) from the
 * same art as public/favicon.svg: the #2563eb rounded square, the white
 * compounding curve, the 28%-white fan band beneath it.
 *
 * Hand-rolled rasterizer + PNG encoder ON PURPOSE: the alternative is an
 * image-library devDependency for three static files that change never.
 * node:zlib deflates the scanlines; the CRC32 is ~10 lines; the drawing is
 * a bezier sampled into a splat buffer. The generated files are COMMITTED
 * (builds never regenerate them — deflate output is not guaranteed stable
 * across zlib versions, and an icon that changes bytes per builder would
 * churn every deploy); tests/scripts/icons.test.ts pins the committed
 * files' signature and dimensions, and the rasterizer's pure functions.
 */
import { deflateSync } from 'node:zlib';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// --------------------------------------------------------------------------
// The art, in the favicon's own 32-unit coordinate space
// --------------------------------------------------------------------------

const ART_UNITS = 32;
const BG: readonly [number, number, number] = [0x25, 0x63, 0xeb]; // #2563eb
const CURVE = { p0: [7, 25], c1: [13, 24], c2: [19, 19.5], p3: [25, 8] } as const;
const STROKE_W = 3.5;
const FAN_OPACITY = 0.28;
const CORNER_R = 7;

function bezier(t: number): [number, number] {
  const m = 1 - t;
  const x =
    m * m * m * CURVE.p0[0] +
    3 * m * m * t * CURVE.c1[0] +
    3 * m * t * t * CURVE.c2[0] +
    t * t * t * CURVE.p3[0];
  const y =
    m * m * m * CURVE.p0[1] +
    3 * m * m * t * CURVE.c1[1] +
    3 * m * t * t * CURVE.c2[1] +
    t * t * t * CURVE.p3[1];
  return [x, y];
}

export interface IconOptions {
  size: number;
  /**
   * Maskable icons must bleed to the edge and keep the art inside the safe
   * zone: full-square background, art scaled toward the centre, no corner
   * rounding. Regular icons get the favicon's rounded corners via alpha.
   */
  maskable: boolean;
}

/** RGBA8 pixels, row-major — the pure half the tests exercise. */
export function rasterizeIcon({ size, maskable }: IconOptions): Uint8Array {
  const px = new Uint8Array(size * size * 4);
  const artScale = maskable ? 0.8 : 1;
  const unit = (size / ART_UNITS) * artScale;
  const offset = (size * (1 - artScale)) / 2;
  const toPx = (v: number): number => v * unit + offset;

  // Background (+ rounded-corner alpha for the non-maskable shape).
  const r = maskable ? 0 : (CORNER_R / ART_UNITS) * size;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 4;
      let alpha = 255;
      if (r > 0) {
        const cx = Math.max(r, Math.min(size - r, x + 0.5));
        const cy = Math.max(r, Math.min(size - r, y + 0.5));
        const d = Math.hypot(x + 0.5 - cx, y + 0.5 - cy);
        alpha = d <= r - 0.5 ? 255 : d >= r + 0.5 ? 0 : Math.round(255 * (r + 0.5 - d));
      }
      px[i] = BG[0];
      px[i + 1] = BG[1];
      px[i + 2] = BG[2];
      px[i + 3] = alpha;
    }
  }

  // The curve, sampled densely once; reused by both the fan and the stroke.
  const samples: [number, number][] = [];
  const n = size * 4;
  for (let s = 0; s <= n; s++) {
    const [ax, ay] = bezier(s / n);
    samples.push([toPx(ax), toPx(ay)]);
  }

  // Fan band: between the curve and its baseline, x within the curve's span.
  const yBase = toPx(CURVE.p0[1]);
  const minCurveY = new Float64Array(size).fill(Number.POSITIVE_INFINITY);
  for (const [sx, sy] of samples) {
    const col = Math.round(sx);
    if (col >= 0 && col < size && sy < minCurveY[col]) minCurveY[col] = sy;
  }
  const x0 = Math.ceil(toPx(CURVE.p0[0]));
  const x1 = Math.floor(toPx(CURVE.p3[0]));
  for (let x = x0; x <= x1 && x < size; x++) {
    if (!Number.isFinite(minCurveY[x])) continue;
    for (let y = Math.ceil(minCurveY[x]); y <= yBase && y < size; y++) {
      const i = (y * size + x) * 4;
      if (px[i + 3] === 0) continue; // outside the rounded corner
      px[i] = Math.round(px[i] + FAN_OPACITY * (255 - px[i]));
      px[i + 1] = Math.round(px[i + 1] + FAN_OPACITY * (255 - px[i + 1]));
      px[i + 2] = Math.round(px[i + 2] + FAN_OPACITY * (255 - px[i + 2]));
    }
  }

  // Stroke: splat each sample's disc into a min-distance buffer, then paint
  // white with a one-pixel antialias ramp. Round caps come free.
  const half = (STROKE_W / ART_UNITS) * size * artScale * 0.5;
  const dist = new Float64Array(size * size).fill(Number.POSITIVE_INFINITY);
  const reach = Math.ceil(half + 1);
  for (const [sx, sy] of samples) {
    const yLo = Math.max(0, Math.floor(sy) - reach);
    const yHi = Math.min(size - 1, Math.ceil(sy) + reach);
    const xLo = Math.max(0, Math.floor(sx) - reach);
    const xHi = Math.min(size - 1, Math.ceil(sx) + reach);
    for (let y = yLo; y <= yHi; y++) {
      for (let x = xLo; x <= xHi; x++) {
        const d = Math.hypot(x + 0.5 - sx, y + 0.5 - sy);
        const idx = y * size + x;
        if (d < dist[idx]) dist[idx] = d;
      }
    }
  }
  for (let idx = 0; idx < size * size; idx++) {
    const d = dist[idx];
    if (d > half + 0.5) continue;
    const i = idx * 4;
    if (px[i + 3] === 0) continue;
    const cover = d <= half - 0.5 ? 1 : half + 0.5 - d;
    px[i] = Math.round(px[i] + cover * (255 - px[i]));
    px[i + 1] = Math.round(px[i + 1] + cover * (255 - px[i + 1]));
    px[i + 2] = Math.round(px[i + 2] + cover * (255 - px[i + 2]));
  }

  return px;
}

// --------------------------------------------------------------------------
// PNG encoding (RGBA8, filter 0, one IDAT)
// --------------------------------------------------------------------------

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (const b of bytes) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, data.length);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  view.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
  return out;
}

export function encodePng(size: number, rgba: Uint8Array): Uint8Array {
  const ihdr = new Uint8Array(13);
  const v = new DataView(ihdr.buffer);
  v.setUint32(0, size);
  v.setUint32(4, size);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type RGBA
  const raw = new Uint8Array(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0; // filter: none
    raw.set(rgba.subarray(y * size * 4, (y + 1) * size * 4), y * (size * 4 + 1) + 1);
  }
  const idat = new Uint8Array(deflateSync(raw, { level: 9 }));
  const signature = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const parts = [
    signature,
    chunk('IHDR', ihdr),
    chunk('IDAT', idat),
    chunk('IEND', new Uint8Array(0)),
  ];
  const total = parts.reduce((sum, p) => sum + p.length, 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

// --------------------------------------------------------------------------
// CLI
// --------------------------------------------------------------------------

const ICONS: { file: string; options: IconOptions }[] = [
  { file: 'icon-192.png', options: { size: 192, maskable: false } },
  { file: 'icon-512.png', options: { size: 512, maskable: false } },
  { file: 'icon-512-maskable.png', options: { size: 512, maskable: true } },
];

const invokedDirectly =
  typeof process.argv[1] === 'string' &&
  import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  const publicDir = fileURLToPath(new URL('../public', import.meta.url));
  for (const { file, options } of ICONS) {
    const png = encodePng(options.size, rasterizeIcon(options));
    await fs.writeFile(path.join(publicDir, file), png);
    console.log(`${file}: ${png.length} bytes`);
  }
}
