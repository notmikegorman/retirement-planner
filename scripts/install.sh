#!/usr/bin/env bash
# Install Finance Planner as a service that starts at boot, on Linux (systemd
# user unit) or macOS (launchd agent).
#
# Safe to run twice. A second run against an existing install reads back what
# the first one chose, so `install.sh` with no flags changes nothing rather
# than quietly resetting the port and the data folder to their defaults. It
# also waits for in-flight simulations before it stops anything — see below.
#
# WHAT IT DELIBERATELY DOES NOT DO:
#   - run as root. This is one person's financial planner, listening on
#     loopback, with no authentication. It has no business owning a system
#     unit, and every file it touches belongs to the person running it.
#   - `git pull`. It installs the checkout you point it at. Moving to newer
#     code is scripts/update.sh's job, because that one has to wait for work in
#     flight and report which commit it moved from.
#   - install with `--omit=dev`. Vite is a devDependency and the UI has to be
#     built from source, because dist/ is gitignored and therefore absent from
#     every fresh clone.

set -euo pipefail
here="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib/common.sh
. "$here/lib/common.sh"

usage() {
  cat <<'EOF'
usage: scripts/install.sh [options]

  --app-dir DIR     where the checkout lives (default: the checkout this
                    script was run from)
  --repo URL        clone URL, used only when --app-dir does not exist yet
  --data-dir DIR    where your plan and history live
                    (default: ~/finance-planner-data)
  --port N          port to listen on, loopback only (default: 5599)
  --auto-update     have the service `git pull` on every start (default off;
                    read the warning it prints before choosing this)
  --no-start        install the service but leave it stopped
  --no-service      set up the app but install no service at all
  --force           skip the wait for in-flight simulations (see update.sh)
  -h, --help        this

The app binds 127.0.0.1 and has NO authentication. Read the security section of
README.md before making it reachable from anywhere else.
EOF
}

# ---------------------------------------------------------------------------
# Arguments, layered over anything a previous install recorded
# ---------------------------------------------------------------------------

fplan_load_config

app_dir="${FPLAN_APP_DIR:-$(cd -- "$here/.." && pwd)}"
data_dir="${FPLAN_DATA_DIR:-$HOME/finance-planner-data}"
port="${FPLAN_PORT:-5599}"
host="${FPLAN_HOST:-127.0.0.1}"
auto_update="${FPLAN_AUTO_UPDATE:-0}"
log_file="${FPLAN_LOG_FILE:-$FPLAN_STATE_DIR/finance-planner.log}"
repo=""
do_start=1
do_service=1
force=""

while [ $# -gt 0 ]; do
  case "$1" in
    --app-dir)   app_dir="$2"; shift 2 ;;
    --repo)      repo="$2"; shift 2 ;;
    --data-dir)  data_dir="$2"; shift 2 ;;
    --port)      port="$2"; shift 2 ;;
    --auto-update) auto_update=1; shift ;;
    --no-start)  do_start=0; shift ;;
    --no-service) do_service=0; shift ;;
    --force)     force="force"; shift ;;
    -h|--help)   usage; exit 0 ;;
    *) usage >&2; fplan_die "unknown option: $1" ;;
  esac
done

[ "$(id -u)" -ne 0 ] || fplan_die \
"Do not install this as root.

It is one person's financial planner: it binds loopback, has no
authentication, and every file it writes should belong to the person whose
plan it holds. Run it as yourself. Both service definitions it writes are
per-user (a systemd --user unit, or a launchd LaunchAgent) and need no
privileges at all."

platform="$(fplan_platform)"
fplan_step "Installing on $platform as $(id -un)"

# ---------------------------------------------------------------------------
# The checkout
# ---------------------------------------------------------------------------

if [ ! -d "$app_dir" ]; then
  [ -n "$repo" ] || fplan_die "$app_dir does not exist. Pass --repo URL to clone it, or --app-dir to point at an existing checkout."
  fplan_step "Cloning $repo into $app_dir"
  git clone "$repo" "$app_dir"
fi
app_dir="$(cd -- "$app_dir" && pwd)"
[ -f "$app_dir/package.json" ] || fplan_die "$app_dir has no package.json — that is not the Finance Planner checkout."

node_bin="${FPLAN_NODE_BIN:-$(command -v node || true)}"
[ -n "$node_bin" ] || fplan_die "No node on PATH. Install Node 22 LTS (20.6 is the hard floor) and run this again."
node_bin="$(command -v "$node_bin")"
fplan_check_node "$node_bin"
command -v npm >/dev/null 2>&1 || fplan_die "No npm on PATH, though node is at $node_bin."

# Export for common.sh's helpers, which read these names.
FPLAN_APP_DIR="$app_dir"
FPLAN_DATA_DIR="$data_dir"
FPLAN_PORT="$port"
FPLAN_HOST="$host"
FPLAN_NODE_BIN="$node_bin"
FPLAN_AUTO_UPDATE="$auto_update"
FPLAN_LOG_FILE="$log_file"

# ---------------------------------------------------------------------------
# Stop anything already running, and only once it is genuinely idle
# ---------------------------------------------------------------------------
#
# `npm ci` deletes node_modules before repopulating it, which under a live
# server means pulling the floor out from under a process that is still
# reading it. And a restart mid-score costs a net-worth row its figure
# permanently. So: wait for quiet, stop, wait for the port to go silent.

