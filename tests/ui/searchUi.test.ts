/**
 * Unit tests for the search page's pure space/report logic
 * (src/ui/components/search/searchLogic.ts).
 *
 * This is where a UI mistake becomes a WRONG ANSWER rather than an ugly one: a
 * mis-parsed level searches a space nobody asked for, and a mis-labelled
 * verdict reports a difference the run never measured. Everything expected
 * below is hand-computed in the test, never pasted from a run.
 */
import { describe, expect, it } from 'vitest';
import type {
  PairedDelta,
  Scenario,
  SearchAttributionRow,
  SearchObjective,
} from '../../src/shared/types';
import {
  choiceOptions,
  compileSpace,
  defaultAxisDrafts,
  DIM_SPECS,
  dimGroups,
  formatDelta,
  formatSpread,
  levelLabel,
  mergeStoredDrafts,
  ordinal,
  parseLevels,
  progressFraction,
  sanitiseDrafts,
  shouldEnumerate,
  spaceSizeNote,
  splitAttribution,
  SUCCESS_METRIC_WARNING,
  verdictTone,
  verdictWord,
  formatDuration,
  type AxisDraft,
} from '../../src/ui/components/search/searchLogic';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function plan(overrides: Partial<Scenario> = {}): Scenario {
  return {
    name: 'Plan',
    events: [{ type: 'retire', person: 'alex', date: '2031-06' }],
    ...overrides,
  };
}



function delta(overrides: Partial<PairedDelta> = {}): PairedDelta {
  return {
    mean: 1000,
    sd: 100,
    se: 50,
    n: 8,
    ci95: [900, 1100],
    p: 0.001,
    winsOn: 8,
    verdict: 'better',
    note: 'note',
    ...overrides,
  };
}

const OBJECTIVE: SearchObjective = {
  metric: 'sustainable_spend',
  probeTargetSuccess: 0.85,
  practicalFloor: 500,
};

// ---------------------------------------------------------------------------
// Parsing levels
// ---------------------------------------------------------------------------

