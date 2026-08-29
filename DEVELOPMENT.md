# Developing Finance Planner

Working on the code while an installed copy keeps running, without the two of
them destroying each other's data.

---

## The shape of it: two checkouts, one data folder, never at once

```
  ~/finance-planner            the installed copy      service, port 5599
  ~/src/finance-planner        where you work          npm run dev, ports 5599 + 5174
  ~/finance-planner-data       the real data           ONE writer at a time
```

The installed copy is a clean checkout that tracks the remote and is moved
forward by `scripts/update.sh`. The development clone is where you commit,
experiment, and abandon things. Nothing has to be pushed to see it work.

**The one hard rule: two servers must never write one data folder at the same
time.** The app now enforces it. The rest of this section is what happens
otherwise, because the enforcement looks like an obstacle until you know what it
is standing in front of.

### What goes wrong, precisely

Every file in the data folder is read **whole**, changed in memory, and written
**whole**. There is no append, no record-level write, no transaction. So two
servers produce this:

```
  A reads plan-history.json          12 entries
  B reads plan-history.json          the same 12
  A appends its entry, writes        13 entries
  B appends its entry, writes        13 entries — its own
                                     A's entry is gone
```

Nothing throws. Nothing is logged. The file is still perfectly well-formed. You
find out weeks later, looking for a version that is not there.

The same shape deletes a net-worth row, and that is the one that matters: those
rows record market prices from a day that has passed, and nothing can recreate
one.

`networthStore.ts`, `planStore.ts` and `planHistoryStore.ts` each hold a
promise chain that serialises their writes, and those chains are load-bearing
and correct — the snapshot button racing a score that arrived from a simulation
started minutes earlier is a real collision they close. But a promise chain is a
JavaScript variable, and a variable protects exactly one process. Two servers
have two chains that have never heard of each other.

It is not only the stores, either. `initDataDir()` runs a giving-split migration
that rewrites `plan.json` raw, before Fastify is even constructed and outside
every chain. So the dangerous moment is not "two servers running" — it is a
second server **starting** while a first one is live.

### The guard

Before it touches anything, the server takes `<data-dir>/.writer.lock`, a file
naming its pid, hostname, port and checkout. A second server against the same
folder refuses to start and tells you what has it:

```
Another Finance Planner is already writing /home/alex/finance-planner-data.

  held by : pid 4321 on planner-box
  serving : http://127.0.0.1:5599/
  from    : /home/alex/finance-planner
  since   : 2026-08-22T09:00:00.000Z
  lock    : /home/alex/finance-planner-data/.writer.lock
```

Things worth knowing about it:

- **A dead holder's lock is taken, not respected.** There is no shutdown drain
  in this app and machines lose power, so a lock file that outlives its process
  must never need a human. The next start notices the pid is gone, says
  `Cleared a lock left by pid N`, and carries on.
- **It waits a few seconds before refusing.** `tsx watch` and systemd's
  `Restart=` both begin the replacement while the old process is still exiting;
  failing on the first collision would make every routine restart a coin flip.
- **A lock written on another machine is refused rather than stolen** — this
  host cannot see that host's process table. Put the data folder on local disk,
  not a network share.
- It guards the *folder*, not the port, which is the point: a service on 5600
  and a dev server on 5599 do not collide on a port and would otherwise collide
  on everything that matters.

The reasoning is written out in full at the top of `src/server/singleWriter.ts`.

---

## So: give the dev checkout its own data folder

The safest arrangement, and the one to default to:

```bash
cp -a ~/finance-planner-data ~/finance-planner-dev-data
cd ~/src/finance-planner
FPLAN_DATA_DIR=~/finance-planner-dev-data npm run dev
```

You get your real numbers to develop against — which matters, because bugs live
in real data — and nothing you do can touch the original. Refresh the copy
whenever it goes stale.

Put it in your shell profile and stop thinking about it:

```bash
export FPLAN_DATA_DIR=~/finance-planner-dev-data
```

Or use the seeded fictional household instead, which needs no copy at all:

```bash
FPLAN_DATA_DIR=/tmp/fplan-scratch npm run dev
```

