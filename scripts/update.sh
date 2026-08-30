#!/usr/bin/env bash
# Move the installed copy to newer code, without killing anything mid-thought.
#
# THE ORDER IS THE POINT, so it is worth stating before the code says it:
#
#   1. Record where we are (commit and engine version), so the last line of
#      output can say what actually changed.
#   2. WAIT FOR THE APP TO GO QUIET. This is the step this script exists for.
#      A net-worth snapshot writes its row immediately and then runs a
#      10,000-path score in the background, followed by a separate solve for
#      the sustainable-spend figure. A restart in either gap leaves the row
#      with prices and no number, forever: snapshotScorer.ts is the only place
#      a row is ever scored, and the re-score route was deliberately removed
#      because scoring an old row against today's plan produces a figure that
#      was never true of it. This has already cost one real record. See
#      scripts/lib/quiet.ts for what the app can and cannot report.
#   3. Stop, and wait for the port to actually go silent — not merely for the
#      stop command to return. Two servers on one data folder silently discard
#      each other's writes.
#   4. THEN pull. Not before: `git pull` rewrites the .ts files that a running
#      server's simulation workers load at spawn time, so pulling under a live
#      process can put new engine code and an old parent in the same run.
#   5. Reinstall dependencies only if the lockfile moved. Rebuild the UI
#      always — a stale dist/ui showing an old interface over a new engine is
#      this project's most expensive failure mode, and it is invisible.
#   6. Start, wait for it to answer, and say where it moved from and to.
#
# If the pull fails, the old code is started again rather than left down.

set -euo pipefail
here="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib/common.sh
. "$here/lib/common.sh"

usage() {
  cat <<'EOF'
usage: scripts/update.sh [options]

  --force        do not wait for in-flight simulations. A snapshot or
                 plan-version score running right now will lose its figure
                 permanently, and nothing can put it back.
  --no-pull      rebuild and restart the code already in the checkout
  --timeout S    how long to wait for quiet before giving up (default 1800;
                 the app's own ceiling on a scoring attempt is 20 minutes)
  -h, --help     this
EOF
}

force=""
do_pull=1
timeout=1800

while [ $# -gt 0 ]; do
  case "$1" in
    --force)    force="force"; shift ;;
    --no-pull)  do_pull=0; shift ;;
    --timeout)  timeout="$2"; shift 2 ;;
    -h|--help)  usage; exit 0 ;;
    *) usage >&2; fplan_die "unknown option: $1" ;;
  esac
done

fplan_require_config
cd "$FPLAN_APP_DIR"

engine_version() {
  sed -n "s/^export const ENGINE_VERSION = '\\([^']*\\)';.*/\\1/p" "$FPLAN_APP_DIR/src/shared/types.ts" | head -1
}
short_head() {
  git -C "$FPLAN_APP_DIR" rev-parse --short HEAD 2>/dev/null || printf 'unknown\n'
}

from_commit="$(short_head)"
from_engine="$(engine_version)"

fplan_step "Retirement Planner at $FPLAN_APP_DIR"
fplan_say "  currently: commit $from_commit, engine $from_engine"
fplan_say "  data:      $FPLAN_DATA_DIR"

# --- 2. wait for quiet -----------------------------------------------------

if fplan_is_answering || [ -d "$FPLAN_DATA_DIR" ]; then
  fplan_step "Checking for work in flight"
  fplan_wait_quiet "$timeout" "${force:-strict}"
else
  fplan_say "Nothing is running."
fi

# --- 3. stop ---------------------------------------------------------------

was_running=0
if fplan_is_answering; then was_running=1; fi

if fplan_service_installed; then
  fplan_step "Stopping the service"
  fplan_service_stop
  fplan_wait_stopped 30
elif [ "$was_running" -eq 1 ]; then
  fplan_die \
"Something is serving $(fplan_base_url) but no service is installed here.

That is almost certainly a development checkout. Stop it yourself before
updating — this script will not kill a process it did not start."
fi

restart_and_die() {
  fplan_warn "$1"
  if fplan_service_installed && [ "$was_running" -eq 1 ]; then
    fplan_warn "restarting the previous version so you are not left with nothing"
    fplan_service_start || true
  fi
  exit 1
}

# --- 4. pull ---------------------------------------------------------------

lock_before="$(cksum package-lock.json 2>/dev/null || echo none)"

if [ "$do_pull" -eq 1 ]; then
  if [ ! -d .git ]; then
    fplan_warn "$FPLAN_APP_DIR is not a git checkout; nothing to pull"
  elif [ -z "$(git remote)" ]; then
    fplan_warn "no git remote is configured, so there is nowhere to pull from.
  Add one with: git remote add origin <url>
  Rebuilding and restarting the code already here."
  elif ! git diff --quiet || ! git diff --cached --quiet; then
    restart_and_die "the checkout has uncommitted changes. Commit or stash them, then run this again.
  An installed copy should be a clean checkout; edit code in your development clone instead."
  else
    fplan_step "Pulling"
    # --ff-only: a merge commit created unattended on a machine nobody is
    # looking at is a worse problem than a failed update.
    git pull --ff-only || restart_and_die "git pull failed. Nothing was changed."
  fi
fi

to_commit="$(short_head)"

# --- 5. dependencies and build --------------------------------------------

lock_after="$(cksum package-lock.json 2>/dev/null || echo none)"

if [ ! -d node_modules ] || [ "$lock_before" != "$lock_after" ]; then
  fplan_step "Dependencies changed; reinstalling"
  npm ci || restart_and_die "npm ci failed. node_modules may now be incomplete — fix it before starting."
else
  fplan_say "Dependencies unchanged."
fi

# ALWAYS, even when the commit did not move. A dist/ui built from older sources
# is served happily by a newer server, and nothing on screen says so — a whole
# session was once spent looking at an old interface computing new numbers.
# The build takes seconds; the confusion takes hours.
fplan_step "Rebuilding the interface"
npm run build:ui || restart_and_die "the UI build failed. Not starting a server that would serve a stale interface."

to_engine="$(engine_version)"

# --- 6. start --------------------------------------------------------------

if fplan_service_installed; then
  fplan_step "Starting"
  fplan_service_start
  if ! fplan_wait_answering 60; then
    fplan_warn "the service did not answer on $(fplan_base_url) within 60s"
    fplan_say "Look at the log: $FPLAN_APP_DIR/scripts/service.sh logs"
    exit 1
  fi
fi

fplan_step "Done"
if [ "$from_commit" = "$to_commit" ] && [ "$from_engine" = "$to_engine" ]; then
  fplan_say "  no new commits — rebuilt $from_commit (engine $from_engine)"
else
  fplan_say "  commit  $from_commit -> $to_commit"
  fplan_say "  engine  $from_engine -> $to_engine"
  if [ "$from_engine" != "$to_engine" ]; then
    fplan_say ""
    fplan_say "  The engine version is part of the run cache key, so every cached"
    fplan_say "  result is now a miss and the first run of each kind will be slow."
  fi
fi
# Only claim it is serving if it actually is. With --no-service there is nothing
# to start, and a closing line that says "serving" over a port with nothing
# behind it is the kind of small lie that costs somebody ten minutes.
if fplan_is_answering; then
  fplan_say "  serving $(fplan_base_url)/"
else
  fplan_say "  not started (no service installed) — run it with: $FPLAN_APP_DIR/scripts/service-run.sh"
fi
