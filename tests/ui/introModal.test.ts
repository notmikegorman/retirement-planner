/**
 * The FIRST-VISIT intro modals: the shared component and its two consumers.
 *
 * Source scans in the house idiom (no DOM here): the modal's behaviors are a
 * handful of declarations — the storage-key contract, the quiet-failure
 * fallback, the default-ticked checkbox — and each consumer's key and gate
 * are one-line wirings a refactor could quietly drop.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const read = (rel: string): string =>
  readFileSync(new URL(rel, import.meta.url), 'utf8');

const modal = read('../../src/ui/modules/IntroModal.tsx');
const expenses = read('../../src/ui/modules/ExpensesModule.tsx');
const tithing = read('../../src/ui/modules/TithingModule.tsx');

describe('the shared IntroModal', () => {
  it('remembers the dismissal only when the box (ticked by default) stays ticked', () => {
    expect(modal).toContain('useState(() => !introSeen(props.storageKey))');
    expect(modal).toContain('const [dontShowAgain, setDontShowAgain] = useState(true)');
    expect(modal).toContain('if (dontShowAgain)');
    expect(modal).toContain("localStorage.setItem(props.storageKey, '1')");
  });

  it('errs on the quiet side when storage is unavailable', () => {
    // No storage means the choice cannot be remembered; popping on every
    // visit would nag, so the failure branch reports "seen".
    expect(modal).toContain('return true;');
    expect(modal).toContain('catch {');
  });

  it('closes on Escape identically to the button, and names itself for a screen reader', () => {
    expect(modal).toContain("if (e.key === 'Escape') close()");
    expect(modal).toContain('aria-labelledby={`intro-${props.storageKey}`}');
  });
});

describe('the two consumers', () => {
  it('each carries its own DISTINCT key — dismissing one must not silence the other', () => {
    expect(expenses).toContain("const INTRO_SEEN_KEY = 'fplan-expenses-intro-seen'");
    expect(tithing).toContain("const INTRO_SEEN_KEY = 'fplan-tithing-intro-seen'");
  });

  it('Expenses gates its modal on the itemised table; Tithing shows its own ungated', () => {
    // The Expenses modal explains the TABLE's inherited cells, so it waits
    // for the table to exist. Tithing's one rule (today's dollars) covers
    // every giving figure, itemised or not.
    expect(expenses).toMatch(
      /\(draft\.expenses\.lines \?\? \[\]\)\.length > 0 \? \(\s*<IntroModal/,
    );
    expect(tithing).toContain('<IntroModal title="About these figures"');
    expect(tithing).not.toMatch(/length > 0 \? \(\s*<IntroModal/);
  });

  it('neither key is cleared by File > New — the flag is about the reader, not the folder', () => {
    const main = read('../../src/ui/main.tsx');
    const reset = main.slice(main.indexOf('function resetRememberedViews'));
    expect(reset).not.toContain('intro-seen');
  });
});