An empty folder is seeded on first boot with the starter profile, the assumption
files and everything else it needs. It works entirely offline. (This is the
**legacy server's** behavior, kept on purpose — it has no setup step to collect
a real household with. The browser app zero-starts instead: an empty folder
gets the first-run setup step and no invented household; only the D8 demo
fallback still seeds the starter. See `initDataDir`'s `seedStarterProfile`
option in `src/store/dataStore.ts`.)

### When you do want the dev checkout on the real folder

Stop the service first. Serially is fine; concurrently is not.

```bash
scripts/service.sh stop      # waits for in-flight simulations
cd ~/src/finance-planner && npm run dev
# ... later ...
scripts/service.sh start
```

`service.sh stop` waits for the same reason `update.sh` does: a snapshot's score
and its sustainable-spend solve run in the background after the row is written,
and stopping in between costs that row its figure permanently.

---

## Running it

```bash
npm run dev      # BOTH halves: API on :5599 (tsx watch) + Vite UI on :5174
npm run dev:ui   # the UI alone (:5174, proxies /api to :5599)
npm run dev:api  # the API alone (:5599, tsx watch)
npm start        # production-shaped: builds the UI once, serves it from :5599
npm run preview  # the same, without opening a browser
```

**Open the Vite port, 5174.** Under `npm run dev` the API port redirects every
UI request there, which is deliberate: `dist/ui` is a build artifact frozen at
whatever moment something last ran `vite build`, and Fastify will happily serve
it while `tsx watch` keeps the API current. That split has bitten twice — once
as engine 1.10.0 under a 1.11.0 interface, once as "I asked for that column to
be removed and it is still there" while the removal sat built and tested on the
other port. Nothing on screen says the numbers are stale, which is what makes it
expensive.

There is no build step for the server. `tsx` runs the TypeScript sources
directly, in development and in production alike, which is why it is a runtime
dependency rather than a dev one. Only the UI is bundled.

**The dual-boot switch (browser-port Phase 4; shipped at Phase 7).** The app
has two backends behind one client (`src/ui/api.ts`): the HTTP server above,
and an in-browser LOCAL backend (`src/ui/local/`) that runs the same stores
and scorers over a FileSystemDirectoryHandle folder behind the writer guard,
no server anywhere. Switch with `?backend=local` / `?backend=http` on any URL
(remembered in localStorage so reloads keep the mode; `http` also forgets),
or bake a default with `VITE_FPLAN_BACKEND=local`. Since Phase 7 the DEPLOYED
app (GitHub Pages, `npm run build:pages`) bakes local as its default; the
REPO default for `npm run dev` / `npm start` stays HTTP, pinned by
`tests/ui/backendMode.test.ts`. In local mode the first visit asks where data
should live (`src/ui/local/storageChoice.ts` — a picked real folder; browsers
without the picker fall back to browser-private OPFS demo storage, and a
remembered OPFS choice from before the 2026-08-29 chooser cut still boots),
and quote refreshes flow through the Phase-6 proxy
once one is configured (`workers/quote-proxy/README.md`; per-symbol honest
failures until then).

**Scripting the app (`window.__fplanApi`).** The browser app deliberately
exposes its whole backend seam on the page: `window.__fplanApi` is the same
`Api` object every component calls — all 27 methods, either backend, same
shapes and same thrown messages. It is the browser descendant of the curl-able
localhost API: when the server's routes retire, "scriptable" becomes the
DevTools console instead of `curl localhost:5599/api/...`. Documented surface,
not an accident — the dual-stack and walkthrough gates drive it to assert
refusals the UI draws no button for, and one-off data surgery
(`await __fplanApi.getPlan()`, mutate, `putPlan`) is the intended use. Two
things it will not save you from: it goes through the same validation and
guards as every button (there is no privileged path), and in HTTP mode it is
just the fetch client, so the legacy curl surface remains strictly more
scriptable from outside the page.

**The Pages deploy (Phase 7).** `npm run build:pages` produces the shipped
artifact: `FPLAN_BASE=/retirement-planner/` (project sites serve under
/<repo>/ — `vite.config.ts` reads the env var, `src/ui/nav.ts` strips and
prepends it around every router read/write), `VITE_FPLAN_BACKEND=local`,
`VITE_FPLAN_SW=1` (the only build that registers the service worker —
`src/ui/pwa.ts` has the update discipline: precache, wait, and a visible
"Reload to update" instead of ever swapping mid-session), then
`scripts/pagesExtras.ts` writes `404.html` (the deep-link trick — Pages
serves the app AS its error page, which boots the router on the deep path)
and generates `sw.js` from the built files. `.github/workflows/pages.yml`
runs exactly that recipe and deploys `dist/ui` — triggered by `workflow_run`
when `ci.yml` finishes green on main, from that run's exact SHA, so the
deploy always rides the same tests the repo already trusts and nothing runs
twice. PWA icons are committed (`public/icon-*.png`); regenerate with
`npx tsx scripts/generateIcons.ts` if the art ever changes.

