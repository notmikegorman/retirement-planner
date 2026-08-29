/**
 * The ported store suite (tests/store/storeSuite.ts), run in the node lane
 * against two drivers:
 *
 *   - the in-memory driver — the fast unit tier: the same guard/refusal/
 *     migration logic with zero fs latency, and proof the memory fake is
 *     faithful enough to develop against;
 *   - the node:fs driver on a fresh temp dir — the same composition the
 *     server wrappers use, minus the env-var indirection.
 *
 * The browser lane (tests/browser/stores.test.ts) runs the same case list
 * against the OPFS driver in Chromium and pins the LIST equal to this one,
 * so a case added here is automatically demanded there.
 */
import { promises as fs } from 'node:fs';
import { readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, it } from 'vitest';
import { createNodeFileStore } from '../../src/server/fileStore';
import {
  createMemoryFileStore,
  seedMemoryFileStore,
  type MemoryFileStore,
} from '../../src/shared/memoryFileStore';
import type { FileStore } from '../../src/shared/fileStore';
import { createStores } from '../../src/store';
import { storeSuiteCases, type StoreSuiteContext } from './storeSuite';

const repoRoot = fileURLToPath(new URL('../../', import.meta.url));
const defaultsDir = path.join(repoRoot, 'data-defaults');

const vtiFixture = JSON.parse(
  readFileSync(path.join(repoRoot, 'tests', 'fixtures', 'yahoo-chart-vti.json'), 'utf8'),
) as unknown;

const cases = storeSuiteCases();

/** data-defaults as a memory store — the browser's bundled-defaults shape. */
async function memoryDefaults(): Promise<MemoryFileStore> {
  const store = createMemoryFileStore('(bundled defaults)');
  const manifest: Record<string, Uint8Array> = {};
  async function walk(rel: string): Promise<void> {
    for (const entry of await fs.readdir(path.join(defaultsDir, rel), { withFileTypes: true })) {
      const childRel = rel === '' ? entry.name : `${rel}/${entry.name}`;
      if (entry.isDirectory()) await walk(childRel);
      else manifest[childRel] = new Uint8Array(await fs.readFile(path.join(defaultsDir, childRel)));
    }
  }
  await walk('');
  await seedMemoryFileStore(store, manifest);
  return store;
}

describe('ported store suite: in-memory driver', () => {
  for (const c of cases) {
    it(c.name, async () => {
      const files = createMemoryFileStore('(memory data folder)');
      const defaults = await memoryDefaults();
      const ctx: StoreSuiteContext = {
        files,
        defaults,
        stores: createStores({ files, defaults }),
        vtiFixture,
      };
      await c.run(ctx);
    });
  }
});

describe('ported store suite: node:fs driver', () => {
  const tmpDirs: string[] = [];

  afterEach(async () => {
    await Promise.all(tmpDirs.splice(0).map((d) => fs.rm(d, { recursive: true, force: true })));
  });

  async function freshFiles(): Promise<FileStore> {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'fplan-storesuite-'));
    tmpDirs.push(dir);
    return createNodeFileStore(() => dir);
  }

  const defaults = createNodeFileStore(() => defaultsDir);

  for (const c of cases) {
    it(c.name, async () => {
      const files = await freshFiles();
      const ctx: StoreSuiteContext = {
        files,
        defaults,
        stores: createStores({ files, defaults }),
        vtiFixture,
      };
      await c.run(ctx);
    });
  }
});
