#!/usr/bin/env bash
# Shared plumbing for install.sh, update.sh, uninstall.sh and service.sh.
#
# Sourced, never executed. Every function is prefixed `fplan_` so that sourcing
# it into an interactive shell cannot shadow anything.
#
# THE ONE IDEA WORTH KNOWING: this file is the only place that knows the
# difference between systemd and launchd. The four top-level scripts talk in
# verbs — start, stop, is_running, logs — and never in `systemctl` or
# `launchctl`. That is what keeps update.sh's careful ordering readable, and it
# is what makes adding a third platform a change in one file.

set -euo pipefail

FPLAN_LABEL="${FPLAN_LABEL:-finance-planner}"
FPLAN_CONFIG_DIR="${FPLAN_CONFIG_DIR:-$HOME/.config/finance-planner}"
FPLAN_CONFIG_FILE="$FPLAN_CONFIG_DIR/config.env"
FPLAN_STATE_DIR="${FPLAN_STATE_DIR:-$HOME/.local/state/finance-planner}"

# ---------------------------------------------------------------------------
# Output
# ---------------------------------------------------------------------------

fplan_say()  { printf '%s\n' "$*"; }
fplan_step() { printf '\n==> %s\n' "$*"; }
fplan_warn() { printf 'warning: %s\n' "$*" >&2; }
fplan_die()  { printf 'error: %s\n' "$*" >&2; exit 1; }

# ---------------------------------------------------------------------------
# Platform
# ---------------------------------------------------------------------------

# Echoes `linux`, `macos`, or dies with a sentence that says what is missing
# rather than "unsupported platform". Someone on a Linux box without a user
# systemd needs to know that is the problem, not that Linux is the problem.
fplan_platform() {
  case "$(uname -s)" in
    Linux)
      command -v systemctl >/dev/null 2>&1 || fplan_die \
"This Linux system has no systemctl, so there is no service manager to install into.

The app itself still runs fine — see DEVELOPMENT.md for running it by hand, or
supervise it with whatever this system does use (runit, OpenRC, supervisord).
Whatever you use must set WorkingDirectory to the checkout: simulation workers
resolve the tsx loader against the working directory, and from anywhere else
every run fails while the app otherwise looks healthy."
      printf 'linux\n'
      ;;
    Darwin)
      command -v launchctl >/dev/null 2>&1 || fplan_die "No launchctl on this Mac, which should be impossible."
      printf 'macos\n'
      ;;
    *)
      fplan_die \
"Unsupported platform: $(uname -s).

install.sh knows how to write a systemd user unit (Linux) and a launchd agent
(macOS) and nothing else. Windows and the BSDs are not half-supported here —
they are not supported, deliberately, rather than left to fail somewhere less
obvious. Run it by hand instead; see DEVELOPMENT.md."
      ;;
  esac
}

# ---------------------------------------------------------------------------
# Config file
# ---------------------------------------------------------------------------

# Load previously-installed settings, if any. This is what makes a second
# `install.sh` with no flags an idempotent no-op instead of a silent reset of
# the port and data folder back to their defaults.
fplan_load_config() {
  if [ -f "$FPLAN_CONFIG_FILE" ]; then
    # shellcheck disable=SC1090
    . "$FPLAN_CONFIG_FILE"
  fi
}

# Single-quote a value for a config file, escaping any embedded single quote.
fplan_shell_quote() {
  printf "'%s'" "$(printf '%s' "$1" | sed "s/'/'\\\\''/g")"
}

fplan_save_config() {
  mkdir -p "$FPLAN_CONFIG_DIR"
  {
    printf '# Written by scripts/install.sh. Edit and re-run install.sh to apply.\n'
    printf 'FPLAN_APP_DIR=%s\n'   "$(fplan_shell_quote "$FPLAN_APP_DIR")"
    printf 'FPLAN_DATA_DIR=%s\n'  "$(fplan_shell_quote "$FPLAN_DATA_DIR")"
    printf 'FPLAN_PORT=%s\n'      "$(fplan_shell_quote "$FPLAN_PORT")"
    printf 'FPLAN_HOST=%s\n'      "$(fplan_shell_quote "$FPLAN_HOST")"
    printf 'FPLAN_NODE_BIN=%s\n'  "$(fplan_shell_quote "$FPLAN_NODE_BIN")"
    printf 'FPLAN_AUTO_UPDATE=%s\n' "$(fplan_shell_quote "$FPLAN_AUTO_UPDATE")"
    printf 'FPLAN_LOG_FILE=%s\n'  "$(fplan_shell_quote "$FPLAN_LOG_FILE")"
  } > "$FPLAN_CONFIG_FILE"
  chmod 600 "$FPLAN_CONFIG_FILE"
}