**Search in local mode (browser-port Phase 5).** The Search page works
identically on both backends: in local mode the shared executor
(`src/store/search/`) runs inside a dedicated coordinator worker
(`src/ui/workers/searchWorker.ts`) over a persistent Web Worker score pool —
off the main thread, so a backgrounded tab's timer throttling cannot stall a
twenty-minute search. All folder IO stays on the guarded main context (the
coordinator proxies reads/writes back as messages), reports persist to
`searches/<id>.json` and slim scores to `searches/scores/` exactly as the
server writes them. The one honest difference is decision D5's default: the
tab IS the process, so closing it mid-search loses that search's progress —
a beforeunload warning is armed while one runs, a CANCELLED search still
writes its partial report, and a killed one is forgotten on reopen rather
than pretended alive.

## Checks

```bash
npm test              # ~2,500 tests, node-env, seconds — the fast loop
npm run typecheck     # tsc --noEmit; covers src, tests and scripts
npx vitest run tests/server/singleWriter.test.ts     # one file

npx playwright install chromium   # ONE-TIME per machine, before the first browser run
npm run test:browser  # the browser lane: engine parity + storage in headless Chromium
```

Run the first two before committing. The engine's golden digests will tell you
immediately if a change moved a number, which is usually the question.

**The browser lane** (`tests/browser/`, config `vitest.browser.config.ts`) is
the byte-equivalence gate of the browser port, two harness pages in one Vite
build served on an OS-assigned ephemeral port — never :5174/:5599, which on a
dev machine may be a live app on real data — and driven in headless Chromium
with Playwright. Page one (`parity.test.ts`) proves the browser-built engine
produces **byte-identical** RunResults, runKeys and input hashes to the Node
engine on six seeded fixtures built from `data-defaults`. Page two
(`stores.test.ts`, Phase 3) proves the STORAGE side: the
FileSystemDirectoryHandle driver passes the same driver-contract cases as the
node:fs and in-memory drivers, the ported store suite (tests/store/) runs
green against real OPFS, the golden cross-driver sequence writes
byte-identical folder trees on node and OPFS, and the Web Locks + lease
writer guard refuses/takes over exactly as specified — with two real tabs of
one browser profile. OPFS is the test double for the picked folder because it
hands back the same `FileSystemDirectoryHandle` API without a picker, which
headless Chromium cannot click. The third file (`dualStack.test.ts`, Phase 4)
is the dual-stack gate: it builds the REAL app bundle and drives the same
scripted session through it twice — once against a privately spawned Node
server (ephemeral port, temp data dir, fixture-fed quotes via
`FPLAN_QUOTE_FIXTURES_DIR`), once in local mode (`?backend=local`) over
seeded OPFS — then byte-diffs the two data folders and the run cache under
enumerated masks and compares the on-screen story verbatim. Phase 5 extended
the same file with the search legs: one small-but-real search driven through
each stack's own seam must persist byte-equal reports (masks: searchId,
createdAt, elapsedMs — ids and wall clock, nothing else) and identical
slim-score trees including their runKey filenames, and a second oversized
search cancelled mid-flight must leave the same truncated-partial-report
shape verbatim, with the beforeunload guard observed arming and disarming.
Phase 6 added `interruption.test.ts` (the killed-tab scoring matrix over the
write-ahead intents) and `proxy.test.ts` (a real Refresh through the quote
proxy handler mounted on a node adapter). Phase 7 added
`pagesWalkthrough.test.ts` — the fresh-machine gate: it builds the BASED
Pages bundle (base `/retirement-planner/`, local default, the 404 trick from
`scripts/pagesExtras.ts`), serves it with GitHub Pages' own semantics
(prefix + 404.html-with-status-404), and drives it as a brand-new user from
the first-visit storage chooser (asserted single-action: since the
2026-08-29 chooser cut, no visible UI reaches OPFS on a picker browser)
through runs, a snapshot, a cached-final-run-restoring reload, a deep-link
reload via the 404 trick, and the no-picker demo fallback. It is the only
lane that executes the base path and the only one that sees the chooser
(every lane, this one included, boots OPFS by pre-seeding
`fplan-storage=opfs` — headless Chromium cannot complete the native folder
dialog, and the seeded value doubles as a pre-cut browser-private user's
remembered choice); it also asserts the service
worker stays UNREGISTERED in the lane — registration is opt-in per build via
`VITE_FPLAN_SW=1`, which only `build:pages` sets.
The lane is deliberately not part of
`npm test`: it pays for a bundle build and a browser launch (~10s), and the
fast loop must stay fast. Run it whenever you touch `src/engine`, `src/tax`,
`src/shared`, `src/store`, `src/ui/io`, the workers, or anything
Vite-related; CI runs it on every push either way. It works from a fresh
clone: `npm ci`, the one-time `npx playwright install chromium`, then
`npm run test:browser` — no dev server, no data folder, no network.

