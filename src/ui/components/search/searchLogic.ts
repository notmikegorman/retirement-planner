/**
 * Pure logic for the Search page: the decision space in, the report out.
 *
 * No React and no IO, so all of it is unit-testable (tests/ui/searchUi.test.ts)
 * — which matters more here than anywhere else in the UI, because this file is
 * where a typo turns "try 60/40, 70/30 and 80/20" into "try 0.6% stocks" and
 * the search dutifully spends twenty minutes answering the wrong question.
 *
 * THREE RULES THIS FILE EXISTS TO ENFORCE:
 *
 *  1. A LEVEL THE USER TYPED IS SHOWN BACK TO THEM, PARSED. Every numeric axis
 *     is free text (ranges included), and free text is guesswork unless the
 *     parse is echoed as chips he can read. `parseLevels` therefore returns the
 *     values, and the editor renders them.
 *  2. THE UNITS ARE NEVER AMBIGUOUS. Stock share and Roth-conversion brackets
 *     are entered in PERCENT, and a value between 0 and 1 is rejected with the
 *     reason rather than silently taken as a fraction — "0.6" meaning 0.6% is a
 *     search of a space nobody asked for.
 *  3. A DIFFERENCE INSIDE THE NOISE IS SAID TO BE INSIDE THE NOISE. The four
 *     verdicts do not collapse into three: `equivalent` ("these are the same
 *     plan") and `inconclusive` ("we did not measure this well enough") are
 *     opposite findings, and every renderer here keeps them apart.
 */
import type {
  GlideShape,
  RetirementGivingRule,
  Scenario,
  ScenarioEvent,
  SearchAxis,
  SearchBudget,
  SearchDim,
  SearchFinalist,
  SearchObjective,
  SearchReport,
  StateCode,
  DeltaVerdict,
  PairedDelta,
  SeedStat,
  SpendingPolicyLevel,
} from '../../../shared/types';
import { formatPct, formatUSD, parseYearMonth } from '../../../shared/util';

// ---------------------------------------------------------------------------
// The dimensions, as the user meets them
// ---------------------------------------------------------------------------

/**
 * Which editor a dimension gets.
 *
 * 'numbers' — free text, because the user has a number in mind (a year, a
 *             price, a share) and a fixed list of checkboxes would be a cage.
 * 'choice'  — checkboxes, because the levels are a closed set of shapes with
 *             parameters the search has no way to invent (a giving rule needs
 *             a percentage; a glidepath needs a form).
 */
export type AxisKind = 'numbers' | 'choice';

/** How a numeric axis reads and writes its text. */
export type NumberUnit = 'year' | 'percent' | 'money' | 'int';

export interface ChoiceOption {
  /** Stable key stored in the draft and in localStorage. */
  key: string;
  label: string;
  /** The level value sent to the server. */
  value: unknown;
}

export interface DimSpec {
  dim: SearchDim;
  title: string;
  /** Which fieldset the row sits in. */
  group: string;
  kind: AxisKind;
  unit?: NumberUnit;
  /** Extra tokens a numeric axis accepts, e.g. "none" on housePrice. */
  keywords?: Array<{ token: string; value: string; label: string }>;
  placeholder?: string;
  /** One line under the control. */
  help?: string;
  /** The paragraph behind the "?". */
  tip: string;
}

/**
 * The twelve, grouped the way the decisions actually cluster in a life: when
 * you stop, what the money is invested in, how you get at it before 59 1/2,
 * the house, and what you spend and give.
 */
