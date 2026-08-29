/**
 * THE BROWSER DRIVER of the storage seam: the FileStore contract on a
 * FileSystemDirectoryHandle.
 *
 * The handle is the ONLY thing this driver knows about its world — it must
 * not care whether the handle came from showDirectoryPicker() (the picked
 * real folder, Phase 7) or navigator.storage.getDirectory() (OPFS, which is
 * how every automated test drives it: headless Chromium cannot click a
 * folder picker, and OPFS hands back the same FileSystemDirectoryHandle API
 * with no prompt). Nothing here may branch on the handle's origin; if it ever
 * needs to, the driver has grown a second contract and the tests are testing
 * the wrong one.
 *
 * It lives under src/ui (not src/shared) because it is browser-ONLY code — it
 * cannot run under node, so "shared" would be a false label — and it must
 * not import from src/server, because pulling the node driver's module graph
 * into a browser bundle is exactly the dependency direction the seam exists
 * to forbid. src/ui/io is pinned Node-import-free forever by
 * tests/shared/noNodeImports.test.ts.
 *
 * SEMANTICS THE CONTRACT DEMANDS, and how each maps:
 *
 *   - PARENT MUST EXIST on writes. The FSA API would happily create every
 *     missing directory ({create: true} on each segment); doing so would let
 *     store code pass in the browser while throwing ENOENT under node. So
 *     writes navigate to the parent with {create: false} and let the
 *     NotFoundError fly as the environment's own error — the same
 *     unnormalized passthrough as node's raw ENOENT from writeFile.
 *   - list() reports the environment's own order. FSA does not promise one;
 *     neither does the contract (readdir order under node is the filesystem's
 *     whim too). Callers that need an order sort themselves.
 *   - DOMException NotFoundError → FileNotFoundError on reads/deletes, the
 *     one portable mapping. TypeMismatchError (file where a directory was
 *     expected, or vice versa) passes through raw, as node's EISDIR does.
 *
 * ATOMICITY — DELIBERATELY STRONGER THAN THE NODE DRIVER, and load-bearing:
 * writeText/writeBytes go createWritable() → write → close(), and the
 * platform stages those bytes in a swap file (Chromium's .crswap) and
 * atomically replaces the target at close(). The node driver is a bare
 * fs.writeFile that can be caught mid-write. The asymmetry is accepted, not
 * accidental, because the environments die differently: a node server dies
 * rarely and by accident; a browser tab dies EVERY DAY, on purpose, by close
 * button — the design lists "a closed browser" among the things a record
 * must survive. This project has already paid for teaching that lesson
 * twice: a mistimed restart mid-scoring cost a real net-worth row its figure
 * (the wait-for-quiet in update.sh exists because of it), and a snapshot row
 * is un-recreatable by definition ("records prices from a moment that has
 * passed"). With every record write an atomic whole-file replace, a tab
 * killed mid-write leaves the OLD file intact plus an orphaned swap file —
 * never a truncated JSON — which is what makes the port's "no torn state on
 * disk, only not-yet-written" claim (risk R2) TRUE rather than likely.
 * Note for the golden-folder gate: bytes-once-written are identical across
 * drivers; only crash-DURING-write behaviour differs, which no folder diff
 * can see.
 */
import {
  FileExistsError,
  FileNotFoundError,
  parentDirOf,
  type DirEntry,
  type FileStore,
} from '../../shared/fileStore';

const isDomNotFound = (err: unknown): boolean =>
  err instanceof DOMException && err.name === 'NotFoundError';

