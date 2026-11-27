#!/usr/bin/env bash
set -euo pipefail

TMUX_BIN="${1:-tmux}"

# launchd starts user agents with a minimal PATH. Theme and persistence
# plugins commonly invoke `tmux` by name, so make the selected binary visible
# to every run-shell command started by the server.
if [[ "$TMUX_BIN" == */* ]]; then
  TMUX_BIN_DIR="${TMUX_BIN%/*}"
else
  TMUX_BIN_PATH="$(command -v "$TMUX_BIN")"
  TMUX_BIN_DIR="${TMUX_BIN_PATH%/*}"
fi
export PATH="$TMUX_BIN_DIR:${PATH:-/usr/bin:/bin:/usr/sbin:/sbin}"

# A server may already have been started interactively before this LaunchAgent
# was installed. Do not kill it (and its sessions) just to put it under launchd.
# Wait for that server to exit, then take ownership; after a reboot the loop is
# skipped and launchd starts the server immediately.
while "$TMUX_BIN" show-options -gqv exit-empty >/dev/null 2>&1; do
  sleep 5
done

# -D keeps the server in the foreground for launchd and disables exit-empty.
# tmux explicitly forbids combining -D with a command such as start-server.
# Resolve symlinked helper binaries (e.g. Anymux Tmux.app/Contents/MacOS/Anymux Tmux)
# so macOS TCC attributes child processes directly to the signed bundle.
EXEC_TMUX_BIN="$TMUX_BIN"
if [[ -L "$TMUX_BIN" ]] && command -v perl >/dev/null 2>&1; then
  resolved_bin="$(perl -MCwd=abs_path -e 'my $p = abs_path($ARGV[0]); print $p if defined $p;' "$TMUX_BIN" 2>/dev/null || true)"
  if [[ -n "$resolved_bin" && -x "$resolved_bin" ]]; then
    EXEC_TMUX_BIN="$resolved_bin"
  fi
fi

printf '%s run-tmux-server: exec %s -D (pid=%s)\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$EXEC_TMUX_BIN" "$$" >&2
exec "$EXEC_TMUX_BIN" -D
