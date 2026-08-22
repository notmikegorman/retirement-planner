/**
 * IS THE APP DOING ANYTHING RIGHT NOW? The check that stands between an update
 * and a permanently unmeasured record.
 *
 * WHY THIS FILE EXISTS AT ALL. Restarting this server is not free. Taking a
 * net-worth snapshot writes the row immediately and then starts a 10,000-path
 * scoring run in the background WITHOUT awaiting it; the run attaches a score,
 * and then a second, separate solve attaches the sustainable-spend figure.
 * Kill the process anywhere in there and the row survives with a hole in it
 * that nothing can ever fill: snapshotScorer is explicit that it is the only
 * place a row is ever scored, the re-score route and its button were
 * deliberately removed, and the spend solver is reachable only from that one
 * flow. It has already happened once. The row records prices from a day that
 * has passed, so there is no re-running it later — the measurement is simply
 * gone. Everything below is in service of not doing that again.
 *
 * WHAT THE APP WILL TELL YOU, AND WHAT IT WILL NOT.
 *
 *   IT WILL TELL YOU about scoring. GET /api/networth/scoring and
 *   GET /api/plan/history/scoring each return `{"scoring":[...]}` — the ids
 *   with a simulation in flight. Those are the two irreversible cases, and
 *   they are exactly the two the app exposes. Both maps are memory-only, so
 *   they are honestly empty after a restart.
 *
 *   IT WILL NOT TELL YOU about anything else. There is no route that lists
 *   runs: GET /api/run/:runId needs an id you already hold, and the run map is
 *   never enumerated, so an interactive Workbench run is invisible. And
 *   GET /api/searches reads the reports directory from disk — a report is only
 *   written when the search FINISHES, so a search that is running does not
 *   appear in the listing at all.
 *
 * SO THE SECOND SIGNAL IS THE FILESYSTEM, and it is not a heuristic bolted on
 * for comfort — it is the only evidence those two produce. A search writes one
 * cache file per evaluation into searches/scores/, thousands of them, the whole
 * time it runs. A finished interactive run writes runs/<runKey>.json. Nothing
 * else writes to either directory, which is what makes "nothing has been
 * written there for N seconds" mean "no search and no run is working". Those
 * three directories and no others: plan.json and profile.json are rewritten on
 * every knob turn in the UI, so watching them would mean waiting for the user
 * to stop typing.
 *
 * WHAT IS DELIBERATELY NOT PROTECTED, so the caller does not think it is:
 * an unfinished interactive run is lost by a restart, and that is fine — it is
 * deterministic and re-runnable. A search loses its report but keeps its
 * compute, because every evaluation is cached to disk as it happens. Only the
 * two scoring flows are unrecoverable, and only they are worth blocking for.
 *
 * FAILURE IS BUSY, NEVER QUIET. A 500, a truncated body, a reply that does not
 * parse — all read as "in flight". The cost of waiting when nothing is running
 * is a slow update; the cost of the reverse is the record above.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export type FetchLike = (url: string) => Promise<{ status: number; text: () => Promise<string> }>;

export interface ScoringReply {
  /** Did we get an answer we understood? A no is treated as busy. */
  ok: boolean;
  ids: string[];
  note?: string;
}

/**
 * Read one `{"scoring":[...]}` body.
 *
 * `status === null` means the request never completed — connection refused,
 * DNS, timeout. That is reported rather than judged; whether a server that is
 * not answering counts as quiet is assessQuiet()'s decision, because it
 * depends on whether anything is supposed to be running at all.
 */
export function parseScoring(status: number | null, body: string | null): ScoringReply {
  if (status === null) return { ok: false, ids: [], note: 'no answer' };
  if (status !== 200) return { ok: false, ids: [], note: `HTTP ${status}` };
  let parsed: unknown;
  try {
    parsed = JSON.parse(body ?? '');
  } catch {
    return { ok: false, ids: [], note: 'unreadable body' };
  }
  const scoring = (parsed as { scoring?: unknown } | null)?.scoring;
  if (!Array.isArray(scoring) || scoring.some((id) => typeof id !== 'string')) {
    return { ok: false, ids: [], note: 'unexpected shape' };
  }
  return { ok: true, ids: scoring as string[] };
}

export interface QuietInput {
  /** True when the server answered at all. False = nothing is serving. */
  serverReachable: boolean;
  scoring: Array<{ label: string; reply: ScoringReply }>;
  /** Seconds since the newest file in each watched directory. */
  fileActivity: Array<{ label: string; ageSeconds: number }>;
  /** How long a watched directory must be untouched before it counts as idle. */
  settleSeconds: number;
}

export interface QuietVerdict {
  quiet: boolean;
  /** One line per reason, in the order a person would want to read them. */
  busy: string[];
}

