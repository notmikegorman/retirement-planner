# Retirement Planner

A retirement planner for one household that runs **entirely in your browser**
and keeps its files where you can read them.

**Open it: <https://notmikegorman.github.io/retirement-planner>**

You describe the household once — people, accounts, salary, expenses, house,
Social Security — and then turn knobs: retire in this month instead of that
one, claim at 67 instead of 70, sell the house and move. Each change re-runs
the projection: a deterministic path, a replay against every historical
sequence since 1928, and a seeded Monte Carlo. The tax math is real US federal
plus Virginia, South Carolina and North Carolina, with ACA premium tax
credits, Medicare and IRMAA, RMDs, 72(t) bridges, and Social Security claiming
and survivor rules.

There is no server behind the page. The simulation engine runs in Web Workers
**on your machine**; a twenty-minute parameter search is your CPU cores
working, not a cloud's. There is no database, no account, no login, no
telemetry — and your data never leaves your computer.

---

## The first question the app asks: where should your data live?

Everything the planner knows is stored as pretty-printed JSON files. On your
first visit the app asks once where those files should live — one question,
and in a browser that ships the folder picker (Chrome, Edge, Brave) it has
one answer:

### A folder on this computer

Pick any folder (the button uses the browser's folder picker). Your profile,
plan, plan history, and net-worth ledger live there as plain files —
`profile.json`, `plan.json`, `networth.json` — readable in any text editor,
diffable, and **yours to back up: copy the folder, `git init` it, sync it**.
Pick an empty folder to **start from zero**: the app asks for the few facts
the tax and Social Security engine cannot run without (who, born when, which
state) and everything you see from then on is your own data — no invented
example household, and no number on screen before there is something real
behind it. Or point it at a folder that already holds planner data (a copy of
one from the old Node server works as-is — the file format never changed).

The browser will ask permission to use the folder, and on later visits may
ask again with a single **Reconnect** click. Installing the page as an app
(the install icon in Chrome's address bar — "Add to Dock" on a Mac) makes the
grant stick so it stops asking.

Picked the wrong folder? **Profile → Settings → Switch storage** returns to the
question so you can pick a different one; it never touches the folder or the
files in it.

### No folder picker? The demo fallback (Safari, Firefox)

Browsers without the File System Access API cannot hold a durable folder
connection, so they get the one thing they can honestly offer: the full app
in browser-private demo storage, behind a standing banner that says so. The
files live inside the browser profile itself, invisible on disk — good for
trying the app in thirty seconds, but **Clear browsing data erases all of
them**, and no ordinary backup ever sees them. For real, file-backed use,
open the page in Chrome, Edge, or Brave.

### What's in the folder

| | |
|---|---|
| `profile.json` | the household. **No history — an overwrite is gone.** |
| `plan.json` | the current plan |
| `plan-history.json` | every previous version, filed automatically on the day's first change |
| `networth.json` | the snapshot ledger. **The irreplaceable one** — each row records prices from a day that has passed |
| `quotes.json` | last fetched prices |
| `assumptions/` | market, tax, Social Security, Medicare, ACA tables — yours to edit |
| `runs/`, `searches/` | caches. Deletable; they cost you recomputation and nothing else |

### Backing it up

The folder is the backup. Copy it anywhere, and treat the copy as what it is —
a complete financial dossier in plain text. The nicest option is a git
repository in the folder, which gives you a dated history of every change:

```bash
cd <your-data-folder> && git init && git add -A && git commit -m "start"
```

Add a `.gitignore` with two lines of app plumbing that isn't data:

```
*.crswap
.writer.lease
```

Whatever you do, **include `networth.json`**. Everything else can be retyped
from statements; that file is the only record of what the portfolio was worth
on past days, and nothing reconstructs it.

---

## Browser support

| Browser | What you get |
|---|---|
| **Chrome, Edge, Brave** (Chromium ≥122) | Everything: the folder picker, the durable storage, installing as an app |
| **Safari, Firefox** | Demo mode: the full app in browser-private storage, with a standing banner saying so — these browsers don't ship the folder picker (the File System Access API), so they cannot hold a durable folder connection |

## Privacy, and the one network step

Simulations, tax math, file IO: all local, always. The single thing that ever
touches the network is the **price refresh** (the Refresh button on the
Accounts card, and Run now on the Workbench), which sends your holdings'
**ticker symbols** — nothing else — through a tiny Cloudflare Worker proxy to
Yahoo Finance's public quote endpoint. The proxy exists because browsers
cannot call Yahoo directly; it validates the symbol, relays the JSON, and
logs nothing.

**The proxy is not deployed yet.** Until the owner runs the one command in
[`workers/quote-proxy/README.md`](workers/quote-proxy/README.md), a quote
refresh reports a per-symbol failure explaining exactly that, stored quotes
keep working with their recorded as-of dates, and everything else is
unaffected. Never refresh, and the app never connects to anything at all.

## Living with it

- **One tab writes at a time.** A second tab (or another machine on a synced
  folder) gets an honest refusal page instead of silently corrupting records.
- **The tab is the engine.** Closing it mid-simulation stops the simulation;
  the app warns before you close while scoring or a search is in flight, and
  an interrupted snapshot score is either finishable with one click or
  honestly labelled unmeasured — never a silent blank.
- **Updates announce themselves.** When a new version is deployed, a small
  "Reload to update" card appears; nothing swaps out from under a running
  session.
- **Caches grow.** `runs/` is unbounded by design; Profile → Settings shows
  its size, and deleting it costs only recomputation.

## It is not financial advice

It is a calculator that does what you tell it, using the assumptions in
`ASSUMPTIONS.md` and the tax tables in `VERIFICATIONS.md`. It has no view
about your situation, it does not know what it has not been told, and every
number it prints is only as good as the profile behind it and the future
resembling the past. Take decisions with a licensed professional who can see
the whole picture.

## You start from zero; only the demo shows an invented household

A first boot on an empty folder starts **from zero**: a one-page setup step
collects who the plan is for and which state, and then everything the app
shows is your own data. With no accounts entered yet, the Workbench shows
what is missing and where to add it rather than a success percentage — a
simulation of zero accounts would be a statement about a household that does
not exist — and once accounts exist but recorded spending is still $0, the
score says that beside itself: those futures spend only what the law charges
anyway (taxes, and Medicare premiums from 65), so the number describes the
inputs as entered, not your retirement.

The **fictional example household** — invented people, round invented
balances (`data-defaults/profile.starter.json`) — survives in exactly two
places, where a filled example is the point: the Safari/Firefox **demo
storage** fallback, and the parked legacy Node server's first boot on an
empty data folder. If you are looking at Alex and Jordan, you are looking at
the example, not at anyone real. `ASSUMPTIONS.md` documents its every number.

---

## The legacy server (the parked Node service)

The hosted browser app above is now the primary way to run the planner. The
original Node service — `npm start`, Fastify on `127.0.0.1:5599`, the same
stores over the same file format — **remains supported as legacy mode** and
runs exactly as it always did; see **[INSTALL.md](INSTALL.md)** for install,
service units, and updates.

One warning travels with it: **the server has no authentication of any
kind.** Anyone who can reach its port can read and overwrite everything in
it. It binds loopback by default; leave it there, and reach it remotely only
through an SSH tunnel, a VPN, or an authenticating reverse proxy. (The
browser app has no port to reach — this whole class of concern is one of the
reasons it took over.)

## Developing it

```bash
npm install
npm run dev        # legacy server on :5599 + Vite UI on :5174
npm test           # the node suite, seconds
npm run test:browser   # engine parity + storage + the full app in headless Chromium
```

**[DEVELOPMENT.md](DEVELOPMENT.md)** has the layout, the two-backend
architecture (`src/ui/api.ts` is the seam), the browser test lanes, the
`window.__fplanApi` scripting surface, and how the GitHub Pages deploy is
built and gated.

## The rest of the documents

- **[INSTALL.md](INSTALL.md)** — the legacy Node service: install, service units, updates.
- **[DEVELOPMENT.md](DEVELOPMENT.md)** — developing, testing, deploying.
- `ARCHITECTURE.md` — how it is built. `DECISIONS.md` — why, at length.
- `SPEC.md` — the original brief. `PLAN.md` — the build phases. Both historical; where they disagree with the code, the code wins.
- `VERIFICATIONS.md` — every tax number, its source, and the date it was checked.
- `ASSUMPTIONS.md` — placeholders to replace and open questions.
