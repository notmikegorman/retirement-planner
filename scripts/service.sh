#!/usr/bin/env bash
# One verb per line, so you never have to remember whether this machine wants
# `systemctl --user` or `launchctl bootout gui/501/...`.
#
#   service.sh start | stop | restart | status | logs [-f] | url
#
# `restart` waits for in-flight simulations first, for the same reason
# update.sh does: a snapshot's score and its sustainable-spend solve run in the
# background after the row is written, and a restart in between costs that row
# its figure permanently. Pass --force to skip the wait and accept that.

set -euo pipefail
here="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib/common.sh
. "$here/lib/common.sh"

command="${1:-status}"
shift || true

# Before require_config: asking for help must work on a machine with no install,
# which is exactly the machine most likely to be asking.
case "$command" in
  -h|--help|help)
    sed -n '5,10p' "$0" | sed 's/^# \{0,1\}//'
    exit 0
    ;;
esac

fplan_require_config

force=""
follow=""
for arg in "$@"; do
  case "$arg" in
    --force) force="force" ;;
    -f|--follow) follow="follow" ;;
  esac
done

case "$command" in
  start)
    fplan_service_installed || fplan_die "No service installed. Run scripts/install.sh."
    if fplan_is_answering; then
      fplan_die "Already answering on $(fplan_base_url)."
    fi
    fplan_service_start
    fplan_wait_answering 60 || fplan_die "Started, but nothing answered within 60s. Try: $0 logs"
    fplan_say "Running at $(fplan_base_url)/"
    ;;

  stop)
    fplan_service_installed || fplan_die "No service installed."
    fplan_wait_quiet 1800 "${force:-strict}"
    fplan_service_stop
    fplan_wait_stopped 30
    fplan_say "Stopped."
    ;;

  restart)
    fplan_service_installed || fplan_die "No service installed."
    fplan_wait_quiet 1800 "${force:-strict}"
    fplan_service_stop
    fplan_wait_stopped 30
    fplan_service_start
    fplan_wait_answering 60 || fplan_die "Restarted, but nothing answered within 60s. Try: $0 logs"
    fplan_say "Running at $(fplan_base_url)/"
    ;;

  status)
    if fplan_service_installed; then
      fplan_say "Service:  installed"
    else
      fplan_say "Service:  NOT installed (run scripts/install.sh)"
    fi
    if fplan_is_answering; then
      fplan_say "HTTP:     answering at $(fplan_base_url)/"
    else
      fplan_say "HTTP:     nothing on $(fplan_base_url)"
    fi
    fplan_say "Checkout: $FPLAN_APP_DIR"
    fplan_say "Data:     $FPLAN_DATA_DIR"
    fplan_say ""
    fplan_service_status
    ;;

  logs)
    fplan_service_logs "$follow"
    ;;

  url)
    fplan_say "$(fplan_base_url)/"
    ;;

  *)
    fplan_die "unknown command: $command (try: start stop restart status logs url)"
    ;;
esac
