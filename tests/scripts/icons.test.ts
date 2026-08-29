/**
 * The PWA icons (scripts/generateIcons.ts + the committed public/*.png).
 * The committed files are what ships — the generator is run by hand — so
 * both halves are pinned: the committed bytes are real PNGs of the declared
 * dimensions (a manifest icon whose size header lies breaks installability
 * silently), and the rasterizer still draws the art it claims (background,
 * rounded corners vs maskable full-bleed, the white curve).
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { encodePng, rasterizeIcon } from '../../scripts/generateIcons';

const publicDir = fileURLToPath(new URL('../../public', import.meta.url));

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

function pngSize(bytes: Uint8Array): { width: number; height: number } {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return { width: view.getUint32(16), height: view.getUint32(20) };
}

describe('the committed icon files', () => {
  it.each([
    ['icon-192.png', 192],
    ['icon-512.png', 512],
    ['icon-512-maskable.png', 512],
  ])('%s is a real PNG of %ix as declared in the manifest', (file, size) => {
    const bytes = readFileSync(`${publicDir}/${file}`);
    expect([...bytes.subarray(0, 8)]).toEqual(PNG_SIGNATURE);
    expect(pngSize(bytes)).toEqual({ width: size, height: size });
  });

  it('the manifest declares exactly these files', () => {
    const manifest = JSON.parse(readFileSync(`${publicDir}/manifest.webmanifest`, 'utf8')) as {
      icons: { src: string; sizes: string; purpose?: string }[];
    };
    expect(manifest.icons.map((i) => i.src).sort()).toEqual([
      'icon-192.png',
      'icon-512-maskable.png',
      'icon-512.png',
    ]);
    expect(
      manifest.icons.find((i) => i.src === 'icon-512-maskable.png')?.purpose,
    ).toBe('maskable');
  });
});

describe('the rasterizer', () => {
  const size = 192;
  const at = (px: Uint8Array, x: number, y: number) => {
    const i = (y * size + x) * 4;
    return [px[i], px[i + 1], px[i + 2], px[i + 3]];
  };

  it('paints the brand background, opaque, in the middle', () => {
    const px = rasterizeIcon({ size, maskable: false });
    // Left-middle: background only (the curve lives centre-right).
    expect(at(px, 10, size / 2)).toEqual([0x25, 0x63, 0xeb, 255]);
  });

  it('rounds the corners on the regular icon and bleeds on the maskable one', () => {
    const regular = rasterizeIcon({ size, maskable: false });
    const maskable = rasterizeIcon({ size, maskable: true });
    expect(at(regular, 0, 0)[3]).toBe(0); // transparent corner
    expect(at(maskable, 0, 0)).toEqual([0x25, 0x63, 0xeb, 255]); // full-bleed
  });

  it('draws the white curve where the art says it runs', () => {
    const px = rasterizeIcon({ size, maskable: false });
    // The curve's start point, favicon coordinates (7, 25) of 32.
    const [r, g, b, a] = at(px, Math.round((7 / 32) * size), Math.round((25 / 32) * size));
    expect(a).toBe(255);
    expect(r).toBeGreaterThan(250);
    expect(g).toBeGreaterThan(250);
    expect(b).toBeGreaterThan(250);
  });

  it('encodePng round-trips the declared dimensions', () => {
    const png = encodePng(16, rasterizeIcon({ size: 16, maskable: true }));
    expect([...png.subarray(0, 8)]).toEqual(PNG_SIGNATURE);
    expect(pngSize(png)).toEqual({ width: 16, height: 16 });
  });
});
