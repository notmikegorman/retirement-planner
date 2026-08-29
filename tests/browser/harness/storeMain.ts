/**
 * Browser entry of the Phase-3 storage gates: everything that must run IN
 * Chromium, against the REAL FileSystemDirectoryHandle API.
 *
 * The folder under test is OPFS (navigator.storage.getDirectory()) — not a
 * mock and not a picked folder: headless Chromium cannot click a folder
 * picker, and OPFS hands back the same FileSystemDirectoryHandle interface
 * the picker returns, so the driver cannot tell the difference (and is
 * FORBIDDEN from trying — see fsaFileStore's header). Every case runs in a
 * fresh subdirectory of one wiped test root, so cases cannot see each other
 * and a crashed run cannot poison the next.
 *
 * The bundled defaults arrive exactly as the production browser app's will:
 * raw strings baked in by Vite (import.meta.glob '?raw'), served to the
 * seeding logic through an in-memory FileStore — proving the whole
 * defaults-as-assets seeding path, not just the driver.
 *
 * What the page exposes (window.__store) is deliberately name-driven: the
 * Playwright side generates one vitest `it` per case NAME taken from the
 * same case-list modules this bundle imports, so the two lanes cannot drift
 * — a case added to the shared list either runs here too or fails loudly as
 * unknown.
 */
/// <reference types="vite/client" />
import { parentDirOf, type FileStore } from '../../../src/shared/fileStore';
import {
  createMemoryFileStore,
  seedMemoryFileStore,
  type MemoryFileStore,
} from '../../../src/shared/memoryFileStore';
import { createStores } from '../../../src/store';
import { parseLease, LEASE_FILENAME } from '../../../src/store/writerLease';
import { createFsaFileStore } from '../../../src/ui/io/fsaFileStore';
import {
  acquireBrowserWriterGuard,
  type BrowserWriterGuard,
} from '../../../src/ui/io/browserWriterGuard';
import { fileStoreContractCases } from '../../store/fileStoreContract';
import { storeSuiteCases, type StoreSuiteContext } from '../../store/storeSuite';
import {
  maskGoldenTree,
  runGoldenFreshSequence,
  runGoldenLegacySequence,
  treeSnapshot,
} from '../../golden/goldenStoreSequence';
import vtiFixture from '../../fixtures/yahoo-chart-vti.json';

// ---------------------------------------------------------------------------
// Bundled defaults — the production shape of data-defaults in a browser
// ---------------------------------------------------------------------------

const rawDefaults = import.meta.glob('../../../data-defaults/**/*', {
  query: '?raw',
  import: 'default',
  eager: true,
}) as Record<string, string>;

