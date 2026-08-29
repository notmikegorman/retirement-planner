/**
 * THE STORAGE CONTRACT, environment-free: every byte the app reads or writes
 * in a data folder moves through this interface, and as of Phase 3 of the
 * browser port there are two drivers on opposite sides of it —
 *
 *   - src/server/fileStore.ts   node:fs, rooted at an absolute path
 *   - src/ui/io/fsaFileStore.ts FileSystemDirectoryHandle (picked folder/OPFS)
 *   - src/shared/memoryFileStore.ts  in-memory, for bundled defaults and tests
 *
 * The contract lives HERE, under src/shared, because the store logic that
 * calls it (src/store/*) must be importable in a browser bundle, and an
 * interface stranded in src/server would drag the Node driver into every
 * browser import chain. src/shared is pinned Node-free forever by
 * tests/shared/noNodeImports.test.ts, so the contract itself can never grow a
 * Node type by accident.
 *
 * The design constraints, written against BOTH drivers from day one:
 *
 *   - ASYNC THROUGHOUT. The File System Access API has no sync surface, and
 *     the stores already await their IO, so nothing here may be sync.
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
 * WHAT THE CONTRACT PROMISES ABOUT ATOMICITY: nothing — and the two drivers
 * genuinely differ here, on purpose. The Node driver's writeText is a bare
 * fs.writeFile (exactly what the app did before the seam existed); the
 * browser driver's is createWritable→close, which the platform performs as a
 * swap-file-and-rename and is therefore atomic whole-file replacement. The
 * asymmetry is documented at the browser driver, where it is load-bearing:
 * it is what makes a torn record file impossible in the environment where a
 * closed tab — not a rare crash — is the ordinary way the process dies.
 *
 * ERROR MAPPING IS MINIMAL ON PURPOSE. Only "it does not exist" is portable
 * across environments, so only that is normalized (FileNotFoundError,
 * FileExistsError for the exclusive create). Everything else — permissions,
 * disk full, quota — passes through as the environment's own error, exactly
 * as the call sites saw it before the seam existed: every store that cares
 * already catches broadly or lets the failure surface with its own message.
 */

/**
 * The path names nothing (driver-level; distinct from the stores' HTTP-mapped
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
   * cannot silently create directory trees a store never asked for. Every
   * driver must reproduce this refusal, including the browser one, whose API
   * would happily create parents if asked.
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
   * Create a file with this text ONLY if nothing is there. Under node this is
   * 'wx' — a real O_EXCL, strong enough to carry a lock. On the browser
   * driver it is check-then-create and therefore ADVISORY ONLY: nothing
   * mutual-exclusion-critical may ride on it there, which is why the
   * single-writer lease (src/store/writerLease.ts) never calls it and the
   * browser's actual exclusion is Web Locks (src/ui/io/browserWriterGuard.ts).
   * Throws FileExistsError when the file exists.
   */
  createExclusive(relPath: string, text: string): Promise<void>;
  /**
   * A human-actionable name for this path — the absolute path under node, a
   * labelled relative path in the browser — for error messages and logs.
   * Synchronous and pure: it names, it never touches storage.
   */
  describe(relPath: string): string;
}

/** The relative parent of a '/'-joined segment path; '' for a top-level file. */
export function parentDirOf(relPath: string): string {
  const idx = relPath.lastIndexOf('/');
  return idx < 0 ? '' : relPath.slice(0, idx);
}
