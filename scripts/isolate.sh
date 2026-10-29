#!/bin/sh
# Give a worktree a genuinely isolated dependency tree.
#
# WHY: examples/parity/node_modules carries a RELATIVE self-link
# (three-clouds-webgpu -> ../../..) which resolves against the PHYSICAL
# directory. That is correct inside a self-contained worktree and WRONG the
# moment a worktree inherits another tree's node_modules by symlink — it then
# silently measures whatever tree the link belongs to. On 2026-09-02 the shared
# one pointed at a scratch dispatch tree @ b027d6a, 11 commits off mainline,
# and every arm captured against it would have been void.
#
# HAND-FORGING THE LAYOUT DOES NOT WORK. A directory of absolute symlinks
# satisfies node's resolver but not pnpm; capture.mjs runs `pnpm typecheck`,
# pnpm judges the modules dir invalid and tries to REMOVE it — averted on
# 2026-09-02 only by the absence of a TTY. Let the package manager own it.
#
# Usage:
#   isolate.sh <worktree>              full isolation: quarantine, install, verify
#   isolate.sh verify-link <worktree>  ONLY the self-link check, no install
#   isolate.sh verify-types <worktree> ONLY the stale-types check, no install
#   isolate.sh verify-workspace <tree> ONLY the workspace-root check
#   isolate.sh detach <worktree>       ONLY the detach sweep, into the quarantine
#   isolate.sh verify-leftovers <wt>   ONLY the "no linked node_modules" check
#   isolate.sh verify-outward <wt>     ONLY the "other trees point elsewhere" check
#
# The extra modes exist so a refusal can be exercised without a real install
# (scripts/isolate.test.ts). They are not test backdoors: each runs the same
# function the full path runs, so a test of it is a test of the real check.
set -e

# ---------------------------------------------------------------------------
# pnpm resolves its workspace root by walking UP from cwd to the NEAREST
# directory holding pnpm-workspace.yaml, and installs into THAT tree. A git
# worktree carries its own, so the root is the worktree and an install is
# contained. A COPIED tree does not, so the root walks up to some ancestor and
# the install writes links into a tree the caller never named.
#
# That is not hypothetical. On 2026-09-03 a tree under <tmp> left the
# SHARED checkout's examples/parity self-link pointing at itself; main went red
# with TS2305 "no exported member" because the stale tree's types/ predated the
# export, and a bench slot was captured against the red key before anyone
# noticed. Nothing in this script's own output would have shown it, because
# every check it ran was scoped to the tree it was given.
verify_workspace_root() {
  wt="$1"
  [ -f "$wt/pnpm-workspace.yaml" ] || {
    echo "REFUSE: $wt has no pnpm-workspace.yaml of its own."
    echo "        pnpm would resolve its workspace root to an ANCESTOR and"
    echo "        install into that tree instead — including repointing that"
    echo "        tree's package links. Pass a git worktree, not a copy."
    return 1
  }
  echo "workspace root          : $wt (own pnpm-workspace.yaml)"
  return 0
}

# ---------------------------------------------------------------------------
# 2026-09-24 (cc_2, wt-sky): the quarantine below used to cover the root and
# examples/parity ONLY, while the worktree carried symlinked node_modules for
# the OTHER workspace packages (examples/basic, r3f, storybook). `pnpm install`
# ran THROUGH those links and rewrote the SHARED checkout's
# examples/{basic,r3f,storybook}/node_modules — every dependency link plus the
# self-link now named ../../../../wt-sky/... The script printed ISOLATION
# VERIFIED, because every check it ran was scoped to the tree it was given.
#
# Two defences in order. Detach EVERY workspace package's link, derived from
# pnpm-workspace.yaml so a new member needs no edit here. Then REFUSE if any
# node_modules symlink survives anywhere under the worktree, which trusts the
# derivation not at all.
#
# The pattern list comes from the `packages:` block by shape (`  - pattern`),
# so a map-valued sibling key like allowBuilds contributes nothing. An
# unparseable marker yields an EMPTY list, and empty is a refusal: a sweep that
# found nothing to detach must not read as "nothing was attached".
workspace_patterns() {
  sed -n '/^packages:/,/^[^[:space:]#]/p' "$1/pnpm-workspace.yaml" |
    sed -n 's/^[[:space:]]*-[[:space:]]*//p' | tr -d "'\"" | sed '/^$/d'
}

