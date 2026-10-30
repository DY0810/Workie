#!/usr/bin/env bash
# Runs `npm run worker -- <args>` inside the Vercel Sandbox with what the worker needs on
# Linux: a D-Bus session, an unlocked gnome-keyring (Secret Service) and an X display.
# Usage: ~/worker.sh pair | status | start | stop | recover | set-provider-key
#        ~/worker.sh exec <command...>   (same environment, any command; used for checks)
set -euo pipefail
. "$HOME/.nvm/nvm.sh" >/dev/null
export WORKIE_WORKER_ORIGIN="${WORKIE_WORKER_ORIGIN:-https://job-dashboard-one-sigma.vercel.app}"
export WORKIE_WORKER_OWNER="${WORKIE_WORKER_OWNER:-household-dy-v1}"
export WORKIE_WORKER_DIRECTORY="$HOME/.local/share/workie-worker-dy"

# The keyring file is encrypted with this local-only password; both persist in the sandbox snapshot.
PASS_FILE="$HOME/private/keyring-pass"
if [ ! -s "$PASS_FILE" ]; then
  (umask 077; head -c 32 /dev/urandom | base64 | tr -d '\n' > "$PASS_FILE")
fi
export PASS_FILE

exec dbus-run-session -- bash -c '
  set -euo pipefail
  # --unlock reads the password on stdin and creates the login keyring on first use.
  eval "$(gnome-keyring-daemon --unlock --components=secrets < "$PASS_FILE")"
  export GNOME_KEYRING_CONTROL SSH_AUTH_SOCK 2>/dev/null || true
  cd "$HOME/workie"
  if [ "${1:-}" = exec ]; then shift; exec "$@"; fi
  exec xvfb-run -a -s "-screen 0 1440x900x24" npm run --silent worker -- "$@"
' _ "$@"
