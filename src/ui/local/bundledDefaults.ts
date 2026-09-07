/**
 * THE BUNDLED DEFAULTS: data-defaults/ baked into the browser bundle as raw
 * strings (Vite `?raw` imports), served to the seeding logic through the
 * in-memory FileStore — the browser's answer to the node side's
 * <repoRoot>/data-defaults directory (src/server/stores.ts).
 *
 * Seeding cannot tell the difference, and must not: createDataStore reads its
 * defaults through the same FileStore contract in both environments (copy =
 * readBytes here, writeBytes there), which is exactly what makes the
 * golden cross-driver gate's "same session, same bytes" claim include the
 * seeded files. The Phase-3 storage harness imports THIS module rather than
 * keeping a copy, so the tested path and the shipped path are one path.
 *
 * `eager: true` on purpose: ~28KB of JSON/CSV rides in the local-backend
 * chunk (which only local mode ever loads), and a lazy per-file fetch would
 * reintroduce a network dependency into seeding — the one step that must work
 * the first time, offline, before anything else exists.
 */
/// <reference types="vite/client" />
import {
  createMemoryFileStore,
  seedMemoryFileStore,
  type MemoryFileStore,
} from '../../shared/memoryFileStore';
import { sha256Hex } from '../../shared/sha256';

const rawDefaults = import.meta.glob('../../../data-defaults/**/*', {
  query: '?raw',
  import: 'default',
  eager: true,
}) as Record<string, string>;

/**
 * A fingerprint of every bundled default, for Show a friend mode's sample.
 *
 * The friend folder is disposable by definition, so it should never need
 * looking after: when the shipped sample changes, the copy sitting in a
 * browser is stale and gets thrown away and re-seeded on the next boot,
 * with no button pressed and nothing to know. That is what this identifies.
 *
 * It also repairs the one folder that mattered. While the plan-block stash
 * was keyed by the CHOSEN folder rather than the BOOTED one (fixed
 * 2026-09-07), "Model the move here" inside the mode wrote a REAL housing
 * move into the sample's plan, and an invented household that cannot afford
 * a real house reported 0.0%. The fix stopped new pollution; it could not
 * clean a folder already holding it, which left the owner to discover a
 * reset button in Settings. A fingerprint that has moved since that folder
 * was seeded reseeds it instead — the repair happens before the page is
 * drawn, and the demo is simply correct.
 *
 * Sorted, path-and-text, so it moves for any change to any default file and
 * for nothing else.
 */
export function bundledDefaultsFingerprint(): string {
  const parts: string[] = [];
  for (const key of Object.keys(rawDefaults).sort()) {
    parts.push(`${key}\u0000${rawDefaults[key] ?? ''}`);
  }
  return sha256Hex(parts.join('\u0001'));
}

export async function bundledDefaults(): Promise<MemoryFileStore> {
  const store = createMemoryFileStore('(bundled defaults)');
  const manifest: Record<string, string> = {};
  for (const [key, text] of Object.entries(rawDefaults)) {
    const idx = key.indexOf('data-defaults/');
    if (idx < 0) continue;
    manifest[key.slice(idx + 'data-defaults/'.length)] = text;
  }
  await seedMemoryFileStore(store, manifest);
  return store;
}
