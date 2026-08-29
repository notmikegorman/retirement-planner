/**
 * The quote proxy's client side (src/ui/local/proxyQuoteFetcher.ts): where
 * the proxy URL may come from, which values are refused, and how the store's
 * Yahoo URL maps onto the proxy's one-symbol contract.
 *
 * The refusal rules are the security half of the deploy-then-point flow: the
 * proxy receives every symbol the portfolio holds, so the URL that receives
 * quote traffic must come only from origin-local configuration (localStorage,
 * the build) and only over schemes worth trusting. A URL query parameter was
 * rejected at design time precisely because a handed-around link could plant
 * one; these tests pin the rule that survived.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createProxyQuoteFetcher,
  resolveQuoteProxyUrl,
} from '../../src/ui/local/proxyQuoteFetcher';

describe('resolveQuoteProxyUrl — the whole pointing rule, pure', () => {
  it('prefers a valid stored override over the build default (deploy-then-point without a rebuild)', () => {
    expect(
      resolveQuoteProxyUrl({
        stored: 'https://fplan-quote-proxy.owner.workers.dev',
        buildDefault: 'https://old.example',
      }),
    ).toEqual({ url: 'https://fplan-quote-proxy.owner.workers.dev', rejected: null });
  });

  it('falls back to the build default when nothing is stored', () => {
    expect(
      resolveQuoteProxyUrl({ stored: null, buildDefault: 'https://proxy.example' }),
    ).toEqual({ url: 'https://proxy.example', rejected: null });
    expect(resolveQuoteProxyUrl({ stored: '', buildDefault: 'https://proxy.example' }).url).toBe(
      'https://proxy.example',
    );
  });

  it('answers null when neither layer is configured — the honest-refusal fetcher takes over', () => {
    expect(resolveQuoteProxyUrl({ stored: null, buildDefault: undefined })).toEqual({
      url: null,
      rejected: null,
    });
  });

  it('accepts http only on localhost/127.0.0.1 — the dev server and the offline test lane', () => {
    for (const url of ['http://localhost:5174', 'http://127.0.0.1:49123']) {
      expect(resolveQuoteProxyUrl({ stored: url, buildDefault: undefined }).url).toBe(url);
    }
  });

  it('refuses non-https elsewhere, garbage, and other schemes — naming what it refused', () => {
    for (const bad of [
      'http://evil.example', // plaintext to a real host: symbols readable on the wire
      'ftp://proxy.example',
      'javascript:alert(1)',
      'not a url',
      'http://192.168.1.4:8080', // loopback names only, not "anything private-looking"
    ]) {
      const resolved = resolveQuoteProxyUrl({ stored: bad, buildDefault: undefined });
      expect(resolved.url, bad).toBeNull();
      expect(resolved.rejected, bad).toBe(bad);
    }
  });

  it('a rejected override falls back to a valid build default rather than to nothing', () => {
    expect(
      resolveQuoteProxyUrl({ stored: 'not a url', buildDefault: 'https://proxy.example' }),
    ).toEqual({ url: 'https://proxy.example', rejected: 'not a url' });
  });
});

describe('createProxyQuoteFetcher — the URL mapping', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('maps the store’s Yahoo chart URL onto GET <proxy>/?symbol=…, signal riding along', async () => {
    const calls: { url: string; signal: AbortSignal | null | undefined }[] = [];
    vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
      calls.push({ url, signal: init?.signal });
      return { ok: true, status: 200, json: async () => ({}) } as Response;
    });
    const fetcher = createProxyQuoteFetcher('https://proxy.example');
    const controller = new AbortController();
    await fetcher(
      // Exactly what src/store/quotes.ts builds — including an encoded caret.
      'https://query1.finance.yahoo.com/v8/finance/chart/%5EGSPC?interval=1d&range=1d',
      { signal: controller.signal },
    );
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('https://proxy.example/?symbol=%5EGSPC');
    // The store's own 10s timeout must still be able to abort a hung proxy.
    expect(calls[0].signal).toBe(controller.signal);
  });

  it('sets no headers — a header-free GET stays a simple CORS request', async () => {
    const inits: (RequestInit | undefined)[] = [];
    vi.stubGlobal('fetch', async (_url: string, init?: RequestInit) => {
      inits.push(init);
      return { ok: true, status: 200, json: async () => ({}) } as Response;
    });
    await createProxyQuoteFetcher('https://proxy.example')(
      'https://query1.finance.yahoo.com/v8/finance/chart/VTI?interval=1d&range=1d',
      {},
    );
    expect(inits[0]?.headers).toBeUndefined();
  });
});
