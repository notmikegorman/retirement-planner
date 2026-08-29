/**
 * The FileStore driver contract (tests/store/fileStoreContract.ts), run in
 * the node lane against the two drivers this environment can host:
 *
 *   - the node:fs driver on a fresh temp dir — the driver the server runs on;
 *   - the in-memory driver — the fast tier AND the browser's bundled-defaults
 *     backend, which must therefore be exactly as strict as the real ones.
 *
 * The third driver (OPFS in Chromium) runs the SAME case list in the browser
 * lane (tests/browser/stores.test.ts). The case names are pinned identical
 * across lanes there, so a case added here is automatically demanded of the
 * browser driver too.
 */
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, it } from 'vitest';
import { createNodeFileStore } from '../../src/server/fileStore';
import { createMemoryFileStore } from '../../src/shared/memoryFileStore';
import type { FileStore } from '../../src/shared/fileStore';
import { fileStoreContractCases } from './fileStoreContract';

const cases = fileStoreContractCases();

describe('FileStore contract: node:fs driver', () => {
  const tmpDirs: string[] = [];

  afterEach(async () => {
    await Promise.all(tmpDirs.splice(0).map((d) => fs.rm(d, { recursive: true, force: true })));
  });

  async function freshStore(): Promise<FileStore> {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'fplan-contract-'));
    tmpDirs.push(dir);
    return createNodeFileStore(() => dir);
  }

  for (const c of cases) {
    it(c.name, async () => {
      await c.run(await freshStore());
    });
  }
});

describe('FileStore contract: in-memory driver', () => {
  for (const c of cases) {
    it(c.name, async () => {
      await c.run(createMemoryFileStore());
    });
  }
});
