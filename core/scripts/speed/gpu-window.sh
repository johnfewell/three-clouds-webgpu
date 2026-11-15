#!/bin/sh
# One helper for every GPU window: hold the GPU lock and, only when the
# result is a time, QUIET around the run itself, with a hard timeout. It never
# waits on a server: sweep.mjs and run.mjs open and close their own Vite
# server in a finally block
# Usage:
#   sh core/scripts/speed/gpu-window.sh <agent> -- sweep --out result.json ...
#   sh core/scripts/speed/gpu-window.sh <agent> --quiet -- sweep --out ... --vsync --seconds 8
#   sh core/scripts/speed/gpu-window.sh <agent> -- report sweep.json --markdown
# Every argument before `--` is scheduling, every one after it is the command
# LOCK and QUIET_SH default to the fleet's ~/code/dispatch scripts
set -u

WORK=${WORK:-$(cd "$(dirname "$0")/../../.." && pwd)}
LOCK=${LOCK:-$HOME/code/dispatch/gpu-lock.sh}
QUIET_SH=${QUIET_SH:-$HOME/code/dispatch/quiet.sh}
QUIET_COOLDOWN_S=${QUIET_COOLDOWN_S:-920}
LIMIT=${LIMIT:-2700}
NAME=""
QUIET=0

usage() {
  echo "usage: gpu-window.sh <agent-name> [--quiet] -- <command> [args...]" >&2
  exit 2
}

while [ $# -gt 0 ]; do
  case "$1" in
    --quiet) QUIET=1; shift ;;
    --) shift; break ;;
    -h|--help) usage ;;
    *) [ -z "$NAME" ] || usage; NAME=$1; shift ;;
  esac
done
[ -n "$NAME" ] || usage
[ $# -gt 0 ] || usage

# QUIET is only for a result that is a TIME, and it may not follow another
# window within the fleet's cooldown
until_now() { printf '%s\n' "$(date +%s)"; }
if [ "$QUIET" = 1 ]; then
  STAMP="$HOME/code/dispatch/heavy/quiet-last-$NAME"
  if [ -f "$STAMP" ]; then
    AGE=$(( $(until_now) - $(stat -f %m "$STAMP" 2>/dev/null || stat -c %Y "$STAMP") ))
    while [ "$AGE" -lt "$QUIET_COOLDOWN_S" ]; do
      echo "quiet cooldown: $(( QUIET_COOLDOWN_S - AGE )) s left for $NAME"
      sleep 10
      AGE=$(( $(until_now) - $(stat -f %m "$STAMP" 2>/dev/null || stat -c %Y "$STAMP") ))
    done
  fi
fi

WATCHDOG=""
cleanup() {
  [ -n "$WATCHDOG" ] && kill "$WATCHDOG" 2>/dev/null
  if [ "$QUIET" = 1 ]; then sh "$QUIET_SH" off "$NAME" >/dev/null 2>&1; fi
  sh "$LOCK" release "$NAME"
}
trap cleanup EXIT HUP INT TERM

sh "$LOCK" acquire "$NAME" || exit 1
( sleep "$LIMIT"; echo "WATCHDOG: ${LIMIT}s"; kill -TERM $$ ) &
WATCHDOG=$!
if [ "$QUIET" = 1 ]; then
  sh "$QUIET_SH" on "$NAME" || exit 1
fi

cd "$WORK" || exit 1
echo "=== start $(date +%T) load $(uptime | sed 's/.*load/load/')"
"$@"
rc=$?
echo "=== end $(date +%T) exit $rc"
exit $rc
