/**
 * ONE WORD FOR THE THING. The user's complaint was "sometimes we call it the
 * plan and sometimes we call it the scenario", and he was right: the app grew a
 * cabinet of saved *scenarios* alongside a live *plan*, and the two words then
 * leaked into help text that had nothing to do with either.
 *
 * There is one plan now, so there is one word. This is the scan that keeps it
 * that way — a plain source read over src/ui, in the idiom of
 * tests/ui/tithingTab.test.ts and the score chart's own wiring scans, because
 * the regression it catches is a sentence, and a sentence is exactly what a
 * behavioural test cannot see.
 *
 * WHAT IT LOOKS AT is the prose the user can actually read: string literals
 * and JSX text. NOT identifiers — `Scenario` is the engine's own type name,
 * `scenarioHelpers` is a module, and `RunRequest.scenario` is a wire field.
 * Renaming those would touch the engine, the run-cache key and the search
 * executor to fix a spelling the user never sees. The word boundary is what
 * separates the two: `scenarioToText` is one identifier and never matches;
 * "the scenario as written" is prose and always does.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const UI_DIR = fileURLToPath(new URL('../../src/ui', import.meta.url));

/**
 * Prose that is allowed to keep the word, with the reason it must.
 *
 * EMPTY, and that is the finding rather than an oversight: every user-facing
 * use of the word in this app was either the cabinet's own vocabulary (deleted
 * with the cabinet) or a plain-English "situation" that reads better as the
 * concrete thing it means — "invisible in exactly the death you bought it for"
 * says more than "in exactly the scenario you bought it for" did.
 *
 * If a future string genuinely needs it, add the EXACT literal here with a
 * comment saying why no other word will do. A bare entry is not an exception,
 * it is a hole.
 */
const ALLOWED: readonly string[] = [];

/** Every .ts/.tsx under src/ui, absolute paths. */
function uiSources(dir: string = UI_DIR): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) out.push(...uiSources(p));
    else if (/\.tsx?$/.test(p)) out.push(p);
  }
  return out.sort();
}

/**
 * Blank out comments, preserving line numbers so a failure can name a line.
 *
 * Comments are deliberately OUT OF SCOPE. They are where this app keeps its
 * reasoning, and several of them have to say "the cabinet held saved
 * scenarios" to explain why something is shaped the way it is. Erasing that
 * history would cost more than the consistency it bought.
 */