**If you change anything under `src/engine` — or `src/shared/sha256.ts`**,
bump `ENGINE_VERSION` in `src/shared/types.ts` and re-pin `engineSourceSha256`
in `tests/shared/engineVersion.test.ts` — the test says so itself, and a pure
refactor still counts. The engine version is part of the run cache key, so
getting this wrong means serving cached answers computed by different code.
The sha256 module is in the pinned set because every cache key and digest is
computed through it: editing it changes what every runKey *means* without
touching a line of src/engine.

Every test that touches the data folder points `FPLAN_DATA_DIR` at a fresh temp
directory of its own, `tests/shared/engineVersion.test.ts` included — it seeds
one from `data-defaults` in a `beforeAll`. That is not tidiness: `initDataDir()`
backfills assumption defaults and `migrateGivingSplitFiles()` rewrites
`plan.json` in place, so a test that resolved the default folder would open, and
could migrate, whatever real records it found there. **`npm test` never reads
your data folder.** Keep it that way.

## Shell scripts

`scripts/*.sh` are checked with `bash -n` and rehearsed against a throwaway
checkout and a throwaway data directory. If you have `shellcheck`, run it; it is
not currently part of any gate because it is not installed here.

The logic worth testing does not live in the shell at all. Template rendering is
`scripts/lib/service.ts` and the in-flight check is `scripts/lib/quiet.ts`, both
TypeScript, both typechecked, both unit-tested under `tests/scripts/`. The shell
scripts orchestrate and print; they do not decide.

---

## The layout

```
src/
  engine/    the simulation. Deterministic, no IO, no network.
  tax/       federal + VA/SC/NC, ACA, Medicare, Social Security
  shared/    types, schemas, and the helpers both halves use
  store/     the environment-neutral stores, services and search core
             (both backends run THIS; node/browser wiring stays out of it)
  server/    Fastify routes and the node faces over src/store
  ui/        React, one page, no router library; ui/local + ui/io + ui/workers
             are the browser backend (drivers, guard, sim/search workers)
scripts/
  lib/       the parts with logic, in TypeScript so they can be tested
  *.sh       install, update, uninstall, service control
tests/       vitest, mirroring src/ plus tests/scripts/
data-defaults/  what a fresh data folder is seeded from
```

Two things about `src/server` worth internalising before you edit it:

- **Simulations run in worker threads**, spawned with
  `execArgv: ['--import', 'tsx']`. Node resolves that bare specifier against the
  process's working directory, so the server only works when its cwd is the
  checkout. `npm start` gets this for free; anything else has to be told.
- **Everything about "a run is in flight" is memory-only**, on purpose. A
  restart leaves rows scoreless rather than carrying a persisted "scoring…" that
  would be a lie forever after. This is why `update.sh` has to ask before it
  stops anything, rather than checking afterwards.

## Where the reasoning lives

The comments are the documentation here, and they are long on purpose: most of
them record an incident. `DECISIONS.md` has the same at essay length,
`ARCHITECTURE.md` has the map, and `ASSUMPTIONS.md` lists every placeholder
number and open question — read it before you question a figure in the starter
profile.
