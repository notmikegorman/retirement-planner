/** Small shared helpers used across engine, server, and UI. */

/** Parse "YYYY-MM" -> { year, month }. Throws on malformed input. */
export function parseYearMonth(ym: string): { year: number; month: number } {
  const m = /^(\d{4})-(\d{2})$/.exec(ym);
  if (!m) throw new Error(`Invalid YearMonth "${ym}" (expected "YYYY-MM")`);
  const year = Number(m[1]);
  const month = Number(m[2]);
  if (month < 1 || month > 12) throw new Error(`Invalid month in "${ym}"`);
  return { year, month };
}

/**
 * Deterministic JSON stringify (sorted object keys, arrays in order) so content
 * hashes are stable across runs and platforms.
 */
export function stableStringify(value: unknown): string {
  return JSON.stringify(sortValue(value));
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortValue);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      out[key] = sortValue((value as Record<string, unknown>)[key]);
    }
    return out;
  }
  return value;
}

export function formatUSD(value: number, opts?: { cents?: boolean }): string {
  return value.toLocaleString('en-US', {
    style: 'currency',
    currency: 'USD',
    maximumFractionDigits: opts?.cents ? 2 : 0,
    minimumFractionDigits: opts?.cents ? 2 : 0,
  });
}

export function formatPct(value: number, digits = 1): string {
  return `${(value * 100).toFixed(digits)}%`;
}

export function clamp(x: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, x));
}
