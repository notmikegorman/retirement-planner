/**
 * THE QUOTE PROXY — the one non-browser piece left after the port: a
 * Cloudflare Worker that lets the page reach Yahoo's chart endpoint, which
 * sends no CORS header and 429s clients without a browser-ish User-Agent (a
 * header a page is forbidden to set). It is deliberately a DUMB PIPE:
 *
 *   GET <worker>/?symbol=VTI   →  Yahoo's chart JSON, byte for byte
 *
 * - ONE parameter, validated with the app's own symbol discipline (the
 *   SYMBOL_RE below mirrors src/shared/schemas.ts — uppercase letters,
 *   digits, `.^-`, at most 10 chars). Anything else is a 400 before a byte
 *   goes upstream, and the path segment is encodeURIComponent'd regardless —
 *   validation is a gate, encoding is a habit.
 * - The BODY RELAYS VERBATIM, status included. parseYahooChart and the
 *   USD-only rejection stay client-side, so a Yahoo shape change is an app
 *   fix, not a proxy redeploy.
 * - NO LOGGING OF ANYTHING (decision D3, a standing constraint): no log
 *   statement of any kind, no storage binding, no metrics, observability off
 *   in wrangler.toml — and a source-scan test pins each of those absences. A
 *   symbol list is a portfolio fingerprint, and this Worker must be
 *   structurally unable to remember one. It sees symbols and an IP; it
 *   keeps neither.
 * - CORS is OPEN (`*`) — the owner's explicit 2026-08-29 decision, revising
 *   D3's allowlist. The relay carries only public market data and sees only
 *   symbols, so the sole exposure of `*` is quota freeloading: another site
 *   could embed this URL as a free relay, and the worst case is the free
 *   tier's 100k/day exhausting so the owner's own refresh fails until the
 *   day rolls over. He priced that and chose reachable-from-anywhere.
 * - The UPSTREAM BASE comes from the environment with the Yahoo default, so
 *   the test lane points it at a local fixture server and stays fully
 *   offline. The timeout is env-tunable for the same reason; 10s means
 *   "hung", matching the client's own budget (src/store/quotes.ts).
 *
 * Tested without any Cloudflare account: unit tests import this module and
 * call the handler with plain Request objects; the browser lane mounts the
 * SAME module in a ~10-line node http adapter on an ephemeral port. wrangler
 * appears only in the deploy step (README.md — `npx wrangler deploy`).
 */

/** Mirror of src/shared/schemas.ts SYMBOL_RE — the app's symbol discipline. */
const SYMBOL_RE = /^[A-Z0-9.^-]{1,10}$/;

/** The exact endpoint src/store/quotes.ts has always built its URL against. */
const DEFAULT_UPSTREAM_BASE = 'https://query1.finance.yahoo.com';

/** Per-request upstream budget. Yahoo answers in ~100ms; 10s means "hung". */
const DEFAULT_TIMEOUT_MS = 10_000;

export interface QuoteProxyEnv {
  /** Override for tests/fixtures; production omits it and gets Yahoo. */
  UPSTREAM_BASE?: string;
  /** Override for tests (a hung-upstream test cannot wait 10 real seconds). */
  UPSTREAM_TIMEOUT_MS?: string;
}

/**
 * OPEN CORS, the owner's explicit choice (2026-08-29, revising the D3
 * allowlist): any page may read quotes through this relay. `*` is safe HERE
 * because the response is public market data keyed by nothing but a symbol —
 * no cookie, no credential, no per-user anything — so the grant leaks
 * nothing; the only cost `*` can incur is someone else spending the free
 * tier's request quota. Constant for every request, so no `vary: origin`.
 */
export function corsHeadersFor(_origin: string | null): Record<string, string> {
  return { 'access-control-allow-origin': '*' };
}

/** A JSON error the client's per-symbol loop records as that symbol's data. */
function refuse(status: number, error: string, cors: Record<string, string>): Response {
  return new Response(`${JSON.stringify({ error })}\n`, {
    status,
    headers: { 'content-type': 'application/json', ...cors },
  });
}

export async function handleQuoteRequest(
  request: Request,
  env: QuoteProxyEnv = {},
): Promise<Response> {
  const cors = corsHeadersFor(request.headers.get('origin'));

  if (request.method !== 'GET') {
    return refuse(405, 'Only GET is served here.', cors);
  }
  const symbol = new URL(request.url).searchParams.get('symbol');
  if (symbol === null || !SYMBOL_RE.test(symbol)) {
    return refuse(
      400,
      'expected a ticker symbol (uppercase letters/digits/.^-, at most 10 chars) in ?symbol=',
      cors,
    );
  }

  const base = env.UPSTREAM_BASE ?? DEFAULT_UPSTREAM_BASE;
  const timeoutMs = Number(env.UPSTREAM_TIMEOUT_MS ?? DEFAULT_TIMEOUT_MS);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const upstream = await fetch(
      // The same path src/store/quotes.ts builds, encoded the same way.
      `${base}/v8/finance/chart/${encodeURIComponent(symbol)}?interval=1d&range=1d`,
      {
        headers: { 'user-agent': 'Mozilla/5.0' },
        signal: controller.signal,
      },
    );
    // Verbatim relay: Yahoo's status, Yahoo's bytes. The body STREAMS through
    // rather than buffering — the proxy never holds a whole response it has
    // no reason to look at.
    return new Response(upstream.body, {
      status: upstream.status,
      headers: {
        'content-type': upstream.headers.get('content-type') ?? 'application/json',
        ...cors,
      },
    });
  } catch (err) {
    // Timeout or unreachable upstream. 502 with a sentence — the client's
    // refresh loop records it as that one symbol's failure, never the batch's.
    const why =
      err instanceof Error && err.name === 'AbortError'
        ? `the upstream quote source did not answer within ${timeoutMs / 1000}s`
        : 'the upstream quote source could not be reached';
    return refuse(502, `Quote fetch failed: ${why}.`, cors);
  } finally {
    clearTimeout(timer);
  }
}

/** The Worker entry — what `npx wrangler deploy` ships. */
export default {
  fetch: (request: Request, env: QuoteProxyEnv): Promise<Response> =>
    handleQuoteRequest(request, env),
};