# Print every workspace package directory that EXISTS, one per line. Non-zero
# when the pattern list itself is empty (see above). A pattern matching no
# directory is normal — a fresh worktree has no examples/ — and is not counted
# as a derivation failure, but the caller prints the count either way.
workspace_dirs() {
  wd_root="$1"
  wd_pats=$(workspace_patterns "$wd_root")
  [ -n "$wd_pats" ] || return 1
  IFS='
'
  for wd_p in $wd_pats; do
    # Unquoted: the value carries a glob, and this is sh, not zsh. A pattern
    # matching nothing stays literal and fails the -d test.
    for wd_d in "$wd_root"/$wd_p; do
      [ -d "$wd_d" ] && printf '%s\n' "$wd_d"
    done
  done
  unset IFS
  return 0
}

detach_inherited() {
  di_wt="$1"
  di_q="$2"
  di_stamp="$3"
  di_dirs=$(workspace_dirs "$di_wt") || {
    echo "REFUSE: no workspace package patterns in $di_wt/pnpm-workspace.yaml"
    echo "        pnpm would still find a node_modules symlink it can install"
    echo "        THROUGH, so isolation cannot be established. Fix the marker."
    return 1
  }
  di_n=0
  di_i=0
  if [ -n "$di_dirs" ]; then
    di_n=$(printf '%s\n' "$di_dirs" | grep -c '')
    di_k=0
    for di_d in $di_dirs; do
      di_k=$((di_k + 1))
      [ -L "$di_d/node_modules" ] || continue
      di_i=$((di_i + 1))
      di_base=$(basename "$di_d")
      mv "$di_d/node_modules" "$di_q/nm-$di_stamp-$di_k-$di_base"
      echo "detached inherited $di_d/node_modules (quarantined, not deleted)"
    done
  fi
  echo "workspace packages      : $di_n present, $di_i detached"
  return 0
}

# ---------------------------------------------------------------------------
# The property the sweep cannot be trusted to establish on its own: after it,
# NO node_modules under this worktree is a symlink. A real directory is
# pnpm's business. A symlink is a hole into another tree, and `pnpm install`
# writes through a symlinked node_modules rather than replacing it.
verify_no_linked_modules() {
  vn_wt="$1"
  # -prune real node_modules so the scan cannot wander into an install; a
  # symlink is never descended (no -L), so pruning it is unnecessary and would
  # hide it.
  vn_left=$(find "$vn_wt" -name .git -prune -o -name node_modules -type d -prune -o -name node_modules -type l -print 2>/dev/null)
  if [ -n "$vn_left" ]; then
    echo "REFUSE: node_modules symlinks remain under the worktree:"
    printf '%s\n' "$vn_left" | sed 's/^/        /'
    echo "        pnpm install would run THROUGH these into the trees they"
    echo "        point at and rewrite those trees' package links."
    return 1
  fi
  echo "linked node_modules     : none under the worktree"
  return 0
}

# ---------------------------------------------------------------------------
# The property this whole script exists to guarantee, as ONE implementation.
verify_link() {
  wt="$1"
  link="$wt/examples/parity/node_modules/three-clouds-webgpu"

  # A MISSING link must refuse BY NAME. The first version ran `cd` straight
  # into this path under `set -e`: with nothing there the script died on the
  # shell's own "no such file" and never printed a REFUSE line at all, so the
  # commonest failure was also the least legible one.
  [ -d "$link" ] || {
    echo "REFUSE: self-link missing at examples/parity/node_modules/three-clouds-webgpu"
    return 1
  }

  r=$(cd "$link" && pwd -P)
  e=$(cd "$wt" && pwd -P)
  echo "self-link resolves to : $r"
  echo "worktree is           : $e"
  [ "$r" = "$e" ] || {
    echo "REFUSE: self-link does not resolve to this worktree"
    return 1
  }
  echo "self-link OK"
  return 0
}

