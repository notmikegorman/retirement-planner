/**
 * The search request contract.
 *
 * The schema exists to make a specific silent failure loud. A typo'd axis name
 * would otherwise search nothing while looking like it searched something, and
 * two axes on one dimension is not a bigger search but an AMBIGUOUS one — the
 * compiler would apply both and the second would quietly win.
 */
import { describe, expect, it } from 'vitest';
import type { SearchRequest } from '../../src/shared/types';
import {
  formatZodError,
  parseOrThrow,
  searchRequestSchema,
} from '../../src/shared/schemas';

const base = {
  name: 'Plan',
  events: [
    { type: 'retire', person: 'p1', date: '2033-06' },
    { type: 'retire', person: 'p2', date: '2033-06' },
  ],
};

function req(overrides: Record<string, unknown> = {}): unknown {
  return { base, axes: [{ dim: 'retireYear', levels: [2029, 2031] }], ...overrides };
}

function why(value: unknown): string {
  const parsed = searchRequestSchema.safeParse(value);
  expect(parsed.success).toBe(false);
  return parsed.success ? '' : formatZodError(parsed.error);
}

describe('searchRequestSchema', () => {
  it('accepts a full twelve-dimension space', () => {
    const parsed = searchRequestSchema.safeParse(
      req({
        axes: [
          { dim: 'retireYear', levels: [2027, 2029, 2031] },
          { dim: 'autoSepp', levels: [true, false] },
          { dim: 'stockShare', levels: [0.4, 0.6, 0.8] },
          { dim: 'glideShape', levels: ['step_now', 'glide_to_target', 'rising_equity'] },
          { dim: 'housePrice', levels: [900_000, 'sale_proceeds', 'none'] },
          { dim: 'financing', levels: ['cash', 'mortgage'] },
          { dim: 'moveOffsetYears', levels: [0, 2] },
          { dim: 'claimAge', levels: [62, 67, 70] },
          { dim: 'givingRule', levels: [{ type: 'continue' }, { type: 'none' }] },
          { dim: 'rothConversion', levels: [0.12, 0.22, 'none'] },
          { dim: 'state', levels: ['va', 'sc', 'nc'] },
          { dim: 'spendingPolicy', levels: [{ type: 'fixed_real' }, { type: 'guardrails' }] },
        ],
        objective: { metric: 'sustainable_spend', practicalFloor: 500 },
        budget: { candidates: 512, finalists: 6, seedBase: 42 },
        label: 'the big one',
      }),
    );
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      const value = parsed.data as SearchRequest;
      expect(value.axes).toHaveLength(12);
      expect(value.label).toBe('the big one');
    }
  });

  it('refuses two axes on one dimension, which would be ambiguous rather than bigger', () => {
    expect(
      why(
        req({
          axes: [
            { dim: 'claimAge', levels: [62, 67] },
            { dim: 'claimAge', levels: [70] },
          ],
        }),
      ),
    ).toMatch(/each dimension may appear at most once/);
  });

  it('refuses a search over nothing', () => {
    expect(why(req({ axes: [] }))).toMatch(/axes/);
  });

  it('refuses an axis with no levels, which would search nothing while looking busy', () => {
    expect(why(req({ axes: [{ dim: 'retireYear', levels: [] }] }))).toMatch(/levels/);
  });

  it('refuses a typo\'d dimension instead of silently dropping the decision', () => {
    expect(why(req({ axes: [{ dim: 'retireYr', levels: [2029] }] }))).toMatch(/dim/);
    expect(why(req({ axes: [{ dim: 'retireYear', levels: [2029], stpe: 1 }] }))).toMatch(/stpe|unrecognized/i);
  });

  it('caps levels per axis, because 40 levels cannot be told apart at any budget', () => {
    const ok = Array.from({ length: 24 }, (_, i) => 2027 + i);
    expect(searchRequestSchema.safeParse(req({ axes: [{ dim: 'retireYear', levels: ok }] })).success)
      .toBe(true);
    expect(why(req({ axes: [{ dim: 'retireYear', levels: [...ok, 2051] }] }))).toMatch(/levels/);
  });

  it('type-checks the levels of each dimension, not just their shape', () => {
    expect(why(req({ axes: [{ dim: 'autoSepp', levels: ['yes'] }] }))).toMatch(/levels/);
    expect(why(req({ axes: [{ dim: 'stockShare', levels: [1.5] }] }))).toMatch(/levels/);
    expect(why(req({ axes: [{ dim: 'claimAge', levels: [61] }] }))).toMatch(/levels/);
    expect(why(req({ axes: [{ dim: 'claimAge', levels: [71] }] }))).toMatch(/levels/);
    expect(why(req({ axes: [{ dim: 'state', levels: ['zz'] }] }))).toMatch(/levels/);
    expect(why(req({ axes: [{ dim: 'glideShape', levels: ['sideways'] }] }))).toMatch(/levels/);
    expect(why(req({ axes: [{ dim: 'housePrice', levels: ['whatever'] }] }))).toMatch(/levels/);
    expect(why(req({ axes: [{ dim: 'retireYear', levels: [2029.5] }] }))).toMatch(/levels/);
  });

  it('refuses a percent-of-portfolio spending level, which the objective cannot rank', () => {
    // The objective is "maximum sustainable spending", found by bisecting the
    // living figure. A fixed_percent policy sets spending from the portfolio and
    // never reads that figure, so every probe of the bisection scores the same
    // and it returns the top of its bracket regardless. Measured on the user's
    // own plan, a 4% level scored 1.000000 at $60k, $120k, $250k and $399k
    // alike, then won the search with a fabricated "+$290,000/yr" verdict.
    // A search that cannot rank a level must decline it, not invent a number.
    expect(
      why(
        req({
          axes: [
            {
              dim: 'spendingPolicy',
              levels: [{ type: 'fixed_real' }, { type: 'fixed_percent', percent: 0.04 }],
            },
          ],
        }),
      ),
    ).toMatch(/levels/);
    // Both rankable policies still parse: guardrails READS the living figure
    // the bisection sweeps (spending holds real, rails on the withdrawal
    // rate), so its probes separate — unlike fixed_percent.
    expect(
      searchRequestSchema.safeParse(
        req({
          axes: [
            { dim: 'spendingPolicy', levels: [{ type: 'fixed_real' }, { type: 'guardrails' }] },
          ],
        }),
      ).success,
    ).toBe(true);
  });

  it('rejects fixed_percent with the WHY, not a zod dump', () => {
    // A user met this rejection live as "axes.9.levels.1.type: Invalid
    // literal value, expected \"fixed_real\"" — a schema bug to his eyes, when
    // it is actually a decision with a story. The message must carry the story.
    const message = why(
      req({
        axes: [{ dim: 'spendingPolicy', levels: [{ type: 'fixed_percent', percent: 0.04 }] }],
      }),
    );
    expect(message).toContain('percent-of-portfolio level cannot be searched');
    expect(message).toContain('+$290,000/yr');
    expect(message).toContain('Use fixed_real or guardrails levels');
    expect(message).not.toContain('Invalid literal');
    expect(message).not.toContain('Invalid discriminator');

    // A level that was never offered gets the ordinary rejection — the story
    // above is about fixed_percent specifically, not about typos.
    expect(
      why(req({ axes: [{ dim: 'spendingPolicy', levels: [{ type: 'whatever' }] }] })),
    ).not.toContain('percent-of-portfolio');
  });

  it('surfaces the human message through the same helper the route uses', () => {
    // server.ts validateBody wraps parseOrThrow and keeps its message; if this
    // passes, the HTTP 400 body carries the sentence, not the zod path alone.
    expect(() =>
      parseOrThrow(
        searchRequestSchema,
        req({
          axes: [{ dim: 'spendingPolicy', levels: [{ type: 'fixed_percent', percent: 0.04 }] }],
        }),
        'search request',
      ),
    ).toThrow(/Invalid search request: .*percent-of-portfolio level cannot be searched/);
  });

  it('rails the budget so a careless number cannot hang the machine', () => {
    expect(why(req({ budget: { candidates: 0 } }))).toMatch(/candidates/);
    expect(why(req({ budget: { candidates: 99_999 } }))).toMatch(/candidates/);
    // A cut factor below 1.5 would never narrow the field.
    expect(why(req({ budget: { eta: 1 } }))).toMatch(/eta/);
    // One report seed cannot produce an interval, so two is the floor.
    expect(why(req({ budget: { reportSeedCount: 1 } }))).toMatch(/reportSeedCount/);
    expect(why(req({ budget: { workers: 0 } }))).toMatch(/workers/);
    expect(why(req({ budget: { screenPaths: 10 } }))).toMatch(/screenPaths/);
    expect(why(req({ budget: { nonsense: true } }))).toMatch(/nonsense|unrecognized/i);
  });

  it('rails the objective', () => {
    expect(why(req({ objective: { metric: 'vibes' } }))).toMatch(/metric/);
    expect(why(req({ objective: { probeTargetSuccess: 1 } }))).toMatch(/probeTargetSuccess/);
    expect(why(req({ objective: { practicalFloor: -1 } }))).toMatch(/practicalFloor/);
    expect(searchRequestSchema.safeParse(req({ objective: {} })).success).toBe(true);
  });

  it('validates the plan it is asked to search', () => {
    expect(why(req({ base: { name: 'x', events: [{ type: 'retire' }] } }))).toMatch(/base/);
  });
});
