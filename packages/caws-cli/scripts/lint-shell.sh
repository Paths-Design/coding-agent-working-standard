#!/usr/bin/env bash
# Shell-template lint gate (CAWS-HOTFIX-SESSION-IDENTITY-REVIEW-FINDINGS-001).
#
# `npm run lint` (and therefore CI pr-checks) runs this after eslint:
#   - bash -n parses EVERY templates/**/*.sh — any syntax error fails the
#     gate (a broken continuation must fail CI at lint time, not bats time);
#   - a render fragment (hook-packs/runtime/service-image) may carry a line
#     that is nothing but a __CAWS_IMAGE_<NAME>__ token; src/runtime/
#     service-image.ts replaces that whole line with generated case items, so
#     the raw file cannot parse. Only such token-only lines are elided before
#     bash -n; every other line of the fragment is still parsed here, and the
#     rendered image is executed under bash by tests/runtime/service-image.test.js;
#   - shellcheck, when installed, runs in informational mode (warnings are
#     printed, never gate-failing) — behavioral authority stays with bats.
set -u

TEMPLATES_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../templates" && pwd)"
TOKEN_LINE='^[[:space:]]*__CAWS_IMAGE_[A-Z_]+__[[:space:]]*$'
failures=0
count=0
fragments=0

while IFS= read -r -d '' file; do
  count=$((count + 1))
  parse_status=0
  if grep -qE "$TOKEN_LINE" "$file"; then
    fragments=$((fragments + 1))
    echo "lint-shell: render fragment (token lines elided before bash -n): $file"
    err="$(grep -vE "$TOKEN_LINE" "$file" | bash -n 2>&1)" || parse_status=$?
  else
    err="$(bash -n "$file" 2>&1)" || parse_status=$?
  fi
  if [ "$parse_status" -ne 0 ]; then
    echo "lint-shell: syntax error in $file"
    printf '%s
' "$err" | sed 's/^/  /'
    failures=$((failures + 1))
  fi
done < <(find "$TEMPLATES_DIR" -name '*.sh' -print0)

echo "lint-shell: bash -n OK for $count template script(s) ($fragments render fragment(s) parsed with token lines elided)"

if command -v shellcheck >/dev/null 2>&1; then
  # Informational only: print, never fail (bats owns behavior). One file
  # per invocation — a single joined argument list exceeds ARG_MAX.
  while IFS= read -r -d '' file; do
    shellcheck --shell=bash --severity=warning --exclude=SC1090,SC1091 \
      "$file" || true
  done < <(find "$TEMPLATES_DIR" -name '*.sh' -print0)
fi

exit "$failures"
