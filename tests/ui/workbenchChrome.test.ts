/**
 * The Workbench's CHROME: what the two columns show around the numbers, and
 * what they no longer show.
 *
 * A user asked for four things after living with the page for a while, and
 * each one is a property something could quietly undo:
 *
 * 1. NO COLLAPSE, NO BLURB, NO HEADING. The inputs panel had a ⌘B collapse
 *    toggle with a stored flag, an "Inputs" heading, and a line reading
 *    "Saved — every change writes itself to plan.json". All three are gone.
 *    THE FAILURE PATH IS NOT: an autosave that stops reaching the disk still
 *    has to shout, and that banner was the only thing that would ever say so.
 *    Deleting the quiet line and the loud one together is the regression this
 *    file exists to catch.
 *
 * 2. ONE BAR ACROSS THE SCREEN. The panel's tab strip and the results' tab
 *    strip have to sit on one line. The mechanism is structural rather than an
 *    offset: `.wb-layout` is a grid with `align-items: start`, and each strip is
 *    the FIRST child of its column. Anything that renders above either strip —
 *    a heading, a status line, a progress bar, a banner — breaks it, so the
 *    scans below check for exactly that.
 *
 * 3. ONE TYPE SCALE. `.wb-panel .tab` used to be 13px against the results
 *    strip's 14px, which is the mismatch the user actually saw. The rule now
 *    is stronger than "fix that one": NOTHING scoped to `.wb-panel` may set a
 *    font-size at all. The panel still runs tighter in PADDING, which is a
 *    width problem and not a type problem.
 *
 * 4. THE NUMBER SAYS WHAT MADE IT. 93.1% on screen against 94.2% recorded for
 *    the same plan on the same day was 1,000 paths against 10,000, and nothing
 *    said so. Run now refreshes prices and re-runs on the recorded conditions;
 *    the chip above the headline says which kind of run is on screen.
 *
 * Source and stylesheet scans, in the idiom of tests/ui/planHistoryTab.test.ts
 * and tests/ui/fieldSpacing.test.ts: this repo has no DOM environment, and a
 * control that is still wired up, or a rule that still sets a size, is a
 * declaration in a file — reading it is what catches it.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const read = (rel: string): string =>
  readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');

/**
 * Every component file in the app, as [path, source].
 *
 * The whole-tree read is the point: the class that broke was rendered two
 * directories away from the stylesheet edit that broke it, on a page this
 * commit never opened.
 */
function allUiSources(): Array<[string, string]> {
  const root = fileURLToPath(new URL('../../src/ui', import.meta.url));
  const out: Array<[string, string]> = [];
  const walk = (dir: string): void => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith('.tsx')) out.push([p.slice(root.length + 1), readFileSync(p, 'utf8')]);
    }
  };
  walk(root);
  return out;
}

const css = read('../../src/ui/styles.css');
const page = read('../../src/ui/pages/WorkbenchPage.tsx');
const panel = read('../../src/ui/components/workbench/ScenarioPanel.tsx');
const results = read('../../src/ui/components/workbench/LiveResults.tsx');
const logic = read('../../src/ui/components/workbench/workbenchLogic.ts');
// The scoring logic moved to src/store in Phase 4 of the browser port (the
// node path re-exports it); the pins follow the code, not the face.
const scoreRunner = read('../../src/store/scoreRunner.ts');

/**
 * The source with every comment removed — JSX blocks, TypeScript blocks, and
 * whole-line `//`.
 *
 * Every claim below is about what the page DOES, and these files explain
 * themselves at length in comments that name the very classes, keys and
 * controls being asserted gone: the tombstone for the collapse toggle spells
 * out the storage key it used to write. Matching those would make the comments
 * the thing under test, and would forbid the app from remembering its own
 * history.
 */
const stripComments = (src: string): string =>
  src
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');

/** The body of the first CSS rule whose selector list matches `selector`. */
function ruleBody(selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`(^|[,}]|\\n)\\s*${escaped}\\s*\\{([^}]*)\\}`, 'm');
  const m = re.exec(css);
  expect(m, `no CSS rule found for "${selector}"`).not.toBeNull();
  return m![2];
}