export function stripComments(src: string): string {
  const blanked = (m: string): string => m.replace(/[^\n]/g, ' ');
  return src
    .replace(/\/\*[\s\S]*?\*\//g, blanked)
    // The `[^:]` guard keeps `https://` out of it — a URL is not a comment.
    .replace(/(^|[^:])(\/\/[^\n]*)/g, (_all, before: string, comment: string) =>
      before + blanked(comment),
    );
}

/** The word as PROSE: never as part of an identifier like `scenarioHelpers`. */
const PROSE_WORD = /\bscenarios?\b/i;

/**
 * A string literal that is a module specifier, not something anyone reads.
 * `'../scenarios/EventsCard'` is a folder on disk; the folder name is not a
 * label and renaming it would move a dozen files to change nothing on screen.
 */
const MODULE_PATH = /^['"`][./]/;

/** Every quoted literal on a line, with its quotes still attached. */
function stringLiterals(line: string): string[] {
  return line.match(/'[^'\n]*'|"[^"\n]*"|`[^`\n]*`/g) ?? [];
}

export interface ProseHit {
  file: string;
  line: number;
  text: string;
}

/** Prose in string literals that still says "scenario". */
export function literalHits(files: readonly string[], read: (f: string) => string): ProseHit[] {
  const hits: ProseHit[] = [];
  for (const file of files) {
    stripComments(read(file))
      .split('\n')
      .forEach((line, i) => {
        for (const literal of stringLiterals(line)) {
          if (!PROSE_WORD.test(literal)) continue;
          if (MODULE_PATH.test(literal)) continue;
          if (ALLOWED.includes(literal.slice(1, -1))) continue;
          hits.push({ file, line: i + 1, text: literal });
        }
      });
  }
  return hits;
}

/**
 * Blank out balanced `{...}` groups INSIDE ONE JSX TEXT RUN.
 *
 * A sentence in JSX is routinely INTERRUPTED by an interpolation — "this plan
 * has {n} events that the solver will replace" is one sentence with a count in
 * the middle of it — and a window that refuses to span a brace stops reading at
 * the first `{`, so the half of the sentence carrying the noun is never
 * examined. That is not a hypothetical: it is how the one surviving
 * "scenario" in this app's JSX went unseen by the first version of this scan.
 *
 * It is applied to the WINDOW, never to the whole file. A `.tsx` file is mostly
 * braces — every function body is one — so blanking globally would erase almost
 * all of the JSX and leave a scan that passes because it looks at nothing.
 *
 * Blanking inside the window is also what keeps the widened window safe:
 * everything in those braces is CODE (`clashing.length`,
 * `overridden[0] === 'retire'`), and code carries exactly the identifiers this
 * scan must never fire on.
 */
export function blankInterpolations(segment: string): string {
  const out = segment.split('');
  let depth = 0;
  for (let i = 0; i < out.length; i += 1) {
    const ch = out[i];
    if (ch === '{') depth += 1;
    const inside = depth > 0;
    if (ch === '}' && depth > 0) depth -= 1;
    if (inside && ch !== '\n') out[i] = ' ';
  }
  return out.join('');
}

/**
 * Prose in JSX text — the words between one tag and the next, INCLUDING the
 * words on the far side of an interpolation.
 *
 * .tsx only, and a window carrying `;` or `=` is discarded: those are the two
 * marks that say "this is code between two unrelated angle brackets", which is
 * what the old brace-free window was accidentally excluding. No sentence this
 * app shows the user contains either.
 */
export function jsxTextHits(files: readonly string[], read: (f: string) => string): ProseHit[] {
  const hits: ProseHit[] = [];
  for (const file of files) {
    if (!file.endsWith('.tsx')) continue;
    const src = stripComments(read(file));
    for (const segment of src.match(/>[^<>]*</g) ?? []) {
      const text = blankInterpolations(segment);
      if (!PROSE_WORD.test(text)) continue;
      // Not JSX text at all. Widening the window to span interpolations also
      // let it span CODE between an unrelated `>` and `<` — the closing angle
      // of `Promise<void>` and the opening one of the next generic, with a type
      // literal in between. What tells them apart is punctuation no sentence in
      // this app uses: a statement separator or an assignment.
      if (/[;=]/.test(text)) continue;
      if (ALLOWED.includes(segment.slice(1, -1).trim())) continue;
      const line = src.slice(0, src.indexOf(segment)).split('\n').length;
      hits.push({ file, line, text: segment.trim() });
    }
  }
  return hits;
}

const read = (f: string): string => readFileSync(f, 'utf8');
const short = (h: ProseHit): string =>
  `${h.file.slice(h.file.indexOf('src/ui'))}:${h.line} ${h.text.replace(/\s+/g, ' ').slice(0, 120)}`;

describe('the user-facing word is “the plan”', () => {
  it('has no “scenario” left in any label, button, help text or message', () => {
    const files = uiSources();
    // Guard the guard: a walker that found nothing would pass this suite
    // silently for ever.
    expect(files.length).toBeGreaterThan(30);
    expect(literalHits(files, read).map(short)).toEqual([]);
  });

  it('has none left in the words between the tags either', () => {
    expect(jsxTextHits(uiSources(), read).map(short)).toEqual([]);
  });

  it('catches a re-introduced one, in a literal and in JSX text alike', () => {
    // The scan is only worth having if it fires. Both shapes, on a fake file,
    // so this cannot pass by accident on a day the real sweep is clean.
    const fake = '/repo/src/ui/pages/FakePage.tsx';
    const src = [
      "const HELP = 'Load the scenario to compare it.';",
      'export const X = () => <div>Pick a scenario below</div>;',
    ].join('\n');
    const lookup = () => src;
    expect(literalHits([fake], lookup)).toHaveLength(1);
    expect(jsxTextHits([fake], lookup)).toHaveLength(1);
  });

  it('reads a sentence that an interpolation runs through the middle of', () => {
    // The blind spot this scan shipped with. `>[^<>{}]*<` stops at the first
    // brace, so a count in the middle of a sentence hid the noun after it —
    // and a real one was sitting in the tree when the scan first went green.
    const fake = '/repo/src/ui/pages/FakePage.tsx';
    const src = [
      'export const X = ({ n }: { n: number }) => (',
      '  <div>Heads up: this scenario has {n} events the solver will replace.</div>',
      ');',
    ].join('\n');
    expect(jsxTextHits([fake], () => src)).toHaveLength(1);
  });

  it('never fires on an identifier, a type name or a module path', () => {
    // These are the engine's and the wire's names. Renaming them touches the
    // run-cache key and the search executor to fix a spelling nobody reads.
    const fake = '/repo/src/ui/pages/FakePage.tsx';
    const src = [
      "import { scenarioToText } from '../components/scenarios/scenarioHelpers';",
      'export function f(scenario: Scenario): ScenarioEvent[] { return scenario.events; }',
      'const req = { scenario: plan };',
    ].join('\n');
    const lookup = () => src;
    expect(literalHits([fake], lookup)).toEqual([]);
    expect(jsxTextHits([fake], lookup)).toEqual([]);
  });

  it('ignores the word inside comments, which is where the history lives', () => {
    // The cabinet has to be explicable after it is gone; a scan that policed
    // comments would force the reasoning to be deleted with the code.
    const fake = '/repo/src/ui/pages/FakePage.tsx';
    const src = [
      '/* The cabinet held saved scenarios; the History tab replaced it. */',
      '// one scenario per file, once upon a time',
      "const OK = 'The plan, as scored';",
    ].join('\n');
    const lookup = () => src;
    expect(literalHits([fake], lookup)).toEqual([]);
    expect(jsxTextHits([fake], lookup)).toEqual([]);
  });
});
