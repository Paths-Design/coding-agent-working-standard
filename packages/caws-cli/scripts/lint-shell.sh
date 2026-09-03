#!/usr/bin/env bash
# Shell-template lint gate (CAWS-HOTFIX-SESSION-IDENTITY-REVIEW-FINDINGS-001).
#
# `npm run lint` (and therefore CI pr-checks) runs this after eslint:
#   - bash -n parses EVERY templates/**/*.sh — any syntax error fails the
#     gate (a broken continuation must fail CI at lint time, not bats time);
#   - shellcheck, when installed, runs in informational mode (warnings are
#     printed, never gate-failing) — behavioral authority stays with bats.
set -u

TEMPLATES_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../templates" && pwd)"
failures=0
count=0

while IFS= read -r -d '' file; do
  count=$((count + 1))
  if ! err="$(bash -n "$file" 2>&1)"; then
    echo "lint-shell: syntax error in $file"
    printf '%s
' "$err" | sed 's/^/  /'
    failures=$((failures + 1))
  fi
done < <(find "$TEMPLATES_DIR" -name '*.sh' -print0)

echo "lint-shell: bash -n OK for $count template script(s)"

if command -v shellcheck >/dev/null 2>&1; then
  # Informational only: print, never fail (bats owns behavior). One file
  # per invocation — a single joined argument list exceeds ARG_MAX.
  while IFS= read -r -d '' file; do
    shellcheck --shell=bash --severity=warning --exclude=SC1090,SC1091 \
      "$file" || true
  done < <(find "$TEMPLATES_DIR" -name '*.sh' -print0)
fi

exit "$failures"