/** True when the stylesheet declares any rule for `selector`. */
function hasRule(selector: string): boolean {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(^|[,}]|\\n)\\s*${escaped}\\s*\\{`, 'm').test(css);
}

/** Every `selector { … }` pair in the stylesheet, comments stripped. */
function rules(): Array<{ selector: string; body: string }> {
  const bare = css.replace(/\/\*[\s\S]*?\*\//g, '');
  return [...bare.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((m) => ({
    selector: m[1].trim(),
    body: m[2],
  }));
}

const fontSizeOf = (body: string): string | null => {
  const m = /font-size:\s*([^;]+);/.exec(body);
  return m === null ? null : m[1].trim();
};

// ---------------------------------------------------------------------------
// 1. The chrome that went
// ---------------------------------------------------------------------------

describe('the inputs panel has no collapse control left anywhere', () => {
  it('has no collapsed grid, rail or icon button in the stylesheet', () => {
    // The 40px stub these three drew could answer no question about the plan.
    expect(hasRule('.wb-layout.panel-collapsed')).toBe(false);
    expect(hasRule('.wb-rail')).toBe(false);
    expect(hasRule('.wb-rail-label')).toBe(false);
    expect(hasRule('.wb-icon-btn')).toBe(false);
  });

  it('renders one unconditional .wb-layout, with no collapsed variant', () => {
    const render = stripComments(page);
    expect(render).toContain('className="wb-layout"');
    expect(render).not.toContain('panel-collapsed');
    expect(render).not.toContain('wb-rail');
    expect(render).not.toContain('wb-icon-btn');
  });

  it('keeps no collapsed state, no ⌘B binding and no stored flag', () => {
    // The stored flag is the worst of the three: it could restore the app into
    // the collapsed stub on a load nobody asked for it on.
    expect(stripComments(page)).not.toMatch(/setCollapsed|toggleCollapsed|\bcollapsed\b/);
    expect(stripComments(page)).not.toContain("'keydown'");
    expect(stripComments(logic)).not.toContain('fplan-workbench-panel');
    expect(stripComments(logic)).not.toMatch(
      /parsePanelCollapsed|panelStorageValue|PANEL_STORAGE_KEY/,
    );
  });
});

describe('the panel says nothing about saving until a save fails', () => {
  it('has dropped the status line, its dot, and the sentence they carried', () => {
    expect(hasRule('.wb-status')).toBe(false);
    expect(stripComments(panel)).not.toContain('wb-status');
    expect(stripComments(panel)).not.toContain('wb-dot');
    // `.wb-dot` itself is NOT asserted gone from the stylesheet — see the
    // "nothing renders a class the stylesheet no longer has" test below. The
    // panel must not draw it; the Search page still does, and deleting the rule
    // because the panel stopped using it is what broke that page once already.
    // The blurb itself, in the one file that could still produce it.
    expect(stripComments(logic)).not.toContain('every change writes itself to plan.json');
  });

  it('leaves nothing rendering a `wb-` class the stylesheet no longer has', () => {
    /*
     * THE BUG THIS EXISTS FOR, WHICH SHIPPED. Clearing the panel's save chrome
     * deleted `.wb-status`, `.wb-dot`, `.wb-dot.dirty` and `.wb-dot.bad` in one
     * stroke, on the reading that the status line was their only caller. It was
     * not: SearchPage draws `<span className="wb-dot dirty" />` beside "a search
     * is running" in its page header. With the rule gone that span computes to
     * an inline box of zero width, zero height and no background — the marker
     * simply stopped being drawn, silently, on a page nobody was looking at
     * while the Workbench was being tidied.
     *
     * So the deletions are not pinned one by one. The invariant is the one that
     * actually matters and that no reading can get wrong: a class is dead when
     * NOTHING RENDERS IT, and until then its rule stays. Delete a rule whose
     * class is still in a className anywhere under src/ui and this fails with
     * the file that still wants it.
     */
    const sources = allUiSources();
    const rendered = new Map<string, string[]>();
    for (const [file, src] of sources) {
      // Only class positions — a `wb-` word inside prose or a comment is not a
      // render, and these files discuss their own history at length.
      for (const m of stripComments(src).matchAll(/className=(?:"([^"]*)"|\{`([^`]*)`\})/g)) {
        for (const cls of (m[1] ?? m[2] ?? '').split(/[\s${}?:'"]+/)) {
          if (/^wb-[a-z-]+$/.test(cls)) rendered.set(cls, [...(rendered.get(cls) ?? []), file]);
        }
      }
    }
    expect(rendered.size, 'no wb- classes found — the scan itself is broken').toBeGreaterThan(5);

    const unstyled = [...rendered]
      .filter(([cls]) => !hasRule(`.${cls}`))
      .map(([cls, files]) => `.${cls} — rendered by ${[...new Set(files)].join(', ')}`);
    expect(unstyled).toEqual([]);
  });

  it('has dropped the "Inputs" heading over the tabs', () => {
    const render = stripComments(page) + stripComments(panel);
    expect(render).not.toContain('<strong>Inputs</strong>');
    // aria-label="Plan inputs" is a different thing and stays — on the
    // sections' group container now (a tablist in the tab era): it names the
    // panel for a screen reader, it does not occupy a row.
    expect(panel).toContain('aria-label="Plan inputs"');
  });

  it('STILL SHOUTS when a write fails, with the reason and a Retry', () => {
    // The one thing that must not have gone with the quiet line. There is no
    // Save button anywhere in the app, so an unreported failure means the user
    // keeps turning knobs into a file that stopped being written.
    const render = stripComments(panel);
    expect(render).toContain('function SaveFailure');
    expect(render).toContain('saveFailureText(state)');
    expect(render).toContain('className="error-banner" role="alert"');
    expect(render).toContain('onClick={onRetry}');
    // And the page still hands it the retry that re-PUTs the plan.
    expect(stripComments(page)).toContain('onRetrySave={() => void savePlan(draft)}');
  });

  it('keeps the failure surviving a navigation, as it did before', () => {
    // session.saveError outlives the unmount and seeds the next mount's state;
    // removing the visible line must not have removed the memory behind it.
    expect(stripComments(page)).toContain('session.saveError = errorText(err)');
    expect(stripComments(page)).toMatch(/session\.saveError === null\s*\?\s*\{ status: 'idle' \}/);
  });
});

// ---------------------------------------------------------------------------
// 2. One bar across the screen
// ---------------------------------------------------------------------------

/**
 * The tags a component renders, in order, with comments and text removed.
 * Enough to answer "what is the first thing in this column".
 */
function openingTags(src: string, marker: string): string[] {
  const body = stripComments(src).slice(stripComments(src).indexOf(marker));
  return [...body.matchAll(/<([A-Za-z][^\s/>]*)((?:[^>]*?))>/g)]
    .slice(0, 6)
    .map((m) => `<${m[1]}${/className="([^"]*)"/.exec(m[2]) ? ` .${/className="([^"]*)"/.exec(m[2])![1]}` : ''}`);
}

