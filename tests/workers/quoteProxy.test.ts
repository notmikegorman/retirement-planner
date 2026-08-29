/**
 * The quote proxy Worker (workers/quote-proxy/handler.ts), tested WITHOUT any
 * Cloudflare machinery: the handler is a plain fetch handler, so the tests
 * import it and drive it with Request objects. The upstream is a local node
 * http server serving the repo's captured Yahoo fixture — the same bytes the
 * dual-stack drive refreshes — so the lane is fully offline and the "verbatim
 * relay" claim is a byte comparison, not an impression.
 *
 * What must hold, in order of what it protects:
 *   1. Privacy: no logging, ever (D3) — pinned by scanning the source for
 *      console.* the same way the repo pins node-imports out of portable code.
 *   2. CORS: the allowlist echoes the matched origin and NEVER answers `*` —
 *      a symbol list is a portfolio fingerprint, and `*` would let any page
 *      that lures the owner read quote traffic.
 *   3. The gate: bad symbols 400 before a byte goes upstream.
 *   4. The pipe: good symbols relay Yahoo's bytes and status verbatim; a
 *      down or hung upstream is a 502 the app records per-symbol.
 */
import { createServer, type Server } from 'node:http';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { corsHeadersFor, handleQuoteRequest } from '../../workers/quote-proxy/handler';
import { parseYahooChart } from '../../src/store/quotes';

const VTI_FIXTURE = readFileSync(
  fileURLToPath(new URL('../fixtures/yahoo-chart-vti.json', import.meta.url)),
  'utf8',
);

const APP_ORIGIN = 'https://notmikegorman.github.io';

/** The upstream double: serves the fixture for VTI, Yahoo-ish shapes otherwise. */
let upstream: Server;
let upstreamBase: string;
/** Requests the upstream saw, for the encode/User-Agent assertions. */
const upstreamSeen: { url: string; userAgent: string | undefined }[] = [];

beforeAll(async () => {
  upstream = createServer((req, res) => {
    upstreamSeen.push({ url: req.url ?? '', userAgent: req.headers['user-agent'] });
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (url.pathname === '/v8/finance/chart/VTI') {
      res.writeHead(200, { 'content-type': 'application/json;charset=utf-8' }).end(VTI_FIXTURE);
      return;
    }
    if (url.pathname === '/v8/finance/chart/NOPE') {
      // Yahoo's own unknown-symbol shape: HTTP 404 with a chart.error body.
      res.writeHead(404, { 'content-type': 'application/json' }).end(
        JSON.stringify({
          chart: {
            result: null,
            error: { code: 'Not Found', description: 'No data found, symbol may be delisted' },
          },
        }),
      );
      return;
    }
    if (url.pathname.endsWith('/HANG')) {
      return; // never answers — the timeout test's upstream
    }
    res.writeHead(500).end('unexpected path');
  });
  await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve));
  const addr = upstream.address();
  if (addr === null || typeof addr === 'string') throw new Error('no port');
  upstreamBase = `http://127.0.0.1:${addr.port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) =>
    upstream.close((err) => (err ? reject(err) : resolve())),
  );
});

function get(query: string, origin?: string): Promise<Response> {
  return handleQuoteRequest(
    new Request(`https://proxy.example/${query}`, {
      headers: origin === undefined ? {} : { origin },
    }),
    { UPSTREAM_BASE: upstreamBase },
  );
}

describe('no logging, structurally (decision D3)', () => {
  it('the handler source contains no console call and no storage binding', () => {
    // The same discipline as the node-import pin: read the source, so a log
    // line added "temporarily" fails loudly. A symbol list is a portfolio
    // fingerprint; the Worker must be unable to remember one.
    const source = readFileSync(
      fileURLToPath(new URL('../../workers/quote-proxy/handler.ts', import.meta.url)),
      'utf8',
    );
    expect(source).not.toMatch(/console\s*\./);
    expect(source).not.toMatch(/\bKV\b|caches\.|analytics/i);
  });

  it('wrangler.toml keeps observability off', () => {
    const toml = readFileSync(
      fileURLToPath(new URL('../../workers/quote-proxy/wrangler.toml', import.meta.url)),
      'utf8',
    );
    expect(toml).toContain('[observability]');
    expect(toml).toMatch(/\[observability\]\s*\n\s*enabled = false/);
  });
});

describe('CORS: an allowlist that echoes, never a star', () => {
  it('echoes the app origin (D6) and varies on origin', () => {
    expect(corsHeadersFor(APP_ORIGIN)).toEqual({
      'access-control-allow-origin': APP_ORIGIN,
      vary: 'origin',
    });
  });

  it('echoes localhost dev origins on any port, http or https', () => {
    for (const origin of [
      'http://localhost:5174',
      'http://127.0.0.1:49301',
      'https://localhost:8443',
      'http://localhost',
    ]) {
      expect(corsHeadersFor(origin)['access-control-allow-origin']).toBe(origin);
    }
  });

  it('answers nothing at all for any other origin — including lookalikes', () => {
    for (const origin of [
      'https://evil.example',
      'https://notmikegorman.github.io.evil.example',
      'http://localhost.evil.example',
      'http://192.168.1.10:5174',
      'https://xnotmikegorman.github.io',
    ]) {
      expect(corsHeadersFor(origin)).toEqual({});
    }
  });

  it('never emits a star, on any branch of a real request', async () => {
    for (const origin of [APP_ORIGIN, 'https://evil.example', undefined]) {
      for (const query of ['?symbol=VTI', '?symbol=bad!', '']) {
        const res = await get(query, origin);
        expect(res.headers.get('access-control-allow-origin')).not.toBe('*');
      }
    }
  });

  it('a no-origin request (curl, tests) gets the body with no CORS header', async () => {
    const res = await get('?symbol=VTI');
    expect(res.status).toBe(200);
    expect(res.headers.get('access-control-allow-origin')).toBeNull();
  });
});