/**
 * Turn one round of evidence into a verdict.
 *
 * When the server is unreachable the scoring probes are skipped rather than
 * counted as failures — a server that is not running has nothing in flight, by
 * construction. The filesystem check still runs, and that is the point: a
 * DEVELOPMENT checkout on another port can be mid-search against this same
 * data folder while the installed service is already stopped. The scoring
 * endpoints of a dead server would never show it; searches/scores/ does.
 */
export function assessQuiet(input: QuietInput): QuietVerdict {
  const busy: string[] = [];

  if (input.serverReachable) {
    for (const { label, reply } of input.scoring) {
      if (!reply.ok) {
        busy.push(`${label}: could not be read (${reply.note ?? 'unknown'}) — treating as in flight`);
      } else if (reply.ids.length > 0) {
        busy.push(`${label}: ${reply.ids.length} in flight (${reply.ids.join(', ')})`);
      }
    }
  }

  for (const { label, ageSeconds } of input.fileActivity) {
    if (ageSeconds < input.settleSeconds) {
      busy.push(`${label}: written ${Math.round(ageSeconds)}s ago (settle is ${input.settleSeconds}s)`);
    }
  }

  return { quiet: busy.length === 0, busy };
}

/**
 * Seconds since the newest file directly inside `dir`.
 *
 * A missing or empty directory returns Infinity — "nothing has ever happened
 * here" is the strongest possible form of idle, and a fresh install has no
 * runs/ or searches/ at all.
 */
export async function newestMtimeAgeSeconds(dir: string, nowMs: number): Promise<number> {
  let names: string[];
  try {
    names = await fs.readdir(dir);
  } catch {
    return Number.POSITIVE_INFINITY;
  }
  let newest = 0;
  for (const name of names) {
    try {
      const st = await fs.stat(path.join(dir, name));
      if (st.mtimeMs > newest) newest = st.mtimeMs;
    } catch {
      // A file deleted between readdir and stat is not evidence of anything.
    }
  }
  if (newest === 0) return Number.POSITIVE_INFINITY;
  return Math.max(0, (nowMs - newest) / 1000);
}

/** The three directories that only compute writes to. */
export function watchedDirs(dataDir: string): Array<{ label: string; dir: string }> {
  return [
    { label: 'runs/', dir: path.join(dataDir, 'runs') },
    { label: 'searches/', dir: path.join(dataDir, 'searches') },
    { label: 'searches/scores/', dir: path.join(dataDir, 'searches', 'scores') },
  ];
}

export interface ProbeOptions {
  baseUrl: string;
  dataDir: string;
  settleSeconds: number;
  fetchImpl?: FetchLike;
  now?: () => number;
}

/** One full round: both scoring endpoints plus the three directories. */
export async function probeOnce(opts: ProbeOptions): Promise<QuietVerdict & { reachable: boolean }> {
  const fetchImpl = opts.fetchImpl ?? (fetch as unknown as FetchLike);
  const now = opts.now ?? Date.now;

  const endpoints = [
    { label: 'snapshot scoring', url: `${opts.baseUrl}/api/networth/scoring` },
    { label: 'plan-version scoring', url: `${opts.baseUrl}/api/plan/history/scoring` },
  ];

  let reachable = false;
  const scoring: Array<{ label: string; reply: ScoringReply }> = [];
  for (const { label, url } of endpoints) {
    let status: number | null = null;
    let body: string | null = null;
    try {
      const res = await fetchImpl(url);
      status = res.status;
      body = await res.text();
      reachable = true;
    } catch {
      // Left as null: parseScoring turns that into 'no answer'.
    }
    scoring.push({ label, reply: parseScoring(status, body) });
  }

  const nowMs = now();
  const fileActivity = [];
  for (const { label, dir } of watchedDirs(opts.dataDir)) {
    fileActivity.push({ label, ageSeconds: await newestMtimeAgeSeconds(dir, nowMs) });
  }

  const verdict = assessQuiet({
    serverReachable: reachable,
    scoring,
    fileActivity,
    settleSeconds: opts.settleSeconds,
  });
  return { ...verdict, reachable };
}

export interface WaitOptions extends ProbeOptions {
  timeoutSeconds: number;
  intervalSeconds: number;
  /** Consecutive quiet rounds required before we believe it. */
  confirmations: number;
  onRound?: (round: number, verdict: QuietVerdict & { reachable: boolean }) => void;
  sleep?: (ms: number) => Promise<void>;
}

