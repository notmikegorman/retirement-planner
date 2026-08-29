/**
 * THE NODE DRIVER of the storage seam, and the only place under src/server
 * allowed to import node:fs (tests/server/fileStoreSeam.test.ts enforces
 * that, with two named exceptions it documents).
 *
 * The CONTRACT itself — FileStore, DirEntry, the typed errors, parentDirOf —
 * moved to src/shared/fileStore.ts in Phase 3 of the browser port, because
 * the store logic that calls it (src/store/*) now runs in browser bundles
 * and must not import anything under src/server. This module re-exports the
 * whole contract so its many existing importers keep one import path; what
 * it OWNS is the node:fs implementation and the data folder's location.
 *
 * ATOMICITY, honestly: writeText/writeBytes here are bare fs.writeFile — no
 * temp+rename — exactly what the app did before the seam existed. The
 * browser driver (src/ui/io/fsaFileStore.ts) is deliberately STRONGER
 * (createWritable→close is an atomic swap); the asymmetry and why it is
 * accepted are documented there. The one caller that genuinely cannot await
 * — singleWriter's exit-time lock release inside process.on('exit') — stays
 * on node:fs directly and dies with the server at Phase 7.
 */
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  FileExistsError,
  FileNotFoundError,
  type DirEntry,
  type FileStore,
} from '../shared/fileStore';

export {
  FileExistsError,
  FileNotFoundError,
  parentDirOf,
  type DirEntry,
  type FileStore,
} from '../shared/fileStore';

/** Where the planner's data folder lives (SPEC §2). */
export function getDataDir(): string {
  return process.env.FPLAN_DATA_DIR || path.join(os.homedir(), 'finance-planner-data');
}

const isEnoent = (err: unknown): boolean =>
  (err as NodeJS.ErrnoException).code === 'ENOENT';

/**
 * The node:fs driver.
 *
 * `root` is a FUNCTION, resolved on every operation, because the data folder
 * is: getDataDir() reads FPLAN_DATA_DIR at call time and the server tests
 * repoint it per test. A driver that captured the root once at construction
 * would pin every store to whichever folder the first import saw.
 */
export function createNodeFileStore(root: () => string): FileStore {
  const abs = (relPath: string): string => path.join(root(), relPath);
  return {
    async readText(relPath) {
      try {
        return await fs.readFile(abs(relPath), 'utf8');
      } catch (err) {
        if (isEnoent(err)) throw new FileNotFoundError(abs(relPath));
        throw err;
      }
    },
    async writeText(relPath, text) {
      await fs.writeFile(abs(relPath), text, 'utf8');
    },
    async readBytes(relPath) {
      try {
        return new Uint8Array(await fs.readFile(abs(relPath)));
      } catch (err) {
        if (isEnoent(err)) throw new FileNotFoundError(abs(relPath));
        throw err;
      }
    },
    async writeBytes(relPath, bytes) {
      await fs.writeFile(abs(relPath), bytes);
    },
    async exists(relPath) {
      try {
        await fs.access(abs(relPath));
        return true;
      } catch {
        return false;
      }
    },
    async list(relPath) {
      let entries;
      try {
        entries = await fs.readdir(abs(relPath), { withFileTypes: true });
      } catch (err) {
        if (isEnoent(err)) throw new FileNotFoundError(abs(relPath));
        throw err;
      }
      return entries.map((e) => ({
        name: e.name,
        kind: e.isDirectory() ? ('directory' as const) : ('file' as const),
      }));
    },
    async mkdir(relPath) {
      await fs.mkdir(abs(relPath), { recursive: true });
    },
    async deleteFile(relPath) {
      try {
        await fs.unlink(abs(relPath));
      } catch (err) {
        if (isEnoent(err)) throw new FileNotFoundError(abs(relPath));
        throw err;
      }
    },
    async createExclusive(relPath, text) {
      let handle;
      try {
        // 'wx' is O_CREAT | O_EXCL: it creates the file or fails, never
        // truncates one somebody else is holding (singleWriter's whole point).
        handle = await fs.open(abs(relPath), 'wx');
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'EEXIST') {
          throw new FileExistsError(abs(relPath));
        }
        throw err;
      }
      try {
        await handle.writeFile(text, 'utf8');
      } finally {
        await handle.close();
      }
    },
    describe(relPath) {
      return abs(relPath);
    },
  };
}

/**
 * THE data folder, as one shared store instance. Every module that used to
 * path.join(getDataDir(), ...) now names files relative to this.
 */
export const dataFiles: FileStore = createNodeFileStore(getDataDir);