describe('the two tab strips sit on one line, structurally', () => {
  it('lays the columns out as a grid whose items start at the same edge', () => {
    // align-items: start is half the mechanism — without it the two columns
    // stretch and their first children still align, but any future change to
    // the panel's height would start moving the strip.
    const layout = ruleBody('.wb-layout');
    expect(layout).toMatch(/display:\s*grid/);
    expect(layout).toMatch(/align-items:\s*start/);
  });

  it('opens the left column with the sections — a header button per fold', () => {
    // WorkbenchPage renders .wb-panel > ScenarioPanel and nothing else, and
    // ScenarioPanel stacks its expand/collapse sections (the tab strip's
    // successor, 2026-08-30).
    const column = stripComments(page);
    const panelOpen = column.indexOf('className="wb-panel"');
    const scenario = column.indexOf('<ScenarioPanel');
    const resultsOpen = column.indexOf('className="wb-results"');
    expect(panelOpen).toBeGreaterThan(-1);
    expect(scenario).toBeGreaterThan(panelOpen);
    expect(scenario).toBeLessThan(resultsOpen);
    // Nothing between the column and its only child.
    expect(column.slice(panelOpen, scenario)).not.toMatch(/<[A-Za-z]/);

    // Each fold is a section opening with its header BAR — the toggle
    // button plus the section's InfoTip beside it (interactive content may
    // not nest inside a <button>); InputSection owns the first `return (`
    // in the file.
    expect(openingTags(panel, 'return (').slice(0, 3)).toEqual([
      '<section .wb-section',
      '<div .wb-section-bar',
      '<button .wb-section-head',
    ]);
  });

  it('makes the results strip the first thing in the right column', () => {
    // The strip is drawn by LiveResults itself rather than by ResultsBody,
    // because ResultsBody only renders once a run has landed — and a column
    // whose strip appeared with the first result would start life shifted.
    expect(openingTags(results, 'export function LiveResults').slice(0, 2)).toEqual([
      '<div',
      '<nav .modalTabBar',
    ]);
    expect(stripComments(results)).not.toMatch(
      /function ResultsBody[\s\S]*?className="modalTabBar"/,
    );
  });

  it('keeps the transient banners where they cannot hide', () => {
    // LEFT: the save failure sits ABOVE the sections — the only thing that
    // would ever say edits have stopped reaching the disk, and a warning
    // that could sit below a closed fold would be no warning at all. (The
    // tab era pinned it UNDER the strip to keep the two tab bars reading as
    // one line; with the strip gone there is no line to protect.)
    const left = stripComments(panel);
    expect(left.indexOf('<SaveFailure')).toBeGreaterThan(-1);
    expect(left.indexOf('<SaveFailure')).toBeLessThan(left.indexOf('aria-label="Plan inputs"'));

    // RIGHT: progress and error render under the strip — the bar used to sit
    // above it and pushed the whole column down on every debounce.
    const right = stripComments(results);
    expect(right.indexOf('className="modalTabBar"')).toBeLessThan(right.indexOf('wb-progress'));
    expect(right.indexOf('className="modalTabBar"')).toBeLessThan(right.indexOf('error-banner'));
  });

  it('reserves the progress bar row so the results do not hop on every debounce', () => {
    // Rendered whether or not a run is in flight: 3px + 12px of margin
    // appearing and vanishing under the strip moves every card below it, once
    // per keystroke, at the 400ms debounce.
    const render = stripComments(results);
    expect(render).toContain('className="wb-progress" aria-hidden="true"');
    expect(render).toContain('className="wb-progress is-running"');
    expect(fontSizeOf(ruleBody('.wb-progress'))).toBeNull();
    expect(ruleBody('.wb-progress')).toMatch(/background:\s*transparent/);
    expect(ruleBody('.wb-progress.is-running')).toMatch(/background:\s*var\(--border\)/);
  });

  it('gives neither column a vertical offset the other does not have', () => {
    /*
     * THE OTHER HALF OF "STRUCTURAL, NO MAGIC PIXEL", and the half the scans
     * above do not cover. They prove each strip is its column's first child and
     * that the grid starts its items at the same edge — both of which survive
     * someone adding `margin-top: 8px` to `.wb-panel`, which is precisely how a
     * measured-once offset gets introduced. The two strips would then sit 8px
     * apart at every width, and every test here would still pass.
     *
     * `align-items: start` means each column's top edge is the row's top edge,
     * so the strips agree exactly when nothing pushes one column's content down
     * past the other's. Today that is true because NEITHER declares any vertical
     * leading at all; the assertion is that they stay equal, not that they stay
     * empty, so a change that deliberately insets both sides still passes.
     *
     * `top` is exempt: `.wb-panel` is a sticky scroller and `top: 62px` is where
     * it parks once the page scrolls, not where it starts.
     */
    const leading = (selector: string): string[] =>
      rules()
        .filter((r) => r.selector.split(',').some((s) => s.trim() === selector))
        .flatMap((r) => [...r.body.matchAll(/(margin|padding)(-top)?:\s*([^;]+);/g)])
        .map((m) => `${m[1]}${m[2] ?? ''}: ${m[3].trim()}`);

    expect(leading('.wb-panel')).toEqual(leading('.wb-results'));
    // (The per-strip comparison retired with the input strip, 2026-08-30:
    // `.wb-panel .tabs` no longer exists to compare, and the results strip's
    // .modalTabBar leading is the app-wide standard, owned by its own rule.)
  });

  it('keeps the panel a sticky scroller that cannot scroll the page sideways', () => {
    // Neither the alignment change nor the type change may cost these: a long
    // label once handed the whole page a horizontal scrollbar.
    const body = ruleBody('.wb-panel');
    expect(body).toMatch(/position:\s*sticky/);
    expect(body).toMatch(/overflow-y:\s*auto/);
    expect(body).toMatch(/overflow-x:\s*hidden/);
    expect(body).toMatch(/min-width:\s*0/);
  });
});