export function createFsaFileStore(
  root: FileSystemDirectoryHandle,
  /** How error messages name this folder ("the picked folder", "OPFS"). */
  label = '(data folder)',
): FileStore {
  const describe = (relPath: string): string =>
    relPath === '' ? label : `${label}/${relPath}`;

  const segmentsOf = (relPath: string): string[] =>
    relPath === '' ? [] : relPath.split('/');

  /**
   * The directory handle for a relative dir path. `create` is per-call and
   * applies to EVERY segment — mkdir wants all, everything else wants none
   * (the parent-must-exist rule rides on this).
   */
  async function dirHandle(relPath: string, create: boolean): Promise<FileSystemDirectoryHandle> {
    let dir = root;
    for (const segment of segmentsOf(relPath)) {
      dir = await dir.getDirectoryHandle(segment, { create });
    }
    return dir;
  }

  /** Parent handle + file name for a file path, parents never created. */
  async function locate(
    relPath: string,
  ): Promise<{ parent: FileSystemDirectoryHandle; name: string }> {
    const parent = await dirHandle(parentDirOf(relPath), false);
    const idx = relPath.lastIndexOf('/');
    return { parent, name: idx < 0 ? relPath : relPath.slice(idx + 1) };
  }

  async function fileHandleForRead(relPath: string): Promise<FileSystemFileHandle> {
    try {
      const { parent, name } = await locate(relPath);
      return await parent.getFileHandle(name, { create: false });
    } catch (err) {
      if (isDomNotFound(err)) throw new FileNotFoundError(describe(relPath));
      throw err;
    }
  }

  /**
   * The atomic whole-file write both text and bytes share: stage in the
   * platform's swap file, replace at close. Parent navigated with
   * create:false FIRST, so a missing parent fails before a swap file is even
   * opened.
   */
  async function replaceFile(relPath: string, contents: string | Uint8Array): Promise<void> {
    const { parent, name } = await locate(relPath);
    const handle = await parent.getFileHandle(name, { create: true });
    const writable = await handle.createWritable();
    try {
      // A fresh Uint8Array view: the one we hold may sit over a larger buffer
      // (a decoder's pool), and write() consumes the whole view it is given.
      await writable.write(typeof contents === 'string' ? contents : contents.slice());
    } catch (err) {
      // A failed write must not half-commit: abort discards the swap file and
      // the target keeps its previous bytes — the atomicity promise upheld on
      // the failure path too.
      await writable.abort().catch(() => undefined);
      throw err;
    }
    await writable.close();
  }

  return {
    async readText(relPath) {
      const file = await (await fileHandleForRead(relPath)).getFile();
      return file.text();
    },
    async writeText(relPath, text) {
      await replaceFile(relPath, text);
    },
    async readBytes(relPath) {
      const file = await (await fileHandleForRead(relPath)).getFile();
      return new Uint8Array(await file.arrayBuffer());
    },
    async writeBytes(relPath, bytes) {
      await replaceFile(relPath, bytes);
    },
    async exists(relPath) {
      if (relPath === '') return true;
      try {
        const { parent, name } = await locate(relPath);
        try {
          await parent.getFileHandle(name, { create: false });
          return true;
        } catch {
          await parent.getDirectoryHandle(name, { create: false });
          return true;
        }
      } catch {
        return false; // any failure to look reads as no, per the contract
      }
    },
    async list(relPath) {
      let dir: FileSystemDirectoryHandle;
      try {
        dir = await dirHandle(relPath, false);
      } catch (err) {
        if (isDomNotFound(err)) throw new FileNotFoundError(describe(relPath));
        throw err;
      }
      const out: DirEntry[] = [];
      for await (const entry of dir.values()) {
        out.push({ name: entry.name, kind: entry.kind });
      }
      return out;
    },
    async mkdir(relPath) {
      await dirHandle(relPath, true);
    },
    async deleteFile(relPath) {
      try {
        const { parent, name } = await locate(relPath);
        // Confirm it is a FILE first (TypeMismatchError passes through raw,
        // like node's EISDIR): removeEntry alone would happily delete an
        // empty directory, which "remove one file" never asked for.
        await parent.getFileHandle(name, { create: false });
        await parent.removeEntry(name);
      } catch (err) {
        if (isDomNotFound(err)) throw new FileNotFoundError(describe(relPath));
        throw err;
      }
    },
    /**
     * ADVISORY ONLY on this driver, by API limitation: FSA has no O_EXCL, so
     * this is exists-then-create with a visible window between the two. That
     * is why the single-writer lease does NOT ride on it (the Phase-2
     * fitness audit's explicit instruction): same-profile exclusion is Web
     * Locks (real, kernel-grade within the profile), cross-machine exclusion
     * is the heartbeat lease's age math — neither needs this primitive to be
     * strong. It exists here so shared code paths that use it for
     * NON-exclusion purposes keep working.
     */
    async createExclusive(relPath, text) {
      if (await this.exists(relPath)) throw new FileExistsError(describe(relPath));
      await replaceFile(relPath, text);
    },
    describe,
  };
}
