/**
 * src/server imports node:fs ONLY through the fileStore driver.
 *
 * The storage seam (src/server/fileStore.ts) exists so the same store logic
 * can run against a second driver — the browser's FileSystemDirectoryHandle —
 * in Phase 3 of the browser port. The failure this scan prevents is quiet and
 * cumulative, the same one tests/shared/noNodeImports.test.ts pins for the
 * engine: one convenient `fs.readFile` added to a store works in every Node
 * test, ships nothing red, and silently widens the seam until the browser
 * driver "works" for every path except the one somebody bypassed. A seam you
 * cannot trust exhaustively is not a seam; this scan is what makes it one.
 *
 * TWO NAMED EXCEPTIONS, each with its retirement date:
 *   - server.ts: the HTTP shell. Its fs use (the built-UI checks and the
 *     .last-browser-open cooldown marker) dies WITH the server at Phase 7 —
 *     nothing in it moves to the browser, so routing it through the seam
 *     would launder retired code into the contract.
 *   - singleWriter.ts: allowed exactly {existsSync, readFileSync, unlinkSync}
 *     — the exit-time lock release runs inside process.on('exit'), which
 *     cannot await; everything else in it (the acquisition loop) already goes
 *     through the seam. The whole file retires at Phase 3 (Web Locks + lease).
 */
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const repoRoot = fileURLToPath(new URL('../..', import.meta.url));
const serverDir = path.join(repoRoot, 'src', 'server');

/** The driver — the seam itself — may (must) import node:fs. */
const DRIVER = 'fileStore.ts';
/** Dies with the server at Phase 7; its fs use never crosses to the browser. */
const RETIRES_WITH_SERVER = 'server.ts';
/** The exit-release trio; see the header. Anything beyond it fails the scan. */
const SINGLE_WRITER = 'singleWriter.ts';
const SINGLE_WRITER_ALLOWED = ['existsSync', 'readFileSync', 'unlinkSync'];

/** Every way a module can name fs. Bare and node:-prefixed, promises included. */
const FS_SPECIFIERS = new Set(['fs', 'node:fs', 'fs/promises', 'node:fs/promises']);

function tsFilesUnder(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...tsFilesUnder(full));
    else if (entry.name.endsWith('.ts')) out.push(full);
  }
  return out;
}

/**
 * Same extractor as noNodeImports.test.ts (which pins it against every import
 * syntax): quoted specifiers after from/import(/require(, so comments that
 * merely mention node:fs cannot trip the scan.
 */
function importSpecifiers(source: string): string[] {
  const specifiers: string[] = [];
  const re =
    /(?:\bfrom\s*|\bimport\s*\(\s*|\brequire\s*\(\s*|^\s*import\s+)['"]([^'"]+)['"]/gm;
  for (let m = re.exec(source); m !== null; m = re.exec(source)) {
    specifiers.push(m[1]);
  }
  return specifiers;
}

describe('the storage seam cannot silently leak', () => {
  it('no module under src/server imports fs except the driver and the two named exceptions', () => {
    const files = tsFilesUnder(serverDir);
    // An empty directory would pass vacuously while the real files sat
    // somewhere the scan never looks.
    expect(files.length).toBeGreaterThan(10);

    const offenders: string[] = [];
    for (const file of files) {
      const base = path.basename(file);
      if (base === DRIVER || base === RETIRES_WITH_SERVER || base === SINGLE_WRITER) continue;
      for (const spec of importSpecifiers(readFileSync(file, 'utf8'))) {
        if (FS_SPECIFIERS.has(spec)) {
          offenders.push(`${path.relative(repoRoot, file)} imports '${spec}'`);
        }
      }
    }
    expect(
      offenders,
      'These imports bypass the FileStore seam — the browser driver would never ' +
        'see their IO, and the golden-folder gate would compare folders that ' +
        'were never fully behind the interface:\n' +
        offenders.join('\n'),
    ).toEqual([]);
  });

  it("singleWriter's fs import is exactly the exit-release trio, nothing more", () => {
    // The allowance is by NAME, not by file: a new openSync/writeFileSync
    // creeping into singleWriter would be a lock path the browser rebuild of
    // Phase 3 silently would not have, which is precisely how a lost
    // plan-history append comes back.
    const source = readFileSync(path.join(serverDir, SINGLE_WRITER), 'utf8');
    const fsImports = [...source.matchAll(/import\s*\{([^}]*)\}\s*from\s*['"](?:node:)?fs['"]/g)];
    expect(fsImports.length, 'expected exactly one named node:fs import').toBe(1);
    const names = fsImports[0][1]
      .split(',')
      .map((n) => n.trim())
      .filter((n) => n.length > 0)
      .sort();
    expect(names).toEqual(SINGLE_WRITER_ALLOWED);
    // And no second fs import (namespace, promises, dynamic) sneaks around
    // the named one just checked.
    const fsSpecCount = importSpecifiers(source).filter((s) => FS_SPECIFIERS.has(s)).length;
    expect(fsSpecCount, 'singleWriter must have exactly one fs import statement').toBe(1);
  });

  it('the driver itself is where node:fs lives', () => {
    // If someone "cleans up" the driver to re-export node helpers from
    // elsewhere, the seam still holds — but if the driver stops importing fs
    // entirely, every store above it is running on something else and this
    // suite is scanning the wrong world.
    const source = readFileSync(path.join(serverDir, DRIVER), 'utf8');
    const specs = importSpecifiers(source);
    expect(specs.some((s) => FS_SPECIFIERS.has(s))).toBe(true);
  });
});