# Everything the scripts need, with the config file as the source of truth and
# the environment able to override it for a one-off.
fplan_require_config() {
  fplan_load_config
  FPLAN_APP_DIR="${FPLAN_APP_DIR:-}"
  [ -n "$FPLAN_APP_DIR" ] || fplan_die \
"No install found ($FPLAN_CONFIG_FILE is missing).

Run scripts/install.sh first, or set FPLAN_APP_DIR and FPLAN_DATA_DIR by hand."
  FPLAN_DATA_DIR="${FPLAN_DATA_DIR:-$HOME/finance-planner-data}"
  FPLAN_PORT="${FPLAN_PORT:-5599}"
  FPLAN_HOST="${FPLAN_HOST:-127.0.0.1}"
  FPLAN_NODE_BIN="${FPLAN_NODE_BIN:-$(command -v node || true)}"
  FPLAN_AUTO_UPDATE="${FPLAN_AUTO_UPDATE:-0}"
  FPLAN_LOG_FILE="${FPLAN_LOG_FILE:-$FPLAN_STATE_DIR/finance-planner.log}"
}

# ---------------------------------------------------------------------------
# Service paths
# ---------------------------------------------------------------------------

fplan_systemd_unit_path() { printf '%s/.config/systemd/user/%s.service\n' "$HOME" "$FPLAN_LABEL"; }
fplan_launchd_label()     { printf 'com.%s.server\n' "$FPLAN_LABEL"; }
fplan_launchd_plist_path(){ printf '%s/Library/LaunchAgents/%s.plist\n' "$HOME" "$(fplan_launchd_label)"; }

fplan_service_installed() {
  case "$(fplan_platform)" in
    linux) [ -f "$(fplan_systemd_unit_path)" ] ;;
    macos) [ -f "$(fplan_launchd_plist_path)" ] ;;
  esac
}

# ---------------------------------------------------------------------------
# Service control
# ---------------------------------------------------------------------------

fplan_service_start() {
  case "$(fplan_platform)" in
    linux)
      systemctl --user start "$FPLAN_LABEL.service"
      ;;
    macos)
      local plist label
      plist="$(fplan_launchd_plist_path)"
      label="$(fplan_launchd_label)"
      # bootstrap is the modern verb; load -w is the one older macOS has. Try
      # the good one, accept the old one, and only then complain.
      launchctl bootstrap "gui/$(id -u)" "$plist" 2>/dev/null \
        || launchctl load -w "$plist" 2>/dev/null \
        || launchctl kickstart "gui/$(id -u)/$label" 2>/dev/null \
        || fplan_die "launchctl refused to start $label. Try: launchctl print gui/$(id -u)/$label"
      ;;
  esac
}

fplan_service_stop() {
  case "$(fplan_platform)" in
    linux)
      systemctl --user stop "$FPLAN_LABEL.service" 2>/dev/null || true
      ;;
    macos)
      launchctl bootout "gui/$(id -u)/$(fplan_launchd_label)" 2>/dev/null \
        || launchctl unload -w "$(fplan_launchd_plist_path)" 2>/dev/null \
        || true
      ;;
  esac
}

fplan_service_enable() {
  case "$(fplan_platform)" in
    linux)
      systemctl --user daemon-reload
      systemctl --user enable "$FPLAN_LABEL.service" >/dev/null
      ;;
    macos)
      : # RunAtLoad in the plist is launchd's equivalent; bootstrap does the rest.
      ;;
  esac
}

fplan_service_disable() {
  case "$(fplan_platform)" in
    linux)
      systemctl --user disable "$FPLAN_LABEL.service" >/dev/null 2>&1 || true
      systemctl --user daemon-reload || true
      ;;
    macos) : ;;
  esac
}

fplan_service_status() {
  case "$(fplan_platform)" in
    linux) systemctl --user status "$FPLAN_LABEL.service" --no-pager || true ;;
    macos) launchctl print "gui/$(id -u)/$(fplan_launchd_label)" 2>/dev/null || fplan_say "not loaded" ;;
  esac
}

fplan_service_logs() {
  local follow="${1:-}"
  case "$(fplan_platform)" in
    linux)
      if [ "$follow" = "follow" ]; then
        journalctl --user -u "$FPLAN_LABEL.service" -f
      else
        journalctl --user -u "$FPLAN_LABEL.service" -n 200 --no-pager
      fi
      ;;
    macos)
      [ -f "$FPLAN_LOG_FILE" ] || fplan_die "No log file yet at $FPLAN_LOG_FILE"
      if [ "$follow" = "follow" ]; then
        tail -f "$FPLAN_LOG_FILE"
      else
        tail -n 200 "$FPLAN_LOG_FILE"
      fi
      ;;
  esac
}

