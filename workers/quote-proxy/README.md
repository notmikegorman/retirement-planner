# Quote proxy (Cloudflare Worker)

The app's only network step. Browsers cannot call Yahoo's chart endpoint
directly — it sends no CORS header, and it 429s clients without a browser-ish
`User-Agent`, a header a page is forbidden to set — so quote refreshes route
through this ~100-line Worker instead. It is a dumb pipe on purpose: it
validates one symbol, adds the `User-Agent`, and relays Yahoo's JSON verbatim.
Parsing stays in the app (`src/store/quotes.ts` → `parseYahooChart`), so a
Yahoo shape change is an app fix, not a proxy redeploy.

## The contract

```
GET https://<your-worker>.workers.dev/?symbol=VTI
```

- `symbol` must match the app's own discipline — uppercase letters, digits,
  `.^-`, at most 10 characters (`BRK.B`, `^GSPC`, `BF-B` all pass). Anything
  else is a `400` before a byte goes upstream.
- The response is Yahoo's chart JSON **byte for byte**, with Yahoo's own
  status. A hung or unreachable upstream is a `502` with a one-line JSON
  `error`; the app records either as that one symbol's failure, never the
  batch's.
- Any other method is a `405`.
- CORS: the matched origin is echoed for `https://notmikegorman.github.io`
  (the app's origin, decision D6) and for localhost/127.0.0.1 dev origins on
  any port. Never `*`. Serving the app from a different origin someday means
  editing `APP_ORIGIN` in `handler.ts` and redeploying.

**No logging — a standing constraint (decision D3).** The Worker sees ticker
symbols and an IP, and a symbol list is a portfolio fingerprint. There is no
`console.*` anywhere in the handler, no KV, no analytics, and
`wrangler.toml` keeps observability off. Keep it that way.

## Deploy (one command)

From this directory, logged in to the owner's Cloudflare account:

```
npx wrangler deploy
```

(First time on a machine: `npx wrangler login` opens the browser sign-in.)
The command prints the Worker's URL, e.g.
`https://fplan-quote-proxy.<account>.workers.dev`.

## Point the app at it (no rebuild needed)

Open the deployed app, open the browser console, and paste — with your URL:

```js
localStorage.setItem('fplan-quote-proxy', 'https://fplan-quote-proxy.<account>.workers.dev');
```

Reload the page. Refresh prices now flows through the proxy. The override is
origin-local storage, so only you (or the app's own code) can set it — a link
someone hands you cannot re-point your quote traffic; the app also refuses
any value that is not `https://` (or `http://` on localhost).

For builds made after deploying, the same URL can be baked in instead:

```
VITE_FPLAN_QUOTE_PROXY=https://fplan-quote-proxy.<account>.workers.dev npm run build:ui
```

The localStorage override, when present and valid, wins over the baked-in
default. Until one of the two is configured, every refresh reports per symbol
that the proxy is not set up, and stored quotes keep working with their
recorded as-of times.

## Free-tier arithmetic

Cloudflare's free tier allows 100,000 requests/day. A refresh is one request
per symbol — a handful per button press. There is no realistic path from this
app to the limit.

## Testing (no Cloudflare account involved)

- `tests/workers/quoteProxy.test.ts` imports the handler directly and drives
  it with plain `Request` objects against a local fixture upstream.
- The browser lane (`tests/browser/proxy.test.ts`) mounts the same module in
  a ~10-line node `http` adapter on an ephemeral port and runs a real
  Refresh-prices through it end to end, offline.

`wrangler` is not a dependency of this repo; it enters only via `npx` at
deploy time.
