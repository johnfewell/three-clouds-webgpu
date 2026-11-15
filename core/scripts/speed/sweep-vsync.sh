#!/bin/sh
# The vsync-on confirmation as it was run on 2026-10-08 (gpu-vsync.sh): a real
# requestAnimationFrame loop with Chrome's default vsync, 8 s measured per arm
# Usage: sh core/scripts/speed/sweep-vsync.sh <agent-name> [combos.json] [out.json]
set -u
NAME=${1:?usage: sweep-vsync.sh <agent-name> [combos.json] [out.json]}
COMBOS=${2:-$(dirname "$0")/combos.json}
OUT=${3:-sweeps/vsync.json}
mkdir -p "$(dirname "$OUT")"
ARMS=base,c3-temporal+res0.75+halfres+interval4+cascades2,c4-max-existing
sh "$(dirname "$0")/gpu-window.sh" "$NAME" --quiet -- \
  node core/scripts/speed/sweep.mjs --out "$OUT" --arms "$ARMS" \
  --extra "$(cat "$COMBOS")" --reps 3 --vsync --seconds 8 --hard-timeout-min 25
