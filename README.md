# Finance Planner

A retirement planner for one household, that runs on your own machine and keeps
its files where you can read them.

You describe the household once — people, accounts, salary, expenses, house,
Social Security — and then turn knobs: retire in this month instead of that
one, claim at 67 instead of 70, sell the house and move. Each change re-runs
the projection: a deterministic path, a replay against every historical
sequence since 1928, and a seeded Monte Carlo. The tax math is real US federal
plus Virginia, South Carolina and North Carolina, with ACA premium tax credits,
Medicare and IRMAA, RMDs, 72(t) bridges and Social Security claiming and
survivor rules.

Everything lives as pretty-printed JSON in one folder. There is no database, no
account, no cloud, and no telemetry.

---

## Read this before you install it

### It has no authentication. None.

There is no login, no password, no token, no API key, and no access control of
any kind. Every route is anonymous. This is not a gap to be fixed later — it is
the design of a program written to run on `127.0.0.1` for one person.

**Anyone who can reach the port owns everything in it.** With one unauthenticated
HTTP request they can:

- read both people's dates of birth, Social Security figures, salary, filing
  status, every account with its balance and holdings, the full monthly expense
  budget, insurance and health details, and the entire net-worth history;
- read every version of the plan, including whatever you wrote in the labels;
- **overwrite the whole profile** (`PUT /api/profile`) — a full replace, no
  merge, no confirmation, and unlike the plan there is no history to restore
  from;
- **permanently delete a net-worth snapshot** (`DELETE /api/networth/:id`).
  Those rows record market prices from a day that has passed. Nothing can
  recreate one;
- burn a plan version's one-shot score, which is then refused forever after;
- start unlimited simulations, each spawning worker threads, until the machine
  is on its knees and the disk is full.

There is also no request log, so none of it leaves a trace.

### So: bind it to localhost, and reach it through a tunnel.

It binds `127.0.0.1` by default and you should leave it there.

To use it from another machine, forward the port over SSH:

```bash
ssh -N -L 5599:127.0.0.1:5599 you@your-server
```

then open <http://127.0.0.1:5599/> on your own laptop. A WireGuard or Tailscale
link is equally good. Both give you the authentication the app does not have.

If you genuinely need it on a network address, put a reverse proxy in front of
it that **terminates TLS and requires authentication**, and firewall the app's
own port so the proxy is the only way in. `FPLAN_HOST` exists for that case, and
the server prints a full-width warning naming everything above every time it
starts on a non-loopback address.

Do not put this on the open internet. Not behind "nobody knows the URL", not on
a high port, not for a few minutes.

### Two smaller things worth knowing

- **DNS rebinding is the realistic attack on a loopback bind.** The server does
  not validate the `Host` header, so a web page you visit in the same browser
  can rebind its own hostname to `127.0.0.1`, become same-origin with the
  planner, and then read and write everything above. There are no CORS headers
  (which is the safe default — it stops an ordinary cross-origin page reading
  responses) and no CSRF tokens (mitigated only because every mutating route
  requires a JSON body). A reverse proxy that checks `Host` closes this;
  nothing inside the app does.
- **The data folder is not encrypted**, by design — the whole point is that you
  can read and diff it. `install.sh` sets it to mode `0700`. Anyone with an
  account on that machine and the patience to become you can read it, and so
  can anyone holding an unencrypted backup of it.

### It is not financial advice

It is a calculator that does what you tell it, using the assumptions in
`ASSUMPTIONS.md` and the tax tables in `VERIFICATIONS.md`. It has no view about
your situation, it does not know what it has not been told, and every number it
prints is only as good as the profile behind it and the future resembling the
past. Take decisions with a licensed professional who can see the whole picture.

### It is also not

- **Multi-user.** One household, one plan, one folder. Two people cannot use one
  install; two servers must never share one data folder (the app now refuses,
  loudly — see [DEVELOPMENT.md](DEVELOPMENT.md)).
- **A tracker.** It does not connect to your bank, your brokerage or your
  payroll. You type the numbers in, or you paste balances when you take a
  snapshot.
- **Offline-only, quite.** There is exactly one outbound request in the whole
  program and only when you ask for it: a **price refresh** (the Refresh button
  on the Accounts card, and RUN NOW on the Workbench) sends your holdings'
  **ticker symbols** — nothing else, no credentials — to Yahoo Finance's public
  chart endpoint, one GET per symbol. Prices land in `quotes.json` and every
  later read is local. **Simulations never touch the network.** Never refresh,
  and the app never connects to anything.

---

## What it needs

