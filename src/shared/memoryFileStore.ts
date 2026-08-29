/**
 * The in-memory FileStore: a full, honest implementation of the contract over
 * two Maps — no environment, no persistence, no permissions.
 *
 * It exists for two jobs, both of which need it to be a faithful driver and
 * not a convenience mock:
 *
 *   1. THE BROWSER'S BUNDLED DEFAULTS. In the browser, data-defaults/ arrives
 *      as strings baked into the bundle (Vite `?raw` imports), and seeding
 *      reads them through the same FileStore contract it reads a real
 *      defaults directory through under node (copy = readBytes here,
 *      writeBytes there). `seedMemoryFileStore` turns that manifest into a
 *      store; nothing in dataStore knows or cares which kind of defaults it
 *      was handed.
 *   2. THE FAST UNIT TIER of the ported store tests: the same suite runs
 *      against this driver in milliseconds and against the real drivers
 *      (node:fs, OPFS-in-Chromium) where the environment is the thing under
 *      test.
 *
 * Because job 2 only means anything if this driver enforces the contract's
 * sharp edges, it does — parent-must-exist on every write (a mock that
 * auto-created parents would let a store pass here and fail on both real
 * drivers), FileNotFoundError mapping, listing in insertion order (the
 * environment order of a Map, which is exactly what "the order the
 * environment yields them" means here).
 */
import {
  FileExistsError,
  FileNotFoundError,
  parentDirOf,
  type DirEntry,
  type FileStore,
} from './fileStore';

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export interface MemoryFileStore extends FileStore {
  /** Every file currently held, path → bytes. Exposed for test assertions. */
  snapshot(): Map<string, Uint8Array>;
}

export function createMemoryFileStore(label = '(memory)'): MemoryFileStore {
  // '' — the root — always exists, like a real mounted directory.
  const dirs = new Set<string>(['']);
  const files = new Map<string, Uint8Array>();

  const describe = (relPath: string): string =>
    relPath === '' ? label : `${label}/${relPath}`;

  const requireParent = (relPath: string): void => {
    const parent = parentDirOf(relPath);
    if (!dirs.has(parent)) {
      // Same shape as node's ENOENT from writeFile: an environment error, not
      // a normalized one — the contract only normalizes "the FILE is absent".
      throw new Error(`parent directory does not exist: ${describe(parent)}`);
    }
  };

  const put = (relPath: string, bytes: Uint8Array): void => {
    requireParent(relPath);
    if (dirs.has(relPath)) throw new Error(`is a directory: ${describe(relPath)}`);
    files.set(relPath, bytes);
  };

  return {
    async readText(relPath) {
      const bytes = files.get(relPath);
      if (bytes === undefined) throw new FileNotFoundError(describe(relPath));
      return decoder.decode(bytes);
    },
    async writeText(relPath, text) {
      put(relPath, encoder.encode(text));
    },
    async readBytes(relPath) {
      const bytes = files.get(relPath);
      if (bytes === undefined) throw new FileNotFoundError(describe(relPath));
      return bytes.slice();
    },
    async writeBytes(relPath, bytes) {
      put(relPath, bytes.slice());
    },
    async exists(relPath) {
      return files.has(relPath) || dirs.has(relPath);
    },
    async list(relPath) {
      if (!dirs.has(relPath)) throw new FileNotFoundError(describe(relPath));
      const prefix = relPath === '' ? '' : `${relPath}/`;
      const out: DirEntry[] = [];
      // Insertion order — this store's "environment order". Directories and
      // files interleave in the order they were created, like a real listing.
      for (const dir of dirs) {
        if (dir === '' || !dir.startsWith(prefix)) continue;
        const rest = dir.slice(prefix.length);
        if (rest.length > 0 && !rest.includes('/')) out.push({ name: rest, kind: 'directory' });
      }
      for (const file of files.keys()) {
        if (!file.startsWith(prefix)) continue;
        const rest = file.slice(prefix.length);
        if (!rest.includes('/')) out.push({ name: rest, kind: 'file' });
      }
      return out;
    },
    async mkdir(relPath) {
      if (relPath === '') return;
      const segments = relPath.split('/');
      for (let i = 1; i <= segments.length; i++) {
        dirs.add(segments.slice(0, i).join('/'));
      }
    },
    async deleteFile(relPath) {
      if (!files.delete(relPath)) throw new FileNotFoundError(describe(relPath));
    },
    async createExclusive(relPath, text) {
      if (files.has(relPath) || dirs.has(relPath)) {
        throw new FileExistsError(describe(relPath));
      }
      put(relPath, encoder.encode(text));
    },
    describe,
    snapshot() {
      return new Map(files);
    },
  };
}

/**
 * Build a store from a path → contents manifest (the bundled-defaults shape),
 * creating every parent directory. Insertion order of the manifest becomes
 * the store's listing order, so callers that care (none should — seeding
 * copies files individually) get a deterministic one.
 */
export async function seedMemoryFileStore(
  store: MemoryFileStore,
  manifest: Record<string, string | Uint8Array>,
): Promise<void> {
  for (const [relPath, contents] of Object.entries(manifest)) {
    await store.mkdir(parentDirOf(relPath));
    if (typeof contents === 'string') await store.writeText(relPath, contents);
    else await store.writeBytes(relPath, contents);
  }
}