if fplan_is_answering; then
  fplan_step "Something is already serving on port $port"
  fplan_wait_quiet 1800 "${force:-strict}"
  if [ "$do_service" -eq 1 ] && fplan_service_installed; then
    fplan_say "Stopping the existing service."
    fplan_service_stop
    fplan_wait_stopped 30
  else
    fplan_die \
"Port $port is being served by something this installer did not install.

That is probably a development checkout (npm run dev). Stop it first, or pass
--port to give the service a port of its own. Two servers must never share one
data folder: they read and write whole files, so the second one silently
discards the first one's writes."
  fi
fi

# ---------------------------------------------------------------------------
# Dependencies and the UI bundle
# ---------------------------------------------------------------------------

fplan_step "Installing dependencies"
# Not --omit=dev: vite lives in devDependencies and the next step needs it.
# The server itself has no build (tsx runs the TypeScript directly), so the
# runtime half really is production-only — it is the UI bundle that is not.
if [ -f "$app_dir/package-lock.json" ]; then
  ( cd "$app_dir" && npm ci )
else
  fplan_warn "no package-lock.json; falling back to npm install"
  ( cd "$app_dir" && npm install )
fi

fplan_step "Building the interface"
# dist/ is gitignored, so a fresh clone has no UI at all. Without this the
# server still starts and the API works, but every page is a stub that says so.
( cd "$app_dir" && npm run build:ui )

# ---------------------------------------------------------------------------
# The data folder
# ---------------------------------------------------------------------------

fplan_step "Data folder: $data_dir"
mkdir -p "$data_dir"
# 0700 because of what is in there: dates of birth, Social Security figures,
# every account balance, and the whole net-worth history, in plain JSON.
chmod 700 "$data_dir"
mkdir -p "$(dirname -- "$log_file")"

fplan_save_config
fplan_say "Settings recorded in $FPLAN_CONFIG_FILE"

# ---------------------------------------------------------------------------
# The service definition
# ---------------------------------------------------------------------------

if [ "$do_service" -eq 0 ]; then
  fplan_step "Skipping the service (--no-service)"
  fplan_say "Run it by hand with: $app_dir/scripts/service-run.sh"
  exit 0
fi

render() {
  "$node_bin" "$app_dir/node_modules/.bin/tsx" "$app_dir/scripts/lib/service.ts" render "$1" \
    --label "$FPLAN_LABEL" \
    --app-dir "$app_dir" \
    --data-dir "$data_dir" \
    --port "$port" \
    --host "$host" \
    --node-bin "$node_bin" \
    --run-script "$app_dir/scripts/service-run.sh" \
    --log-file "$log_file" \
    --auto-update "$auto_update"
}

chmod +x "$app_dir/scripts/service-run.sh"

case "$platform" in
  linux)
    unit="$(fplan_systemd_unit_path)"
    fplan_step "Writing $unit"
    mkdir -p "$(dirname -- "$unit")"
    render systemd > "$unit"
    fplan_service_enable
    # Without lingering, a user unit dies at logout and does not come back at
    # boot — which is exactly the thing "install it as a service" was for.
    if command -v loginctl >/dev/null 2>&1; then
      if ! loginctl enable-linger "$(id -un)" 2>/dev/null; then
        fplan_warn "could not enable lingering; the service will not start until you log in.
  Fix with: sudo loginctl enable-linger $(id -un)"
      fi
    fi
    ;;
  macos)
    plist="$(fplan_launchd_plist_path)"
    fplan_step "Writing $plist"
    mkdir -p "$(dirname -- "$plist")"
    render launchd > "$plist"
    ;;
esac

if [ "$do_start" -eq 0 ]; then
  fplan_step "Installed but not started (--no-start)"
  fplan_say "Start it with: $app_dir/scripts/service.sh start"
  exit 0
fi

fplan_step "Starting"
fplan_service_start

if fplan_wait_answering 60; then
  fplan_step "Running"
else
  fplan_warn "the service did not answer on $(fplan_base_url) within 60s"
  fplan_say "Look at the log: $app_dir/scripts/service.sh logs"
  exit 1
fi

cat <<EOF

  Finance Planner is at   $(fplan_base_url)/
  Your data lives in      $data_dir
  Logs                    $app_dir/scripts/service.sh logs
  Update                  $app_dir/scripts/update.sh
  Stop / start / status   $app_dir/scripts/service.sh <stop|start|status>

  It is listening on 127.0.0.1 and has NO password. Anyone who can reach that
  port can read every balance and date of birth in it, and can overwrite the
  profile or delete a net-worth row with one request. To use it from another
  machine, tunnel to it:

      ssh -N -L $port:127.0.0.1:$port $(id -un)@$(hostname -s 2>/dev/null || hostname)

  then open http://127.0.0.1:$port/ on your own machine. Do not put this on a
  network address without an authenticating proxy in front of it. The security
  section of README.md says exactly what is at stake.

  The starter profile is a fictional example household. Replace it with yours
  on the Profile page, and read ASSUMPTIONS.md while you do.
EOF
