#!/bin/sh
# The combinations sweep as it was run on 2026-10-08 (gpu-combos.sh), with the
# worktree, dispatch folder and agent name as arguments
# Usage: sh core/scripts/speed/sweep-combos.sh <agent-name> [combos.json] [out.json]
set -u
NAME=${1:?usage: sweep-combos.sh <agent-name> [combos.json] [out.json]}
COMBOS=${2:-$(dirname "$0")/combos.json}
OUT=${3:-sweeps/sweep-combos.json}
mkdir -p "$(dirname "$OUT")"
ARMS=base,$(python3 -c "import json,sys; print(','.join(a['id'] for a in json.load(open(sys.argv[1]))))" "$COMBOS")
echo "arms: $ARMS"
sh "$(dirname "$0")/gpu-window.sh" "$NAME" --quiet -- \
  node core/scripts/speed/sweep.mjs --out "$OUT" --arms "$ARMS" \
  --extra "$(cat "$COMBOS")" --reps 3 --hard-timeout-min 25
