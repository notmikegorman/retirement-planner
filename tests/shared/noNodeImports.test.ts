/**
 * src/engine, src/tax and src/shared must import NOTHING from Node.
 *
 * These three directories are the code that has to run inside a Web Worker
 * byte-for-byte as it runs under Node — the whole browser port rests on them
 * staying environment-free. The failure this scan prevents is quiet and
 * cumulative: one convenient `node:path` import in a helper works fine in
 * every Node test, ships nothing red, and then either breaks the browser
 * bundle outright or — worse — gets polyfilled by a bundler shim whose
 * behaviour differs in some corner, forking the numbers between
 * environments. The engine's only such import (`node:crypto` in simulate.ts)
 * was removed for the vendored shared/sha256; this test pins that at zero,
 * forever.
 *
 * The scan reads source text rather than executing modules, so an import
 * that is unreachable at runtime (or type-only via `import type` of a Node
 * type) still fails: type-only Node imports drag @types/node into the
 * compile of browser-destined code and are one keystroke away from becoming
 * value imports.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { builtinModules } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// src/store joined in Phase 3 of the browser port: the record stores, the
// seeding/migration logic and the writer lease all run inside the browser's
// IO context now, so one convenient node: import there would break (or
// silently shim) the exact code that guards irreplaceable records. src/ui/io
// is the browser driver + writer guard — browser-only by nature, but a Node
// type leaking in would still drag @types/node into the bundle's compile.
// src/ui/workers (the sim + guard workers) and src/ui/local (the Phase-4
// local backend) joined for the same reason: they ARE the browser runtime,
// and a node: import there fails only at bundle time, which is exactly the
// quiet-until-shipped failure this scan exists to make loud.
// workers/quote-proxy joined in Phase 6: the Cloudflare Worker runs in a
// browser-like runtime (fetch, Request, Response — no node at all), and it
// is deployed straight from source by wrangler, so a node: import there
// would fail only at deploy time, on the owner's machine, with no CI in
// front of it. Pinned like the rest of the portable code instead.
const PORTABLE_DIRS = [
  'src/engine',
  'src/tax',
  'src/shared',
  'src/store',
  'src/ui/io',
  'src/ui/local',
  'src/ui/workers',
  'workers/quote-proxy',
] as const;

/** Bare builtin names ('fs', 'path') count the same as 'node:'-prefixed. */
const BUILTINS = new Set(builtinModules);

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
 * Every module specifier a file names, however it names it: static
 * import/export-from, side-effect import, dynamic import(), require().
 * Matching quoted specifiers after those tokens (rather than parsing) keeps
 * comments that merely MENTION node:crypto from tripping the scan.
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

describe('the browser-portable directories are Node-free', () => {
  const repoRoot = fileURLToPath(new URL('../..', import.meta.url));

  for (const dir of PORTABLE_DIRS) {
    it(`${dir} imports nothing from node: or any bare builtin`, () => {
      const files = tsFilesUnder(path.join(repoRoot, dir));
      // An empty directory would make this test pass vacuously while the
      // real files sat somewhere the scan never looks.
      expect(files.length).toBeGreaterThan(0);

      const offenders: string[] = [];
      for (const file of files) {
        for (const spec of importSpecifiers(readFileSync(file, 'utf8'))) {
          if (spec.startsWith('node:') || BUILTINS.has(spec)) {
            offenders.push(`${path.relative(repoRoot, file)} imports '${spec}'`);
          }
        }
      }
      expect(
        offenders,
        'These imports would break (or silently shim) the browser build:\n' +
          offenders.join('\n'),
      ).toEqual([]);
    });
  }

  it('the scan itself sees through every import syntax', () => {
    // A regex that quietly stopped matching would green-light everything —
    // so the extractor is pinned against each syntax it claims to cover.
    const sample = [
      `import { x } from 'node:fs';`,
      `import type { Y } from "node:crypto";`,
      `export { z } from 'node:path';`,
      `import 'node:process';`,
      `const p = await import('node:os');`,
      `const q = require('fs');`,
      `// a comment saying node:crypto must NOT match`,
      `const s = 'from a plain string';`,
    ].join('\n');
    expect(importSpecifiers(sample)).toEqual([
      'node:fs',
      'node:crypto',
      'node:path',
      'node:process',
      'node:os',
      'fs',
    ]);
  });
});
