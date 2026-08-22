/**
 * Turn a budgeting-app CSV export into the profile's itemised expense lines.
 * Written against a YNAB-shaped export (Category / Activity columns); any
 * export with those two columns works, and the parser says so when it does not.
 *
 * WHY A SCRIPT AND NOT A ONE-OFF PASTE. The budget is re-exported every time
 * the user wants to re-baseline, and the interesting part — which category feeds
 * which modeled stream, and what each line does in retirement and for a
 * survivor — is a set of DECISIONS that must survive re-import. Hand-transcribing
 * loses them silently. Here they live in CATEGORY_RULES, in one legible table,
 * and re-running preserves anything already edited in the app.
 *
 * Usage:
 *   npx tsx scripts/transcribe-budget.ts <budget.csv> [--month "Jul 2026"] [--write]
 *
 * Without --write it prints the lines and the reconciliation and touches nothing.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ExpenseLine, ExpenseLineCategory } from '../src/shared/types';

// ---------------------------------------------------------------------------
// CSV
// ---------------------------------------------------------------------------

/**
 * A real CSV parse rather than a split on commas: YNAB category names contain
 * commas ("Rent/Mortgage, HOA") and its money columns are quoted with thousands
 * separators, so the naive version silently shifts every column after the first
 * offending row — producing a budget that looks plausible and is wrong.
 */
function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          cell += '"';
          i++;
        } else quoted = false;
      } else cell += c;
      continue;
    }
    if (c === '"') quoted = true;
    else if (c === ',') {
      row.push(cell);
      cell = '';
    } else if (c === '\n') {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
    } else if (c !== '\r') cell += c;
  }
  if (cell.length > 0 || row.length > 0) {
    row.push(cell);
    rows.push(row);
  }
  return rows;
}

/** "$1,234.56" / "($45.00)" / "" -> a number. Parens are YNAB's negative. */
function money(raw: string): number {
  const t = (raw ?? '').trim();
  if (t === '') return 0;
  const negative = t.startsWith('(') && t.endsWith(')');
  const n = Number(t.replace(/[()$,\s]/g, ''));
  if (!Number.isFinite(n)) return 0;
  return negative ? -n : n;
}

// ---------------------------------------------------------------------------
// The decisions
// ---------------------------------------------------------------------------

interface Rule {
  /** Matched case-insensitively against "Group: Category". */
  match: RegExp;
  category: ExpenseLineCategory;
  /** $/mo once nobody works. Absent = unchanged, which is the honest default. */
  retired?: number | 'zero' | 'same';
  /**
   * $/mo while between homes (sold, renting, purchase pending) — the
   * `monthlyRenting` column. Absent = unchanged, and EVERY rule leaves it
   * absent on purpose: only the user knows which of their lines are
   * dwelling-sensitive (a heating line and a monitored-alarm line go to zero
   * while renting; electricity roughly halves), and this table inventing
   * per-category guesses beyond what they said would put numbers nobody chose
   * into a column they edit themselves. The field exists so a rule CAN carry
   * one the day it is stated.
   */
  renting?: number | 'zero' | 'same';
  /** $/mo for the survivor. Absent = unchanged. */
  survivor?: number | 'same' | 'half' | number;
  why?: string;
}

/**
 * WHAT THE MODEL "KNOWS", written down where it can be argued with.
 *
 * Every one of these is only a DEFAULT for a cell the user can see and edit in
 * the Expenses tab. That is the whole design: the alternative — an engine that
 * silently zeroes investing at retirement and multiplies everything else by
 * 0.75 — is how $820/mo of housing ended up double-charged for thirty years
 * without anyone being able to see it.
 *
 * Order matters: first match wins, so put the specific before the general.
 */
