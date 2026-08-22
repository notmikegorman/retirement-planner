# Installing Finance Planner

Running it as a service that starts at boot, on Linux or macOS.

Read the security section of [README.md](README.md#read-this-before-you-install-it)
first. The short version, because it decides how you install: **the app has no
authentication of any kind.** Bind it to loopback and reach it over an SSH
tunnel or a VPN, or put an authenticating reverse proxy in front of it. Nothing
below assumes otherwise.

---

## Before you start

- **Node 20.6 or newer.** 22 LTS is the safe target. `package.json` says `>=20`
  and that is too generous: worker threads are started with `--import`, which
  landed in 20.6.0. On 20.0–20.5 the server boots, serves the interface, reads
  and writes your data, and then fails every simulation. The installer checks.
- **git**, if you want `update.sh` to be able to pull.
- **More than one core.** See [README](README.md#what-it-needs).
- **Do not run any of this as root.** `install.sh` refuses. Both service
  definitions it writes are per-user and need no privileges.

---

## Install

```bash
git clone <repo-url> ~/finance-planner
~/finance-planner/scripts/install.sh
```

or, to clone and install in one step:

```bash
scripts/install.sh --repo <repo-url> --app-dir /opt/finance-planner
```

### What it actually does

1. Works out the platform, and **stops with an explanation** if it is neither
   systemd-on-Linux nor macOS. It does not write something that half works.
2. Checks node's version and refuses an old one.
3. Refuses to run as root.
4. If something is already serving on the port, **waits for simulations and
   scoring to finish**, then stops the existing service. (`npm ci` deletes
   `node_modules` before repopulating it, which under a live server pulls the
   floor out from under a running process.)
5. `npm ci` — with dev dependencies, deliberately. Vite is a devDependency and
   step 6 needs it.
6. `npm run build:ui`. `dist/` is gitignored, so a fresh clone has no interface
   at all. Without this the API works fine and every page is a stub saying so.
7. Creates the data folder, mode `0700`.
8. Records your choices in `~/.config/finance-planner/config.env`.
9. Writes the service definition, enables it, starts it, and waits for it to
   answer.

### Options

| Flag | |
|---|---|
| `--app-dir DIR` | where the checkout lives (default: the checkout you ran the script from) |
| `--repo URL` | clone from here, when `--app-dir` does not exist yet |
| `--data-dir DIR` | default `~/finance-planner-data` |
| `--port N` | default `5599` |
| `--auto-update` | let the service `git pull` on every start — read [below](#auto-update-opt-in) first |
| `--no-start` | install it, leave it stopped |
| `--no-service` | set the app up, install no service |
| `--force` | do not wait for in-flight simulations |

### Running it twice

Safe, and the normal way to change the port or move the data folder. A second
run loads what the first one recorded, so `install.sh` on its own changes
nothing rather than silently resetting your choices to defaults. To change one
thing, pass one flag:

```bash
scripts/install.sh --port 5600
```

---

## What the service definition contains

Rendered by `scripts/lib/service.ts`, and unit-tested there, because a mistake
in a unit file is not caught by anything until the machine fails to come back
after a reboot nobody was watching.

### Linux: `~/.config/systemd/user/finance-planner.service`

A **user** unit, not a system one.

```ini
[Service]
Type=simple
WorkingDirectory="/opt/finance-planner"
ExecStart="/opt/finance-planner/scripts/service-run.sh"
Environment="FPLAN_DATA_DIR=/var/lib/finance-planner"
Environment="FPLAN_PORT=5599"
Environment="FPLAN_HOST=127.0.0.1"
Environment="FPLAN_NO_OPEN=1"
Environment="FPLAN_APP_DIR=/opt/finance-planner"
Environment="FPLAN_AUTO_UPDATE=0"
Environment="PATH=<node's own directory>:/usr/local/bin:/usr/bin:/bin"
Restart=on-failure
RestartSec=5
NoNewPrivileges=yes
```

`install.sh` also runs `loginctl enable-linger` for you. Without lingering a
user unit dies when you log out and does not come back at boot, which is the
whole thing you installed it for. If that call fails it says so and tells you
the `sudo` incantation.

Logs go to the journal:

```bash
journalctl --user -u finance-planner -f
```

### macOS: `~/Library/LaunchAgents/com.finance-planner.server.plist`

A LaunchAgent with `RunAtLoad`, `KeepAlive` restricted to `SuccessfulExit=false`,
a `ThrottleInterval` of 10 seconds, the same environment, and stdout/stderr sent
to `~/.local/state/finance-planner/finance-planner.log`.

Note that a LaunchAgent starts when you log in, not when the machine boots. On a
Mac used as a server, log in and enable automatic login.

### The four lines that matter, and why

**`WorkingDirectory` is not cosmetic.** Simulation workers are spawned with
`execArgv: ['--import', 'tsx']`, and Node resolves that bare `tsx` against the
process's *working directory* rather than against the file that asked for it.
Start the server from anywhere else and it boots, serves the whole interface,
reads and writes the data folder — and then every Monte Carlo run, every
historical run, every snapshot score and every search fails with
`ERR_MODULE_NOT_FOUND` naming a directory you never chose. `npm start` conceals
this because npm always runs scripts from the package root. A service does not.

**`PATH` must contain node's own directory.** The launcher is
`node_modules/.bin/tsx`, a symlink to a `.mjs` whose shebang is
`#!/usr/bin/env node`. systemd hands a user unit a minimal PATH and launchd
hands an agent even less, so an nvm, fnm, asdf or Homebrew node — which is to
say almost every node — is simply not found.

**`FPLAN_NO_OPEN=1`** stops the server shelling out to a desktop browser at
boot. On a headless box that is a harmless failure, but a service groping for a
GUI is noise where noise is expensive.

**`Restart=on-failure`, never `always`.** `always` fights `systemctl stop`, and
with auto-update on it turns a bad commit into an endless rebuild loop instead
of a stopped service with a log you can read.

### Neither definition ever sets `FPLAN_VITE_URL`

Setting it replaces static file serving entirely and 307-redirects every
non-API request to a Vite dev server. In production that server is not running,
so the interface simply vanishes. It is a development-only switch that
`scripts/dev.mjs` sets, and it must stay out of any unit file.

---

## Day to day

```bash
scripts/service.sh status        # is it installed, is it answering, where is its data
scripts/service.sh logs          # last 200 lines
scripts/service.sh logs -f       # follow
scripts/service.sh stop          # waits for in-flight work first
scripts/service.sh start
scripts/service.sh restart       # ditto; --force to skip the wait
```

`service.sh` is the same verbs on both platforms, so you never have to remember
whether this machine wants `systemctl --user` or `launchctl bootout gui/501/…`.

---

## Updating

```bash
scripts/update.sh
```

In order, and the order is the point:

1. Record the current commit and engine version.
2. **Wait for the app to go quiet.** See below — this is the step the script
   exists for.
3. Stop, and wait for the port to actually fall silent rather than merely for
   the stop command to return.
4. `git pull --ff-only`. After the stop, never before: pulling rewrites the
   `.ts` files a running server's workers load at spawn time, so a pull under a
   live process can put new engine code and an old parent in one run.
5. `npm ci` only if the lockfile moved. Rebuild the interface **always**.
6. Start, wait for an answer, and report `commit a1b2c3d -> e4f5g6h`,
   `engine 1.21.0 -> 1.22.0`.

If the pull fails it starts the old version again rather than leaving you with
nothing.

| Flag | |
|---|---|
| `--force` | do not wait for in-flight work. Says what you are giving up. |
| `--no-pull` | rebuild and restart what is already in the checkout |
| `--timeout S` | how long to wait for quiet (default 1800) |

### Why it waits, and what it is watching

Taking a net-worth snapshot writes the row **immediately** and then starts a
10,000-path scoring run in the background without waiting for it, followed by a
separate solve for the sustainable-spend figure. Kill the process in either gap
and the row survives with a hole in it that nothing can ever fill: a snapshot is
scored exactly once, when it is taken. The re-score route and its button were
deliberately removed, because scoring a past row against today's plan produces a
number that was never true of that row. The prices in it come from a day that
has passed. **This has already cost one real record its figure.**

So the updater asks the app what it is doing:

- `GET /api/networth/scoring` — snapshot rows being scored
- `GET /api/plan/history/scoring` — plan versions being scored

and requires several consecutive empty answers, because one reading is a sample.
An answer it cannot read — a 500, a truncated body — counts as **busy**. Waiting
when nothing is running costs a slow update; guessing the other way costs a
measurement nobody can take again.

Those two endpoints are the only ones the app has, and they do not cover
everything. A running **search** does not appear in `GET /api/searches`, because
a search's report is written only when it finishes. An interactive **Workbench
run** is invisible entirely, because the run map is never enumerated. So the
updater also watches the three directories that nothing but computation writes
to — `runs/`, `searches/` and `searches/scores/` — and treats a file written in
the last 20 seconds as work in progress. (Not `plan.json` or `profile.json`:
those are rewritten on every knob turn, so watching them would mean waiting for
you to stop typing.)

Losing an unfinished interactive run is fine, and losing a search's report costs
only the report — every evaluation it made is already cached on disk, so
re-running replays from cache. Only the two scoring flows are unrecoverable, and
only they are worth blocking an update for.

### Auto-update (opt-in)

```bash
scripts/install.sh --auto-update
```

The service then pulls fast-forward-only on every start, reinstalls dependencies
if the lockfile moved, rebuilds the interface if the commit moved, and starts
regardless of whether any of that worked — a service refusing to start because a
network was down is worse than one running last week's code, and the log says
which happened.

**It is off by default and you probably want it to stay off.** The honest cost:

- A commit that pulls cleanly, builds cleanly and then throws at boot leaves the
  service in a **restart loop**. There is no rollback and no health gate: nothing
  compares "did it serve a request afterwards" against "did it serve one
  before".
- The failure appears **at boot**, which is the moment you are least likely to be
  watching, and its cause is a commit you may not have read.
- The running code becomes whatever was last pushed. That is the entire point of
  the feature and also its entire risk.

`scripts/update.sh`, run deliberately, gives you the wait for in-flight work,
the from/to report, and yourself standing in front of the machine when it
restarts. Prefer it.

To turn auto-update off again: `scripts/install.sh` (no `--auto-update`), or
edit `FPLAN_AUTO_UPDATE` in `~/.config/finance-planner/config.env` and re-run
`install.sh`.

---

## Uninstalling

```bash
scripts/uninstall.sh
```

Stops the service (waiting for in-flight work first), removes the unit or agent,
removes `~/.config/finance-planner/config.env`, and prints where your data is
and how big it is.

**It does not delete your data, and there is no flag that does.** That folder
holds the only copy of rows recording prices from days that have passed. A
`--purge` flag is a flag that gets typed by accident at the end of a long
evening by somebody who meant to reinstall. Deleting it is an `rm` you write out
yourself.

The checkout is left alone too.

---

## Environment variables

Everything the app reads. There are no others, no config file it parses, and no
command-line arguments.

| | |
|---|---|
| `FPLAN_DATA_DIR` | the data folder. Default `~/finance-planner-data` — but under a service `os.homedir()` is whatever the service manager decided `HOME` means, so the installer always sets this explicitly. |
| `FPLAN_PORT` | default `5599`. Unset means the default; a value that cannot be a port now **stops the boot** rather than silently falling back to 5599, which is how a unit file, the docs and a reverse proxy end up disagreeing about where the server is. |
| `FPLAN_HOST` | default `127.0.0.1`. Any non-loopback value prints a full-width warning at every boot naming exactly what has been exposed. See the security section. |
| `FPLAN_NO_OPEN` | any non-empty value stops the browser opening. Note it is a truthiness check: `FPLAN_NO_OPEN=0` also disables it. |
| `FPLAN_AUTO_UPDATE` | `1` turns on the opt-in pull-on-start above. |
| `FPLAN_VITE_URL` | **development only.** Must never be set in a unit file. |

---

## When it will not start

**Check the log first.** `scripts/service.sh logs` on either platform.

**"Another Finance Planner is already writing …"** — exactly what it says, and
the message names the process, its port and its checkout. Usually a development
server you forgot about. Two servers on one data folder discard each other's
writes silently, so this refusal is deliberate. See
[DEVELOPMENT.md](DEVELOPMENT.md).

**"FPLAN_PORT is … which is not a number"** — fix or remove the value. This is
new behaviour: it used to fall back to 5599 without a word.

**"Node … is too old"** — 20.6 minimum, and the reason is in the message.

**The app is up but every run fails with `ERR_MODULE_NOT_FOUND`** — the working
directory is wrong. That is the failure `WorkingDirectory` exists to prevent, so
either the unit was edited or the service is being started some other way. The
directory in the error message is the one the process is actually in.

**Every page is a stub saying "UI not built"** — `npm run build:ui` did not run
or failed. `dist/` is gitignored, so a fresh clone has no interface. Re-run
`scripts/install.sh`, or `npm run build:ui` by hand.

**The service is enabled but nothing runs after a reboot** — on Linux,
lingering. `loginctl show-user $USER | grep Linger` should say `yes`; if not,
`sudo loginctl enable-linger $USER`. On macOS, a LaunchAgent needs a login
session, so enable automatic login.

**Simulations are extremely slow** — check the core count. In a container,
`os.cpus()` reports the host's cores rather than your quota, so the worker pool
is sized for a machine you do not have.

**The disk filled up** — `runs/` and `searches/scores/` are never pruned. Stop
the service, empty them, start it. They are caches; you lose only recomputation.