export const DIM_SPECS: readonly DimSpec[] = [
  {
    dim: 'retireYear',
    title: 'Retirement year',
    group: 'When you stop',
    kind: 'numbers',
    unit: 'year',
    placeholder: '2029, 2031, 2033',
    help: 'Ranges work: 2029-2035, or 2029-2035/2 for every other year.',
    tip:
      'The calendar year both people stop working (July of that year). This is usually the ' +
      'single most powerful dimension in the space and the one worth the most levels: a year ' +
      'either side of your plan costs nothing extra to try, and the search reports what each ' +
      'one is worth rather than only naming the best.',
  },
  {
    dim: 'claimAge',
    title: 'Social Security claiming age',
    group: 'When you stop',
    kind: 'numbers',
    unit: 'int',
    placeholder: '62, 67, 70',
    help: 'Whole years, 62 to 70.',
    tip:
      'Household claiming age in whole years. Claiming later buys a bigger, inflation-linked, ' +
      'survivor-inheritable benefit at the cost of drawing the portfolio harder in the bridge ' +
      'years, so it interacts with the retirement year and with the 72(t) — which is exactly ' +
      'the kind of pairing the attribution section is built to expose.',
  },
  {
    dim: 'stockShare',
    title: 'Target stock share',
    group: 'The portfolio',
    kind: 'numbers',
    unit: 'percent',
    placeholder: '50, 60, 70, 80',
    help: 'Percent in stocks; the rest goes to bonds. Enter 60, not 0.6.',
    tip:
      'The stock share the portfolio is steered TO. The remainder goes to bonds. Pair it with ' +
      'the glidepath dimension, which decides how the portfolio gets there — the same 70/30 ' +
      'reached today, at retirement, or over five years is three different plans, and the ' +
      'search treats them as such.',
  },
  {
    dim: 'glideShape',
    title: 'How it gets there',
    group: 'The portfolio',
    kind: 'choice',
    tip:
      'The path to the target share. "Rising equity" is the retirement-researcher\'s answer to ' +
      'sequence-of-returns risk: start conservative at the moment the portfolio is most ' +
      'vulnerable and drift UP over the following decade. It is in the list because you asked ' +
      'the question once before (allocation-glidepath.json), not because it is recommended.',
  },
  {
    dim: 'autoSepp',
    title: '72(t) bridge',
    group: 'Getting at the money',
    kind: 'choice',
    tip:
      'The automatic 72(t)/SEPP election that opens pre-tax money before 59 1/2 without the 10% ' +
      'penalty. It goes INERT the moment retirement is already penalty-free — and the report ' +
      'says "the question does not arise" for that case rather than reporting a spurious zero ' +
      'effect, which is a different and much more useful statement.',
  },
  {
    dim: 'rothConversion',
    title: 'Roth conversions',
    group: 'Getting at the money',
    kind: 'numbers',
    unit: 'percent',
    keywords: [{ token: 'none', value: 'none', label: 'no conversions' }],
    placeholder: 'none, 12, 22, 24',
    help: 'Convert yearly to the top of that bracket. "none" is a level too.',
    tip:
      'Convert traditional money to Roth each year up to the top of the named marginal bracket. ' +
      'Filling a low bracket in the gap between retirement and RMDs trades tax now for less ' +
      'tax later — and matters most to the survivor, who files single at roughly half the ' +
      'brackets. Always include "none" so the report can price the whole idea, not just its size.',
  },
  {
    dim: 'state',
    title: 'State of residence',
    group: 'Getting at the money',
    kind: 'choice',
    tip:
      'Where you live from the move onward, which sets the state income tax the engine applies. ' +
      'Only states this planner has real tax math for are offered.',
  },
  {
    dim: 'housePrice',
    title: 'Replacement house',
    group: 'The house',
    kind: 'numbers',
    unit: 'money',
    keywords: [
      { token: 'proceeds', value: 'sale_proceeds', label: 'buy with the sale proceeds' },
      { token: 'none', value: 'none', label: 'sell and rent from then on' },
    ],
    placeholder: '900k, 1.1m, proceeds, none',
    help: 'k and m suffixes work. "proceeds" and "none" are levels in their own right.',
    tip:
      'The purchase price in nominal purchase-year dollars. "proceeds" is NOT the same plan as ' +
      'typing that number: it is a residual claim — buy with whatever the move actually leaves ' +
      '— so the 72(t) does not reserve cash for it, while a firm number is a commitment the ' +
      'bridge must fund. "none" sells and rents to the horizon. All three are worth searching.',
  },
  {
    dim: 'financing',
    title: 'How it is paid for',
    group: 'The house',
    kind: 'choice',
    tip:
      'Cash or a 20%-down mortgage on the replacement house. Inert when no house is bought — ' +
      'and reported as inert, not as "no effect".',
  },
  {
    dim: 'moveOffsetYears',
    title: 'Years from retiring to moving',
    group: 'The house',
    kind: 'numbers',
    unit: 'int',
    placeholder: '0, 1, 2, 5',
    help: '0 sells in the retirement year.',
    tip:
      'How long you stay put after retiring before selling. It moves a large, lumpy, taxable ' +
      'event around the years when the bridge is thinnest, so it can matter far more than its ' +
      'size suggests.',
  },
  {
    dim: 'spendingPolicy',
    title: 'Spending rule',
    group: 'Spending and giving',
    kind: 'choice',
    tip:
      'Fixed real spending keeps the standard of living constant and lets the portfolio absorb ' +
      'every shock. Guardrails holds spending real too, but cuts or raises it when the ' +
      'withdrawal rate drifts outside your configured band — which is what most households ' +
      'actually do. Both can be ranked on sustainable dollars. A percent-of-portfolio rule ' +
      'cannot: it sets spending by formula, so "how much can I sustainably spend" has no ' +
      'answer for it, and it is not offered.',
  },
  {
    dim: 'givingRule',
    title: 'Giving in retirement',
    group: 'Spending and giving',
    kind: 'choice',
    tip:
      'What happens to the giving when the paychecks stop. Each option carries the parameters ' +
      'shown in its label — the search cannot invent a percentage, so these are concrete rules ' +
      'rather than shapes.',
  },
];

export function dimSpec(dim: SearchDim): DimSpec {
  const found = DIM_SPECS.find((d) => d.dim === dim);
  if (!found) throw new Error(`Unknown search dimension "${dim}"`);
  return found;
}