const CATEGORY_RULES: Rule[] = [
  // --- Specific before general ------------------------------------------
  {
    match: /^auto:/i,
    category: 'living',
    why: 'Running a car is ordinary consumption; the housing plan models the house, not the car.',
  },
  {
    match: /auto insurance|motor club|roadside/i,
    category: 'living',
    why: 'A car policy and a membership fee — neither is life cover nor housing.',
  },

  // --- Not consumption at all -------------------------------------------
  {
    match: /credit card|card payment|payment: /i,
    category: 'excluded',
    why: 'When spending runs through a card, the card payment is a transfer of money already counted as its underlying categories — not a second expense.',
  },
  {
    match: /brokerage|invest(ing|ment)?\b/i,
    category: 'investing',
    retired: 'zero',
    why: 'Investing out of a paycheck ends with the paycheck.',
  },

  // --- Streams the engine models from its own inputs --------------------
  {
    match: /mortgage|rent\b|property tax|home:? ?(investment|insurance|maintenance|repair)|hoa\b|home ?owner.*insurance/i,
    category: 'modeled_elsewhere',
    why: 'The housing plan already charges these from the purchase price and the profile — summing them here is the double-count.',
  },
  {
    match: /health ?insurance|medical premium|dental premium|medicare/i,
    category: 'modeled_elsewhere',
    why: 'Premiums come from the health profile (ACA benchmark, IRMAA), not from the budget.',
  },

  // --- Its own tab -------------------------------------------------------
  {
    match: /life insurance|term life/i,
    category: 'insurance',
    why: 'The Insurance tab is authoritative for premium and term; this row is here so the budget reconciles.',
  },
  {
    match: /tithe|charitable|church|giving|missions/i,
    category: 'charitable',
    why: 'Retirement giving is a rule on the Tithing tab, not a flat number.',
  },

  // --- Ends with the job -------------------------------------------------
  {
    match: /parking|commut|dry clean|work lunch|professional dues/i,
    category: 'living',
    retired: 'zero',
    why: 'A cost of going to work.',
  },

  // --- Genuinely per-person: one of two people stops needing it ---------
  {
    match: /clothing|personal care|haircut|hobby|phone|subscription.*personal/i,
    category: 'living',
    survivor: 'half',
    why: 'Buys for two today; one afterwards.',
  },
  {
    match: /grocer|food|dining|restaurant/i,
    category: 'living',
    survivor: 0.6,
    why: 'Feeding one costs more than half of feeding two.',
  },
];

/**
 * The default when nothing matches: an ordinary living cost that does not
 * notice either the salary stopping or a death.
 *
 * UNCHANGED IS THE CONSERVATIVE DIRECTION for both columns — it spends more of
 * the household's money and so reports a LOWER probability of success. A
 * default that guessed costs downward would flatter every plan it touched.
 */
const FALLBACK: Rule = { match: /.*/, category: 'living' };

function ruleFor(name: string): Rule {
  return CATEGORY_RULES.find((r) => r.match.test(name)) ?? FALLBACK;
}

/** Stable across re-imports, so an edit in the app survives the next export. */
function idFor(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 60);
}

// ---------------------------------------------------------------------------
// Transcription
// ---------------------------------------------------------------------------

interface Row {
  month: string;
  group: string;
  category: string;
  assigned: number;
}

function readRows(csv: string): Row[] {
  const table = parseCsv(csv).filter((r) => r.some((c) => c.trim() !== ''));
  if (table.length === 0) throw new Error('empty CSV');
  const header = table[0].map((h) => h.trim().toLowerCase());
  const col = (...names: string[]): number => {
    for (const n of names) {
      const i = header.findIndex((h) => h === n);
      if (i >= 0) return i;
    }
    for (const n of names) {
      const i = header.findIndex((h) => h.includes(n));
      if (i >= 0) return i;
    }
    return -1;
  };
  const iMonth = col('month');
  const iGroup = col('category group', 'group');
  const iCat = col('category');
  const iAssigned = col('assigned', 'budgeted');
  if (iAssigned < 0) {
    throw new Error(`no "Assigned" column; header was: ${header.join(' | ')}`);
  }
  return table.slice(1).map((r) => ({
    month: (iMonth >= 0 ? r[iMonth] : '').trim(),
    group: (iGroup >= 0 ? r[iGroup] : '').trim(),
    category: (iCat >= 0 ? r[iCat] : '').trim(),
    assigned: money(r[iAssigned]),
  }));
}

