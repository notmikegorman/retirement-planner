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
import { createStores } from '../../../src/store';
import { createFsaFileStore } from '../../../src/ui/io/fsaFileStore';
import {
  acquireBrowserWriterGuard,
  type BrowserWriterGuard,
} from '../../../src/ui/io/browserWriterGuard';
import { bundledDefaults } from '../../../src/ui/local/bundledDefaults';
import { fileStoreContractCases } from '../../store/fileStoreContract';
import { storeSuiteCases, type StoreSuiteContext } from '../../store/storeSuite';
import {
  maskGoldenTree,
  runGoldenFreshSequence,
  runGoldenLegacySequence,
  treeSnapshot,
} from '../../golden/goldenStoreSequence';
import vtiFixture from '../../fixtures/yahoo-chart-vti.json';

// Bundled defaults: the PRODUCTION module (src/ui/local/bundledDefaults.ts,
// imported above) — the harness proves the exact seeding path the local
// backend ships, not a test copy of it.

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

export interface GuardAcquireReply {
  ok: boolean;
  reason?: string;
  message?: string;
}

export interface StoreWindow {
  __store: {
    ready: true;
    contractCaseNames: string[];
    suiteCaseNames: string[];
    runContractCase(name: string): Promise<true>;
    runSuiteCase(name: string): Promise<true>;
    golden(): Promise<{ fresh: Record<string, string>; legacy: Record<string, string> }>;
    writeRaw(folder: string, rel: string, text: string): Promise<true>;
    readRaw(folder: string, rel: string): Promise<string | null>;
    guardAcquire(folder: string): Promise<GuardAcquireReply>;
    guardRelease(folder: string): Promise<true>;
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

  async writeRaw(folder: string, rel: string, text: string): Promise<true> {
    const files = await namedFolder(folder);
    await files.mkdir(parentDirOf(rel));
    await files.writeText(rel, text);
    return true;
  },

  async readRaw(folder: string, rel: string): Promise<string | null> {
    const files = await namedFolder(folder);
    try {
      return await files.readText(rel);
    } catch {
      return null;
    }
  },

  async guardAcquire(folder: string): Promise<GuardAcquireReply> {
    const result = await acquireBrowserWriterGuard({ folderId: folder });
    if (!result.ok) return { ok: false, reason: result.reason, message: result.message };
    heldGuards.set(folder, result.guard);
    return { ok: true };
  },

  async guardRelease(folder: string): Promise<true> {
    const guard = heldGuards.get(folder);
    if (!guard) throw new Error(`no held guard for folder ${folder}`);
    heldGuards.delete(folder);
    await guard.release();
    return true;
  },
};
