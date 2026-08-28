/**
 * The vendored sha256 must be byte-identical to `node:crypto` — not "correct
 * in spirit", identical. Every cache key (runKeyFor), every RunMeta hash,
 * every planHash/spaceHash/keyOf computes through it, so a single divergent
 * input means every cached run on disk silently misses, the search economy
 * dies, and golden digests fail confusingly — while every screen keeps
 * rendering. This file is the proof that can never happen:
 *
 *  - the FIPS 180-4 vectors pin correctness against the STANDARD (published
 *    values, not just "whatever node says today");
 *  - an exhaustive sweep of small lengths covers every padding boundary,
 *    where hand-rolled SHA-256 implementations classically break;
 *  - multi-byte UTF-8 pins catch the encoder fork (node's utf8 vs a UTF-16
 *    code-unit hash agree on ASCII and split on the first em-dash — and the
 *    stored labels are full of em-dashes);
 *  - 100,000 seeded random inputs across lengths and scripts property-test
 *    equality with `createHash` directly.
 */
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { sha256Hex } from '../../src/shared/sha256';

/** The reference: node:crypto itself, utf8-encoding strings as .update does. */
function nodeSha256Hex(input: string | Uint8Array): string {
  return createHash('sha256').update(input).digest('hex');
}

describe('sha256Hex matches the FIPS 180-4 reference vectors', () => {
  // Published NIST values — pinned as literals so this test would survive
  // (and still mean something) in an environment with no node:crypto at all.
  const vectors: Array<[name: string, input: string, digest: string]> = [
    ['empty message', '', 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'],
    ['"abc"', 'abc', 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad'],
    [
      'two-block 56-byte message',
      'abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq',
      '248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1',
    ],
    [
      'three-block 112-byte message',
      'abcdefghbcdefghicdefghijdefghijkefghijklfghijklmghijklmnhijklmno' +
        'ijklmnopjklmnopqklmnopqrlmnopqrsmnopqrstnopqrstu',
      'cf5b16a778af8380036ce59e7b0492370b249b11e8f07a51afac45037afee9d1',
    ],
  ];

  for (const [name, input, digest] of vectors) {
    it(`digests the ${name} to the published value`, () => {
      expect(sha256Hex(input)).toBe(digest);
    });
  }

  it('digests a 15,625-block message to the published value (one million "a"s)', () => {
    expect(sha256Hex('a'.repeat(1_000_000))).toBe(
      'cdc76e5c9914fb9281a1c7e284d73e67f1809a48a497200e046d39ccc7112cd0',
    );
  });
});

describe('sha256Hex survives every padding boundary', () => {
  it('agrees with node:crypto at every length 0..257', () => {
    // 55/56 (length field fits / spills a block), 63/64/65 (block edges) and
    // both multi-block edges all live inside this sweep; an off-by-one in the
    // padding arithmetic cannot hide from it.
    for (let n = 0; n <= 257; n++) {
      const s = 'a'.repeat(n);
      expect(sha256Hex(s), `length ${n}`).toBe(nodeSha256Hex(s));
    }
  });
});

describe('sha256Hex UTF-8-encodes strings exactly as node:crypto does', () => {
  // Pinned literals (computed with createHash once, at authoring time) AND a
  // live comparison. The pins keep meaning in a node:crypto-free environment;
  // the live check makes the equivalence claim self-verifying here.
  const vectors: Array<[name: string, input: string, digest: string]> = [
    [
      'em-dashes (3-byte UTF-8, everywhere in stored labels)',
      'phase one — rent, then buy',
      'eef31b892a9fe2c542d8fa7f22622104f705ed16a7aa08ab26a7edf194614ff4',
    ],
    [
      'accented characters (2-byte UTF-8)',
      'café naïve résumé',
      '46b141253557c500c5f438e6fe9bd901ebded55773b57676c310016b6fb8c490',
    ],
    [
      'an emoji (4-byte UTF-8, a surrogate pair in UTF-16)',
      'balance 💰 check',
      'a828904ea0c4eda117d93e0c0b6fa8f6ef1d8e83941f24fbca2fd73c9e791677',
    ],
    [
      'mixed multi-byte widths in one string',
      '—é€🎉 mixed — café 💰',
      '2bc5b9ccf07bfc1877ec6bf29b1097b05c899806d7864cd5a4cca47ea2a95951',
    ],
  ];

  for (const [name, input, digest] of vectors) {
    it(`digests ${name} to the pinned value`, () => {
      expect(sha256Hex(input)).toBe(digest);
      expect(nodeSha256Hex(input)).toBe(digest);
    });
  }

  it('replaces a lone surrogate the same way node does (U+FFFD)', () => {
    // Both WHATWG TextEncoder and node's utf8 encoder map an unpaired
    // surrogate to the replacement character. If either ever didn't, a label
    // truncated mid-emoji would hash differently on the two sides.
    const lone = 'broken \ud83d surrogate';
    expect(sha256Hex(lone)).toBe(nodeSha256Hex(lone));
  });
});

describe('sha256Hex on raw bytes', () => {
  it('hashes a Uint8Array to the same digest as the string it encodes', () => {
    const s = 'bytes — and text';
    expect(sha256Hex(new TextEncoder().encode(s))).toBe(sha256Hex(s));
  });

  it('hashes a subarray view by its contents, not its backing buffer', () => {
    // A DataView opened on the wrong buffer offset would read neighbouring
    // bytes and still produce a plausible-looking digest.
    const backing = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9]);
    const view = backing.subarray(3, 7);
    expect(sha256Hex(view)).toBe(nodeSha256Hex(new Uint8Array([4, 5, 6, 7])));
  });
});

