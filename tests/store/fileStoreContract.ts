/**
 * THE DRIVER CONTRACT, as executable cases: what EVERY FileStore
 * implementation must do, phrased once and run against all three drivers —
 *
 *   node:fs        tests/store/fileStoreContract.test.ts (temp dir)
 *   in-memory      tests/store/fileStoreContract.test.ts
 *   OPFS/Chromium  tests/browser/stores.test.ts (via the harness)
 *
 * One case list for three drivers is the point: a driver that quietly
 * diverges on a contract edge (auto-creating parents, sorting listings,
 * returning '' for a missing file) would let the stores pass on one driver
 * and corrupt on another, and no per-driver test file would ever notice the
 * drift. Every case gets a FRESH store from the runner.
 *
 * Cases must be environment-neutral: no vitest, no node imports, assertion
 * helpers from ./check only.
 */
import {
  FileExistsError,
  FileNotFoundError,
  type FileStore,
} from '../../src/shared/fileStore';
import { eq, is, ok, rejects } from './check';

export interface ContractCase {
  name: string;
  run(files: FileStore): Promise<void>;
}

export function fileStoreContractCases(): ContractCase[] {
  return [
    {
      name: 'writeText/readText round-trip exact text, trailing newline included',
      async run(files) {
        await files.writeText('plan.json', '{\n  "a": 1\n}\n');
        is(await files.readText('plan.json'), '{\n  "a": 1\n}\n', 'round-trip changed bytes');
      },
    },
    {
      name: 'readText on a missing file throws FileNotFoundError',
      async run(files) {
        await rejects(files.readText('nope.json'), 'missing file must be typed', {
          instanceOf: FileNotFoundError,
        });
      },
    },
    {
      name: 'writeBytes/readBytes round-trip all 256 byte values',
      async run(files) {
        const bytes = new Uint8Array(256).map((_, i) => i);
        await files.writeBytes('blob.bin', bytes);
        const back = await files.readBytes('blob.bin');
        eq(Array.from(back), Array.from(bytes), 'binary round-trip changed bytes');
      },
    },
    {
      name: 'readBytes on a missing file throws FileNotFoundError',
      async run(files) {
        await rejects(files.readBytes('nope.bin'), 'missing file must be typed', {
          instanceOf: FileNotFoundError,
        });
      },
    },
    {
      name: 'writeText replaces the whole previous content, never appends or merges',
      async run(files) {
        await files.writeText('f.txt', 'a much longer first version of the file\n');
        await files.writeText('f.txt', 'short\n');
        is(await files.readText('f.txt'), 'short\n', 'replacement left old bytes behind');
      },
    },
    {
      name: "writeText into a missing parent REJECTS and creates nothing — the parent-must-exist rule",
      async run(files) {
        // The rule every driver must reproduce even when its API would
        // happily create the tree: a store that forgets mkdir must fail the
        // same way everywhere, or it works on one driver and ENOENTs on the
        // other.
        let rejected = false;
        try {
          await files.writeText('ghost-dir/f.json', '{}\n');
        } catch {
          rejected = true;
        }
        ok(rejected, 'write into a missing parent must reject');
        is(await files.exists('ghost-dir'), false, 'the failed write must not create the parent');
        is(await files.exists('ghost-dir/f.json'), false, 'the failed write must not create the file');
      },
    },
    {
      name: 'mkdir creates parents included, and writes then land',
      async run(files) {
        await files.mkdir('a/b/c');
        is(await files.exists('a'), true, 'mkdir must create the first segment');
        is(await files.exists('a/b/c'), true, 'mkdir must create the whole chain');
        await files.writeText('a/b/c/f.json', '{}\n');
        is(await files.readText('a/b/c/f.json'), '{}\n', 'write under fresh dirs failed');
      },
    },
    {
      name: "mkdir('') is a no-op on the existing root; root always exists",
      async run(files) {
        await files.mkdir('');
        is(await files.exists(''), true, 'the root must exist');
      },
    },
    {
      name: 'mkdir on an existing directory is idempotent and loses nothing',
      async run(files) {
        await files.mkdir('d');
        await files.writeText('d/f.txt', 'kept\n');
        await files.mkdir('d');
        is(await files.readText('d/f.txt'), 'kept\n', 'repeated mkdir must not disturb contents');
      },
    },
    {
      name: 'exists: false for missing, true for files, true for directories',
      async run(files) {
        is(await files.exists('missing'), false, 'missing path must read as absent');
        await files.writeText('present.txt', 'x');
        is(await files.exists('present.txt'), true, 'file must read as present');
        await files.mkdir('somedir');
        is(await files.exists('somedir'), true, 'directory must read as present');
      },
    },
    {
      name: 'list reports names and kinds; content beyond that is the environment order',
      async run(files) {
        await files.mkdir('sub');
        await files.writeText('one.json', '1');
        await files.writeText('two.json', '2');
        const entries = await files.list('');
        const byName = new Map(entries.map((e) => [e.name, e.kind]));
        is(byName.get('sub'), 'directory', 'sub must list as a directory');
        is(byName.get('one.json'), 'file', 'one.json must list as a file');
        is(byName.get('two.json'), 'file', 'two.json must list as a file');
        is(entries.length, 3, 'listing must carry exactly the three entries');
      },
    },
    {
      name: 'list on a missing directory throws FileNotFoundError',
      async run(files) {
        await rejects(files.list('nowhere'), 'missing dir must be typed', {
          instanceOf: FileNotFoundError,
        });
      },
    },
    {
      name: 'deleteFile removes exactly its file; a second delete is FileNotFoundError',
      async run(files) {
        await files.writeText('keep.txt', 'keep');
        await files.writeText('drop.txt', 'drop');
        await files.deleteFile('drop.txt');
        is(await files.exists('drop.txt'), false, 'deleted file must be gone');
        is(await files.readText('keep.txt'), 'keep', 'the other file must survive');
        await rejects(files.deleteFile('drop.txt'), 'second delete must be typed', {
          instanceOf: FileNotFoundError,
        });
      },
    },
    {
      name: 'createExclusive creates when absent and refuses (typed) when present',
      async run(files) {
        await files.createExclusive('once.txt', 'first\n');
        is(await files.readText('once.txt'), 'first\n', 'exclusive create must write its text');
        await rejects(files.createExclusive('once.txt', 'second\n'), 'second create must refuse', {
          instanceOf: FileExistsError,
        });
        is(await files.readText('once.txt'), 'first\n', 'the refusal must not clobber the file');
      },
    },
    {
      name: 'describe names paths without touching storage',
      async run(files) {
        const root = files.describe('');
        const nested = files.describe('a/b.json');
        ok(root.length > 0, 'describe("") must name the root');
        ok(nested.includes('a/b.json') || nested.includes('a'), 'describe must carry the path');
        is(await files.exists('a/b.json'), false, 'describe must not create anything');
      },
    },
    {
      name: 'unicode text survives the UTF-8 round trip',
      async run(files) {
        const text = '{"note":"café — 10½% → ok ✓"}\n';
        await files.writeText('u.json', text);
        is(await files.readText('u.json'), text, 'unicode round-trip changed bytes');
      },
    },
  ];
}
