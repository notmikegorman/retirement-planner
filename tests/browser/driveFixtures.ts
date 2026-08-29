/**
 * The dual-stack drive's starting world: one profile, one quotes file, built
 * from the repo's own public fixtures so the drive is reproducible from the
 * repo alone, forever — the same rule the parity fixtures follow. Both stacks
 * are seeded with these exact bytes (a temp dir for the node server, OPFS for
 * local mode), which is what entitles the gate to demand byte-equal folders
 * at the end.
 *
 * The profile is the bundled starter with two deliberate changes:
 *
 *   - the taxable brokerage goes HOLDINGS-MODE (200 VTI + cash), because a
 *     drive without a priced holding would never exercise the quote path —
 *     the refresh inside Run now, the refresh inside the snapshot flow, and
 *     the fatal missing-quote gate would all be vacuously green;
 *   - the path counts drop to drive scale (100 interactive / 400 final). The
 *     numbers still cross the interactive/final boundary the workbench's
 *     chips and the recorded scores care about, and the spend solve still
 *     bisects — a dozen runs — without the gate costing minutes per stack.
 *
 * The quotes file holds exactly what a refresh of the VTI fixture would
 * store, built THROUGH parseYahooChart rather than typed out, so the seeded
 * price and the refreshed price can never drift apart: the drive's refreshes
 * (fixture-fed on both stacks) rewrite the same values, and only fetchedAt —
 * masked — moves.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Profile, QuotesFile } from '../../src/shared/types';
import { parseYahooChart } from '../../src/store/quotes';

const repoRoot = fileURLToPath(new URL('../..', import.meta.url));

/** The raw Yahoo chart fixture, as text — also what the local fetcher serves. */
export const VTI_FIXTURE_TEXT = readFileSync(
  path.join(repoRoot, 'tests', 'fixtures', 'yahoo-chart-vti.json'),
  'utf8',
);

/** Drive-scale path counts; see the header. */
export const DRIVE_PATHS_INTERACTIVE = 100;
export const DRIVE_PATHS_FINAL = 400;

/** What the session types into the snapshot dialog. */
export const DRIVE_HOME_VALUE = 500_000;
export const DRIVE_NOTE = 'dual-stack drive';

/** What the session types into the living-expenses override. */
export const DRIVE_LIVING_OVERRIDE = 6_000;

export function driveProfile(): Profile {
  const profile = JSON.parse(
    readFileSync(path.join(repoRoot, 'data-defaults', 'profile.starter.json'), 'utf8'),
  ) as Profile;
  profile.settings.mcPathsInteractive = DRIVE_PATHS_INTERACTIVE;
  profile.settings.mcPathsFinal = DRIVE_PATHS_FINAL;
  const brokerage = profile.accounts.find((a) => a.id === 'brokerage');
  if (!brokerage) throw new Error('starter profile lost its brokerage account');
  brokerage.holdings = [{ symbol: 'VTI', quantity: 200, assetClass: 'stocks' }];
  brokerage.cash = 500;
  return profile;
}

export function driveQuotes(): QuotesFile {
  const fetched = parseYahooChart('VTI', JSON.parse(VTI_FIXTURE_TEXT));
  return {
    VTI: {
      price: fetched.price,
      currency: fetched.currency,
      asOf: fetched.asOf,
      source: 'yahoo',
      // Any fixed moment: the drive's refreshes overwrite it with the real
      // clock on both stacks, and the folder diff masks it.
      fetchedAt: '2026-08-28T12:00:00.000Z',
    },
  };
}

/** The seeded starting files, path → pretty bytes, identical on both stacks. */
export function driveSeedFiles(): Record<string, string> {
  return {
    'profile.json': `${JSON.stringify(driveProfile(), null, 2)}\n`,
    'quotes.json': `${JSON.stringify(driveQuotes(), null, 2)}\n`,
  };
}