// ---------------------------------------------------------------------------
// 3. One type scale
// ---------------------------------------------------------------------------

describe('the panel and the results column read at one size', () => {
  it('lets NOTHING scoped to .wb-panel set a font-size', () => {
    // The strongest form of the user's request, and the cheapest to keep: any
    // future "just this one a notch smaller" fails here rather than shipping.
    const offenders = rules()
      .filter((r) => r.selector.includes('.wb-panel') && fontSizeOf(r.body) !== null)
      .map((r) => `${r.selector} { font-size: ${fontSizeOf(r.body)} }`);
    expect(offenders).toEqual([]);
  });

  it('guards every card that copies draft state against the other open sections', () => {
    // The panel's folds toggled independently for a few hours (2026-08-30)
    // before going mutually exclusive; cards that copy draft state keep
    // their multi-writer guards anyway — the panel has flipped fold
    // semantics once already, and each guard is inert while sections cannot
    // co-mount. (The corporate-share keys that used to be guards 1 and 4
    // retired WITH the second bonds door: the dial lives under the
    // Investing module alone now.) Two guards, each pinned:
    // 1. OverridesCard's commit re-emits the passthrough branches from the
    //    LIVE draft, not the mount-time copy — including the bonds dial it
    //    no longer edits.
    const overridesCard = read('../../src/ui/components/scenarios/OverridesCard.tsx');
    expect(overridesCard).toContain('const fresh = overrideFieldsFrom(overrides);');
    expect(overridesCard).toContain('expenses: fresh.expenses,');
    expect(overridesCard).toContain('income: fresh.income,');
    expect(overridesCard).toContain('corporateShare: fresh.market.corporateShare');
    // 2. EventsCard remounts on any outside rewrite of the events array —
    // its open editor saves by a captured index, and Plan/Housing writes
    // reorder or filter that array.
    expect(panel).toContain('key={`events:${cardKey}:${stableStringify(draft.events)}`}');
  });

  it('keeps the folds mutually exclusive, and stamps the on-screen run for the lanes', () => {
    // Opening a section closes whichever was open (the owner's revision,
    // 2026-08-30, after a few hours of independent toggling) — the toggle,
    // the render binding, and the single-member store call together.
    expect(panel).toContain('const next = openId === id ? null : id;');
    expect(panel).toContain('open={openId === id}');
    expect(panel).toContain('storeOpenSections(new Set(next === null ? [] : [next]))');
    // The browser drives wait on data-run-key as their "a new run landed on
    // screen" signal — the provenance line they used to read moved onto the
    // Details tab with the Summary split. Dropping the stamp would strand
    // them on a timeout, not a clear failure, so it is pinned here.
    expect(results).toContain('data-run-key={result.meta.runKey}');
  });

  it('flips the bottom folds’ header tips upward, out of the scroll box’s clip', () => {
    // DORMANT BY DESIGN while the owner's no-?-icons rule stands (InfoTip
    // renders null, so no bubble opens anywhere). The rule is kept — and
    // pinned — because re-enabling help is a one-function change, and
    // without the flip the bottom folds' tips would reopen straight into
    // the scroll box's clip (measured live in review: ~6px visible).
    // The bar is the bubble's containing block so the flip is relative to
    // the header, not the panel.
    expect(ruleBody('.wb-section-bar')).toMatch(/position:\s*relative/);
    const flipped = ruleBody('.wb-section:nth-last-child(-n + 2) .wb-section-bar .infotip-bubble');
    expect(flipped).toMatch(/bottom:\s*calc\(100% \+ 4px\)/);
    expect(flipped).toMatch(/top:\s*auto/);
  });

  it('binds each split-off tab to its panel, and each fold to its rehomed tip', () => {
    // A tab button over a permanently empty panel is the failure a label
    // list alone cannot catch: the branches are pinned by id.
    expect(results).toContain("{tab === 'summary' && (");
    expect(results).toContain("{tab === 'details' && (");
    expect(results).toContain("{tab === 'withdrawals' && (");
    expect(results).toContain('<WithdrawalRateCard');
    // The cards' inner titles died with the Summary-echo rule; their
    // InfoTips live on the fold headers now. Six hints, by id, wired
    // through the section helper — and the strip's InfoTip import chain
    // (the *_CARD_TIP exports) named so a rename cannot silently strand a
    // fold without its help.
    expect(panel).toContain('hint={SECTION_HINTS[id]}');
    // Six hints — Life insurance joined 2026-08-31 (History's left for the
    // results strip; Events and Advanced deliberately carry none). The
    // InfoTip component renders null while the owner's no-?-icons rule
    // stands; the wiring stays so the help text keeps its home.
    for (const id of ['plan', 'spending', 'tithing', 'insurance', 'income', 'housing']) {
      expect(panel).toContain(`${id}: <InfoTip`);
    }
    for (const tip of [
      'PLAN_CARD_TIP',
      'SPENDING_CARD_TIP',
      'TITHING_CARD_TIP',
      'INSURANCE_CARD_TIP',
      'INCOME_CARD_TIP',
      'HOUSING_CARD_TIP',
    ]) {
      expect(panel).toContain(tip);
    }
  });

  it('dresses the results strip as the shared modalTabBar, tab-era overrides gone', () => {
    // The owner asked the two tab styles to stop diverging (2026-08-30): the
    // results strip wears the same underline dress as Net worth, Settings and
    // the rest — and the tab-era width overrides for the input strip died
    // with the input strip.
    expect(stripComments(results)).toContain('className="modalTabBar"');
    expect(stripComments(results)).toContain("'modalTabBtn isActive' : 'modalTabBtn'");
    expect(hasRule('.wb-panel .tabs')).toBe(false);
    expect(hasRule('.wb-panel .tab')).toBe(false);
  });

  it('lets the panel run tighter in padding, which is a width problem', () => {
    // The one surviving .wb-panel override, kept deliberately: a column with a
    // 320px floor cannot also afford 20px of card padding on each side.
    const scoped = ruleBody('.wb-panel .card');
    expect(scoped).toMatch(/padding:\s*12px 14px/);
    expect(fontSizeOf(scoped)).toBeNull();
  });

  it('uses the same inline small-print sizes on both sides of the page', () => {
    // Inline style objects escape the stylesheet, so they are scanned too. Both
    // columns now use 12 (the .field-help step) and 13 (the .muted step) and
    // nothing else; a stray 12.5 in the History tab and another in MixEditor
    // were the whole of the drift.
    const inline = (rel: string): string[] => {
      const src = read(rel);
      return [...src.matchAll(/style=\{\{([^}]*)\}\}/g)].flatMap((m) => [
        ...m[1].matchAll(/fontSize:\s*([\d.]+)/g),
      ].map((f) => f[1]));
    };
    const left = [
      '../../src/ui/components/workbench/ScenarioPanel.tsx',
      '../../src/ui/components/workbench/PlanHistoryCard.tsx',
      '../../src/ui/components/workbench/HousingCard.tsx',
      '../../src/ui/components/scenarios/OverridesCard.tsx',
      '../../src/ui/components/scenarios/MixEditor.tsx',
      '../../src/ui/components/scenarios/CorporateShareField.tsx',
    ].flatMap(inline);
    const right = [
      '../../src/ui/components/workbench/LiveResults.tsx',
      '../../src/ui/components/results/CashflowTable.tsx',
      '../../src/ui/components/results/MagiChartCard.tsx',
      '../../src/ui/components/results/TitheCard.tsx',
      '../../src/ui/components/results/WithdrawalRateCard.tsx',
    ].flatMap(inline);
    expect([...new Set(left)].sort()).toEqual(['12']);
    expect([...new Set(right)].sort()).toEqual(['12', '13']);
  });

  it('states the sizes that are DELIBERATELY not shared, and why', () => {
    /*
     * Two groups differ on purpose, and both are listed here so an unexplained
     * third can never join them quietly.
     *
     * HEADLINE NUMBERS, results side only. A figure that IS the answer is not
     * body text, and there is nothing on the inputs side for it to disagree
     * with — the panel holds no answers.
     *
     * MICRO-LABELS IN A DENSE EDITOR, panel side only. Column headings and
     * per-cell annotations inside a two-column grid of controls; likewise
     * nothing opposite them. They are not a smaller version of body text, they
     * are furniture on a control.
     */
    expect(fontSizeOf(ruleBody('.verdict'))).toBe('27px');
    expect(fontSizeOf(ruleBody('.wb-metric-value'))).toBe('26px');
    expect(fontSizeOf(ruleBody('.explore-answer'))).toBe('18px');
    expect(fontSizeOf(ruleBody('.success-gauge'))).toBe('40px');

    expect(fontSizeOf(ruleBody('.pair-head'))).toBe('11px');
    expect(fontSizeOf(ruleBody('.housing-step'))).toBe('11px');
    expect(fontSizeOf(ruleBody('.pair-note'))).toBe('11.5px');
    expect(fontSizeOf(ruleBody('.pair-status'))).toBe('11.5px');
  });

  it('draws the one warning on the results side in the app-wide warning class', () => {
    // It was `.field-help warn` — unboxed help text at 12px — which made it the
    // only warning in the app at a different size from the boxed ones the panel
    // and the Search page draw. Same class now, so there is no size to disagree.
    expect(stripComments(results)).toContain('className="lib-warning warn"');
    expect(stripComments(results)).not.toContain('className="field-help warn"');
    expect(fontSizeOf(ruleBody('.lib-warning'))).toBe('12.5px');
  });
});

