/**
 * Byte-diff two golden folders produced by goldenFolderHarness.ts.
 *
 * The verdict is binary and the tolerance is ENUMERATED, never wholesale: a
 * fixed list of (file, field) pairs is masked before comparison, each one a
 * stamp the stores take from the real clock or real randomness with no
 * injection seam. Everything else — every other field, every filename, every
 * directory, all JSON formatting — must match byte for byte. Masking is done
 * with targeted regex replacement on the RAW text, deliberately not
 * parse-and-restringify: reserializing would silently forgive formatting
 * drift (key order, indentation, trailing newline), which is exactly the kind
 * of behaviour change this gate exists to catch.
 *
 * The mask list (keep in sync with the harness header):
 *   fresh/networth.json          rows[].id, rows[].takenAt
 *   fresh/plan-history.json      the 6-hex randomBytes suffix of entries[].id
 *   fresh/runs/<runKey>.json     meta.createdAt, top-level elapsedMs
 *
 *     npx tsx tests/golden/goldenFolderDiff.ts <dirA> <dirB>
 */
import { promises as fsp } from 'node:fs';
import path from 'node:path';

interface Walked {
  files: string[];
  dirs: string[];
}

async function walk(root: string, rel = ''): Promise<Walked> {
  const out: Walked = { files: [], dirs: [] };
  const entries = await fsp.readdir(path.join(root, rel), { withFileTypes: true });
  for (const entry of entries) {
    const childRel = rel ? `${rel}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      out.dirs.push(childRel);
      const sub = await walk(root, childRel);
      out.files.push(...sub.files);
      out.dirs.push(...sub.dirs);
    } else {
      out.files.push(childRel);
    }
  }
  out.files.sort();
  out.dirs.sort();
  return out;
}

/** The enumerated masks. Each returns the text with ONLY its fields hidden. */
function normalize(relPath: string, text: string): { text: string; masked: string[] } {
  const masked: string[] = [];
  let result = text;
  if (relPath === 'fresh/networth.json') {
    result = result.replace(/"id": "nw-[0-9a-z]+-[0-9a-f]{6}"/g, '"id": "nw-MASKED"');
    result = result.replace(/^(\s*)"takenAt": "[^"]+"/gm, '$1"takenAt": "MASKED"');
    masked.push('rows[].id (Date.now+randomBytes, no seam)', 'rows[].takenAt (real clock, no seam)');
  }
  if (relPath === 'fresh/plan-history.json') {
    result = result.replace(/("id": "ph-[0-9a-z]+-)[0-9a-f]{6}"/g, '$1MASKED"');
    masked.push('entries[].id randomBytes suffix only (time36 prefix stays compared)');
  }
  if (/^fresh\/runs\/[0-9a-f]{64}\.json$/.test(relPath)) {
    result = result.replace(/"createdAt": "[^"]*"/g, '"createdAt": "MASKED"');
    result = result.replace(/"elapsedMs": [0-9.]+/g, '"elapsedMs": 0');
    masked.push('meta.createdAt (finishRun wall clock)', 'elapsedMs (wall-clock timing)');
  }
  return { text: result, masked };
}

function fail(message: string): never {
  console.error(`GOLDEN DIFF FAILED: ${message}`);
  process.exit(1);
}

async function main(): Promise<void> {
  const [a, b] = [process.argv[2], process.argv[3]];
  if (!a || !b) fail('usage: tsx tests/golden/goldenFolderDiff.ts <dirA> <dirB>');

  const [wa, wb] = await Promise.all([walk(path.resolve(a)), walk(path.resolve(b))]);

  const problems: string[] = [];
  const setB = new Set(wb.files);
  const setA = new Set(wa.files);
  for (const f of wa.files) if (!setB.has(f)) problems.push(`only in ${a}: ${f}`);
  for (const f of wb.files) if (!setA.has(f)) problems.push(`only in ${b}: ${f}`);
  const dirsB = new Set(wb.dirs);
  const dirsA = new Set(wa.dirs);
  for (const d of wa.dirs) if (!dirsB.has(d)) problems.push(`directory only in ${a}: ${d}`);
  for (const d of wb.dirs) if (!dirsA.has(d)) problems.push(`directory only in ${b}: ${d}`);

  let compared = 0;
  const maskedReport = new Map<string, string[]>();
  for (const f of wa.files) {
    if (!setB.has(f)) continue;
    const rawA = await fsp.readFile(path.join(a, f), 'utf8');
    const rawB = await fsp.readFile(path.join(b, f), 'utf8');
    const na = normalize(f, rawA);
    const nb = normalize(f, rawB);
    if (na.masked.length > 0) maskedReport.set(f, na.masked);
    compared += 1;
    if (na.text !== nb.text) {
      // Point at the first differing line so the failure is actionable.
      const linesA = na.text.split('\n');
      const linesB = nb.text.split('\n');
      let line = 0;
      while (line < Math.max(linesA.length, linesB.length) && linesA[line] === linesB[line]) line += 1;
      problems.push(
        `${f} differs at line ${line + 1}:\n  ${a}: ${linesA[line] ?? '<EOF>'}\n  ${b}: ${linesB[line] ?? '<EOF>'}`,
      );
    }
  }

  console.log(`Compared ${compared} files, ${wa.dirs.length} directories.`);
  for (const [file, fields] of maskedReport) {
    console.log(`  masked in ${file}:`);
    for (const field of fields) console.log(`    - ${field}`);
  }
  if (problems.length > 0) {
    console.error(`\n${problems.length} difference(s):`);
    for (const p of problems) console.error(`  ${p}`);
    process.exit(1);
  }
  console.log('GOLDEN DIFF OK: folders are byte-identical modulo the enumerated masks.');
  process.exit(0);
}

main().catch((err) => {
  console.error('GOLDEN DIFF CRASHED:', err);
  process.exit(1);
});
