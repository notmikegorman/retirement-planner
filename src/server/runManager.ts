/**
 * Run manager: resolves a RunRequest into a full SimulationInput, dedupes and
 * caches by content hash (runs/<runKey>.json), and executes simulations in a
 * worker thread (simWorker.ts) while tracking progress in memory.
 *
 * runKey = sha256(stableStringify({ engineVersion, input })) — identical inputs
 * (profile + assumptions + scenario + mode + paths + seed) on the same engine
 * version always map to the same run, which is what makes the disk cache safe.
 */
import { Worker } from 'node:worker_threads';
import { sha256Hex } from '../shared/sha256';
import { ENGINE_VERSION } from '../shared/types';
import type {
  RunMode,
  RunProgress,
  RunRequest,
  RunResult,
  Scenario,
  SimulationInput,
} from '../shared/types';
import { scenarioSchema, parseOrThrow } from '../shared/schemas';
import { missingQuotesMessage } from '../shared/holdings';
import { stableStringify } from '../shared/util';
import { loadAssumptions, loadResolvedProfile, ValidationError } from './dataStore';
import { dataFiles } from './fileStore';
import type { SimWorkerMessage } from './simWorker';

/** In-memory progress per run, keyed by runId (= runKey). */
const runs = new Map<string, RunProgress>();

const RUN_MODES: readonly RunMode[] = ['deterministic', 'historical', 'montecarlo'];
const RUN_KEY_RE = /^[0-9a-f]{64}$/;

function runFilePath(runKey: string): string {
  return `runs/${runKey}.json`;
}

/**
 * The cache key for a resolved SimulationInput.
 *
 * Exported so the search executor derives its keys from THIS function rather
 * than a copy: the search's whole economy rests on a combination it has already
 * tested being free, and on the 113MB of runs the app has already cached being
 * usable. A second implementation that drifted by one field would silently miss
 * every one of them and nothing would look wrong.
 *
 * Note for callers building inputs programmatically: stableStringify sorts
 * object KEYS but preserves ARRAY order, and `events` is an array. Two
 * logically identical plans whose events were emitted in different orders hash
 * differently — so anything generating scenarios must emit events in a
 * canonical order (see search/compile.ts).
 */
export function runKeyFor(input: SimulationInput): string {
  return sha256Hex(stableStringify({ engineVersion: ENGINE_VERSION, input }));
}

/** A cached full RunResult, or null on a miss. */
export async function readCachedResult(runKey: string): Promise<RunResult | null> {
  try {
    const text = await dataFiles.readText(runFilePath(runKey));
    return JSON.parse(text) as RunResult;
  } catch {
    // Missing or unreadable/corrupt cache entry -> treat as a miss and recompute.
    return null;
  }
}

/**
 * A RunRequest resolved into the exact SimulationInput a run would execute.
 *
 * Shared by startRun and lookupCachedRun so those two can never disagree about
 * what "these inputs" means. A lookup that resolved the profile even slightly
 * differently would hash to a different runKey and miss every one of the ~477
 * runs already on disk — silently, and looking perfectly healthy: the page
 * would simply never find the 10,000-path answer it was asked to prefer.
 *
 * Nothing here is a side effect. It reads files, resolves prices and validates;
 * it starts no simulation, which is what makes it safe to call on page load.
 */
async function resolveRunInput(req: RunRequest): Promise<SimulationInput> {
  // The plan always arrives inline — the UI has it in hand and there is nothing
  // else to run. Nothing is loaded from disk here, so an unsaved knob turn and
  // a saved one produce identical runs.
  let scenario: Scenario;
  try {
    scenario = parseOrThrow(scenarioSchema, req.scenario, 'plan');
  } catch (err) {
    throw new ValidationError((err as Error).message);
  }

  if (!RUN_MODES.includes(req.mode)) {
    throw new ValidationError(
      `Invalid run mode "${String(req.mode)}" (expected ${RUN_MODES.join(' | ')})`,
    );
  }

  // The RESOLVED profile: holdings-mode balances/allocations derived from
  // stored quotes, so the derived figures are real input — they feed the
  // runKey below, which is exactly what makes a price refresh reprice instead
  // of hitting a stale cache entry. An unpriced symbol is FATAL here, not
  // lenient: a run quietly using the last-resolved cache would be a wrong
  // answer wearing a fresh timestamp. Runs never fetch; the error names the
  // fix (the Refresh button).
  const { profile, missing } = await loadResolvedProfile();
  if (missing.length > 0) throw new ValidationError(missingQuotesMessage(missing));
  const assumptions = await loadAssumptions();

  // Paths default: deterministic needs exactly 1; historical passes 0 so the
  // engine sets it from the number of rolling windows; MC uses the interactive
  // path count from settings.
  const paths =
    req.paths ??
    (req.mode === 'deterministic' ? 1 : req.mode === 'historical' ? 0 : profile.settings.mcPathsInteractive);
  const seed = req.seed ?? profile.settings.seed;

  return { profile, assumptions, scenario, mode: req.mode, paths, seed };
}

