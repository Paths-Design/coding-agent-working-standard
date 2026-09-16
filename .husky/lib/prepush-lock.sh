#!/bin/bash
# Cross-worktree advisory lock for the pre-push heavy stages.
#
# Why: pre-push runs `npm run build` and `npm test` for up to 15 minutes each.
# Linked worktrees symlink node_modules to the canonical checkout, so the turbo
# cache under node_modules/.cache/turbo is shared. Two agents pushing inside the
# same window run concurrent builds against that shared cache, which is how you
# get "passes alone, fails together" push failures and a dist/ that does not
# match any one worktree.
#
# The lock lives in the COMMON git dir so every linked worktree contends on the
# same object. mkdir is the primitive because it is atomic on POSIX filesystems
# (test-then-create with a file is not).
#
# Sourceable and side-effect free on load, so the tests can exercise the
# primitive without running a build.

# caws_prepush_lock_dir — path of the shared lock, or empty if git is unusable.
caws_prepush_lock_dir() {
  local common
  common=$(git rev-parse --git-common-dir 2>/dev/null) || return 1
  [ -n "$common" ] || return 1
  # --git-common-dir may be relative (".git") in the canonical checkout.
  case "$common" in
    /*) : ;;
    *) common="$(pwd)/$common" ;;
  esac
  printf '%s\n' "$common/caws-prepush.lock"
}

# caws_prepush_lock_holder_alive <lockdir> — 0 if a live PID owns it.
caws_prepush_lock_holder_alive() {
  local lockdir="$1" pid
  [ -f "$lockdir/pid" ] || return 1
  pid=$(cat "$lockdir/pid" 2>/dev/null)
  case "$pid" in
    ''|*[!0-9]*) return 1 ;;
  esac
  kill -0 "$pid" 2>/dev/null
}

# caws_prepush_lock_acquire <lockdir> <max_wait_seconds> [poll_seconds]
#   0 = acquired (caller must release)
#   1 = contended; another live pre-push holds it past the deadline
caws_prepush_lock_acquire() {
  local lockdir="$1" max_wait="$2" poll="${3:-5}" waited=0
  while :; do
    if mkdir "$lockdir" 2>/dev/null; then
      printf '%s\n' "$$" > "$lockdir/pid"
      return 0
    fi
    # Existing lock: reclaim it if the holder is gone (crash, SIGKILL, reboot).
    if ! caws_prepush_lock_holder_alive "$lockdir"; then
      rm -rf "$lockdir" 2>/dev/null
      continue
    fi
    [ "$waited" -ge "$max_wait" ] && return 1
    sleep "$poll"
    waited=$((waited + poll))
  done
}

# caws_prepush_lock_release <lockdir> — only removes a lock this process owns,
# so a stolen-then-reacquired lock is never deleted by the previous holder.
caws_prepush_lock_release() {
  local lockdir="$1" pid
  [ -d "$lockdir" ] || return 0
  pid=$(cat "$lockdir/pid" 2>/dev/null)
  if [ "$pid" = "$$" ]; then
    rm -rf "$lockdir" 2>/dev/null
  fi
  return 0
}
