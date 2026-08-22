/**
 * THE WAIT THAT STANDS BETWEEN AN UPDATE AND A LOST RECORD
 * (scripts/lib/quiet.ts, used by scripts/update.sh).
 *
 * A net-worth snapshot writes its row immediately and then runs a
 * 10,000-path score in the background, followed by a separate solve for the
 * sustainable-spend figure. Restart in either gap and the row keeps its prices
 * and loses its number permanently — there is no re-score, deliberately. This
 * module is the only thing that stops an update from doing that, so the
 * properties below are the ones worth pinning:
 *
 *   1. A NON-EMPTY `scoring` LIST MEANS BUSY. Obvious, and tested anyway.
 *   2. AN UNREADABLE ANSWER ALSO MEANS BUSY. A 500, a truncated body, a shape
 *      that changed — every one of them is treated as work in flight. Waiting
 *      when nothing is running costs a slow update. Guessing the other way
 *      costs a measurement that cannot be taken again.
 *   3. THE FILESYSTEM IS CHECKED EVEN WHEN THE SERVER IS DOWN. A running
 *      search and an interactive run are invisible to every route the app has:
 *      searches only appear in the listing once they FINISH, and the run map is
 *      never enumerated. Files in searches/scores/ and runs/ are the only
 *      evidence they exist, and a development checkout on another port can be
 *      producing them while the installed service is already stopped.
 *   4. QUIET MUST HOLD STILL. One reading is a sample; `confirmations`
 *      consecutive quiet rounds is an answer.
 *
 * The endpoint is stubbed two ways on purpose: an injected fetch for the
 * decision logic, and a real HTTP server on a real port for the request path,
 * so a mistake in the URL or the JSON handling cannot hide behind a mock.
 */
import { createServer, type Server } from 'node:http';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  type FetchLike,
  assessQuiet,
  newestMtimeAgeSeconds,
  parseScoring,
  probeOnce,
  waitForQuiet,
  watchedDirs,
} from '../../scripts/lib/quiet';

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'fplan-quiet-'));
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

const NO_SLEEP = async (): Promise<void> => {};

/** A fetch that answers both scoring endpoints with the same body. */
function stubFetch(status: number | 'refuse', body: string): FetchLike {
  return async () => {
    if (status === 'refuse') throw new Error('ECONNREFUSED');
    return { status, text: async () => body };
  };
}

describe('parseScoring', () => {
  it('reads the quiet answer the app actually sends', () => {
    expect(parseScoring(200, '{"scoring":[]}')).toEqual({ ok: true, ids: [] });
  });

  it('reads ids', () => {
    expect(parseScoring(200, '{"scoring":["a","b"]}')).toEqual({ ok: true, ids: ['a', 'b'] });
  });

  it('refuses to call an answer it does not understand "quiet"', () => {
    expect(parseScoring(null, null).ok).toBe(false);
    expect(parseScoring(500, 'boom').ok).toBe(false);
    expect(parseScoring(200, '{"scoring":[').ok).toBe(false);
    expect(parseScoring(200, '{"scoring":"soon"}').ok).toBe(false);
    expect(parseScoring(200, '{"scoring":[1,2]}').ok).toBe(false);
    expect(parseScoring(200, '{}').ok).toBe(false);
  });
});

describe('assessQuiet', () => {
  const idle = { label: 'runs/', ageSeconds: Number.POSITIVE_INFINITY };

  it('is quiet when both endpoints are empty and nothing has been written', () => {
    const verdict = assessQuiet({
      serverReachable: true,
      scoring: [{ label: 'snapshot scoring', reply: { ok: true, ids: [] } }],
      fileActivity: [idle],
      settleSeconds: 20,
    });
    expect(verdict).toEqual({ quiet: true, busy: [] });
  });

  it('is busy while a snapshot is being scored, and names the row', () => {
    const verdict = assessQuiet({
      serverReachable: true,
      scoring: [{ label: 'snapshot scoring', reply: { ok: true, ids: ['snap-7'] } }],
      fileActivity: [idle],
      settleSeconds: 20,
    });
    expect(verdict.quiet).toBe(false);
    expect(verdict.busy[0]).toContain('snap-7');
  });

  it('treats an unreadable reply as busy, not as quiet', () => {
    const verdict = assessQuiet({
      serverReachable: true,
      scoring: [{ label: 'snapshot scoring', reply: { ok: false, ids: [], note: 'HTTP 500' } }],
      fileActivity: [idle],
      settleSeconds: 20,
    });
    expect(verdict.quiet).toBe(false);
    expect(verdict.busy[0]).toContain('HTTP 500');
  });

  it('is busy while a watched directory is still being written to', () => {
    // This is the ONLY evidence a running search produces: it writes one score
    // file per evaluation, and its report does not exist until it finishes.
    const verdict = assessQuiet({
      serverReachable: true,
      scoring: [{ label: 'snapshot scoring', reply: { ok: true, ids: [] } }],
      fileActivity: [{ label: 'searches/scores/', ageSeconds: 3 }],
      settleSeconds: 20,
    });
    expect(verdict.quiet).toBe(false);
    expect(verdict.busy[0]).toContain('searches/scores/');
  });

  it('skips the endpoints when nothing is serving, but STILL checks the files', () => {
    // A stopped service has nothing in flight by construction — but a dev
    // checkout on another port can be mid-search against the same folder, and
    // no endpoint on a dead server would ever say so.
    const quiet = assessQuiet({
      serverReachable: false,
      scoring: [{ label: 'snapshot scoring', reply: { ok: false, ids: [], note: 'no answer' } }],
      fileActivity: [idle],
      settleSeconds: 20,
    });
    expect(quiet.quiet).toBe(true);

    const busy = assessQuiet({
      serverReachable: false,
      scoring: [{ label: 'snapshot scoring', reply: { ok: false, ids: [], note: 'no answer' } }],
      fileActivity: [{ label: 'searches/scores/', ageSeconds: 1 }],
      settleSeconds: 20,
    });
    expect(busy.quiet).toBe(false);
  });
});

