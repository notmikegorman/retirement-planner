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
files and everything else it needs. It works entirely offline.

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

## Checks

```bash
npm test              # 2,259 tests
npm run typecheck     # tsc --noEmit; covers src, tests and scripts
npx vitest run tests/server/singleWriter.test.ts     # one file
```

Run both before committing. The engine's golden digests will tell you
immediately if a change moved a number, which is usually the question.

**If you change anything under `src/engine`**, bump `ENGINE_VERSION` in
`src/shared/types.ts` and re-pin `engineSourceSha256` in
`tests/shared/engineVersion.test.ts` — the test says so itself, and a pure
refactor still counts. The engine version is part of the run cache key, so
getting this wrong means serving cached answers computed by different code.

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
  server/    Fastify routes, the data-folder stores, run and search managers
  ui/        React, one page, no router library
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