export interface WaitResult {
  quiet: boolean;
  rounds: number;
  lastBusy: string[];
  reachable: boolean;
  /**
   * Consecutive quiet rounds at the moment we gave up.
   *
   * This exists because of a failure mode the message got wrong once: the
   * deadline can expire while the last round was QUIET but the run of quiet
   * rounds was still one short. Reporting that as "still busy" with an empty
   * list of reasons is the worst of both — it refuses, and then names nothing
   * to wait for. The caller needs to be able to tell the two apart.
   */
  consecutiveQuiet: number;
  confirmationsWanted: number;
}

/**
 * Poll until quiet, or until the deadline.
 *
 * `confirmations` exists because one reading is a sample. The gap between a
 * snapshot's score landing and its sustainable-spend solve starting is the
 * moment that would fool a single probe; the id stays in the map across both
 * phases so it should not, but requiring the answer to hold still for several
 * consecutive rounds costs seconds and removes the argument.
 */
export async function waitForQuiet(opts: WaitOptions): Promise<WaitResult> {
  const now = opts.now ?? Date.now;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const deadline = now() + opts.timeoutSeconds * 1000;

  let consecutive = 0;
  let rounds = 0;
  let last: QuietVerdict & { reachable: boolean } = { quiet: false, busy: [], reachable: false };

  for (;;) {
    rounds += 1;
    last = await probeOnce(opts);
    opts.onRound?.(rounds, last);

    consecutive = last.quiet ? consecutive + 1 : 0;
    if (consecutive >= opts.confirmations) {
      return {
        quiet: true,
        rounds,
        lastBusy: [],
        reachable: last.reachable,
        consecutiveQuiet: consecutive,
        confirmationsWanted: opts.confirmations,
      };
    }
    if (now() >= deadline) {
      return {
        quiet: false,
        rounds,
        lastBusy: last.busy,
        reachable: last.reachable,
        consecutiveQuiet: consecutive,
        confirmationsWanted: opts.confirmations,
      };
    }
    await sleep(opts.intervalSeconds * 1000);
  }
}

// ---------------------------------------------------------------------------
// CLI: used by scripts/update.sh. Exit 0 = quiet, 1 = still busy, 2 = usage.
// ---------------------------------------------------------------------------

export function parseArgs(argv: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith('--')) continue;
    const eq = arg.indexOf('=');
    if (eq > -1) {
      out[arg.slice(2, eq)] = arg.slice(eq + 1);
    } else {
      out[arg.slice(2)] = argv[i + 1] ?? '';
      i += 1;
    }
  }
  return out;
}

// True only when this file IS the program, so importing it from a test (or
// from another module) never runs the CLI.
function isDirectRun(): boolean {
  const entry = process.argv[1];
  return entry !== undefined && import.meta.url === pathToFileURL(entry).href;
}

if (isDirectRun()) {
  const args = parseArgs(process.argv.slice(2));
  const baseUrl = args['base-url'];
  const dataDir = args['data-dir'];
  if (!baseUrl || !dataDir) {
    console.error('usage: quiet.ts --base-url URL --data-dir DIR [--settle S] [--timeout S] [--interval S] [--confirmations N]');
    process.exit(2);
  }
  const result = await waitForQuiet({
    baseUrl,
    dataDir,
    settleSeconds: Number(args.settle || 20),
    // 1800s outlasts the app's own 20-minute ceiling on a scoring attempt
    // (scoreRunner's TIMEOUT_MS), so a legitimate solve is never cut off by
    // this wait expiring first. A search has no ceiling at all — cancel it
    // from the UI, or accept losing its report, before reaching for --force.
    timeoutSeconds: Number(args.timeout || 1800),
    intervalSeconds: Number(args.interval || 5),
    confirmations: Number(args.confirmations || 3),
    onRound: (round, verdict) => {
      if (verdict.quiet) {
        console.log(`  round ${round}: quiet`);
      } else {
        for (const reason of verdict.busy) console.log(`  round ${round}: ${reason}`);
      }
    },
  });

  if (result.quiet) {
    console.log(
      result.reachable
        ? 'Nothing in flight. Safe to restart.'
        : 'Nothing in flight (no server answering, and no compute has touched the data folder).',
    );
    process.exit(0);
  }
  console.error('');
  if (result.lastBusy.length > 0) {
    console.error('Still busy after the timeout. NOT restarting:');
    for (const reason of result.lastBusy) console.error(`  - ${reason}`);
  } else {
    // Quiet at the last look, but not for long enough to trust it. Saying
    // "still busy" here and then listing nothing is how a refusal becomes
    // baffling: there is nothing to wait for and no way to tell.
    console.error(
      `Quiet for ${result.consecutiveQuiet} of the ${result.confirmationsWanted} consecutive checks needed, ` +
        'and the timeout ran out first. NOT restarting.',
    );
    console.error('Nothing is running right now — allow a longer --timeout and it will pass.');
  }
  process.exit(1);
}