async function bundledDefaults(): Promise<MemoryFileStore> {
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

// ---------------------------------------------------------------------------
// OPFS test-root management
// ---------------------------------------------------------------------------

const TEST_ROOT = 'fplan-store-tests';
let rootPromise: Promise<FileSystemDirectoryHandle> | null = null;

function testRoot(): Promise<FileSystemDirectoryHandle> {
  rootPromise ??= (async () => {
    const opfs = await navigator.storage.getDirectory();
    // '?keep' attaches without wiping: the SECOND tab of the Web Locks
    // scenarios must see (not destroy) the first tab's folders.
    if (!location.search.includes('keep')) {
      await opfs.removeEntry(TEST_ROOT, { recursive: true }).catch(() => undefined);
    }
    return opfs.getDirectoryHandle(TEST_ROOT, { create: true });
  })();
  return rootPromise;
}

let seq = 0;
async function freshFolder(prefix: string): Promise<FileStore> {
  const root = await testRoot();
  seq += 1;
  const dir = await root.getDirectoryHandle(`${prefix}-${seq}`, { create: true });
  return createFsaFileStore(dir, `(opfs ${prefix}-${seq})`);
}

/** Named folders for the lease scenarios — shared BY NAME across two tabs. */
const namedFolders = new Map<string, Promise<FileStore>>();
function namedFolder(name: string): Promise<FileStore> {
  let p = namedFolders.get(name);
  if (!p) {
    p = (async () => {
      const root = await testRoot();
      const dir = await root.getDirectoryHandle(`lease-${name}`, { create: true });
      return createFsaFileStore(dir, `(opfs lease-${name})`);
    })();
    namedFolders.set(name, p);
  }
  return p;
}

// ---------------------------------------------------------------------------
// The driven surface
// ---------------------------------------------------------------------------

const contractCases = fileStoreContractCases();
const suiteCases = storeSuiteCases();
const heldGuards = new Map<string, BrowserWriterGuard>();

export interface LeaseAcquireReply {
  ok: boolean;
  reason?: string;
  message?: string;
  takeoverNote?: string | null;
}

export interface StoreWindow {
  __store: {
    ready: true;
    contractCaseNames: string[];
    suiteCaseNames: string[];
    runContractCase(name: string): Promise<true>;
    runSuiteCase(name: string): Promise<true>;
    golden(): Promise<{ fresh: Record<string, string>; legacy: Record<string, string> }>;
    leaseWrite(folder: string, rel: string, text: string): Promise<true>;
    leaseRead(folder: string, rel: string): Promise<string | null>;
    leaseHolder(folder: string): Promise<string | null>;
    leaseAcquire(
      folder: string,
      clientId: string,
      label: string,
    ): Promise<LeaseAcquireReply>;
    leaseAcquireOverBrokenIO(folder: string): Promise<{ threw: boolean }>;
    leaseRelease(folder: string): Promise<{ leaseGone: boolean }>;
  };
}

(window as unknown as StoreWindow).__store = {
  ready: true,
  contractCaseNames: contractCases.map((c) => c.name),
  suiteCaseNames: suiteCases.map((c) => c.name),

  async runContractCase(name: string): Promise<true> {
    const found = contractCases.find((c) => c.name === name);
    if (!found) throw new Error(`unknown contract case: ${name}`);
    await found.run(await freshFolder('contract'));
    return true;
  },

  async runSuiteCase(name: string): Promise<true> {
    const found = suiteCases.find((c) => c.name === name);
    if (!found) throw new Error(`unknown suite case: ${name}`);
    const files = await freshFolder('suite');
    const defaults = await bundledDefaults();
    const ctx: StoreSuiteContext = {
      files,
      defaults,
      stores: createStores({ files, defaults }),
      vtiFixture,
    };
    await found.run(ctx);
    return true;
  },

  async golden(): Promise<{ fresh: Record<string, string>; legacy: Record<string, string> }> {
    const defaults = await bundledDefaults();
    const freshFiles = await freshFolder('golden-fresh');
    await runGoldenFreshSequence({
      files: freshFiles,
      defaults,
      stores: createStores({ files: freshFiles, defaults }),
      vtiFixture,
    });
    const legacyFiles = await freshFolder('golden-legacy');
    await runGoldenLegacySequence({
      files: legacyFiles,
      defaults,
      stores: createStores({ files: legacyFiles, defaults }),
      vtiFixture,
    });
    // Masked HERE with the same shared mask code the node side uses, so the
    // comparison in the test is byte-vs-byte of two already-normalized trees.
    return {
      fresh: maskGoldenTree(await treeSnapshot(freshFiles)),
      legacy: maskGoldenTree(await treeSnapshot(legacyFiles)),
    };
  },

  async leaseWrite(folder: string, rel: string, text: string): Promise<true> {
    const files = await namedFolder(folder);
    await files.mkdir(parentDirOf(rel));
    await files.writeText(rel, text);
    return true;
  },

  async leaseRead(folder: string, rel: string): Promise<string | null> {
    const files = await namedFolder(folder);
    try {
      return await files.readText(rel);
    } catch {
      return null;
    }
  },

  async leaseHolder(folder: string): Promise<string | null> {
    const files = await namedFolder(folder);
    try {
      return parseLease(await files.readText(LEASE_FILENAME))?.holder.clientId ?? null;
    } catch {
      return null;
    }
  },

  async leaseAcquire(folder: string, clientId: string, label: string): Promise<LeaseAcquireReply> {
    const files = await namedFolder(folder);
    const result = await acquireBrowserWriterGuard({
      files,
      folderId: folder,
      self: { clientId, label },
      onLog: () => undefined,
    });
    if (!result.ok) return { ok: false, reason: result.reason, message: result.message };
    heldGuards.set(folder, result.guard);
    return { ok: true, takeoverNote: result.guard.takeoverNote };
  },

  /**
   * Attempt the guard over a store whose lease read THROWS (an IO failure,
   * not a refusal). The point is the Web Lock's exception hygiene: a throw
   * out of the lease layer must release the lock, or this tab would go on
   * holding it while reporting failure — and a retry would be refused as
   * "another tab" that does not exist. The vitest side proves the release by
   * acquiring the SAME folderId normally right after.
   */
  async leaseAcquireOverBrokenIO(folder: string): Promise<{ threw: boolean }> {
    const files = await namedFolder(folder);
    const broken = {
      ...files,
      async readText(relPath: string): Promise<string> {
        if (relPath === LEASE_FILENAME) throw new Error('injected IO failure');
        return files.readText(relPath);
      },
    };
    try {
      const result = await acquireBrowserWriterGuard({
        files: broken,
        folderId: folder,
        self: { clientId: 'client-broken', label: 'Broken IO Tab' },
        onLog: () => undefined,
      });
      // Reachable only if the throw was swallowed somewhere — release so a
      // failed expectation does not wedge later scenarios, then report.
      if (result.ok) await result.guard.release();
      return { threw: false };
    } catch {
      return { threw: true };
    }
  },

  async leaseRelease(folder: string): Promise<{ leaseGone: boolean }> {
    const guard = heldGuards.get(folder);
    if (!guard) throw new Error(`no held guard for folder ${folder}`);
    heldGuards.delete(folder);
    await guard.release();
    const files = await namedFolder(folder);
    return { leaseGone: !(await files.exists(LEASE_FILENAME)) };
  },
};
