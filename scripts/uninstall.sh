#!/usr/bin/env bash
# Remove the service. Keep the data.
#
# THERE IS NO --purge, AND THAT IS DELIBERATE. The data folder holds the only
# copy of things this app cannot rebuild: a net-worth ledger whose rows record
# prices from days that have passed, and every version of the plan there has
# ever been. A flag that deletes those is a flag that will eventually be typed
# by accident, at the end of a long evening, by someone who meant to reinstall.
# This script prints the path and the size and stops. Deleting it is a `rm` you
# have to write out yourself, which is the correct amount of friction.

set -euo pipefail
here="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib/common.sh
. "$here/lib/common.sh"

force=""
[ "${1:-}" = "--force" ] && force="force"

fplan_require_config
platform="$(fplan_platform)"

fplan_step "Removing the Finance Planner service"

if fplan_is_answering; then
  # Same wait as everywhere else: stopping mid-score costs a row its figure,
  # and "I was uninstalling anyway" does not make the loss any less permanent
  # if the plan is to reinstall against the same folder.
  fplan_wait_quiet 900 "${force:-strict}"
fi

fplan_service_stop
fplan_service_disable

case "$platform" in
  linux)
    unit="$(fplan_systemd_unit_path)"
    if [ -f "$unit" ]; then
      rm -f "$unit"
      systemctl --user daemon-reload || true
      fplan_say "Removed $unit"
    else
      fplan_say "No unit at $unit"
    fi
    fplan_say "Lingering was left enabled; turn it off with: loginctl disable-linger $(id -un)"
    ;;
  macos)
    plist="$(fplan_launchd_plist_path)"
    if [ -f "$plist" ]; then
      rm -f "$plist"
      fplan_say "Removed $plist"
    else
      fplan_say "No agent at $plist"
    fi
    ;;
esac

if [ -f "$FPLAN_CONFIG_FILE" ]; then
  rm -f "$FPLAN_CONFIG_FILE"
  fplan_say "Removed $FPLAN_CONFIG_FILE"
fi

size="$(du -sh "$FPLAN_DATA_DIR" 2>/dev/null | cut -f1 || echo '?')"

cat <<EOF

  The service is gone. Nothing else was touched.

  YOUR DATA IS STILL THERE, and this script will not remove it:

      $FPLAN_DATA_DIR   ($size)

  It holds your profile, your plan and every version of it, and the net-worth
  ledger. Those rows record prices from days that have passed; they cannot be
  recomputed from anything. Copy the folder somewhere before you delete it.

  The checkout is also untouched:

      $FPLAN_APP_DIR

  Reinstall at any time with:  $FPLAN_APP_DIR/scripts/install.sh
EOF