| | |
|---|---|
| **Node** | **20.6 or newer**; 22 LTS is the safe target. Not 20.0–20.5 — see below. |
| **CPU** | More than one core, genuinely. |
| **Memory** | ~1 GB free while running. Each worker boots its own runtime and holds a copy of the profile and the full assumptions bundle. |
| **Disk** | A few hundred MB to start, and it grows without bound — see [Housekeeping](#housekeeping). |
| **OS** | Linux or macOS. Windows is not supported. |

**Why 20.6 and not the 20 in `package.json`.** Simulations run in worker threads
started with `--import`, which arrived in Node 20.6.0. On an older 20.x the
server starts, serves the interface, reads and writes your data — and then fails
every single run. `install.sh` checks and refuses.

**Why more than one core.** Every simulation runs off the main thread, and a
parameter search runs a pool of `min(8, max(2, cores - 2))` of them at once. On a
single-core box the pool floor of two, plus interactive runs that are not
queued at all, will saturate the machine and a search will take hours. Two cores
is usable; four or more is comfortable. Note that in a container, `os.cpus()`
reports the *host's* cores rather than your CPU quota, so a tightly-limited
container will oversize its pool and thrash.

---

## Install it

```bash
git clone <this-repo> ~/finance-planner
~/finance-planner/scripts/install.sh
```

That installs dependencies, builds the interface, creates `~/finance-planner-data`
with mode `0700`, and installs a service that starts at boot — a systemd **user**
unit on Linux, a launchd agent on macOS. It runs as you, never as root.

Then open <http://127.0.0.1:5599/>.

Common options:

```bash
scripts/install.sh --port 5600 --data-dir /var/lib/finance-planner
scripts/install.sh --repo https://github.com/you/finance-planner --app-dir /opt/finance-planner
scripts/install.sh --no-service        # set it up, run it yourself
```

Running it again is safe: it reads back what the first run chose, waits for any
simulation in flight, and restarts.

Full detail, including what goes in the unit file and what to do when it will
not start: **[INSTALL.md](INSTALL.md)**.

## Run it, look at it, stop it

```bash
scripts/service.sh status
scripts/service.sh logs -f
scripts/service.sh stop
scripts/service.sh start
```

Without a service — on your laptop, in a terminal:

```bash
npm install && npm start        # builds the UI, serves on :5599, opens a browser
```

## Update it

```bash
scripts/update.sh
```

It **waits for the app to go quiet before it stops anything**, then pulls,
reinstalls dependencies if the lockfile moved, rebuilds the interface, restarts,
and tells you which commit and engine version it moved from and to.

That wait is not politeness. When you take a net-worth snapshot the row is
written immediately and the 10,000-path score that measures it runs afterwards,
in the background, followed by a separate solve for the sustainable-spend
figure. Kill the process in either gap and the row keeps its prices and loses
its number **permanently** — a snapshot is scored once, when it is taken, and
never again, because re-scoring an old row against today's plan would produce a
figure that was never true of it. This has already cost one real record. So the
updater polls both scoring queues and watches the directories that only
simulations write to, and refuses to restart while anything is moving.

`--force` skips the wait. It tells you exactly what you are giving up.

There is also an opt-in mode where the service pulls on every start
(`FPLAN_AUTO_UPDATE=1`). It is off by default and [INSTALL.md](INSTALL.md#auto-update-opt-in)
sets out honestly why you probably do not want it.

## Uninstall it

```bash
scripts/uninstall.sh
```

Removes the service and its settings. **It does not touch your data**, and there
is no flag that does — deleting that folder is a `rm` you have to write out
yourself.

---

## Your data

Everything is in one folder, `~/finance-planner-data` by default
(`FPLAN_DATA_DIR` moves it):

| | |
|---|---|
| `profile.json` | the household. **No history — an overwrite is gone.** |
| `plan.json` | the current plan |
| `plan-history.json` | every previous version, filed automatically on the day's first change |
| `networth.json` | the snapshot ledger. **The irreplaceable one** — each row records prices from a day that has passed |
| `quotes.json` | last fetched prices |
| `assumptions/` | market, tax, Social Security, Medicare, ACA tables — yours to edit |
| `runs/`, `searches/` | caches. Deletable; they cost you recomputation and nothing else |

It is all pretty-printed JSON, on purpose, so it stays readable and diffable.

### Backing it up

The folder is the backup. Copy it anywhere, and treat the copy as what it is —
a complete financial dossier in plain text.

The nicest option is to make it a git repository, which gives you a dated
history of every change for free:

```bash
cd ~/finance-planner-data && git init && git add -A && git commit -m "start"
```

The server suggests this on first boot. Commit whenever you remember; a cron job
that commits nightly is better.

Whatever you do, **include `networth.json`**. Everything else can be retyped
from statements. That file is the only record of what the portfolio was worth on
a past day, and no amount of later effort reconstructs it.

### Housekeeping

`runs/` and `searches/scores/` grow forever and nothing prunes them — a full run
result is around half a megabyte and a heavy user's cache reaches hundreds of
megabytes. Both are pure caches: stop the service, delete their contents, start
it again. The only cost is that the next few runs are slow.

---

## Developing it

Two checkouts, one repo: the installed copy on its port, and a clone you work in
on another. They must not write the same data folder at the same time — the
server now refuses to start when another one holds it, and tells you which
process, on which port, from which checkout.

```bash
npm run dev     # API on :5599 (reloads) + Vite UI on :5174 — open the UI port
npm test        # 2,259 tests
npm run typecheck
```

**[DEVELOPMENT.md](DEVELOPMENT.md)** has the two-checkout setup, why the guard
exists and what it is protecting, and how to work against a copy of your real
data without risking the original.

---

## The starter profile is invented

First boot seeds a **fictional example household** — invented people, round
invented balances, salary, PIA, expenses and an illustrative ACA benchmark. It
exists to give the app something to run, not to describe anyone. Replace every
value on the Profile page with your own, and read `ASSUMPTIONS.md` while you do:
it lists exactly which numbers are placeholders and which questions the model
does not answer.

## The rest of the documents

- **[INSTALL.md](INSTALL.md)** — install, service units, updates, troubleshooting.
- **[DEVELOPMENT.md](DEVELOPMENT.md)** — the two-checkout workflow and the single-writer guard.
- `ARCHITECTURE.md` — how it is built. `DECISIONS.md` — why, at length.
- `SPEC.md` — the original brief. `PLAN.md` — the build phases. Both historical; where they disagree with the code, the code wins.
- `VERIFICATIONS.md` — every tax number, its source, and the date it was checked.
- `ASSUMPTIONS.md` — placeholders to replace and open questions.
- The Methodology page inside the app — the modelling simplifications, in plain English.
