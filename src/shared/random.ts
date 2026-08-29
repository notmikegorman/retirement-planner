/**
 * The one source of record-id randomness, on the WEB crypto API — which Node
 * (≥20) and every browser both ship as `globalThis.crypto` — so the id format
 * (`nw-<time36>-<6 hex>`, `ph-<time36>-<6 hex>`) is produced by the same code
 * in both environments. Deliberately NOT a per-environment fork: the browser
 * port's whole verification story is byte-comparing folders across drivers,
 * and two "equivalent" random suffixes from two implementations is exactly
 * the kind of benign-looking difference that would teach the golden-folder
 * diff to tolerate drift.
 *
 * (The suffixes are still masked in golden comparisons — randomness is
 * randomness — but the FORMAT and the generator are pinned shared.)
 */

/** `n` cryptographically random bytes as lowercase hex (2n characters). */
export function randomHex(n: number): string {
  const bytes = new Uint8Array(n);
  globalThis.crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}
