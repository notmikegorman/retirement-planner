/**
 * THE STORAGE SEAM: every byte the app reads or writes in a data folder goes
 * through this interface, and this module is the only place under src/server
 * allowed to import node:fs (tests/server/fileStoreSeam.test.ts enforces
 * that, with two named exceptions it documents).
 *
 * WHY AN INTERFACE AND NOT JUST HELPERS. The browser port (Phase 3 of the
 * plan) needs a second driver on FileSystemDirectoryHandle — the picked
 * folder has no absolute paths, no fs.Stats, no Buffer, and no synchronous
 * calls. So the contract is written against BOTH drivers from day one:
 *
 *   - ASYNC THROUGHOUT. The File System Access API has no sync surface, and
 *     the stores already await their IO, so nothing here may be sync. The one
 *     caller that genuinely cannot await — singleWriter's exit-time lock
 *     release, which runs inside process.on('exit') — stays on node:fs
 *     directly and dies with the server at Phase 3.
 *   - NO NODE TYPES IN SIGNATURES. Text is string, binary is Uint8Array,
 *     listings are plain {name, kind} records. A Buffer or fs.Stats in the
 *     contract would make the browser driver a lie: it would have to fake the
 *     type, and code would eventually call a faked method.
 *   - PATHS ARE RELATIVE, '/'-joined segments inside the store's root
 *     ("plan.json", "runs/<runKey>.json"). The browser driver's root is a
 *     directory HANDLE, not a path, so an absolute path in the contract would
 *     be unimplementable there. Error MESSAGES still need something a human
 *     can act on ("Malformed JSON in /Users/.../plan.json"), which is what
 *     `describe()` is for: the driver renders a relative path however its
 *     environment names files.
 *
 * WHAT THE CONTRACT DELIBERATELY DOES NOT PROMISE: atomic writes, fsync,
 * temp+rename. writeText is exactly today's bare fs.writeFile — Phase 2 is a
 * refactor with zero behaviour change, and the atomicity upgrade the browser
 * driver gets for free (createWritable + close is a swap-and-rename) is
 * Phase 3's story, not this one's.
 *
 * ERROR MAPPING IS MINIMAL ON PURPOSE. Only "it does not exist" is portable
 * across environments, so only that is normalized (FileNotFoundError,
 * FileExistsError for the exclusive create). Everything else — permissions,
 * disk full — passes through as the environment's own error, exactly as the
 * call sites saw it before the seam existed: every store that cares already
 * catches broadly or lets the failure surface with its own message.
 */
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * The path names nothing (driver-level; distinct from dataStore's HTTP-mapped
 * NotFoundError, which stores construct from this one with their own message).
 */
export class FileNotFoundError extends Error {}
/** createExclusive found the file already present — somebody else holds it. */
export class FileExistsError extends Error {}

export interface DirEntry {
  name: string;
  kind: 'file' | 'directory';
}

export interface FileStore {
  /** UTF-8 contents of a file. Throws FileNotFoundError when it is not there. */
  readText(relPath: string): Promise<string>;
  /**
   * Write UTF-8 text, replacing any existing file. The parent directory must
   * already exist (call mkdir first) — matching node's writeFile, so the seam
   * cannot silently create directory trees a store never asked for.
   */
  writeText(relPath: string, text: string): Promise<void>;
  /** Raw bytes of a file (seeding copies). Throws FileNotFoundError. */
  readBytes(relPath: string): Promise<Uint8Array>;
  /** Write raw bytes, replacing any existing file. Parent must exist. */
  writeBytes(relPath: string, bytes: Uint8Array): Promise<void>;
  /** Does this path exist (file or directory)? Any failure to look reads as no. */
  exists(relPath: string): Promise<boolean>;
  /**
   * The entries of a directory, in the order the environment yields them —
   * NOT sorted here: migrateGivingSplitFiles is documented as a raw ordered
   * pass, and the seam must not quietly impose an order the code never had.
   * Throws FileNotFoundError when the directory is not there.
   */
  list(relPath: string): Promise<DirEntry[]>;
  /** Create a directory, parents included; '' is the store's root itself. */
  mkdir(relPath: string): Promise<void>;
  /** Remove one file. Throws FileNotFoundError when it is not there. */
  deleteFile(relPath: string): Promise<void>;
  /**
   * Create a file with this text ONLY if nothing is there — the lock-take
   * primitive ('wx' under node). Throws FileExistsError when the file exists.
   * Its only consumer is singleWriter's .writer.lock, which Phase 3 replaces
   * with Web Locks + a lease file; on the browser driver this operation is
   * check-then-create and therefore advisory, which is exactly the honesty
   * level the lease design already accepts.
   */
  createExclusive(relPath: string, text: string): Promise<void>;
  /**
   * A human-actionable name for this path — the absolute path under node —
   * for error messages and logs. Synchronous and pure: it names, it never
   * touches storage.
   */
  describe(relPath: string): string;
}

/** Where the planner's data folder lives (SPEC §2). */
export function getDataDir(): string {
  return process.env.FPLAN_DATA_DIR || path.join(os.homedir(), 'finance-planner-data');
}

const isEnoent = (err: unknown): boolean =>
  (err as NodeJS.ErrnoException).code === 'ENOENT';

/**
 * The node:fs driver — Phase 2's only implementation.
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

/** The relative parent of a '/'-joined segment path; '' for a top-level file. */
export function parentDirOf(relPath: string): string {
  const idx = relPath.lastIndexOf('/');
  return idx < 0 ? '' : relPath.slice(0, idx);
}