describe('newestMtimeAgeSeconds', () => {
  it('is infinite for a folder that does not exist — a fresh install', async () => {
    expect(await newestMtimeAgeSeconds(path.join(tmpDir, 'nope'), Date.now())).toBe(
      Number.POSITIVE_INFINITY,
    );
  });

  it('is infinite for an empty folder', async () => {
    await fs.mkdir(path.join(tmpDir, 'runs'));
    expect(await newestMtimeAgeSeconds(path.join(tmpDir, 'runs'), Date.now())).toBe(
      Number.POSITIVE_INFINITY,
    );
  });

  it('measures from the NEWEST file, not the oldest', async () => {
    const dir = path.join(tmpDir, 'runs');
    await fs.mkdir(dir);
    await fs.writeFile(path.join(dir, 'old.json'), '{}');
    await fs.utimes(path.join(dir, 'old.json'), new Date(1000), new Date(1000));
    await fs.writeFile(path.join(dir, 'new.json'), '{}');
    const now = Date.now();
    await fs.utimes(path.join(dir, 'new.json'), new Date(now - 5000), new Date(now - 5000));

    const age = await newestMtimeAgeSeconds(dir, now);
    expect(age).toBeGreaterThanOrEqual(4.5);
    expect(age).toBeLessThan(6);
  });
});

describe('watchedDirs', () => {
  it('watches only the folders that nothing but compute writes to', () => {
    // plan.json and profile.json are rewritten on every knob turn in the UI,
    // so watching them would mean waiting for the user to stop typing.
    expect(watchedDirs('/data').map((w) => w.label)).toEqual([
      'runs/',
      'searches/',
      'searches/scores/',
    ]);
  });
});