// ---------------------------------------------------------------------------
// 4. Run now
// ---------------------------------------------------------------------------

describe('Run now refreshes prices FIRST, then runs the recorded conditions', () => {
  const body = (() => {
    const src = stripComments(page);
    const start = src.indexOf('const startRunNow = useCallback');
    expect(start, 'startRunNow is gone').toBeGreaterThan(-1);
    return src.slice(start, src.indexOf('\n  }, [', start));
  })();

  it('asks for a quote refresh before it starts the simulation', () => {
    // The order is the point. Derived balances are priced from quotes.json and
    // nothing else on this page refreshes it, so a run started first is a run
    // scored on whatever the prices were when the app was opened.
    const refresh = body.indexOf('api.refreshQuotes()');
    const run = body.indexOf('runPlan(draft, finalRunParams(profile.settings)');
    expect(refresh).toBeGreaterThan(-1);
    expect(run).toBeGreaterThan(refresh);
  });

  it('refreshes EVERY holdings symbol, by asking for none in particular', () => {
    // api.refreshQuotes() with no argument means "every symbol any account
    // holds" server-side. Passing a list here would price some holdings today
    // and the rest at whatever was on file.
    expect(body).toContain('api.refreshQuotes()');
    expect(body).not.toMatch(/refreshQuotes\(\s*\[/);
  });

  it('runs at mcPathsFinal on the profile seed, not the panel run settings', () => {
    expect(body).toContain('finalRunParams(profile.settings)');
    expect(body).not.toContain('runParams,');
    // …and those conditions are the server's own, which is what makes the
    // number comparable rather than merely slower. Reading the server here is
    // deliberate: two copies of "the recorded conditions" would drift.
    expect(scoreRunner).toContain("export const SCORE_MODE = 'montecarlo' as const");
    expect(scoreRunner).toContain('paths: profile.settings.mcPathsFinal');
    expect(scoreRunner).toContain('seed: profile.settings.seed');
  });

  it('marks the INTERACTIVE inputs answered so the live loop does not undo it', () => {
    // lastRunKey is compared against the interactive inputKey. Recording the
    // final params' key would leave the two unequal, and the debounce would
    // fire a 1,000-path run 400ms later that overwrote the 10,000-path one.
    expect(body).toContain('lastRunKey.current = runInputKey(scenarioForPlainRun(draft), runParams)');
  });

  it('shows progress the whole way, so the button never looks dead', () => {
    expect(body).toContain("setRunNow({ status: 'quotes' })");
    expect(body).toContain("setRunNow({ status: 'running' })");
    expect(body).toContain('setRunning(true)');
    // The button reads the phase back out.
    expect(stripComments(results)).toContain('runNowButtonText(runNow)');
    expect(stripComments(results)).toContain('disabled={busy}');
  });

  it('leaves the previous result standing when it fails, and says why', () => {
    // Nothing in here writes a result — only runPlan does, and it is the last
    // thing attempted. A failed Run now costs the user the wait, never the
    // answer he already had.
    expect(body).not.toContain('setResult(');
    expect(body).toMatch(/catch \(err\) \{[\s\S]*?status: 'error', message: `Run now failed — \$\{errorText\(err\)\}`/);
    // …and the reason is drawn beside the number rather than in the column's
    // shared banner, whose Retry re-runs the LIVE loop and would answer a
    // different question from the one that just failed.
    expect(stripComments(results)).toMatch(/runNow\.status === 'error'[\s\S]*?\{runNow\.message\}/);
  });

  it('reports a price that did not refresh instead of pretending it did', () => {
    // A per-symbol failure is survivable — the previous quote stays on file —
    // but not silent: the button's whole promise is "scored on today's prices".
    expect(body).toContain('refreshFailureNote(refreshed.results)');
  });

  it('leaves the automatic interactive run exactly as it was', () => {
    // It is what keeps the screen alive while knobs move; Run now is the
    // deliberate, slow answer beside it, not a replacement for it.
    expect(stripComments(page)).toContain('if (lastRunKey.current !== inputKey) void startRun()');
    expect(stripComments(page)).toContain('const LIVE_DEBOUNCE_MS = 400');
  });
});

describe('the headline number carries the conditions that produced it', () => {
  it('labels the run above the verdict, not in small text at the foot', () => {
    const render = stripComments(results);
    const bar = render.indexOf('<RunNowBar');
    const verdict = render.indexOf('className={`verdict ');
    expect(bar).toBeGreaterThan(-1);
    expect(bar).toBeLessThan(verdict);
    expect(render).toContain('runQualityLabel(result.meta, profile.settings)');
  });

  it('tells the strip that its missing chips are a method difference, not a first run', () => {
    // Pressing Run now always produces this state: a 10,000-path run standing
    // where a 1,000-path one was. The chips have to say so rather than claim
    // there was nothing before them.
    const render = stripComments(results);
    expect(render).toContain('comparableRun(current, candidate)');
    expect(render).toContain('methodMismatch={mismatched}');
    expect(render).toContain('comparisonNote(baseline ? baseline.label : null, previous !== null, mismatched)');
  });

  it('reads the path count off the RUN, never off what the live loop is sending', () => {
    // Run now forces Monte Carlo at final quality whatever the Settings tab
    // says. Gating the footer on runParams.paths hid the path count on exactly
    // the run whose path count is the interesting fact.
    const render = stripComments(results);
    expect(render).toContain("result.meta.mode === 'montecarlo' ? ` · ${result.meta.paths} paths`");
    expect(render).not.toContain('runParams.paths !== undefined');
  });
});

// ---------------------------------------------------------------------------
// 5. …and the conditions include how precisely it measured
// ---------------------------------------------------------------------------

/*
 * Naming the path count was not enough on its own. "Quick run · 1,000 paths"
 * states the conditions and leaves the reader to know what 1,000 paths buys —
 * they do not, and neither did the app. It buys ±1.6 points at 93%, which
 * swallows the entire 1.3-point swing the user reported as a bug
 * (94.2% final against 92.9% quick, same plan hash, same seed).
 *
 * These are source scans in the idiom of the four sections above: where a chip
 * is rendered, what class it is given, and which module decided it.
 */
describe('the run states how precisely it measured, not only how it was made', () => {
  const render = stripComments(results);

  it('prints the precision beside the conditions, in the bar above the verdict', () => {
    /*
     * Same reasoning as the conditions chip in df1a13f: this belongs where the
     * eye lands BEFORE the headline, not in the provenance line at the foot of
     * the card where the path count already sat unread. RunNowBar is DECLARED
     * below the verdict and RENDERED above it — the section above already
     * pins the call site — so the containment check is the one that means
     * anything here, and the ordering is checked inside the bar's own body.
     */
    const start = render.indexOf('function RunNowBar(');
    expect(start).toBeGreaterThan(-1);
    const bar = render.slice(start);
    const quality = bar.indexOf('runQualityLabel(result.meta, profile.settings)');
    const precision = bar.indexOf('successPrecision(result.success, result.meta)');
    expect(precision).toBeGreaterThan(-1);
    expect(precision).toBeGreaterThan(quality);
    // The conditions chip first, the precision beside it — one row, two facts.
    expect(bar.indexOf('{label.headline}')).toBeLessThan(bar.indexOf('{precision.text}'));
  });

  it('reads the success rate and the paths off the RUN, never off the panel', () => {
    // The panel holds a draft of what to ask for next; result.meta holds what
    // was actually asked. Run now forces final quality whatever the panel says,
    // and a precision computed from the panel would describe the wrong run.
    expect(render).toContain('successPrecision(result.success, result.meta)');
    expect(render).not.toContain('successPrecision(result.success, runParams');
  });

  it('leaves the precision chip uncoloured, unlike the conditions chip', () => {
    // The conditions chip goes green for a final run because comparability with
    // a recorded score is good news. A precision is the grain of the
    // instrument, not news, and a green ±0.3 beside a plain ±1.3 would read as
    // a verdict on the plan.
    expect(render).toMatch(/<span className="wb-chip" title=\{precision\.title\}>/);
    expect(render).not.toMatch(/precision\.tone/);
  });

  it('prints what the ± means, rather than hiding it in a hover', () => {
    // "±1.3" on its own is another unlabelled number, which is the defect and
    // not the fix. The sentence goes in the help line under the chips.
    expect(render).toContain('precision.sentence');
  });

  it('decides the threshold in the logic module, once', () => {
    // The component renders; it does not do statistics. Two copies of "what
    // 1,000 paths can resolve" would drift, and the drifting one would be the
    // one on screen.
    expect(render).not.toContain('pathFractionDeltaResolution');
    expect(render).not.toContain('Math.sqrt');
    expect(stripComments(logic)).toContain('export function pathFractionDeltaResolution');
  });

  it('gives the change chip a hover of its own, separate from the tile"s', () => {
    // They answer different questions: the tile's says what the number counts,
    // the chip's says what the app did with the difference. A chip that
    // declines to report a move has to be able to say why on itself.
    const chip = stripComments(
      read('../../src/ui/components/workbench/DeltaChip.tsx'),
    );
    expect(chip).toMatch(/className=\{`wb-chip \$\{delta\.tone\}`\} title=\{delta\.changeTitle\}/);
  });
});

// ---------------------------------------------------------------------------
// 6. …and the page stops throwing away a final run it already has
// ---------------------------------------------------------------------------

/*
 * THE REFRESH BUG. Run now produced 94.2% at 10,000 paths; the user refreshed
 * their browser and the page came back reading 92.9%, because the live loop
 * recomputed at 1,000 paths and nothing asked whether the better answer was
 * still on file. It was — the run cache holds every run the app has ever made,
 * ~477 of them on one test machine.
 *
 * The fix is one question asked before every interactive run: does a
 * final-quality run for THESE EXACT INPUTS already exist? The hazards are all in
 * how it is asked, so these are source scans in the idiom of the five sections
 * above — a lookup that started a run, or a plan-shaped question, is a call in a
 * file, and reading it is what catches it.
 */
describe('a final run already on file is preferred over recomputing a quick one', () => {
  const src = stripComments(page);
  const body = (() => {
    const start = src.indexOf('const startRun = useCallback');
    expect(start, 'startRun is gone').toBeGreaterThan(-1);
    return src.slice(start, src.indexOf('\n  }, [', start));
  })();

  it('looks before it computes, on the same path a page load takes', () => {
    // Load and edit both arrive here — the debounced effect calls startRun for
    // either — so one ordering fixes both: ask the cache, and only run when it
    // has nothing.
    const look = body.indexOf('restoreFinalRun(draft, profile.settings, runParams, id)');
    const run = body.indexOf('runPlan(draft, runParams, id)');
    expect(look).toBeGreaterThan(-1);
    expect(run).toBeGreaterThan(look);
  });

  it('still runs the quick run when the cache has nothing — the ordinary case', () => {
    // Straight after an edit there is no cached final, and the live loop has to
    // behave exactly as it always did: responsive, at mcPathsInteractive.
    expect(body).toContain('if (!restored) await runPlan(draft, runParams, id)');
  });

  it('says "no" on every path that did not put a run on screen', () => {
    /*
     * The caller's `if (!restored)` is only half the contract. The other half
     * is that a miss actually SAYS no — and the scan above cannot see that
     * half: `if (!restored) await runPlan(...)` reads exactly the same whether
     * restoreFinalRun answers honestly or claims a hit it never had.
     *
     * A restoreFinalRun that answered true on a miss would suppress the quick
     * run entirely. Straight after an edit — the ordinary case, when there is
     * no cached final for the plan that now exists — nothing would compute and
     * nothing would clear, so the PREVIOUS plan's number would sit on screen
     * under the current plan's knobs, wearing its "Final quality" chip and its
     * own older moment. That is the stale-number-wearing-the-current-plan's-
     * name failure this whole change exists to prevent, reintroduced one line
     * further in than the place that guards against it.
     *
     * So: three ways to find nothing, three falses. And exactly one true, the
     * one that follows the write to the page — a second `return true` anywhere
     * in this function is a path that answered yes without showing anything.
     */
    const start = src.indexOf('const restoreFinalRun = useCallback');
    expect(start, 'restoreFinalRun is gone').toBeGreaterThan(-1);
    const fn = src.slice(start, src.indexOf('\n    },\n    [publishResult],', start));

    // The swap was refused as dishonest (deterministic mode, an unlocked seed,
    // more paths than mcPathsFinal) — nothing was even asked for.
    expect(fn).toContain('if (standIn === null) return false;');
    // The lookup itself failed. A failed lookup is a MISS, not an error: the
    // quick run behind it asks the same server and reports what is really wrong.
    expect(fn).toMatch(/catch \{\s*return false;\s*\}/);
    // The cache simply had nothing. This is the ordinary case after an edit.
    expect(fn).toContain('if (cached === null) return false;');

    expect(fn.match(/return true;/g) ?? []).toHaveLength(1);
    expect(fn).toMatch(/publishResult\(cached\.meta\.runKey, cached, id\);\s*return true;/);
  });

  it('asks with the lookup, never with the route that would START the run', () => {
    /*
     * POST /api/run answers a cache hit just as instantly, which makes it the
     * obvious shortcut and the actual bug: its MISS spawns the simulation, so
     * every page load without a cached answer would quietly begin a 10,000-path
     * run nobody clicked for. Looking is free; computing is not.
     */
    const restore = src.slice(src.indexOf('const restoreFinalRun = useCallback'));
    expect(restore).toContain('api.lookupCachedRun(');
    expect(restore.slice(0, restore.indexOf('\n  }, ['))).not.toContain('api.startRun(');
    // …and the manager behind it reads a file and answers; it never hands the
    // request to the executor. (The manager moved to src/store in Phase 4 of
    // the browser port — the pin follows the code, not the node face.)
    const manager = stripComments(read('../../src/store/runManager.ts'));
    const lookup = manager.slice(manager.indexOf('async function lookupCachedRun'));
    expect(lookup.slice(0, lookup.indexOf('\n  }'))).not.toContain('execute(');
  });

  it('asks about the whole input, not about the plan', () => {
    /*
     * The plan hash alone is the wrong key. Holdings balances are derived from
     * quote prices, so the same plan at two prices is two different runs, and
     * reusing one for the other would put a stale number on screen wearing the
     * current plan's name. The client sends the plan and the conditions; the
     * SERVER folds in the resolved profile, the assumptions and the engine
     * version, which is what makes a hit mean "identical inputs entirely".
     */
    expect(stripComments(page)).toMatch(
      /api\.lookupCachedRun\(\{\s*scenario: scenarioForPlainRun\(plan\),\s*\.\.\.standIn,\s*\}\)/,
    );
    const manager = stripComments(read('../../src/store/runManager.ts'));
    expect(manager).toContain('return readCachedResult(runKeyFor(await resolveRunInput(req)))');
    expect(manager).toContain(
      "stableStringify({ engineVersion: ENGINE_VERSION, input })",
    );
  });

  it('decides in the logic module whether the swap is honest at all', () => {
    // A deterministic panel mode, an unlocked seed, or a request for MORE than
    // mcPathsFinal each make the final run something other than a finer version
    // of what was asked for. The page renders; finalStandInParams decides.
    expect(body).toContain('restoreFinalRun');
    expect(stripComments(page)).toContain('finalStandInParams(params, settings)');
    expect(stripComments(logic)).toContain('export function finalStandInParams');
  });

  it('writes a restored run through the same gate a simulated one goes through', () => {
    // Rule 2 at the top of the page: only the newest request may write. A
    // second copy of that check would be a second place for a slow answer to
    // overwrite a fresh one, so both paths end in publishResult.
    expect(src).toContain('const publishResult = useCallback');
    expect(src).toMatch(/publishResult\(runId, done\.result, id\)/);
    expect(src).toMatch(/publishResult\(cached\.meta\.runKey, cached, id\)/);
    expect(stripComments(page)).toMatch(
      /const publishResult = useCallback[\s\S]*?if \(!alive\.current \|\| requestId\.current !== id\) return;/,
    );
  });

  it('leaves the live loop, its debounce and Run now exactly where they were', () => {
    // The quick run is what keeps the screen alive while knobs move, and this
    // change must not have made an edit slower or turned Run now into something
    // else. Raising mcPathsInteractive would have "fixed" the refresh at the
    // cost of every keystroke.
    expect(src).toContain('if (lastRunKey.current !== inputKey) void startRun()');
    expect(src).toContain('const LIVE_DEBOUNCE_MS = 400');
    expect(src).toContain('const refreshed = await api.refreshQuotes()');
    expect(stripComments(logic)).toContain(
      'paths: parsePositiveInt(settings.pathsText, profileSettings.mcPathsInteractive)',
    );
  });

  it('says on the chip when the run was computed, so 3:41 PM is not read as now', () => {
    // A restored run is labelled by its own meta, so runQualityLabel already
    // calls it "Final quality · 10,000 paths". What it could not say is that
    // the number was made this afternoon rather than a second ago.
    const render = stripComments(results);
    const start = render.indexOf('function RunNowBar(');
    const bar = render.slice(start);
    expect(bar).toContain('runComputedAt(result.meta)');
    expect(bar.indexOf('{precision.text}')).toBeLessThan(bar.indexOf('{computed.text}'));
    // Neutral, like the precision chip beside it: a run's age is a fact about
    // the run, not a verdict on the plan.
    expect(bar).toMatch(/<span className="wb-chip" title=\{computed\.title\}>/);
    // Off the RUN, never off the panel — the panel holds a draft of what to ask
    // for next, and a restored run was asked for at a different moment entirely.
    expect(render).not.toContain('runComputedAt(runParams');
  });
});