/** The groups in display order, derived from DIM_SPECS so they cannot drift. */
export function dimGroups(): Array<{ group: string; dims: DimSpec[] }> {
  const out: Array<{ group: string; dims: DimSpec[] }> = [];
  for (const spec of DIM_SPECS) {
    const existing = out.find((g) => g.group === spec.group);
    if (existing) existing.dims.push(spec);
    else out.push({ group: spec.group, dims: [spec] });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Choice levels
// ---------------------------------------------------------------------------

const GLIDE_OPTIONS: ChoiceOption[] = [
  { key: 'step_now', label: 'Switch now, in one step', value: 'step_now' satisfies GlideShape },
  {
    key: 'step_at_retirement',
    label: 'Switch at retirement, in one step',
    value: 'step_at_retirement' satisfies GlideShape,
  },
  {
    key: 'glide_to_target',
    label: 'Glide over 5 years from retirement',
    value: 'glide_to_target' satisfies GlideShape,
  },
  {
    key: 'rising_equity',
    label: 'Rising equity: start 20 points lower, climb for 10 years',
    value: 'rising_equity' satisfies GlideShape,
  },
];

const AUTO_SEPP_OPTIONS: ChoiceOption[] = [
  { key: 'on', label: 'Elect the 72(t) when it is needed', value: true },
  { key: 'off', label: 'No 72(t) — pay the 10% penalty on early IRA draws', value: false },
];

const FINANCING_OPTIONS: ChoiceOption[] = [
  { key: 'cash', label: 'Cash', value: 'cash' },
  { key: 'mortgage', label: 'Mortgage, 20% down', value: 'mortgage' },
];

const STATE_OPTIONS: ChoiceOption[] = [
  { key: 'va', label: 'Virginia', value: 'va' satisfies StateCode },
  { key: 'sc', label: 'South Carolina', value: 'sc' satisfies StateCode },
  { key: 'nc', label: 'North Carolina', value: 'nc' satisfies StateCode },
];

/**
 * Only the two policies the objective can rank. The percent-of-portfolio
 * levels that used to sit here were removed when the schema started rejecting
 * them (a policy that DEFINES spending makes "maximum sustainable spending"
 * unanswerable — the search once fabricated a +$290,000/yr winner from one),
 * and a catalog that offers what the server refuses is a button that always
 * errors. Guardrails stays because it READS the living figure the bisection
 * sweeps: the level runs the user's configured band, so "rails vs no rails"
 * is a real, rankable decision.
 */
const SPENDING_POLICY_OPTIONS: ChoiceOption[] = [
  {
    key: 'fixed_real',
    label: 'Fixed real spending',
    value: { type: 'fixed_real' } satisfies SpendingPolicyLevel,
  },
  {
    key: 'guardrails',
    label: 'Guardrails — hold spending real, cut or raise at your configured rails',
    value: { type: 'guardrails' } satisfies SpendingPolicyLevel,
  },
];

/**
 * Giving levels. 'amount' is deliberately absent: it needs a dollar figure the
 * search has no way to choose, and offering it with a made-up number would be
 * putting words in the user's mouth about the one dimension of this plan that
 * is a promise rather than a preference.
 */
const GIVING_OPTIONS: ChoiceOption[] = [
  {
    key: 'continue',
    label: 'Keep giving what you give now',
    value: { type: 'continue' } satisfies RetirementGivingRule,
  },
  {
    key: 'none',
    label: 'Giving stops with the paychecks',
    value: { type: 'none' } satisfies RetirementGivingRule,
  },
  {
    key: 'growth_10',
    label: '10% of the prior year’s real investment growth',
    value: { type: 'percent_of_growth', percent: 0.1 } satisfies RetirementGivingRule,
  },
  {
    key: 'income_10',
    label: '10% of the income actually drawn',
    value: { type: 'percent_of_income', percent: 0.1 } satisfies RetirementGivingRule,
  },
  {
    key: 'tithe_10_defer_10',
    label: 'Tithe account: 10%, held 10 years, then given',
    value: {
      type: 'tithe_account',
      percent: 0.1,
      deferYears: 10,
      seedFromExistingGains: false,
    } satisfies RetirementGivingRule,
  },
];

const CHOICE_OPTIONS: Partial<Record<SearchDim, ChoiceOption[]>> = {
  glideShape: GLIDE_OPTIONS,
  autoSepp: AUTO_SEPP_OPTIONS,
  financing: FINANCING_OPTIONS,
  state: STATE_OPTIONS,
  spendingPolicy: SPENDING_POLICY_OPTIONS,
  givingRule: GIVING_OPTIONS,
};

export function choiceOptions(dim: SearchDim): ChoiceOption[] {
  return CHOICE_OPTIONS[dim] ?? [];
}

// ---------------------------------------------------------------------------
// Parsing the numeric axes
// ---------------------------------------------------------------------------

export type ParseResult =
  | { ok: true; levels: unknown[] }
  | { ok: false; error: string };

/** Schema cap: more levels than this and a dimension's marginal effect is noise. */
export const MAX_LEVELS = 24;

function parseMoneyToken(raw: string): number | null {
  const m = /^\$?([0-9]*\.?[0-9]+)\s*([km])?$/i.exec(raw.replace(/,/g, ''));
  if (!m) return null;
  const n = Number(m[1]);
  if (!Number.isFinite(n)) return null;
  const suffix = (m[2] ?? '').toLowerCase();
  if (suffix === 'k') return n * 1_000;
  if (suffix === 'm') return n * 1_000_000;
  return n;
}

/** "2029-2035" and "2029-2035/2" expand; anything else is one value. */
function expandRange(token: string): number[] | null {
  const m = /^(-?[0-9]+)\s*-\s*(-?[0-9]+)(?:\s*\/\s*([0-9]+))?$/.exec(token);
  if (!m) return null;
  const from = Number(m[1]);
  const to = Number(m[2]);
  const step = m[3] === undefined ? 1 : Number(m[3]);
  if (!Number.isFinite(from) || !Number.isFinite(to) || !Number.isFinite(step) || step < 1) {
    return null;
  }
  if (to < from) return null;
  const out: number[] = [];
  for (let v = from; v <= to; v += step) out.push(v);
  return out;
}

/**
 * Parse one numeric axis's text into level values.
 *
 * Percent axes REJECT a value strictly between 0 and 1 rather than guessing.
 * "0.6" is either 60% expressed as a fraction or 0.6% expressed as a percent,
 * and the two are a different search; the only honest move is to ask.
 */
export function parseLevels(dim: SearchDim, text: string): ParseResult {
  const spec = dimSpec(dim);
  if (spec.kind !== 'numbers') return { ok: false, error: 'not a numeric dimension' };
  const tokens = text
    .split(/[,\n]/)
    .map((t) => t.trim())
    .filter((t) => t.length > 0);
  if (tokens.length === 0) return { ok: false, error: 'Add at least one value' };

  const levels: unknown[] = [];
  const seen = new Set<string>();
  const push = (value: unknown) => {
    const key = JSON.stringify(value);
    if (seen.has(key)) return;
    seen.add(key);
    levels.push(value);
  };

  for (const token of tokens) {
    const keyword = spec.keywords?.find((k) => k.token === token.toLowerCase());
    if (keyword) {
      push(keyword.value);
      continue;
    }
    if (spec.unit === 'money') {
      const n = parseMoneyToken(token);
      if (n === null || n < 0) {
        return { ok: false, error: `"${token}" is not a price (try 950k, 1.2m, or a plain number)` };
      }
      push(Math.round(n));
      continue;
    }
    const range = expandRange(token);
    const values = range ?? [Number(token.replace(/[%,]/g, ''))];
    for (const raw of values) {
      if (!Number.isFinite(raw)) return { ok: false, error: `"${token}" is not a number` };
      if (spec.unit === 'percent') {
        if (raw > 0 && raw < 1) {
          return {
            ok: false,
            error: `Enter ${spec.title.toLowerCase()} in percent — write ${Math.round(raw * 100)} for ${raw}, not ${raw}`,
          };
        }
        if (raw < 0 || raw > 100) return { ok: false, error: `"${raw}" is not a percent` };
        // /100, with the float noise cleaned off: 60 -> 0.6, not 0.6000000000000001.
        push(Math.round(raw * 1e4) / 1e6);
        continue;
      }
      if (!Number.isInteger(raw)) return { ok: false, error: `"${raw}" must be a whole number` };
      if (dim === 'retireYear' && (raw < 2020 || raw > 2100)) {
        return { ok: false, error: `"${raw}" is not a plausible retirement year` };
      }
      if (dim === 'claimAge' && (raw < 62 || raw > 70)) {
        return { ok: false, error: 'Claiming age is 62 to 70' };
      }
      if (dim === 'moveOffsetYears' && (raw < 0 || raw > 40)) {
        return { ok: false, error: 'Years from retiring to moving is 0 to 40' };
      }
      push(raw);
    }
  }

  if (levels.length > MAX_LEVELS) {
    return {
      ok: false,
      error: `${levels.length} levels — the cap is ${MAX_LEVELS}, because past that there are too few observations per level for its effect to mean anything`,
    };
  }
  return { ok: true, levels };
}

// ---------------------------------------------------------------------------
// The draft the editor holds, and the axes it compiles to
// ---------------------------------------------------------------------------

export interface AxisDraft {
  dim: SearchDim;
  enabled: boolean;
  /** Free text, for the numeric dimensions. */
  text: string;
  /** Selected option keys, for the choice dimensions. */
  chosen: string[];
}

/** The retirement year the plan as it stands is written for, if it has one. */
export function planRetireYear(plan: Scenario): number | undefined {
  const years = plan.events
    .filter((e): e is Extract<ScenarioEvent, { type: 'retire' }> => e.type === 'retire')
    .map((e) => parseYearMonth(e.date).year)
    .filter((y) => Number.isFinite(y));
  return years.length === 0 ? undefined : Math.min(...years);
}

/**
 * Seeded from the plan, never from thin air: the retirement-year row opens on
 * the years either side of the plan's own, and the house row on the price it
 * already carries. A default that ignores the plan is a default the user has
 * to retype before he can use it.
 */
export function defaultAxisDrafts(plan: Scenario): AxisDraft[] {
  const retire = planRetireYear(plan);
  // Never seed a year that has already been lived: a plan cannot retire in the
  // past, and a level the search cannot honour is a level that wastes budget
  // and confuses the report.
  const thisYear = new Date().getFullYear();
  const years =
    retire === undefined
      ? [thisYear + 3, thisYear + 5, thisYear + 7].join(', ')
      : [retire - 2, retire, retire + 2].filter((y) => y >= thisYear).join(', ');
  const price = plan.housing?.purchasePrice;
  const houseText =
    typeof price === 'number'
      ? `${Math.round(price / 1000)}k, ${Math.round((price * 1.2) / 1000)}k, proceeds`
      : '800k, 1m, proceeds, none';

  return DIM_SPECS.map((spec) => {
    const base: AxisDraft = { dim: spec.dim, enabled: false, text: '', chosen: [] };
    switch (spec.dim) {
      case 'retireYear':
        return { ...base, enabled: true, text: years };
      case 'stockShare':
        return { ...base, enabled: true, text: '50, 60, 70, 80' };
      case 'glideShape':
        return { ...base, enabled: true, chosen: ['step_now', 'step_at_retirement', 'glide_to_target'] };
      case 'autoSepp':
        return { ...base, enabled: true, chosen: ['on', 'off'] };
      case 'claimAge':
        return { ...base, text: '62, 67, 70' };
      case 'rothConversion':
        return { ...base, text: 'none, 12, 22, 24' };
      case 'housePrice':
        return { ...base, text: houseText };
      case 'financing':
        return { ...base, chosen: ['cash', 'mortgage'] };
      case 'moveOffsetYears':
        return { ...base, text: '0, 1, 2' };
      case 'state':
        return { ...base, chosen: ['va', 'sc'] };
      case 'spendingPolicy':
        return { ...base, chosen: ['fixed_real', 'guardrails'] };
      case 'givingRule':
        return { ...base, chosen: ['continue', 'growth_10'] };
      default:
        return base;
    }
  });
}

/**
 * Read back a stored space, defensively.
 *
 * The stored draft is keyed by dimension, and dimensions can be added or
 * removed between versions — so the defaults are the shape and the stored
 * values only fill it in. A stored row for a dimension that no longer exists is
 * dropped rather than crashing the page it is meant to restore.
 */
export function mergeStoredDrafts(raw: string | null, defaults: AxisDraft[]): AxisDraft[] {
  if (raw === null) return defaults;
  let stored: unknown;
  try {
    stored = JSON.parse(raw);
  } catch {
    return defaults;
  }
  if (!Array.isArray(stored)) return defaults;
  return defaults.map((fallback) => {
    const found = stored.find(
      (s): s is AxisDraft =>
        typeof s === 'object' && s !== null && (s as AxisDraft).dim === fallback.dim,
    );
    if (!found) return fallback;
    return {
      dim: fallback.dim,
      enabled: typeof found.enabled === 'boolean' ? found.enabled : fallback.enabled,
      text: typeof found.text === 'string' ? found.text : fallback.text,
      chosen: Array.isArray(found.chosen)
        ? found.chosen.filter((k): k is string => typeof k === 'string')
        : fallback.chosen,
    };
  });
}

/**
 * Choice keys that once existed and were deliberately retired, with the label
 * each wore and the reason it went. mergeStoredDrafts cannot drop them (it has
 * no per-key knowledge) and compileSpace silently ignores unknown keys — and
 * silently is the problem: a stored space carrying one either resubmits a
 * request the server now rejects, or quietly searches something narrower than
 * the user picked, and neither ever says so.
 */
const RETIRED_CHOICES: Partial<
  Record<SearchDim, { levels: Record<string, string>; reason: string }>
> = {
  spendingPolicy: {
    levels: {
      pct_35: '3.5% of the portfolio',
      pct_40: '4.0% of the portfolio',
      pct_45: '4.5% of the portfolio',
    },
    reason:
      'a percent-of-portfolio rule sets spending by formula, so maximum sustainable ' +
      'spending has no answer for it',
  },
};

export interface SanitisedDrafts {
  drafts: AxisDraft[];
  /** One sentence per healed axis; empty when the stored space was already clean. */
  notes: string[];
  /** True when the caller should rewrite the stored copy. */
  changed: boolean;
}

/**
 * Heal a stored space that carries levels the catalog no longer offers.
 *
 * WHY: the space lives in localStorage, so a level the schema has since
 * rejected does not age out — it resubmits the same doomed request forever.
 * Dropping the dead keys here, and having the caller REWRITE the stored copy,
 * is what ends that loop: sanitising the healed output again reports nothing
 * to do, which is the property that keeps the note from recurring.
 *
 * An enabled axis healed below two levels is turned off whole: one level is
 * not a decision (it would force that setting onto every candidate), and zero
 * would sit as a permanent error on a row the user never touched.
 */
export function sanitiseDrafts(drafts: readonly AxisDraft[]): SanitisedDrafts {
  const notes: string[] = [];
  let changed = false;
  const healed = drafts.map((draft) => {
    const spec = DIM_SPECS.find((d) => d.dim === draft.dim);
    if (!spec || spec.kind !== 'choice') return draft;
    const options = choiceOptions(draft.dim);
    const kept = draft.chosen.filter((key) => options.some((o) => o.key === key));
    if (kept.length === draft.chosen.length) return draft;
    changed = true;
    const retired = RETIRED_CHOICES[draft.dim];
    const names = draft.chosen
      .filter((key) => !options.some((o) => o.key === key))
      .map((key) => retired?.levels[key] ?? `“${key}”`)
      .join(', ');
    const disable = draft.enabled && kept.length < 2;
    notes.push(
      `${spec.title}: dropped ${names}${retired ? ` — ${retired.reason}` : ''}.` +
        (disable ? ' The axis was turned off — fewer than two levels left.' : ''),
    );
    return { ...draft, chosen: kept, ...(disable ? { enabled: false } : {}) };
  });
  return { drafts: healed, notes, changed };
}

export interface CompiledSpace {
  axes: SearchAxis[];
  /** Per-dimension error text for the rows that could not compile. */
  errors: Partial<Record<SearchDim, string>>;
  /** Cartesian size of the enabled, valid axes. */
  combinations: number;
}

/** Turn the editor's draft into the axes the server validates. */
export function compileSpace(drafts: readonly AxisDraft[]): CompiledSpace {
  const axes: SearchAxis[] = [];
  const errors: Partial<Record<SearchDim, string>> = {};
  let combinations = 1;

  for (const draft of drafts) {
    if (!draft.enabled) continue;
    const spec = dimSpec(draft.dim);
    let levels: unknown[];
    if (spec.kind === 'choice') {
      const options = choiceOptions(draft.dim);
      levels = draft.chosen
        .map((key) => options.find((o) => o.key === key))
        .filter((o): o is ChoiceOption => o !== undefined)
        .map((o) => o.value);
      if (levels.length === 0) {
        errors[draft.dim] = 'Tick at least one level, or turn the dimension off';
        continue;
      }
    } else {
      const parsed = parseLevels(draft.dim, draft.text);
      if (!parsed.ok) {
        errors[draft.dim] = parsed.error;
        continue;
      }
      levels = parsed.levels;
    }
    combinations *= levels.length;
    axes.push({ dim: draft.dim, levels } as SearchAxis);
  }

  return { axes, errors, combinations: axes.length === 0 ? 0 : combinations };
}

/** What the levels of one drafted axis read as, for the chips under the field. */
export function draftLevelLabels(draft: AxisDraft): string[] {
  const spec = dimSpec(draft.dim);
  if (spec.kind === 'choice') {
    const options = choiceOptions(draft.dim);
    return draft.chosen
      .map((key) => options.find((o) => o.key === key)?.label)
      .filter((l): l is string => l !== undefined);
  }
  const parsed = parseLevels(draft.dim, draft.text);
  return parsed.ok ? parsed.levels.map((v) => levelLabel(draft.dim, v)) : [];
}

/** One level value, in English. Mirrors the server's own labelling. */
export function levelLabel(dim: SearchDim, value: unknown): string {
  const spec = dimSpec(dim);
  const keyword = spec.keywords?.find((k) => k.value === value);
  if (keyword) return keyword.label;
  const option = choiceOptions(dim).find((o) => JSON.stringify(o.value) === JSON.stringify(value));
  if (option) return option.label;
  switch (dim) {
    case 'retireYear':
      return `retire ${String(value)}`;
    case 'claimAge':
      return `claim at ${String(value)}`;
    case 'stockShare':
      return typeof value === 'number' ? `${Math.round(value * 100)}/${Math.round(100 - value * 100)}` : String(value);
    case 'rothConversion':
      return typeof value === 'number' ? `convert to ${Math.round(value * 100)}%` : String(value);
    case 'housePrice':
      return typeof value === 'number' ? formatUSD(value) : String(value);
    case 'moveOffsetYears':
      return value === 0 ? 'move at retirement' : `move ${String(value)}y after retiring`;
    default:
      return typeof value === 'object' ? JSON.stringify(value) : String(value);
  }
}

// ---------------------------------------------------------------------------
// Budget presets
// ---------------------------------------------------------------------------

export type BudgetPreset = 'quick' | 'standard' | 'thorough';

export interface PresetSpec {
  id: BudgetPreset;
  label: string;
  /** What it costs and what it buys, in one line. */
  note: string;
  budget: Partial<SearchBudget>;
}

/**
 * Three points on the precision/time curve. The middle one is the server's own
 * default and is what every measured figure in the report's design assumes; the
 * quick one is explicitly a screening tool, and the report says so through its
 * own widened intervals rather than through anything hard-coded here.
 */
export const BUDGET_PRESETS: readonly PresetSpec[] = [
  {
    id: 'quick',
    label: 'Quick look',
    note: 'Minutes. Fewer seeds, so the intervals come back wide — good for "is this dimension worth searching at all?"',
    budget: {
      candidates: 128,
      finalists: 4,
      screenPaths: 1000,
      racePaths: 2000,
      reportPaths: 2000,
      selectionSeedCount: 8,
      reportSeedCount: 8,
      attribution: true,
      polish: false,
      widowProbe: false,
    },
  },
  {
    id: 'standard',
    label: 'Standard',
    note: 'Around 20-25 minutes on this machine. 20 report seeds resolves every effect worth acting on.',
    budget: {
      candidates: 512,
      finalists: 6,
      screenPaths: 1000,
      racePaths: 4000,
      reportPaths: 4000,
      selectionSeedCount: 16,
      reportSeedCount: 20,
      attribution: true,
      polish: true,
      widowProbe: true,
    },
  },
  {
    id: 'thorough',
    label: 'Thorough',
    note: 'An hour or more. Twice the candidates and 32 report seeds — for the decision you are actually about to make.',
    budget: {
      candidates: 1024,
      finalists: 8,
      screenPaths: 1000,
      racePaths: 4000,
      reportPaths: 6000,
      selectionSeedCount: 24,
      reportSeedCount: 32,
      polishSeedCount: 12,
      attribution: true,
      polish: true,
      widowProbe: true,
    },
  },
];

export function presetSpec(id: BudgetPreset): PresetSpec {
  const found = BUDGET_PRESETS.find((p) => p.id === id);
  if (!found) throw new Error(`Unknown budget preset "${id}"`);
  return found;
}

/**
 * Enumerate when the whole space fits inside the candidate budget: sampling a
 * space smaller than the sample is strictly worse than looking at all of it.
 */
export function shouldEnumerate(combinations: number, candidates: number): boolean {
  return combinations > 0 && combinations <= candidates;
}

/*
 * The two sentences below are in the USER's own language, because they read the
 * originals and understood neither — the old copy was quoted back verbatim as proof.
 * They live here rather than in the component so the copy is pinned by tests —
 * these are exactly the strings that regress into jargon.
 */

/**
 * Shown when the metric is switched to probability of success. Says what the
 * measurement actually did — twenty structurally different plans, one score —
 * and what the default does with the success target instead.
 */
export const SUCCESS_METRIC_WARNING =
  'This plan is funded well enough that success probability cannot tell decisions apart: in ' +
  'testing, twenty structurally different plans all scored ~100.00%, so ranking on probability ' +
  'ranks market luck. The default objective ranks on dollars of sustainable spending instead, ' +
  'and uses the success target as a pass/fail gate.';

/** The line under the combination count: what will actually be simulated. */
export function spaceSizeNote(combinations: number, candidates: number, enumerate: boolean): string {
  const n = combinations.toLocaleString('en-US');
  if (enumerate) {
    return `Small enough to search exhaustively: every one of the ${n} plans will be tried.`;
  }
  return (
    `These axes make ${n} combinations, more than the budget affords, so ` +
    `${candidates.toLocaleString('en-US')} of them will be sampled — and regardless of ` +
    'sampling, your plan as it stands and every variant that changes exactly one decision ' +
    'are always simulated, which is what lets the report price each decision on its own.'
  );
}

// ---------------------------------------------------------------------------
// Reading the report
// ---------------------------------------------------------------------------

/** The unit the objective is measured in — dollars a year, or a success rate. */
export function objectiveUnit(objective: SearchObjective): 'usd' | 'pct' {
  return objective.metric === 'sustainable_spend' ? 'usd' : 'pct';
}

export function objectiveTitle(objective: SearchObjective): string {
  return objective.metric === 'sustainable_spend'
    ? 'Sustainable spending'
    : 'Probability of success';
}

/** A level of the objective (not a difference), formatted in its own units. */
export function formatObjective(objective: SearchObjective, value: number): string {
  return objectiveUnit(objective) === 'usd' ? `${formatUSD(value)}/yr` : formatPct(value);
}

/** A DIFFERENCE, always signed: "+$2,400/yr", "-0.8 pts". */
export function formatDelta(objective: SearchObjective, value: number): string {
  const sign = value > 0 ? '+' : value < 0 ? '-' : '';
  const magnitude = Math.abs(value);
  return objectiveUnit(objective) === 'usd'
    ? `${sign}${formatUSD(magnitude)}/yr`
    : `${sign}${(magnitude * 100).toFixed(2)} pts`;
}

/**
 * A confidence interval, formatted as an interval and never as "± something"
 * when it is not symmetric about the estimate.
 */
export function formatInterval(objective: SearchObjective, ci: readonly [number, number]): string {
  return `${formatDelta(objective, ci[0])} to ${formatDelta(objective, ci[1])}`;
}

/**
 * The spread of a measured level across seeds. Returns null at n < 2, which is
 * the point: one observation licenses no interval, and "± 0" would claim
 * infinite precision on the least precise number in the report.
 */
export function formatSpread(objective: SearchObjective, stat: SeedStat | undefined): string | null {
  if (!stat || stat.n < 2) return null;
  const half = (stat.ci95[1] - stat.ci95[0]) / 2;
  return objectiveUnit(objective) === 'usd'
    ? `±${formatUSD(half)} (${stat.n} seeds)`
    : `±${(half * 100).toFixed(2)} pts (${stat.n} seeds)`;
}

/**
 * The four verdicts, in the user's words. `equivalent` and `inconclusive` are
 * never allowed to render the same: one is a finding, the other is a confession.
 */
export function verdictWord(verdict: DeltaVerdict): string {
  switch (verdict) {
    case 'better':
      return 'better';
    case 'worse':
      return 'worse';
    case 'equivalent':
      return 'same plan';
    case 'inconclusive':
      return 'not resolved';
  }
}

/**
 * Colour class for a verdict chip. `equivalent` and `inconclusive` deliberately
 * differ: a settled tie is neutral, an unresolved one is a caution.
 */
export function verdictTone(verdict: DeltaVerdict): string {
  switch (verdict) {
    case 'better':
      return 'good';
    case 'worse':
      return 'bad';
    case 'equivalent':
      return '';
    case 'inconclusive':
      return 'warn';
  }
}

/** One line under a chip, from the delta's own ready-written note. */
export function deltaSummary(objective: SearchObjective, delta: PairedDelta): string {
  const parts = [
    formatDelta(objective, delta.mean),
    `95% CI ${formatInterval(objective, delta.ci95)}`,
    `beat the baseline on ${delta.winsOn} of ${delta.n} seeds`,
  ];
  if (delta.approximate) parts.push('slope-converted — rankable, not quotable');
  return parts.join(' · ');
}

/** True when this row's number came from screening rather than the report stage. */
export function isScreeningOnly(finalist: SearchFinalist): boolean {
  return finalist.sustainableSpend === undefined && finalist.probeSuccess === undefined;
}

/** The finalist's objective value as a SeedStat, whichever metric is in play. */
export function objectiveStat(
  objective: SearchObjective,
  finalist: SearchFinalist,
): SeedStat | undefined {
  return objective.metric === 'sustainable_spend'
    ? finalist.sustainableSpend
    : finalist.successAtPlanSpend ?? finalist.probeSuccess;
}

/**
 * Attribution rows, split into the three statements they are entitled to make.
 * They are DIFFERENT statements and the UI must not run them together:
 *
 *  - moved      — the decision is worth something (either sign).
 *  - noEffect   — measured, and the difference is inside the practical floor.
 *  - unresolved — measured, and we cannot tell. Not the same as no effect.
 *  - inert      — the knob could not act at all under the winner's other
 *                 settings. The question does not arise; nothing was measured.
 */
export interface AttributionSplit {
  moved: SearchReport['attribution'];
  noEffect: SearchReport['attribution'];
  unresolved: SearchReport['attribution'];
  inert: SearchReport['attribution'];
}

export function splitAttribution(rows: SearchReport['attribution']): AttributionSplit {
  const split: AttributionSplit = { moved: [], noEffect: [], unresolved: [], inert: [] };
  for (const row of rows) {
    if (row.inert) {
      split.inert.push(row);
      continue;
    }
    const primary = row.onOwn ?? row.insideWinner;
    if (!primary) {
      split.unresolved.push(row);
      continue;
    }
    if (primary.verdict === 'better' || primary.verdict === 'worse') split.moved.push(row);
    else if (primary.verdict === 'equivalent') split.noEffect.push(row);
    else split.unresolved.push(row);
  }
  // Biggest mover first: the user reads this section top-down and stops.
  split.moved.sort(
    (a, b) =>
      Math.abs((b.onOwn ?? b.insideWinner)?.mean ?? 0) -
      Math.abs((a.onOwn ?? a.insideWinner)?.mean ?? 0),
  );
  return split;
}

/** Dimension title for a report row, falling back to the server's own label. */
export function attributionTitle(dim: SearchDim, fallback: string): string {
  const found = DIM_SPECS.find((d) => d.dim === dim);
  return found ? found.title : fallback;
}

// ---------------------------------------------------------------------------
// Keeping a finalist
// ---------------------------------------------------------------------------

/*
 * A finalist worth remembering goes into the PLAN'S HISTORY (api.keepPlan),
 * which holds plans and nothing else — so what travels with it is a name, and
 * not the search's own numbers.
 *
 * That is deliberate. A search's `success` is a mean over a LIST of seeds at
 * the search's own path count, and a recorded score carries ONE seed because
 * that is what makes two scores comparable. Squeezing the mean into the single
 * `seed` field would put a number in the History column that was not measured
 * the way its neighbours were, and nothing downstream could tell. A kept
 * version can be scored from the History tab in one press, under exactly the
 * conditions every other score there was taken under.
 */

/** A name for a saved finalist that says where it came from. */
export function finalistSaveName(report: SearchReport, finalist: SearchFinalist): string {
  const label = finalist.label.length > 80 ? `${finalist.label.slice(0, 77)}…` : finalist.label;
  const prefix = report.label ? `${report.label}: ` : '';
  const name = `${prefix}${label}`;
  return name.length > 120 ? name.slice(0, 120) : name;
}

export function ordinal(n: number): string {
  const rem100 = n % 100;
  if (rem100 >= 11 && rem100 <= 13) return `${n}th`;
  switch (n % 10) {
    case 1:
      return `${n}st`;
    case 2:
      return `${n}nd`;
    case 3:
      return `${n}rd`;
    default:
      return `${n}th`;
  }
}

// ---------------------------------------------------------------------------
// Progress
// ---------------------------------------------------------------------------

/** "4m 12s", "1h 05m". Absent input reads as an em dash, never as "0s". */
export function formatDuration(ms: number | undefined): string {
  if (ms === undefined || !Number.isFinite(ms) || ms < 0) return '—';
  const total = Math.round(ms / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) return `${h}h ${String(m).padStart(2, '0')}m`;
  if (m > 0) return `${m}m ${String(s).padStart(2, '0')}s`;
  return `${s}s`;
}

/** Fraction done, clamped, and never 1 until the stage list says it is. */
export function progressFraction(evaluated: number, total: number): number {
  if (total <= 0) return 0;
  return Math.max(0, Math.min(1, evaluated / total));
}

/**
 * The tie bracket, as a sentence. It INCLUDES the winner's own id, so a
 * bracket of one means "the winner stands alone" and anything more is the
 * actual result: several plans this model cannot tell apart.
 */
export function tieBracketNote(report: SearchReport): string {
  const n = report.tieBracket.length;
  if (n <= 1) {
    return 'No other finalist is statistically indistinguishable from this one.';
  }
  return (
    `${n} plans — this one and ${n - 1} other${n === 2 ? '' : 's'} — are indistinguishable at this ` +
    'precision. That is the result, not a failure of it: choose among them on grounds the model ' +
    'does not know about.'
  );
}