describe('sha256Hex equals node:crypto on 100,000 seeded random inputs', () => {
  /**
   * mulberry32 — the same tiny integer-op PRNG the engine uses (rng.ts), so
   * the corpus is bit-identical on every platform and every CI run. A flaky
   * random corpus would make a real divergence look like test noise.
   */
  function mulberry32(seed: number): () => number {
    let a = seed >>> 0;
    return () => {
      a = (a + 0x6d2b79f5) >>> 0;
      let t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  it('produces byte-identical hex across lengths 0..~2000 bytes and all scripts', () => {
    const rand = mulberry32(0x5eed5a25);
    for (let iter = 0; iter < 100_000; iter++) {
      // Up to ~600 code points at up to 4 UTF-8 bytes each ≈ 2400 bytes;
      // iter 0 pins the empty string into the corpus unconditionally.
      const codePoints = iter === 0 ? 0 : Math.floor(rand() * 600);
      const mode = iter % 5;
      let s = '';
      for (let i = 0; i < codePoints; i++) {
        if (mode === 0) {
          // ASCII
          s += String.fromCharCode(0x20 + Math.floor(rand() * 0x5f));
        } else if (mode === 1) {
          // Latin-1: the 1-byte/2-byte UTF-8 boundary
          s += String.fromCharCode(Math.floor(rand() * 0x100));
        } else if (mode === 2) {
          // BMP minus surrogates: the 3-byte range (em-dashes live here)
          let cp = Math.floor(rand() * 0x10000);
          if (cp >= 0xd800 && cp <= 0xdfff) cp = 0x2014; // em-dash
          s += String.fromCharCode(cp);
        } else if (mode === 3) {
          // Astral plane: 4-byte UTF-8, surrogate pairs in UTF-16
          s += String.fromCodePoint(0x10000 + Math.floor(rand() * 0x100000));
        } else {
          // Surrogate salad: lone surrogates mixed with ASCII — both encoders
          // must agree on the U+FFFD replacement, not just on clean text
          s +=
            rand() < 0.3
              ? String.fromCharCode(0xd800 + Math.floor(rand() * 0x800))
              : String.fromCharCode(0x20 + Math.floor(rand() * 0x5f));
        }
      }
      const actual = sha256Hex(s);
      const expected = nodeSha256Hex(s);
      if (actual !== expected) {
        // Report the seed-reproducible failure precisely instead of dumping
        // 100k comparisons through the assertion library.
        expect.fail(
          `divergence at iteration ${iter} (mode ${mode}, ${codePoints} code points): ` +
            `vendored ${actual} !== node ${expected} for ${JSON.stringify(s)}`,
        );
      }
    }
  });
});