# ---------------------------------------------------------------------------
# The SECOND cause of TS2305, which verify_link cannot see.
#
# "Module has no exported member" has two causes here, and they are diagnosed
# the same way: the symbol IS exported at src/index.ts, so the reader is sent
# to the source file and to whoever last touched the export.
#   (1) the self-link points into a FOREIGN tree, whose types/ predates it.
#       verify_link catches this, by identity.
#   (2) the link is CORRECT and types/ is a stale untracked build artifact.
#       verify_link passes, so a link-only check reports OK and leaves the
#       reader stuck with a source defect that does not exist.
#
# Diagnosis is the whole job here, so each failure names its own cause rather
# than a shared "typecheck is unhappy". An absent types/ is NOT stale: it is a
# tree that has not been built, which the typecheck itself fixes.
verify_types() {
  vt_wt="$1"
  link="$vt_wt/examples/parity/node_modules/three-clouds-webgpu"

  # Cause (1) first, and by name: stale types in a FOREIGN tree is a link
  # problem, and telling this reader to run `pnpm build` would fix nothing.
  if ! verify_link "$vt_wt"; then
    echo "        this is a LINK problem, not a stale-build one: the types/ that"
    echo "        were read belong to the tree the link names. Fix the link."
    return 1
  fi

  types="$vt_wt/types"
  [ -d "$types" ] || {
    echo "types/                : absent (this tree has not been built)"
    echo "                        \`pnpm typecheck\` runs \`pnpm build\` first, so a"
    echo "                        full typecheck cannot see this case"
    return 0
  }

  # Newest .ts in src/ against oldest .d.ts in types/. One file each is not
  # enough: vite writes many declarations, and comparing a single pair reported
  # OK while the export the reader needed was missing.
  #
  # find -printf is NOT used: it is GNU, and this runs on darwin. Newline IFS
  # plus a shell loop instead, because the alternative (`find | xargs ls`)
  # word-splits a tree path containing a space into two non-existent paths, so
  # every comparison below silently reads "unreadable" on exactly the paths this
  # script exists to check.
  vt_newest=
  vt_oldest=
  vt_saw_src=0
  vt_saw_decl=0
  vt_prev=
  IFS='
'
  # Tests are EXCLUDED. Unit tests live next to modules as
  # *.test.ts, and 75 of this tree's 144 .ts files under src/ are tests. A test
  # edit changes no declaration, so counting it made the check refuse and blame
  # a stale build for an edit that cannot have caused one.
  for vt_f in $(find "$vt_wt/src" -name '*.ts' -type f \
    ! -name '*.test.ts' ! -name '*.test.tsx' 2>/dev/null); do
    vt_saw_src=1
    if [ -z "$vt_prev" ] || [ "$vt_f" -nt "$vt_prev" ]; then
      vt_prev=$vt_f
      vt_newest=$vt_f
    fi
  done
  vt_prev=
  for vt_f in $(find "$types" -name '*.d.ts' -type f 2>/dev/null); do
    vt_saw_decl=1
    if [ -z "$vt_prev" ] || [ "$vt_prev" -nt "$vt_f" ]; then
      vt_prev=$vt_f
      vt_oldest=$vt_f
    fi
  done
  unset IFS
  [ "$vt_saw_src" = 1 ] && [ "$vt_saw_decl" = 1 ] || {
    echo "types/                : present but unreadable (no .ts in src/ or no"
    echo "                        .d.ts in types/) — cannot judge freshness"
    return 1
  }

  # `-nt` is not POSIX test. It is the one non-POSIX construct here, used
  # because no POSIX spelling compares two mtimes; macOS sh and busybox ash
  # both accept it, and the alternative (`find -printf`) is GNU only.
  if [ "$vt_newest" -nt "$vt_oldest" ]; then
    echo "REFUSE: types/ is STALE behind a correct self-link"
    echo "        newest source : $vt_newest"
    echo "        oldest decl   : $vt_oldest"
    echo "        types/ is an untracked build artifact, so this is NOT a source"
    echo "        defect: \`pnpm build\` regenerates it and the error goes away"
    echo "        with nothing else changed. Report it as the stale-build cause."
    return 1
  fi
  echo "types/                : fresh (no source newer than the oldest .d.ts)"
  return 0
}