function toLines(rows: Row[]): ExpenseLine[] {
  const out: ExpenseLine[] = [];
  for (const r of rows) {
    // A zero assignment is a category the user deliberately funded at nothing
    // this month. Carrying it in as a $0 row is noise in a table he has to read.
    if (r.assigned === 0) continue;
    const label = r.group && r.category ? `${r.group}: ${r.category}` : r.category || r.group;
    if (!label) continue;
    const rule = ruleFor(label);
    const now = Math.round(r.assigned);

    const retired =
      rule.retired === 'zero' ? 0 : typeof rule.retired === 'number' ? rule.retired : undefined;
    // No rule sets this today (see Rule.renting for why); the plumbing exists
    // so a stated default survives re-import the day the user writes one.
    const rentingValue =
      rule.renting === 'zero' ? 0 : typeof rule.renting === 'number' ? rule.renting : undefined;
    const survivor =
      rule.survivor === 'half'
        ? Math.round(now / 2)
        : typeof rule.survivor === 'number' && rule.survivor < 1
          ? Math.round(now * rule.survivor)
          : typeof rule.survivor === 'number'
            ? rule.survivor
            : undefined;

    out.push({
      id: idFor(label),
      label,
      category: rule.category,
      monthlyNow: now,
      ...(retired !== undefined ? { monthlyRetired: retired } : {}),
      ...(rentingValue !== undefined ? { monthlyRenting: rentingValue } : {}),
      ...(survivor !== undefined ? { monthlySurvivor: survivor } : {}),
      ...(rule.why ? { note: rule.why } : {}),
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

const argv = process.argv.slice(2);
const file = argv.find((a) => !a.startsWith('--'));
const monthArg = argv.includes('--month') ? argv[argv.indexOf('--month') + 1] : undefined;
const write = argv.includes('--write');
if (!file) {
  console.error('usage: npx tsx scripts/transcribe-budget.ts <budget.csv> [--month "Jul 2026"] [--write]');
  process.exit(2);
}

const all = readRows(readFileSync(file, 'utf8'));
const months = [...new Set(all.map((r) => r.month).filter(Boolean))];
const month = monthArg ?? months[months.length - 1];
const rows = months.length > 0 ? all.filter((r) => r.month === month) : all;
if (rows.length === 0) {
  console.error(`no rows for month "${month}". Months present: ${months.join(', ')}`);
  process.exit(1);
}

const lines = toLines(rows);
const sum = (f: (l: ExpenseLine) => number): number => lines.reduce((n, l) => n + f(l), 0);
const inCat = (c: ExpenseLineCategory): ExpenseLine[] => lines.filter((l) => l.category === c);
const total = (ls: ExpenseLine[]): number => ls.reduce((n, l) => n + l.monthlyNow, 0);

console.log(`\nMONTH: ${month}   (${months.length} months in file)\n`);
console.log(
  'LINE'.padEnd(46),
  'CATEGORY'.padEnd(18),
  'NOW'.padStart(9),
  'RENTING'.padStart(9),
  'RETIRED'.padStart(9),
  'SURVIVOR'.padStart(9),
);
console.log('-'.repeat(105));
for (const l of lines) {
  const rent = l.monthlyRenting === undefined ? '=' : String(l.monthlyRenting);
  const r = l.monthlyRetired === undefined ? '=' : String(l.monthlyRetired);
  const s = l.monthlySurvivor === undefined ? '=' : String(l.monthlySurvivor);
  console.log(
    l.label.slice(0, 45).padEnd(46),
    l.category.padEnd(18),
    String(l.monthlyNow).padStart(9),
    rent.padStart(9),
    r.padStart(9),
    s.padStart(9),
  );
}
console.log('-'.repeat(105));
for (const c of ['living', 'charitable', 'investing', 'insurance', 'modeled_elsewhere', 'excluded'] as const) {
  const ls = inCat(c);
  if (ls.length === 0) continue;
  const summed = c === 'living' || c === 'charitable' || c === 'investing';
  console.log(
    `${c.padEnd(20)} ${String(ls.length).padStart(3)} lines  $${String(total(ls)).padStart(8)}/mo` +
      (summed ? '  -> modeled' : '  (not summed)'),
  );
}
console.log(`\nEverything assigned this month: $${sum((l) => l.monthlyNow)}/mo`);
console.log('("=" means inherited: whatever figure is otherwise in force for that state.)\n');

if (write) {
  const dir = process.env.FPLAN_DATA_DIR || path.join(os.homedir(), 'finance-planner-data');
  const p = path.join(dir, 'profile.json');
  const profile = JSON.parse(readFileSync(p, 'utf8')) as {
    expenses: { lines?: ExpenseLine[] };
  };
  // PRESERVE EDITS. A re-import must not silently discard the columns the user
  // has been tuning in the app — that is the whole reason ids are stable.
  const existing = new Map((profile.expenses.lines ?? []).map((l) => [l.id, l]));
  /*
   * ONLY THE SUMMED CATEGORIES ARE WRITTEN. The insurance / modeled_elsewhere /
   * excluded rows exist for the on-screen reconciliation above; the user
   * deleted them from the profile the first time they appeared, and a re-import
   * that resurrected every row he removed would make deleting anything
   * pointless. The reconciliation still prints them — they are just not data.
   */
  const written = lines.filter(
    (l) => l.category === 'living' || l.category === 'charitable' || l.category === 'investing',
  );
  profile.expenses.lines = written.map((l) => {
    const prior = existing.get(l.id);
    return prior ? { ...l, ...prior, monthlyNow: l.monthlyNow } : l;
  });
  writeFileSync(p, `${JSON.stringify(profile, null, 2)}\n`);
  console.log(`wrote ${profile.expenses.lines.length} lines to ${p}`);
  console.log('(existing rows kept their edited retired/survivor values; only "Now" was refreshed)');
}