# ---------------------------------------------------------------------------
# Health
# ---------------------------------------------------------------------------

fplan_base_url() { printf 'http://127.0.0.1:%s\n' "$FPLAN_PORT"; }

fplan_is_answering() {
  curl -fsS --max-time 3 "$(fplan_base_url)/api/meta" >/dev/null 2>&1
}

# WAIT FOR THE PROCESS TO BE GONE, not merely for the stop command to return.
# Two servers on one data folder lose each other's writes silently, so the next
# start must not begin while the last one is still exiting. The app's own lock
# would catch an overlap and refuse — this just means it never has to.
fplan_wait_stopped() {
  local waited=0 limit="${1:-30}"
  while fplan_is_answering; do
    if [ "$waited" -ge "$limit" ]; then
      fplan_die "Still answering on $(fplan_base_url) after ${limit}s. Refusing to start a second copy against the same data folder."
    fi
    sleep 1
    waited=$((waited + 1))
  done
}

fplan_wait_answering() {
  local waited=0 limit="${1:-45}"
  while ! fplan_is_answering; do
    if [ "$waited" -ge "$limit" ]; then
      return 1
    fi
    sleep 1
    waited=$((waited + 1))
  done
  return 0
}

# ---------------------------------------------------------------------------
# Node
# ---------------------------------------------------------------------------

# The floor is 20.6, not the 20 in package.json's `engines`. Worker threads are
# spawned with `execArgv: ['--import', 'tsx']`, and `--import` landed in Node
# 20.6.0 — on 20.0-20.5 the app boots and serves and then every simulation dies.
fplan_check_node() {
  local bin="$1" version major minor
  [ -x "$bin" ] || command -v "$bin" >/dev/null 2>&1 || fplan_die "No node found. Install Node 20.6 or newer (22 LTS recommended)."
  version="$("$bin" --version 2>/dev/null | sed 's/^v//')"
  [ -n "$version" ] || fplan_die "Could not read a version out of $bin --version"
  major="${version%%.*}"
  minor="$(printf '%s' "$version" | cut -d. -f2)"
  if [ "$major" -lt 20 ] || { [ "$major" -eq 20 ] && [ "$minor" -lt 6 ]; }; then
    fplan_die \
"Node $version is too old. This needs 20.6 or newer (22 LTS recommended).

Not a style preference: simulations run in worker threads started with
--import, which arrived in 20.6.0. On an older 20.x the server starts, serves
the interface, and then fails every single run."
  fi
  fplan_say "node $version at $bin"
}

# ---------------------------------------------------------------------------
# In-flight work
# ---------------------------------------------------------------------------

# Block until nothing is computing, or die trying.
#
# The reason this is not optional, and not a sleep: a net-worth snapshot writes
# its row immediately and then runs a 10,000-path score in the background, and
# after that a second solve for the sustainable-spend figure. Kill the process
# in either gap and the row keeps its prices and loses its number FOREVER —
# snapshotScorer.ts is the only place a row is ever scored, and the re-score
# route was deliberately removed because scoring a past row against today's
# plan produced a figure that was never true of it. It has happened once here
# already. scripts/lib/quiet.ts explains what the app can and cannot tell us.
#
# $1: extra seconds to wait for quiet. Pass "force" as $2 to warn instead of die.
fplan_wait_quiet() {
  local timeout="${1:-1800}" mode="${2:-strict}" tsx="$FPLAN_APP_DIR/node_modules/.bin/tsx"

  if [ ! -x "$tsx" ] && [ ! -f "$tsx" ]; then
    fplan_warn "no tsx in $FPLAN_APP_DIR/node_modules — skipping the in-flight check"
    return 0
  fi
  if [ -n "${FPLAN_NODE_BIN:-}" ]; then
    PATH="$(dirname -- "$FPLAN_NODE_BIN"):$PATH"
    export PATH
  fi

  fplan_say "Waiting for simulations and scoring to finish before touching anything."
  if "$tsx" "$FPLAN_APP_DIR/scripts/lib/quiet.ts" \
      --base-url "$(fplan_base_url)" \
      --data-dir "$FPLAN_DATA_DIR" \
      --timeout "$timeout"; then
    return 0
  fi

  if [ "$mode" = "force" ]; then
    fplan_warn "--force: restarting anyway. A snapshot or plan-version score in flight right now will lose its figure permanently."
    return 0
  fi
  fplan_die \
"Refusing to restart while work is in flight.

A restart here can cost a net-worth row its score permanently — there is no
re-score, by design. Wait and run this again, cancel a running search from the
Explore page, or re-run with --force if you accept losing whatever is running."
}
