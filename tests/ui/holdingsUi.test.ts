/**
 * The holdings-mode editor's pure logic (profileLogic helpers) and its wiring
 * (source scan, the bondPreset convention — node environment, no DOM):
 *
 * - a typed ticker normalises or is refused, never stored dirty;
 * - every price label carries its condition — the ET moment and "— delayed";
 * - the derived preview prices the DRAFT through the SAME shared function the
 *   server resolves runs with, so the two can never disagree;
 * - manual balance and allocation editors DISAPPEAR in holdings mode rather
 *   than sitting beside the derived figures as a second author.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  formatDerivedMix,
  formatQuoteAsOf,
  normalizeSymbolInput,
} from '../../src/ui/components/profile/profileLogic';

const read = (rel: string): string =>
  readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');
const accountsCard = read('../../src/ui/components/profile/AccountsCard.tsx');

describe('normalizeSymbolInput', () => {
  it('uppercases and trims what a person actually types', () => {
    expect(normalizeSymbolInput('vti')).toBe('VTI');
    expect(normalizeSymbolInput('  bnd ')).toBe('BND');
    expect(normalizeSymbolInput('brk.b')).toBe('BRK.B');
    expect(normalizeSymbolInput('^gspc')).toBe('^GSPC');
    expect(normalizeSymbolInput('bf-b')).toBe('BF-B');
  });

  it('refuses what the schema would bounce, so Save never learns about it', () => {
    for (const raw of ['', '   ', 'TOO LONG SYM', 'ELEVENCHARS', 'VTI$', 'a b']) {
      expect(normalizeSymbolInput(raw), JSON.stringify(raw)).toBeNull();
    }
  });
});

describe('formatQuoteAsOf', () => {
  it("renders the exchange's own clock: 20:00Z on Aug 18 is 4:00 PM ET", () => {
    expect(formatQuoteAsOf('2026-08-18T20:00:00.000Z')).toBe('Aug 18, 4:00 PM ET');
  });

  it('winter dates respect EST, not a hardcoded offset', () => {
    // 21:00Z in January is 4:00 PM EST — a fixed -4 would say 5:00 PM.
    expect(formatQuoteAsOf('2026-01-15T21:00:00.000Z')).toBe('Jan 15, 4:00 PM ET');
  });

  it('passes junk through rather than rendering "Invalid Date"', () => {
    expect(formatQuoteAsOf('not-a-date')).toBe('not-a-date');
  });
});

describe('formatDerivedMix', () => {
  it('keeps one decimal — 55.69/44.31 must not flatten to 56/44', () => {
    expect(formatDerivedMix({ stocks: 0.5569, bonds: 0.4431, bills: 0 })).toBe(
      '55.7 / 44.3 / 0.0',
    );
  });
});

describe('the wiring (source scan)', () => {
  it('prices the draft through the shared resolver, not a private copy', () => {
    // deriveAccount is the same function dataStore.loadResolvedProfile prices
    // runs with; a second implementation here would preview one number and
    // simulate another.
    expect(accountsCard).toContain("from '../../../shared/holdings'");
    expect(accountsCard).toContain('deriveAccount(account, quotes)');
  });

  it('labels every price with its condition — the ET moment and "delayed"', () => {
    expect(accountsCard).toContain('formatQuoteAsOf(quote.asOf)');
    expect(accountsCard).toContain('— delayed');
  });

  it('hides the manual balance and allocation editors in holdings mode', () => {
    // Both render behind !isHoldings — a typed number beside a derived one
    // would be two answers to one question.
    expect(accountsCard).toMatch(/\{!isHoldings \? \(\s*<NumberField\s*label="Balance/);
    expect(accountsCard).toMatch(/\{!isHoldings \? \(\s*<div style=\{\{ marginTop: 4 \}\}>\s*<AllocationEditor/);
  });

  it('has a Refresh prices button that calls the refresh route', () => {
    expect(accountsCard).toContain('Refresh prices');
    expect(accountsCard).toContain('api.refreshQuotes');
    // And the initial quotes come from the stored file, never a fetch of its own.
    expect(accountsCard).toContain('api.getQuotes()');
  });
});
