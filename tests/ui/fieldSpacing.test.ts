/**
 * Field-spacing invariants, read straight out of src/ui/styles.css.
 *
 * A form label has to read as belonging to the field BELOW it. That is not a
 * matter of taste but of one comparison: the gap from a label to its own
 * control must be smaller than the gap to whatever sits above it. Two rules in
 * the stylesheet cooperate to make that true, and a third (.field-note) has to
 * offset by the same label track to stay on its control's centre line.
 *
 * These are asserted here because the numbers had already drifted apart once:
 * .field-note carried `margin-top: 20px` with the comment "label row (16px) +
 * row-gap (4px)" long after .field-label began reserving two lines (32px), so
 * every "= $x/yr" sat 16px above the input it annotated. Nothing failed, because
 * nothing was watching. Measuring the rendered page catches it, but only while
 * someone is looking at that page; parsing the stylesheet catches it on every
 * run, which is the point.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const css = readFileSync(
  fileURLToPath(new URL('../../src/ui/styles.css', import.meta.url)),
  'utf8',
);

/** The body of the first rule whose selector list matches `selector`. */
function ruleBody(selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // Selector must be whole — its own line or the last in a comma-separated list.
  const re = new RegExp(`(^|[,}]|\\n)\\s*${escaped}\\s*\\{([^}]*)\\}`, 'm');
  const m = re.exec(css);
  expect(m, `no CSS rule found for "${selector}"`).not.toBeNull();
  return m![2];
}

/** A custom property's value from :root. */
function rootVar(name: string): string {
  const m = new RegExp(`--${name}:\\s*([^;]+);`).exec(css);
  expect(m, `:root does not define --${name}`).not.toBeNull();
  return m![1].trim();
}

const px = (v: string): number => {
  const m = /^(-?[\d.]+)px$/.exec(v.trim());
  expect(m, `expected a px length, got "${v}"`).not.toBeNull();
  return Number(m![1]);
};

describe('field spacing invariants (src/ui/styles.css)', () => {
  const labelH = px(rootVar('field-label-h'));
  const labelGap = px(rootVar('field-label-gap'));

  it('reserves a label track tall enough for two lines', () => {
    // Labels wrap to two lines at the narrow field widths; reserving the taller
    // case is what keeps controls in one row on a single baseline.
    const lineHeight = px(/line-height:\s*(\d+px)/.exec(ruleBody('.field-label'))![1]);
    expect(labelH).toBe(lineHeight * 2);
  });

  it('bottom-aligns the label text inside that track', () => {
    // The load-bearing declaration: without it a one-line label leaves its
    // unused second line as dead space between itself and its own control,
    // which is what made labels appear to caption the field above them.
    expect(ruleBody('.field-label')).toMatch(/align-self:\s*end/);
    // min-height would fight align-self by growing the box instead of the track.
    expect(ruleBody('.field-label')).not.toMatch(/min-height/);
  });

  it('sizes the grid track from the variable, and lets it grow', () => {
    const body = ruleBody('label.field');
    expect(body).toMatch(/grid-template-rows:\s*minmax\(var\(--field-label-h\),\s*auto\)/);
    expect(body).toMatch(/row-gap:\s*var\(--field-label-gap\)/);
  });

  it('separates stacked rows by more than a label sits from its own control', () => {
    // The whole point: label-to-own-field must be the SMALLER distance, or the
    // label groups with the wrong field. Row separation is the competing gap.
    const rowGap = px(/margin-top:\s*([\d.]+px)/.exec(ruleBody('.row + .row'))![1]);
    expect(rowGap).toBeGreaterThan(labelGap);
  });

  it('offsets .field-note by the full label track so it centres on its control', () => {
    // Derived, never a literal — a hardcoded px here is exactly how this broke.
    expect(ruleBody('.field-note')).toMatch(
      /margin-top:\s*calc\(var\(--field-label-h\)\s*\+\s*var\(--field-label-gap\)\)/,
    );
  });

  it('has no field row hard-coding a tighter margin than the shared one', () => {
    // Inline style={{ marginTop: 4 }} on a .row predates .row + .row and used to
    // add spacing where there was none; left in place it now UNDERCUTS the
    // shared gap and reintroduces the crowding on that row alone.
    const rowGap = px(/margin-top:\s*([\d.]+px)/.exec(ruleBody('.row + .row'))![1]);
    const sources = [
      '../../src/ui/pages/ProfilePage.tsx',
      '../../src/ui/components/profile/AccountsCard.tsx',
      '../../src/ui/components/profile/BudgetCard.tsx',
      '../../src/ui/components/profile/InsuranceCard.tsx',
    ];
    for (const rel of sources) {
      const src = readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');
      for (const m of src.matchAll(/className="row"[^>]*?marginTop:\s*(\d+)/g)) {
        expect(Number(m[1]), `${rel} pins a row margin below the shared ${rowGap}px`)
          .toBeGreaterThanOrEqual(rowGap);
      }
    }
  });
});