# Print the absolute target of a symlink: physical when it resolves, lexical
# when it does not.
#
# TWO RESOLUTIONS, physical first. `cd && pwd -P` is exact, and it is what
# catches a link that reaches the worktree THROUGH another symlink. It returns
# nothing for a link whose target no longer exists, and that is the case the
# 2026-09-24 install left behind: ../../../../wt-sky/build, naming a tree pnpm
# had already finished with. So a failure falls back to the lexical answer,
# which needs no filesystem and therefore still names the worktree.
link_target() {
  lt_link="$1"
  lt_tgt=$(readlink "$lt_link" 2>/dev/null) || return 0
  [ -n "$lt_tgt" ] || return 0
  case "$lt_tgt" in
    /*) lt_abs=$lt_tgt ;;
    *) lt_abs=$(dirname "$lt_link")/$lt_tgt ;;
  esac
  if lt_real=$(cd "$lt_link" 2>/dev/null && pwd -P); then
    lt_abs=$lt_real
  else
    lt_abs=$(normalize_path "$lt_abs")
  fi
  printf '%s' "$lt_abs"
  return 0
}

# Collapse //, /./ and /../ by segment, keeping a leading / for absolute
# input. Pure string, so it answers for paths that do not exist.
normalize_path() {
  np_in=$1
  np_out=
  while [ -n "$np_in" ]; do
    case "$np_in" in
      */*) np_seg=${np_in%%/*}; np_in=${np_in#*/} ;;
      *) np_seg=$np_in; np_in= ;;
    esac
    case "$np_seg" in
      ''|'.') : ;;
      '..')
        np_out=${np_out%/*}
        [ -n "$np_out" ] || np_out=/
        ;;
      *) np_out=$np_out/$np_seg ;;
    esac
  done
  printf '%s' "$np_out"
}

# ---------------------------------------------------------------------------
# Every check above is scoped to the tree isolate.sh was handed, so none of
# them can see the damage done to some OTHER tree by the 2026-09-24 install.
# This one looks outward: for each sibling worktree of the same repo, no link
# under a workspace package's node_modules may resolve into the target
# worktree. The example self-links are checked by name, and the rest of each
# top-level link set too, because the install rewrote those as well.
verify_outward() {
  vo_wt="$1"
  # BOTH spellings of this worktree. A caller may pass /var/... while the
  # links pnpm wrote name /private/var/... (macOS TMPDIR), so a link is
  # suspicious if it matches either. Comparing one spelling against the other
  # is how a dangling ../../../../wt-isolate would slip through.
  vo_here=$(cd "$vo_wt" && pwd -P)
  vo_here_alt=$vo_wt
  vo_trees=$(git -C "$vo_wt" worktree list --porcelain 2>/dev/null | sed -n 's/^worktree //p')
  vo_trees=${vo_trees:-NONE}
  if [ "$vo_trees" = NONE ]; then
    echo "sibling worktrees      : none reported by git — outward check is EMPTY"
    echo "                        (git failed or this is not a worktree)"
    return 1
  fi
  vo_bad=''
  vo_trees_n=0
  vo_links_n=0
  # Newline IFS for every path loop below. Word splitting turns a tree path
  # containing a space into two non-directories, both skipped by the -d test,
  # and a skipped tree reads as a clean bill of health for that tree.
  IFS='
'
  for vo_t in $vo_trees; do
    [ -d "$vo_t" ] || continue
    vo_other=$(cd "$vo_t" && pwd -P)
    [ "$vo_other" = "$vo_here" ] && continue
    vo_trees_n=$((vo_trees_n + 1))
    # A sibling mid-install has no node_modules yet, and one that is not a
    # pnpm tree yields no patterns. Neither is this worktree's doing.
    vo_dirs=$(workspace_dirs "$vo_t" 2>/dev/null) || continue
    for vo_d in $vo_dirs; do
      [ -d "$vo_d/node_modules" ] || continue
      vo_self="$vo_d/node_modules/three-clouds-webgpu"
      vo_links="$vo_self
$(find "$vo_d/node_modules" -maxdepth 1 -type l -print 2>/dev/null | grep -v "^$vo_self\$")"
      for vo_l in $vo_links; do
        [ -L "$vo_l" ] || continue
        vo_links_n=$((vo_links_n + 1))
        vo_hit=$(link_target "$vo_l")
        case "$vo_hit" in
          "$vo_here" | "$vo_here"/* | "$vo_here_alt" | "$vo_here_alt"/*)
            vo_bad="$vo_bad$vo_l -> $vo_hit
" ;;
        esac
      done
    done
  done
  unset IFS
  echo "sibling worktrees      : $vo_trees_n checked, $vo_links_n links resolved"
  if [ -n "$vo_bad" ]; then
    echo "REFUSE: links in OTHER trees resolve into this worktree:"
    printf '%s' "$vo_bad" | sed 's/^/        /'
    echo "        an install here ran through an inherited node_modules and"
    echo "        repointed another tree's package links at this worktree."
    return 1
  fi
  echo "no sibling points here : OK"
  return 0
}

if [ "$1" = "verify-workspace" ]; then
  shift
  [ -n "$1" ] || { echo "usage: isolate.sh verify-workspace <tree>"; exit 2; }
  if verify_workspace_root "$1"; then exit 0; else exit 1; fi
fi

if [ "$1" = "verify-link" ]; then
  shift
  [ -n "$1" ] || { echo "usage: isolate.sh verify-link <worktree>"; exit 2; }
  if verify_link "$1"; then exit 0; else exit 1; fi
fi

if [ "$1" = "verify-types" ]; then
  shift
  [ -n "$1" ] || { echo "usage: isolate.sh verify-types <worktree>"; exit 2; }
  if verify_types "$1"; then exit 0; else exit 1; fi
fi

if [ "$1" = "detach" ]; then
  shift
  [ -n "$1" ] || { echo "usage: isolate.sh detach <worktree>"; exit 2; }
  Q="$(dirname "$1")/quarantine"; mkdir -p "$Q"
  if detach_inherited "$1" "$Q" "$(date +%s).$$"; then exit 0; else exit 1; fi
fi

if [ "$1" = "verify-leftovers" ]; then
  shift
  [ -n "$1" ] || { echo "usage: isolate.sh verify-leftovers <worktree>"; exit 2; }
  if verify_no_linked_modules "$1"; then exit 0; else exit 1; fi
fi

if [ "$1" = "verify-outward" ]; then
  shift
  [ -n "$1" ] || { echo "usage: isolate.sh verify-outward <worktree>"; exit 2; }
  if verify_outward "$1"; then exit 0; else exit 1; fi
fi

WT="$1"
[ -n "$WT" ] || { echo "usage: isolate.sh <worktree>"; exit 2; }
cd "$WT"

Q="$(dirname "$WT")/quarantine"; mkdir -p "$Q"
# $$ in the stamp: several agents isolate concurrently under one quarantine
# dir, and two installs inside the same second would collide on a name.
STAMP=$(date +%s).$$

# 1. Refuse a tree whose workspace root lies elsewhere, then detach from any
#    inherited store BEFORE pnpm can act on it.
verify_workspace_root .
if [ -L node_modules ]; then
  mv node_modules "$Q/root-nm-$STAMP"
  echo "detached inherited root node_modules (quarantined, not deleted)"
fi
if [ -L examples/parity/node_modules ]; then
  mv examples/parity/node_modules "$Q/parity-nm-$STAMP"
  echo "detached inherited parity node_modules (quarantined, not deleted)"
fi
detach_inherited . "$Q" "$STAMP"

# 2. Trust nothing above. One surviving symlink is a refusal, whatever the
#    derivation said it covered.
verify_no_linked_modules .

# 3. Real install. CI=true so pnpm never blocks on a TTY prompt — safe only
#    because steps 1 and 2 guarantee there is no inherited tree left to purge.
CI=true pnpm install --frozen-lockfile >/dev/null

# 4. Verify the property we actually care about, and REFUSE if it fails.
verify_link .

# 5. And verify we did not damage a sibling worktree on the way here.
verify_outward .

# 6. The gate capture.mjs will run anyway — fail here, not mid-slot.
CI=true pnpm typecheck >/dev/null 2>&1 || { echo "REFUSE: pnpm typecheck fails in this worktree"; exit 1; }

# 7. THE APP MUST BE ABLE TO LOAD, NOT MERELY RESOLVE.
#
# examples/parity/public is GENERATED. package.json wires it to `predev`, so
# `pnpm dev` provisions it and a fresh worktree never does. capture.mjs neither
# provisions nor checks: with the assets absent the page never initialises and
# EVERY case fails as `probe-timeout`.
#
# Cost of learning this at stage 7 instead of stage 0: one 32-minute bench slot
# and 63 identical, uninformative skips (2026-09-02). Resolution and typecheck
# are not loadability.
CI=true pnpm --filter parity setup-assets >/dev/null 2>&1 || {
  echo "REFUSE: pnpm --filter parity setup-assets failed"; exit 1; }
# Assert the FILES BY NAME, not a count of entries. My first version counted
# entries in examples/parity/public and got 1 — the `assets` directory — which
# would have passed just as happily if that directory were empty. A count is
# not the property; the property is that these four files exist.
MISSING=''
for f in local_weather.png shape.bin shape_detail.bin turbulence.png; do
  [ -f "examples/parity/public/assets/$f" ] || MISSING="$MISSING $f"
done
[ -z "$MISSING" ] || {
  echo "REFUSE: provisioning left these assets missing —$MISSING"; exit 1; }
echo "assets provisioned      : all 4 present in examples/parity/public/assets"

# 8. The `**/stbn.bin` route fixture, generated rather than committed.
#
# It was NVIDIA's spatiotemporal blue-noise volume until ADR-009 Amendment 3
# removed it: that data is non-commercial-only and cannot ship under our MIT
# licence. setup-assets above writes our own void-and-cluster volume at the
# same path and the same 128x128x64 R8 shape, which is all STBNLoader reads.
# The harnesses serve the path directly, so an absent file is a 404 that
# surfaces as an uninformative probe timeout, one bench slot at a time.
node -e '
  import("./scripts/jitterFixture.mjs").then(m => {
    if (!m.jitterFixtureIsCurrent()) {
      console.error("REFUSE: jitter fixture is absent or not the generated one")
      process.exit(1)
    }
    console.log("jitter fixture         : " + m.JITTER_FIXTURE_BYTES + " bytes, generated")
  })
' || { echo "REFUSE: scripts/jitterFixture.mjs reported a bad fixture"; exit 1; }

echo "ISOLATION VERIFIED (pnpm-owned, typecheck green, assets present, jitter fixture generated, no sibling repointed)"