describe('probeOnce against a real stub server', () => {
  let server: Server;
  let baseUrl: string;
  let bodies: Record<string, string>;
  let seen: string[];

  beforeEach(async () => {
    bodies = {
      '/api/networth/scoring': '{"scoring":[]}',
      '/api/plan/history/scoring': '{"scoring":[]}',
    };
    seen = [];
    server = createServer((req, res) => {
      seen.push(req.url ?? '');
      const body = bodies[req.url ?? ''];
      if (body === undefined) {
        res.writeHead(404).end('{}');
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' }).end(body);
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const addr = server.address();
    baseUrl = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('asks both scoring endpoints by their real paths', async () => {
    const verdict = await probeOnce({ baseUrl, dataDir: tmpDir, settleSeconds: 20 });
    expect(seen).toEqual(['/api/networth/scoring', '/api/plan/history/scoring']);
    expect(verdict.reachable).toBe(true);
    expect(verdict.quiet).toBe(true);
  });

  it('reports busy when the plan-history endpoint has something in flight', async () => {
    bodies['/api/plan/history/scoring'] = '{"scoring":["ver-3"]}';
    const verdict = await probeOnce({ baseUrl, dataDir: tmpDir, settleSeconds: 20 });
    expect(verdict.quiet).toBe(false);
    expect(verdict.busy.join(' ')).toContain('ver-3');
  });

  it('notices a server that is not there without throwing', async () => {
    const verdict = await probeOnce({
      baseUrl: 'http://127.0.0.1:1',
      dataDir: tmpDir,
      settleSeconds: 20,
    });
    expect(verdict.reachable).toBe(false);
    expect(verdict.quiet).toBe(true);
  });
});

describe('waitForQuiet', () => {
  it('requires the quiet answer to hold for several consecutive rounds', async () => {
    // probeOnce asks BOTH endpoints, so a round is two calls.
    let calls = 0;
    const fetchImpl: FetchLike = async () => {
      calls += 1;
      const round = Math.ceil(calls / 2);
      // Busy, quiet, busy again — the gap between a score landing and its
      // spend solve starting is exactly this shape. One quiet reading is a
      // sample, not an answer.
      const busy = round <= 2 || (round >= 5 && round <= 6);
      return { status: 200, text: async () => (busy ? '{"scoring":["x"]}' : '{"scoring":[]}') };
    };

    const result = await waitForQuiet({
      baseUrl: 'http://stub',
      dataDir: tmpDir,
      settleSeconds: 0,
      fetchImpl,
      timeoutSeconds: 1000,
      intervalSeconds: 0,
      confirmations: 3,
      sleep: NO_SLEEP,
      now: () => 0,
    });

    expect(result.quiet).toBe(true);
    // Rounds 3 and 4 were quiet, 5 and 6 busy again; the run of three only
    // completes at 9. A single-sample check would have restarted at round 3.
    expect(result.rounds).toBe(9);
  });

  it('gives up rather than waiting forever, and says what was still running', async () => {
    let clock = 0;
    const result = await waitForQuiet({
      baseUrl: 'http://stub',
      dataDir: tmpDir,
      settleSeconds: 0,
      fetchImpl: stubFetch(200, '{"scoring":["snap-1"]}'),
      timeoutSeconds: 30,
      intervalSeconds: 5,
      confirmations: 3,
      sleep: async () => {
        clock += 5000;
      },
      now: () => clock,
    });

    expect(result.quiet).toBe(false);
    expect(result.lastBusy.join(' ')).toContain('snap-1');
  });

  it('separates "still busy" from "quiet, but not for long enough"', async () => {
    // The deadline can expire while the LAST round was quiet and the run of
    // quiet rounds was one short. Reported as plain busy, that is a refusal
    // with an empty list of reasons — nothing to wait for and no way to tell.
    let clock = 0;
    let calls = 0;
    const result = await waitForQuiet({
      baseUrl: 'http://stub',
      dataDir: tmpDir,
      settleSeconds: 0,
      fetchImpl: async () => {
        calls += 1;
        const busy = Math.ceil(calls / 2) === 1; // busy for round 1 only
        return { status: 200, text: async () => (busy ? '{"scoring":["x"]}' : '{"scoring":[]}') };
      },
      timeoutSeconds: 10,
      intervalSeconds: 5,
      confirmations: 3,
      sleep: async () => {
        clock += 5000;
      },
      now: () => clock,
    });

    expect(result.quiet).toBe(false);
    expect(result.lastBusy).toEqual([]);
    expect(result.consecutiveQuiet).toBe(2);
    expect(result.confirmationsWanted).toBe(3);
  });

  it('reports the full confirmation state on a genuine success too', async () => {
    const result = await waitForQuiet({
      baseUrl: 'http://stub',
      dataDir: tmpDir,
      settleSeconds: 0,
      fetchImpl: stubFetch(200, '{"scoring":[]}'),
      timeoutSeconds: 100,
      intervalSeconds: 0,
      confirmations: 2,
      sleep: NO_SLEEP,
      now: () => 0,
    });
    expect(result.quiet).toBe(true);
    expect(result.consecutiveQuiet).toBe(2);
  });

  it('never returns quiet on a server that keeps erroring', async () => {
    const result = await waitForQuiet({
      baseUrl: 'http://stub',
      dataDir: tmpDir,
      settleSeconds: 0,
      fetchImpl: stubFetch(500, 'nope'),
      timeoutSeconds: 0,
      intervalSeconds: 0,
      confirmations: 1,
      sleep: NO_SLEEP,
      now: () => 0,
    });
    expect(result.quiet).toBe(false);
    expect(result.lastBusy.join(' ')).toContain('HTTP 500');
  });

  it('is quiet immediately when nothing is serving and the folder is idle', async () => {
    const result = await waitForQuiet({
      baseUrl: 'http://stub',
      dataDir: tmpDir,
      settleSeconds: 20,
      fetchImpl: stubFetch('refuse', ''),
      timeoutSeconds: 1000,
      intervalSeconds: 0,
      confirmations: 2,
      sleep: NO_SLEEP,
      now: () => 0,
    });
    expect(result.quiet).toBe(true);
    expect(result.reachable).toBe(false);
  });

  it('stays busy while a search keeps writing score files, even with no server', async () => {
    const scores = path.join(tmpDir, 'searches', 'scores');
    await fs.mkdir(scores, { recursive: true });
    await fs.writeFile(path.join(scores, 'abc.json'), '{}');

    const result = await waitForQuiet({
      baseUrl: 'http://stub',
      dataDir: tmpDir,
      settleSeconds: 600,
      fetchImpl: stubFetch('refuse', ''),
      timeoutSeconds: 0,
      intervalSeconds: 0,
      confirmations: 1,
      sleep: NO_SLEEP,
    });
    expect(result.quiet).toBe(false);
    expect(result.lastBusy.join(' ')).toContain('searches/scores/');
  });
});