describe('parseLevels', () => {
  it('expands ranges and de-duplicates, preserving order', () => {
    // "2029-2033/2" is 2029, 2031, 2033; the trailing 2031 is already present.
    const res = parseLevels('retireYear', '2029-2033/2, 2031');
    expect(res).toEqual({ ok: true, levels: [2029, 2031, 2033] });
  });

  it('reads percents as percents and refuses the 0-to-1 ambiguity', () => {
    expect(parseLevels('stockShare', '50, 60, 70')).toEqual({
      ok: true,
      levels: [0.5, 0.6, 0.7],
    });
    // 0.6 is either 60% written as a fraction or 0.6% written as a percent.
    // Guessing either way silently searches a space nobody asked for.
    const bad = parseLevels('stockShare', '0.6');
    expect(bad.ok).toBe(false);
    expect(bad.ok === false && bad.error).toContain('percent');
  });

  it('keeps a fractional percent exact rather than rounding it away', () => {
    // 4.25% must be 0.0425, not 0.043 — the money difference is real.
    expect(parseLevels('rothConversion', '4.25')).toEqual({ ok: true, levels: [0.0425] });
  });

  it('accepts k/m money suffixes and the keyword levels', () => {
    expect(parseLevels('housePrice', '950k, 1.2m, proceeds, none')).toEqual({
      ok: true,
      levels: [950_000, 1_200_000, 'sale_proceeds', 'none'],
    });
  });

  it('rejects out-of-range values with the reason, not a silent clamp', () => {
    const res = parseLevels('claimAge', '61');
    expect(res.ok).toBe(false);
    expect(res.ok === false && res.error).toContain('62 to 70');
  });

  it('refuses more than the 24-level cap', () => {
    const res = parseLevels('retireYear', '2030-2060');
    expect(res.ok).toBe(false);
    expect(res.ok === false && res.error).toContain('cap is 24');
  });

  it('refuses an empty list rather than searching nothing', () => {
    expect(parseLevels('retireYear', '   ').ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Compiling the space
// ---------------------------------------------------------------------------

describe('compileSpace', () => {
  const drafts = (over: Partial<Record<string, Partial<AxisDraft>>> = {}): AxisDraft[] =>
    DIM_SPECS.map((s) => ({
      dim: s.dim,
      enabled: false,
      text: '',
      chosen: [],
      ...(over[s.dim] ?? {}),
    }));

  it('multiplies the enabled axes and ignores the rest', () => {
    const res = compileSpace(
      drafts({
        retireYear: { enabled: true, text: '2029, 2031, 2033' },
        autoSepp: { enabled: true, chosen: ['on', 'off'] },
        claimAge: { enabled: false, text: '62, 67' },
      }),
    );
    expect(res.errors).toEqual({});
    expect(res.axes.map((a) => a.dim)).toEqual(['retireYear', 'autoSepp']);
    expect(res.combinations).toBe(6); // 3 x 2
  });

  it('reports a per-dimension error and drops only that axis', () => {
    const res = compileSpace(
      drafts({
        retireYear: { enabled: true, text: 'next year' },
        autoSepp: { enabled: true, chosen: ['on', 'off'] },
      }),
    );
    expect(res.errors.retireYear).toBeDefined();
    expect(res.axes.map((a) => a.dim)).toEqual(['autoSepp']);
  });

  it('treats an enabled choice axis with nothing ticked as an error', () => {
    const res = compileSpace(drafts({ glideShape: { enabled: true, chosen: [] } }));
    expect(res.errors.glideShape).toBeDefined();
    expect(res.axes).toHaveLength(0);
  });

  it('reports zero combinations when nothing is on (not one)', () => {
    // An empty product is 1 mathematically, and reporting "1 combination" for
    // an empty space would invite starting a search over nothing.
    expect(compileSpace(drafts()).combinations).toBe(0);
  });

  it('compiles boolean and object levels through the choice options', () => {
    const res = compileSpace(
      drafts({
        autoSepp: { enabled: true, chosen: ['off'] },
        spendingPolicy: { enabled: true, chosen: ['fixed_real', 'guardrails'] },
      }),
    );
    expect(res.axes).toEqual([
      { dim: 'autoSepp', levels: [false] },
      { dim: 'spendingPolicy', levels: [{ type: 'fixed_real' }, { type: 'guardrails' }] },
    ]);
  });
});

describe('the spending-policy catalog', () => {
  it('offers fixed_real and guardrails, and no percent-of-portfolio level', () => {
    // The schema rejects fixed_percent (a policy that DEFINES spending cannot
    // be ranked on sustainable spending), so a catalog still offering it would
    // be a button that always errors — the exact incident this test pins.
    const types = choiceOptions('spendingPolicy').map((o) => (o.value as { type: string }).type);
    expect(types).toEqual(['fixed_real', 'guardrails']);
  });

  it('seeds the default space with both rankable policies', () => {
    const drafts = defaultAxisDrafts(plan());
    expect(drafts.find((d) => d.dim === 'spendingPolicy')?.chosen).toEqual([
      'fixed_real',
      'guardrails',
    ]);
  });
});

describe('sanitiseDrafts', () => {
  const draft = (over: Partial<AxisDraft>): AxisDraft => ({
    dim: 'spendingPolicy',
    enabled: true,
    text: '',
    chosen: [],
    ...over,
  });

  it('leaves a clean space alone', () => {
    const input = [draft({ chosen: ['fixed_real', 'guardrails'] })];
    const res = sanitiseDrafts(input);
    expect(res.changed).toBe(false);
    expect(res.notes).toEqual([]);
    expect(res.drafts).toEqual(input);
  });

  it('drops retired percent-of-portfolio keys and says why', () => {
    const res = sanitiseDrafts([draft({ chosen: ['fixed_real', 'guardrails', 'pct_40'] })]);
    expect(res.changed).toBe(true);
    expect(res.drafts[0].chosen).toEqual(['fixed_real', 'guardrails']);
    // Two levels survive: still a decision, so the axis stays on.
    expect(res.drafts[0].enabled).toBe(true);
    const note = res.notes.join(' ');
    expect(note).toContain('4.0% of the portfolio');
    expect(note).toContain('sets spending by formula');
  });

  it('turns off an axis healed below two levels — one level is not a decision', () => {
    const res = sanitiseDrafts([draft({ chosen: ['fixed_real', 'pct_35', 'pct_45'] })]);
    expect(res.drafts[0].chosen).toEqual(['fixed_real']);
    expect(res.drafts[0].enabled).toBe(false);
    expect(res.notes.join(' ')).toContain('turned off');
  });

  it('cleans a disabled axis quietly — no turned-off clause for a row already off', () => {
    const res = sanitiseDrafts([draft({ enabled: false, chosen: ['pct_40'] })]);
    expect(res.changed).toBe(true);
    expect(res.drafts[0].chosen).toEqual([]);
    expect(res.notes.join(' ')).not.toContain('turned off');
  });

  it('is idempotent, which is what keeps the note from recurring', () => {
    // The caller rewrites storage with the healed drafts; sanitising the
    // rewritten copy must find nothing, or the note would show forever.
    const once = sanitiseDrafts([draft({ chosen: ['fixed_real', 'pct_40'] })]);
    const twice = sanitiseDrafts(once.drafts);
    expect(twice.changed).toBe(false);
    expect(twice.notes).toEqual([]);
  });

  it('never judges the chosen list of a numeric axis', () => {
    const numeric: AxisDraft = { dim: 'retireYear', enabled: true, text: '2029', chosen: ['x'] };
    expect(sanitiseDrafts([numeric]).changed).toBe(false);
  });
});

describe("the two notes, in the user's language", () => {
  it('explains why success probability cannot rank this household', () => {
    expect(SUCCESS_METRIC_WARNING).toContain('funded well enough');
    expect(SUCCESS_METRIC_WARNING).toContain('twenty structurally different plans');
    expect(SUCCESS_METRIC_WARNING).toContain('ranks market luck');
    expect(SUCCESS_METRIC_WARNING).toContain('pass/fail gate');
    // The old copy the user read and did not understand.
    expect(SUCCESS_METRIC_WARNING).not.toContain('saturates');
    expect(SUCCESS_METRIC_WARNING).not.toContain('rank noise');
  });

  it('explains the sample and why the one-decision variants always run', () => {
    const note = spaceSizeNote(6912, 512, false);
    expect(note).toContain('These axes make 6,912 combinations');
    expect(note).toContain('512 of them will be sampled');
    expect(note).toContain('changes exactly one decision');
    expect(note).toContain('price each decision on its own');
    // The phrase the user could not parse.
    expect(note).not.toContain('one-knob neighbours');

    expect(spaceSizeNote(24, 512, true)).toBe(
      'Small enough to search exhaustively: every one of the 24 plans will be tried.',
    );
  });
});

describe('the seeded space', () => {
  it('never offers a retirement year that has already passed', () => {
    const thisYear = new Date().getFullYear();
    const drafts = defaultAxisDrafts(
      plan({ events: [{ type: 'retire', person: 'm', date: `${thisYear}-06` }] }),
    );
    const retire = drafts.find((d) => d.dim === 'retireYear');
    const parsed = parseLevels('retireYear', retire?.text ?? '');
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.levels.every((y) => typeof y === 'number' && y >= thisYear)).toBe(true);
      expect(parsed.levels.length).toBeGreaterThan(0);
    }
  });

  it('groups every dimension exactly once', () => {
    const grouped = dimGroups().flatMap((g) => g.dims.map((d) => d.dim));
    expect(grouped.sort()).toEqual(DIM_SPECS.map((d) => d.dim).sort());
  });
});

describe('mergeStoredDrafts', () => {
  const defaults: AxisDraft[] = [
    { dim: 'retireYear', enabled: true, text: '2029', chosen: [] },
    { dim: 'autoSepp', enabled: false, text: '', chosen: ['on'] },
  ];

  it('keeps the default shape and fills in stored values', () => {
    const stored = JSON.stringify([{ dim: 'retireYear', enabled: false, text: '2035', chosen: [] }]);
    expect(mergeStoredDrafts(stored, defaults)).toEqual([
      { dim: 'retireYear', enabled: false, text: '2035', chosen: [] },
      { dim: 'autoSepp', enabled: false, text: '', chosen: ['on'] },
    ]);
  });

  it('ignores rubbish rather than losing the page', () => {
    expect(mergeStoredDrafts('not json', defaults)).toEqual(defaults);
    expect(mergeStoredDrafts('{"a":1}', defaults)).toEqual(defaults);
    expect(mergeStoredDrafts(null, defaults)).toEqual(defaults);
  });

  it('drops a stored row for a dimension that no longer exists', () => {
    const stored = JSON.stringify([{ dim: 'gone', enabled: true, text: 'x', chosen: [] }]);
    expect(mergeStoredDrafts(stored, defaults)).toEqual(defaults);
  });
});

describe('shouldEnumerate', () => {
  it('enumerates a space that fits inside the sample, samples one that does not', () => {
    expect(shouldEnumerate(24, 512)).toBe(true);
    expect(shouldEnumerate(512, 512)).toBe(true);
    expect(shouldEnumerate(513, 512)).toBe(false);
    expect(shouldEnumerate(0, 512)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Reading the report
// ---------------------------------------------------------------------------

describe('formatting a difference', () => {
  it('signs a negative delta as negative', () => {
    // The formatter renders magnitudes, so the sign has to be added back — a
    // -$670 printed as "+$670" is the worst kind of wrong.
    expect(formatDelta(OBJECTIVE, -670)).toBe('-$670/yr');
    expect(formatDelta(OBJECTIVE, 670)).toBe('+$670/yr');
    expect(formatDelta(OBJECTIVE, 0)).toBe('$0/yr');
  });

  it('renders a success-metric delta in points', () => {
    const successObjective: SearchObjective = { ...OBJECTIVE, metric: 'success' };
    expect(formatDelta(successObjective, -0.0123)).toBe('-1.23 pts');
  });
});

describe('formatSpread', () => {
  it('shows nothing at one seed rather than an implied +/- 0', () => {
    expect(
      formatSpread(OBJECTIVE, { mean: 1, sd: 0, se: 0, n: 1, min: 1, max: 1, ci95: [1, 1], values: [1] }),
    ).toBeNull();
    expect(formatSpread(OBJECTIVE, undefined)).toBeNull();
  });

  it('reports the half-width and the seed count when there is one', () => {
    expect(
      formatSpread(OBJECTIVE, {
        mean: 100_000,
        sd: 2000,
        se: 1000,
        n: 4,
        min: 98_000,
        max: 102_000,
        ci95: [96_000, 104_000],
        values: [1, 2, 3, 4],
      }),
    ).toBe('±$4,000 (4 seeds)');
  });
});

describe('the four verdicts', () => {
  it('never collapses "same plan" into "not resolved"', () => {
    expect(verdictWord('equivalent')).not.toBe(verdictWord('inconclusive'));
    expect(verdictTone('equivalent')).not.toBe(verdictTone('inconclusive'));
  });

  it('keeps better and worse visually opposite', () => {
    expect(verdictTone('better')).toBe('good');
    expect(verdictTone('worse')).toBe('bad');
  });
});

describe('splitAttribution', () => {
  const row = (over: Partial<SearchAttributionRow>): SearchAttributionRow => ({
    dim: 'retireYear',
    label: 'retirement year',
    winnerLevel: '2031',
    note: '',
    ...over,
  });

  it('separates moved / no effect / unresolved / inert', () => {
    const split = splitAttribution([
      row({ dim: 'retireYear', onOwn: delta({ mean: 5000 }) }),
      row({ dim: 'claimAge', onOwn: delta({ mean: 10, verdict: 'equivalent' }) }),
      row({ dim: 'state', onOwn: delta({ mean: 300, verdict: 'inconclusive' }) }),
      row({ dim: 'autoSepp', inert: true }),
      // Nothing measured at all is NOT "no effect" — it goes with unresolved.
      row({ dim: 'givingRule' }),
    ]);
    expect(split.moved.map((r) => r.dim)).toEqual(['retireYear']);
    expect(split.noEffect.map((r) => r.dim)).toEqual(['claimAge']);
    expect(split.unresolved.map((r) => r.dim)).toEqual(['state', 'givingRule']);
    expect(split.inert.map((r) => r.dim)).toEqual(['autoSepp']);
  });

  it('puts the biggest mover first, by magnitude and not by sign', () => {
    const split = splitAttribution([
      row({ dim: 'claimAge', onOwn: delta({ mean: 1200 }) }),
      row({ dim: 'retireYear', onOwn: delta({ mean: -9000, verdict: 'worse' }) }),
    ]);
    expect(split.moved.map((r) => r.dim)).toEqual(['retireYear', 'claimAge']);
  });

  it('classes an inert row as inert even when a delta is attached', () => {
    const split = splitAttribution([row({ dim: 'financing', inert: true, onOwn: delta() })]);
    expect(split.inert).toHaveLength(1);
    expect(split.moved).toHaveLength(0);
  });
});

describe('small formatters', () => {
  it('formats durations without pretending to know an unknown one', () => {
    expect(formatDuration(undefined)).toBe('—');
    expect(formatDuration(45_000)).toBe('45s');
    expect(formatDuration(125_000)).toBe('2m 05s');
    expect(formatDuration(3_725_000)).toBe('1h 02m');
  });

  it('clamps progress and never divides by a zero total', () => {
    expect(progressFraction(0, 0)).toBe(0);
    expect(progressFraction(5, 10)).toBe(0.5);
    expect(progressFraction(15, 10)).toBe(1);
  });

  it('ordinals the teens correctly', () => {
    expect([1, 2, 3, 4, 11, 12, 13, 21].map(ordinal)).toEqual([
      '1st',
      '2nd',
      '3rd',
      '4th',
      '11th',
      '12th',
      '13th',
      '21st',
    ]);
  });

  it('labels levels in English', () => {
    expect(levelLabel('stockShare', 0.7)).toBe('70/30');
    expect(levelLabel('housePrice', 'sale_proceeds')).toBe('buy with the sale proceeds');
    expect(levelLabel('moveOffsetYears', 0)).toBe('move at retirement');
    expect(levelLabel('autoSepp', true)).toBe('Elect the 72(t) when it is needed');
  });
});

// ---------------------------------------------------------------------------
// The cabinet
// ---------------------------------------------------------------------------

