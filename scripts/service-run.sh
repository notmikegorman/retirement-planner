#!/usr/bin/env bash
# What the service actually executes. Both the systemd unit and the launchd
# agent point here rather than at node, so the three things that are easy to get
# wrong in a unit file are got right in one place instead of two.
#
# 1. THE WORKING DIRECTORY. Every simulation runs in a worker thread spawned
#    with `execArgv: ['--import', 'tsx']` (see src/server/runManager.ts and
#    src/server/search/pool.ts). Node resolves that bare `tsx` against the
#    process's working directory, NOT against the file that requested it. Start
#    the server from anywhere else and it boots, seeds the data folder, serves
#    the whole interface — and then every Monte Carlo run, every historical
#    run, every snapshot score, every plan-version score and every search fails
#    with ERR_MODULE_NOT_FOUND naming a directory nobody chose. `npm start`
#    conceals this because npm always runs scripts from the package root.
#
# 2. THE LAUNCHER. There is no build step for the server: tsx runs the
#    TypeScript sources directly in production, which is why tsx is a runtime
#    dependency and not a dev one. node_modules/.bin/tsx is a symlink to a .mjs
#    whose shebang is `#!/usr/bin/env node`, so `node` has to be findable —
#    and a service gets a minimal PATH that almost never contains an nvm, fnm,
#    asdf or Homebrew node.
#
# 3. exec, not a child process. The service manager supervises whatever PID it
#    started; wrapping node in a shell that waits on it means SIGTERM goes to
#    the shell and the real server is orphaned.

set -euo pipefail

here="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
APP_DIR="${FPLAN_APP_DIR:-$here/..}"

# Run by hand rather than by the service manager? Then nothing has set the
# environment, so pick up whatever install.sh recorded.
if [ -z "${FPLAN_APP_DIR:-}" ] && [ -f "${FPLAN_CONFIG_DIR:-$HOME/.config/finance-planner}/config.env" ]; then
  # shellcheck disable=SC1090,SC1091
  . "${FPLAN_CONFIG_DIR:-$HOME/.config/finance-planner}/config.env"
  APP_DIR="${FPLAN_APP_DIR:-$APP_DIR}"
  export FPLAN_DATA_DIR FPLAN_PORT FPLAN_HOST
fi

APP_DIR="$(cd -- "$APP_DIR" && pwd)"
cd "$APP_DIR"

if [ -n "${FPLAN_NODE_BIN:-}" ]; then
  PATH="$(dirname -- "$FPLAN_NODE_BIN"):$PATH"
  export PATH
fi

# A service must not grope for a desktop browser. Set here as well as in the
# unit so that running this script by hand behaves the same way.
export FPLAN_NO_OPEN=1

# ---------------------------------------------------------------------------
# Opt-in auto-update. Default OFF, and read the block below before turning it on.
# ---------------------------------------------------------------------------
#
# WHAT IT DOES: pulls fast-forward-only, reinstalls dependencies if and only if
# the lockfile moved, and rebuilds the UI if the commit moved at all. Then it
# starts the server regardless of whether any of that worked.
#
# WHY FAILURE IS NOT FATAL HERE. A service that refuses to start because a
# network was down is a worse outcome than a service running last week's code,
# and the log says exactly which happened. But note carefully what that does
# NOT protect you from, because this is the honest cost of the feature:
#
#   - A commit that pulls cleanly, builds cleanly, and then throws at boot
#     leaves you with a service in a restart loop. There is no rollback here
#     and no health gate: nothing compares "did it serve a request afterwards"
#     against "did it serve one before".
#   - The failure appears at BOOT, which is the moment you are least likely to
#     be watching, and its cause is a commit you may not have read.
#   - `git pull` on a machine you are not looking at means the running code is
#     whatever was last pushed. That is the entire point of the feature and
#     also its entire risk.
#
# The alternative — scripts/update.sh, run deliberately — waits for in-flight
# work, tells you which commit it moved from and to, and leaves you standing in
# front of the machine when it restarts. Prefer it. This exists because it was
# asked for, and it is off unless FPLAN_AUTO_UPDATE=1.
if [ "${FPLAN_AUTO_UPDATE:-0}" = "1" ]; then
  printf '[auto-update] enabled; checking for new commits\n'
  if [ -d "$APP_DIR/.git" ] && command -v git >/dev/null 2>&1; then
    before="$(git -C "$APP_DIR" rev-parse HEAD 2>/dev/null || echo unknown)"
    lock_before="$(cksum "$APP_DIR/package-lock.json" 2>/dev/null || echo none)"

    if git -C "$APP_DIR" pull --ff-only 2>&1; then
      after="$(git -C "$APP_DIR" rev-parse HEAD 2>/dev/null || echo unknown)"
      if [ "$before" = "$after" ]; then
        printf '[auto-update] already current at %s\n' "${before:0:12}"
      else
        printf '[auto-update] %s -> %s\n' "${before:0:12}" "${after:0:12}"
        lock_after="$(cksum "$APP_DIR/package-lock.json" 2>/dev/null || echo none)"
        if [ "$lock_before" != "$lock_after" ]; then
          printf '[auto-update] lockfile moved; reinstalling dependencies\n'
          npm ci || printf '[auto-update] npm ci FAILED — node_modules may be incomplete\n'
        fi
        npm run build:ui || printf '[auto-update] UI build FAILED — serving the previously built dist/ui\n'
      fi
    else
      printf '[auto-update] pull failed (offline? diverged? local edits?) — starting the code already here\n'
    fi
  else
    printf '[auto-update] %s is not a git checkout — nothing to pull\n' "$APP_DIR"
  fi
fi

exec "$APP_DIR/node_modules/.bin/tsx" src/server/server.ts