/**
 * THE RUN ALREADY ON FILE FOR THESE EXACT INPUTS, OR NULL — AND IT STARTS
 * NOTHING.
 *
 * This is what lets the Workbench show the 10,000-path number it already has
 * instead of recomputing a 1,000-path one that disagrees with it: a user ran
 * at final quality, refreshed the browser, and watched 94.2% revert to 93.1%
 * because nothing ever asked whether the better answer was still on disk.
 *
 * IT KEYS ON THE WHOLE INPUT, not on the plan. The plan alone is the wrong
 * question — the resolved profile's balances move with quote prices, so a run
 * reused across a price change would put a stale number on screen wearing the
 * current plan's name. runKeyFor covers profile, assumptions, scenario, mode,
 * paths, seed and the engine version, which is exactly "the same inputs
 * entirely", so a hit means the number is still precisely right.
 *
 * POST /api/run CANNOT DO THIS JOB, and that is the whole reason this exists.
 * startRun answers instantly on a cache hit too, but on a MISS it spawns the
 * simulation — so using it to ask the question would start a 10,000-path run on
 * every page load that had no cached answer. Looking is free; computing is not.
 *
 * Disk only, deliberately: a run still in flight has no result to show, and a
 * finished one reaches the file before it reaches the in-memory map (finishRun
 * awaits the write), so the file is the whole truth about what has been
 * computed.
 */
export async function lookupCachedRun(req: RunRequest): Promise<RunResult | null> {
  return readCachedResult(runKeyFor(await resolveRunInput(req)));
}

/**
 * Start (or reuse) a run for the given request. Returns immediately with the
 * runId to poll via getRun().
 */
export async function startRun(req: RunRequest): Promise<{ runId: string }> {
  const input = await resolveRunInput(req);
  const runKey = runKeyFor(input);
  const runId = runKey;

  // Same runKey already in flight (or already completed in memory): reuse it
  // rather than double-spawning identical work.
  const existing = runs.get(runId);
  if (existing) {
    if (existing.status === 'queued' || existing.status === 'running') return { runId };
    if (existing.status === 'done' && !req.fresh) return { runId };
  }

  // Disk cache hit -> done immediately.
  if (!req.fresh) {
    const cached = await readCachedResult(runKey);
    if (cached) {
      runs.set(runId, { runId, status: 'done', progress: 1, result: cached });
      return { runId };
    }
  }

  spawnWorker(runId, runKey, input);
  return { runId };
}

function spawnWorker(runId: string, runKey: string, input: SimulationInput): void {
  runs.set(runId, { runId, status: 'queued', progress: 0 });

  // This project runs under the tsx loader (npm start = tsx src/server/server.ts),
  // so the worker must also boot tsx to execute the .ts entry directly.
  const worker = new Worker(new URL('./simWorker.ts', import.meta.url), {
    workerData: input,
    execArgv: ['--import', 'tsx'],
  });

  let settled = false;

  worker.on('message', (msg: SimWorkerMessage) => {
    if (msg.type === 'progress') {
      const current = runs.get(runId);
      if (current && (current.status === 'queued' || current.status === 'running')) {
        runs.set(runId, {
          runId,
          status: 'running',
          progress: msg.frac,
          message: msg.message,
        });
      }
    } else if (msg.type === 'done') {
      settled = true;
      void finishRun(runId, runKey, msg.result);
    } else if (msg.type === 'error') {
      settled = true;
      runs.set(runId, {
        runId,
        status: 'error',
        progress: runs.get(runId)?.progress ?? 0,
        error: msg.error,
      });
    }
  });

  worker.on('error', (err) => {
    settled = true;
    runs.set(runId, {
      runId,
      status: 'error',
      progress: runs.get(runId)?.progress ?? 0,
      error: err.stack ?? err.message,
    });
  });

  worker.on('exit', (code) => {
    if (!settled && code !== 0) {
      runs.set(runId, {
        runId,
        status: 'error',
        progress: runs.get(runId)?.progress ?? 0,
        error: `Simulation worker exited unexpectedly with code ${code}`,
      });
    }
  });
}

async function finishRun(runId: string, runKey: string, result: RunResult): Promise<void> {
  // The engine is pure/deterministic and must not read the clock; the server
  // stamps wall-clock metadata here. runKey is normalized to the cache key.
  result.meta.createdAt = new Date().toISOString();
  result.meta.runKey = runKey;

  try {
    await dataFiles.mkdir('runs');
    await dataFiles.writeText(runFilePath(runKey), `${JSON.stringify(result, null, 2)}\n`);
  } catch (err) {
    // Cache write failure is not fatal — the result is still served from memory.
    console.error(`Failed to write run cache ${dataFiles.describe(runFilePath(runKey))}:`, err);
  }

  runs.set(runId, { runId, status: 'done', progress: 1, result });
}

/**
 * Current progress for a run, or null when unknown. Falls back to the disk
 * cache so completed runs survive server restarts.
 */
export async function getRun(runId: string): Promise<RunProgress | null> {
  const current = runs.get(runId);
  if (current) return current;

  // Only well-formed runKeys may touch the filesystem (no path traversal).
  if (RUN_KEY_RE.test(runId)) {
    const cached = await readCachedResult(runId);
    if (cached) {
      const done: RunProgress = { runId, status: 'done', progress: 1, result: cached };
      runs.set(runId, done);
      return done;
    }
  }
  return null;
}
