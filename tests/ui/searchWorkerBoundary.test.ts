/**
 * THE COORDINATOR'S WRITE BOUNDARY, pinned at the source level: the search
 * workers perform NO folder IO — not through OPFS, not through a picker
 * handle, not by importing the folder-touching modules.
 *
 * WHY A SOURCE SCAN. The boundary (DECISIONS.md, Phase 5: "the write boundary
 * is absolute") is what keeps the single-writer discipline whole in local
 * mode: one context owns the folder, and the coordinator's every
 * readScore/writeScore/readCachedResult crosses back to it as a message. The
 * failure mode is exactly the one searchWorker.ts's own header warns about —
 * "a coordinator that opened its own OPFS handles would be a second writer
 * with a green typecheck." OPFS is fully available inside Web Workers, the
 * TypeScript DOM lib types it, and the byte-comparing dual-stack gate cannot
 * see it either: a coordinator that persisted the report itself would write
 * the same bytes the manager writes, so the two folders still compare equal.
 * No runtime gate can distinguish "the right context wrote it" from "the
 * wrong context wrote the same thing" — which is precisely when the
 * noNodeImports pattern applies: scan the source, fail loudly, forever.
 *
 * WHAT IS SCANNED. The three search workers and their entire relative-import
 * closure (the shared executor, evaluator, stores machinery they pull in) —
 * so the boundary cannot be laundered through a helper module. Two rules:
 *
 *   1. no file in the closure may name a folder-reaching capability
 *      (navigator.storage, getDirectory(), createWritable(),
 *      createSyncAccessHandle(), showDirectoryPicker());
 *   2. no file in the closure may resolve an import into src/ui/io or
 *      src/ui/local — the modules whose JOB is touching the folder.
 *
 * The guard worker is deliberately NOT scanned: its whole purpose is lease
 * IO on the handle it is handed. And a textual scan is a tripwire, not a
 * proof — code determined to evade it can alias its way past any token list
 * — but every honest mistake and every convenient shortcut names these
 * capabilities plainly, which is the failure class this test exists to stop.
 */
import { readFileSync } from 'node:fs';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const repoRoot = fileURLToPath(new URL('../..', import.meta.url));

/** The boundary's roots: everything that runs inside the search workers. */
const ROOTS = [
  'src/ui/workers/searchWorker.ts',
  'src/ui/workers/searchPool.ts',
  'src/ui/workers/searchScoreWorker.ts',
];

/** Folder-reaching capabilities no file behind the boundary may name. */
const FORBIDDEN_TOKENS = [
  'navigator.storage',
  'getDirectory(',
  'createWritable(',
  'createSyncAccessHandle(',
  'showDirectoryPicker(',
];

/** The folder-touching module homes no import behind the boundary may reach. */
const FORBIDDEN_DIRS = [path.join('src', 'ui', 'io'), path.join('src', 'ui', 'local')];

/** Quoted module specifiers, however imported — noNodeImports' extractor. */
function importSpecifiers(source: string): string[] {
  const specifiers: string[] = [];
  const re = /(?:\bfrom\s*|\bimport\s*\(\s*|\brequire\s*\(\s*|^\s*import\s+)['"]([^'"]+)['"]/gm;
  for (let m = re.exec(source); m !== null; m = re.exec(source)) specifiers.push(m[1]);
  return specifiers;
}

/** Source with comments removed, so prose ABOUT a capability cannot trip it. */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
}

/** ./x → an existing .ts/.tsx file (the repo uses extensionless imports). */
function resolveRelative(fromFile: string, spec: string): string | null {
  const base = path.resolve(path.dirname(fromFile), spec);
  for (const candidate of [base, `${base}.ts`, `${base}.tsx`, path.join(base, 'index.ts')]) {
    if (candidate.endsWith('.ts') || candidate.endsWith('.tsx')) {
      if (existsSync(candidate)) return candidate;
    }
  }
  return null;
}

/** Every file the roots transitively reach through relative imports. */
function closureOf(roots: string[]): Map<string, string> {
  const files = new Map<string, string>();
  const queue = roots.map((r) => path.join(repoRoot, r));
  while (queue.length > 0) {
    const file = queue.pop() as string;
    if (files.has(file)) continue;
    const source = readFileSync(file, 'utf8');
    files.set(file, source);
    for (const spec of importSpecifiers(source)) {
      if (!spec.startsWith('.')) continue; // bare imports: noNodeImports' turf
      const resolved = resolveRelative(file, spec);
      if (resolved) queue.push(resolved);
    }
  }
  return files;
}

describe('the search workers perform no folder IO (the absolute write boundary)', () => {
  const closure = closureOf(ROOTS);

  it('reaches a real closure, not an empty scan', () => {
    // The executor, the evaluator and the score store are all behind the
    // coordinator; if the walk stopped seeing them, the test would be
    // green-lighting nothing.
    const names = [...closure.keys()].map((f) => path.relative(repoRoot, f));
    expect(names).toContain(path.join('src', 'store', 'search', 'execute.ts'));
    expect(names).toContain(path.join('src', 'store', 'search', 'pool.ts'));
    expect(names).toContain(path.join('src', 'store', 'search', 'scoreStore.ts'));
    expect(closure.size).toBeGreaterThan(5);
  });

  it('no file behind the boundary names a folder-reaching capability', () => {
    const offenders: string[] = [];
    for (const [file, source] of closure) {
      const code = stripComments(source);
      for (const token of FORBIDDEN_TOKENS) {
        if (code.includes(token)) {
          offenders.push(`${path.relative(repoRoot, file)} names '${token}'`);
        }
      }
    }
    expect(
      offenders,
      'A search worker (or something it imports) reaches for the folder — the\n' +
        'coordinator must proxy ALL folder IO to the guarded main context:\n' +
        offenders.join('\n'),
    ).toEqual([]);
  });

  it('no import behind the boundary resolves into the folder-touching modules', () => {
    const offenders: string[] = [];
    for (const [file, source] of closure) {
      for (const spec of importSpecifiers(source)) {
        if (!spec.startsWith('.')) continue;
        const resolved = resolveRelative(file, spec);
        if (!resolved) continue;
        const rel = path.relative(repoRoot, resolved);
        if (FORBIDDEN_DIRS.some((dir) => rel.startsWith(dir + path.sep))) {
          offenders.push(`${path.relative(repoRoot, file)} imports '${spec}' (${rel})`);
        }
      }
    }
    expect(
      offenders,
      'The search workers must not import the folder-touching modules:\n' + offenders.join('\n'),
    ).toEqual([]);
  });

  it('the scan sees through comments and each import syntax', () => {
    // A scanner that quietly stopped matching would green-light everything.
    expect(stripComments(`const a = 1; // navigator.storage in prose\n/* getDirectory( */`)).not.toMatch(
      /navigator\.storage|getDirectory\(/,
    );
    expect(stripComments(`const h = await navigator.storage.getDirectory();`)).toContain(
      'navigator.storage',
    );
    expect(importSpecifiers(`import { x } from './a';\nconst y = await import('../b');`)).toEqual([
      './a',
      '../b',
    ]);
  });
});
