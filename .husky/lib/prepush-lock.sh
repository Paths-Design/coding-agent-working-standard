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
# same object.
#
# The primitive is `ln -s <pid> <lock>`, not `mkdir`. Both syscalls are atomic,
# but mkdir only makes *existence* atomic — the owner's pid has to be written
# afterwards, in a second step. A contender arriving between those two steps
# finds a lock with no pid, concludes the holder is dead, and deletes a lock that
# is very much alive. That is not theoretical: 16 processes racing a mkdir-based
# version of this file produced 9 simultaneous winners (T7b). A symlink carries
# its payload *in* the atomic operation, so a lock never exists without its owner.
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

# caws_prepush_lock_owner <lock> — the pid recorded in the lock, or empty.
caws_prepush_lock_owner() {
  local lock="$1" pid
  [ -L "$lock" ] || return 1
  pid=$(readlink "$lock" 2>/dev/null)
  case "$pid" in
    ''|*[!0-9]*) return 1 ;;
  esac
  printf '%s\n' "$pid"
}

# caws_prepush_lock_holder_alive <lock> — 0 if a live PID owns it.
caws_prepush_lock_holder_alive() {
  local pid
  pid=$(caws_prepush_lock_owner "$1") || return 1
  kill -0 "$pid" 2>/dev/null
}

# caws_prepush_lock_acquire <lock> <max_wait_seconds> [poll_seconds]
#   0 = acquired (caller must release)
#   1 = contended; another live pre-push holds it past the deadline
#   2 = the lock could not be created for a reason that is not contention
caws_prepush_lock_acquire() {
  local lock="$1" max_wait="$2" poll="${3:-5}" waited=0
  while :; do
    if ln -s "$$" "$lock" 2>/dev/null; then
      return 0
    fi
    # `ln -s` reports every failure the same way, so distinguish "someone holds
    # it" from "this filesystem will not take a symlink". Spinning on the latter
    # would look like eternal contention and wedge every push.
    if [ ! -L "$lock" ] && [ ! -e "$lock" ]; then
      return 2
    fi
    # Existing lock: reclaim it if the holder is gone (crash, SIGKILL, reboot).
    # Safe to do unconditionally now — a lock always carries its owner, so an
    # unreadable or dead owner really is abandoned rather than half-written.
    if ! caws_prepush_lock_holder_alive "$lock"; then
      rm -f "$lock" 2>/dev/null
      continue
    fi
    [ "$waited" -ge "$max_wait" ] && return 1
    sleep "$poll"
    waited=$((waited + poll))
  done
}

# caws_prepush_lock_release <lock> — only removes a lock this process owns,
# so a stolen-then-reacquired lock is never deleted by the previous holder.
caws_prepush_lock_release() {
  local lock="$1" pid
  [ -L "$lock" ] || return 0
  pid=$(readlink "$lock" 2>/dev/null)
  if [ "$pid" = "$$" ]; then
    rm -f "$lock" 2>/dev/null
  fi
  return 0
}
