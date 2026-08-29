/**
 * The slim score cache: everything a search consumes from a simulation, and
 * nothing else.
 *
 * WHY NOT JUST USE THE RUN CACHE. runs/<runKey>.json holds a full RunResult —
 * the fan chart plus the complete deterministic reference path with tax traces
 * — and measures ~472KB. Measured on the user's folder: 245 files, 113MB. A
 * single search of ~3,800 evaluations would write about 1.8GB, and two searches
 * would put 3.7GB in the user's home directory. So the search persists ~1KB per
 * evaluation here instead, and the run cache keeps its full-fat entries for the
 * runs a human actually opens.
 *
 * The keys are IDENTICAL — the same sha256(engineVersion + input) runManager
 * uses — which is what lets the search read the run cache as a first-class
 * source. Every combination the user has already looked at in the workbench is
 * free to the search, and the 113MB already on disk is an asset rather than
 * dead weight.
 *
 * HONEST NOTE ON WHERE THE WIN IS: this saves disk, not CPU. Building the fan
 * (36 sorts) and the reference path (~2ms) is small next to 1.66s of path
 * simulation, so the engine still does the same work. Nothing here makes a
 * search faster except the cache hits.
 */
import path from 'node:path';
import type { RunResult } from '../../shared/types';
import { getDataDir } from '../dataStore';
import { dataFiles } from '../fileStore';

/** The metrics the search and its report consume. Roughly 200 bytes of JSON. */
export interface SearchScore {
  runKey: string;
  /** Fraction of paths never insolvent through the horizon (0..1). */
  success: number;
  medianTerminalReal: number;
  breakGlassReal: number | null;
  /** Lifetime charitable total, real dollars (cash given + terminal carve-out). */
  charitableTotalReal: number;
  horizonYears: number;
  /** Earliest year any worst-decile path first ran short; null if none did. */
  worstDecileFirstShortfallYear: number | null;
  elapsedMs: number;
}

const RUN_KEY_RE = /^[0-9a-f]{64}$/;

/**
 * ABSOLUTE path of the score-cache directory, kept because callers outside
 * the seam (tests, tooling) locate the cache with it. Store IO below speaks
 * data-dir-relative paths like everything else behind the seam.
 */
export function scoresDir(): string {
  return path.join(getDataDir(), 'searches', 'scores');
}

function scoreFilePath(runKey: string): string {
  if (!RUN_KEY_RE.test(runKey)) throw new Error(`Invalid run key "${runKey}"`);
  return `searches/scores/${runKey}.json`;
}

/** Reduce a full RunResult to the slim record. */
export function scoreFromResult(runKey: string, result: RunResult): SearchScore {
  const years = Object.keys(result.worstDecileShortfallYears ?? {})
    .map(Number)
    .filter((y) => Number.isFinite(y));
  return {
    runKey,
    success: result.success,
    medianTerminalReal: result.medianTerminalReal,
    breakGlassReal: result.breakGlassReal,
    charitableTotalReal: result.charitableLegacy?.totalReal ?? 0,
    horizonYears: result.horizonYears,
    worstDecileFirstShortfallYear: years.length > 0 ? Math.min(...years) : null,
    elapsedMs: result.elapsedMs,
  };
}

export async function readScore(runKey: string): Promise<SearchScore | null> {
  try {
    const text = await dataFiles.readText(scoreFilePath(runKey));
    return JSON.parse(text) as SearchScore;
  } catch {
    // Missing, unreadable or corrupt -> a miss. A cache that throws is worse
    // than one that misses.
    return null;
  }
}

export async function writeScore(score: SearchScore): Promise<void> {
  try {
    await dataFiles.mkdir('searches/scores');
    // Not pretty-printed: these are machine records by the thousand, and the
    // 2-space convention exists so the user can read their data folder, not so a
    // cache can triple in size.
    await dataFiles.writeText(scoreFilePath(score.runKey), JSON.stringify(score));
  } catch {
    // A cache write failure must never fail the search; the value is in memory.
  }
}
