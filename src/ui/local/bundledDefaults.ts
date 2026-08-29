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

const rawDefaults = import.meta.glob('../../../data-defaults/**/*', {
  query: '?raw',
  import: 'default',
  eager: true,
}) as Record<string, string>;

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