describe('the symbol gate', () => {
  it('400s everything outside the app symbol discipline, before touching upstream', async () => {
    const seenBefore = upstreamSeen.length;
    for (const symbol of [
      'vti', // lowercase — the app's own schema refuses it too
      'TOOLONGSYMBOL', // 11+ chars
      'A B', // whitespace
      'A/B', // path metacharacter
      '../etc', // traversal
      'A=B', // the plan's draft regex allowed '='; the app's does not
      '', // empty
    ]) {
      const res = await get(`?symbol=${encodeURIComponent(symbol)}`, APP_ORIGIN);
      expect(res.status, `symbol ${JSON.stringify(symbol)}`).toBe(400);
      const body = (await res.json()) as { error: string };
      expect(body.error).toContain('ticker symbol');
    }
    const res = await get('', APP_ORIGIN); // no symbol parameter at all
    expect(res.status).toBe(400);
    expect(upstreamSeen.length).toBe(seenBefore);
  });

  it('405s non-GET without touching upstream', async () => {
    const seenBefore = upstreamSeen.length;
    const res = await handleQuoteRequest(
      new Request('https://proxy.example/?symbol=VTI', { method: 'POST' }),
      { UPSTREAM_BASE: upstreamBase },
    );
    expect(res.status).toBe(405);
    expect(upstreamSeen.length).toBe(seenBefore);
  });

  it('encodes the symbol into the upstream path even though the gate already passed it', async () => {
    // ^GSPC is a legal symbol whose caret must be %5E on the wire — the
    // encode-regardless habit, observed rather than trusted.
    await get('?symbol=%5EGSPC', APP_ORIGIN);
    const last = upstreamSeen.at(-1);
    expect(last?.url).toContain('/v8/finance/chart/%5EGSPC?interval=1d&range=1d');
  });
});

describe('the dumb pipe', () => {
  it('relays Yahoo body bytes VERBATIM, with the User-Agent Yahoo requires', async () => {
    const res = await get('?symbol=VTI', APP_ORIGIN);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe(VTI_FIXTURE);
    expect(upstreamSeen.at(-1)?.userAgent).toBe('Mozilla/5.0');
    expect(res.headers.get('content-type')).toContain('application/json');
  });

  it('what it relays still parses through the app-side parser — the contract meets the client', () => {
    const fetched = parseYahooChart('VTI', JSON.parse(VTI_FIXTURE));
    expect(fetched.symbol).toBe('VTI');
    expect(fetched.price).toBeGreaterThan(0);
  });

  it("relays Yahoo's own rejection status and body untouched — failure is the client's data", async () => {
    const res = await get('?symbol=NOPE', APP_ORIGIN);
    expect(res.status).toBe(404);
    const body = (await res.json()) as { chart: { error: { description: string } } };
    // The client turns exactly this into a per-symbol failure message.
    expect(body.chart.error.description).toContain('delisted');
  });

  it('times out a hung upstream and answers 502 with a sentence', async () => {
    const res = await handleQuoteRequest(
      new Request('https://proxy.example/?symbol=HANG', {
        headers: { origin: APP_ORIGIN },
      }),
      { UPSTREAM_BASE: upstreamBase, UPSTREAM_TIMEOUT_MS: '100' },
    );
    expect(res.status).toBe(502);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain('did not answer within 0.1s');
    // Even the failure carries the CORS echo, so the page can READ it.
    expect(res.headers.get('access-control-allow-origin')).toBe(APP_ORIGIN);
  });

  it('answers 502 when the upstream is not there at all', async () => {
    const res = await handleQuoteRequest(
      new Request('https://proxy.example/?symbol=VTI'),
      // An ephemeral port nothing listens on: bind-then-close would race, so
      // use the upstream's port + a closed neighbour via a fresh reservation.
      { UPSTREAM_BASE: 'http://127.0.0.1:1' },
    );
    expect(res.status).toBe(502);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain('could not be reached');
  });

  it('defaults its upstream to Yahoo — asserted on the source, not the network', () => {
    const source = readFileSync(
      fileURLToPath(new URL('../../workers/quote-proxy/handler.ts', import.meta.url)),
      'utf8',
    );
    expect(source).toContain("'https://query1.finance.yahoo.com'");
    // And the path is the exact one src/store/quotes.ts builds.
    expect(source).toContain('/v8/finance/chart/${encodeURIComponent(symbol)}?interval=1d&range=1d');
  });
});
