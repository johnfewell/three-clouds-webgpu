#!/bin/sh
# The dispatcher's original driver, kept verbatim so a re-run reproduces the
# 2026-10-08 sweep. Every hard-coded path it carried is now an argument
# Usage: sh core/scripts/speed/sweep-groups.sh <agent-name> [out-dir]
#   WORK=<worktree>  the tree to measure (default: this checkout)
#   RETINA=1         the report's scene label, which assumed retina
set -u
NAME=${1:?usage: sweep-groups.sh <agent-name> [out-dir]}
OUT=${2:-sweeps}
ALL=baseline-medium,sky-horizon-low-sun,shafts-low-sun,layers-4-shadow
mkdir -p "$OUT"
STATUS=${STATUS:-$OUT/STATUS.md}

group() {
  local name=$1 cases=$2 arms=$3
  echo "=== group $name $(date +%T)"
  sh "$(dirname "$0")/gpu-window.sh" "$NAME" --quiet -- \
    node core/scripts/speed/sweep.mjs \
    --out "$OUT/sweep-$name.json" --cases "$cases" --arms "$arms" \
    --reps 3 --hard-timeout-min 20 || return $?
  {
    echo
    echo "### sweep group: $name ($(date +%H:%M), retina 2880x1800 DPR 2, n=3, fast-clock ms)"
    node core/scripts/speed/sweep-report.mjs "$OUT/sweep-$name.json" --markdown
  } >> "$STATUS"
}

group 1-temporalUpscale "$ALL" base,temporalUpscale
group 2-shafts shafts-low-sun base,lightShafts-off,lightShaftsHalfRes
group 3-resolution "$ALL" base,resolutionScale-0.75,resolutionScale-0.5
group 4-presets "$ALL" base,preset-low,preset-medium,preset-high
group 5-steps-shadow "$ALL" base,maxIter-250,maxIter-100,minStep-100,minStep-200,iterToSun-1,iterToSun-0,octaves-4,shapeDetail-off,shadow-128,shadow-512,cascades-2,cascades-1,shadowInterval-2,shadowInterval-4,shadowTemporal-off,shadowIter-25
echo "=== end $(date +%T)"
