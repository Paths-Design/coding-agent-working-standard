#!/usr/bin/env bats
# The machine dispatcher exports BASH_ENV=<runtime>/handler-env.sh for its
# handlers and saves the caller's value in CAWS_PRIOR_BASH_ENV. The command
# analyzer reports an inherited BASH_ENV as an unmodeled environment, so the
# analysis call must carry the caller's value, never the dispatcher's own.
# These cases record what the analyzer process actually receives.

setup() {
  LIB="$BATS_TEST_DIRNAME/../../../templates/hook-packs/shared/lib"
  WORK="$(mktemp -d "$BATS_TEST_TMPDIR/dispatcher-env.XXXXXX")"
  RUNTIME="$WORK/runtime"
  mkdir -p "$RUNTIME/lib"
  : > "$RUNTIME/handler-env.sh"
  : > "$WORK/agent-startup.sh"
  # Stands in for the analyzer: records the BASH_ENV it was started with.
  cat > "$WORK/analyzer" <<'STUB'
#!/bin/sh
if [ "${BASH_ENV+set}" = set ]; then printf 'set:%s\n' "$BASH_ENV"; else printf 'unset\n'; fi
STUB
  chmod +x "$WORK/analyzer"
}

observe() {
  # shellcheck disable=SC1090
  source "$LIB/bash-mutation-analysis.sh"
  caws_run_with_agent_bash_env "$WORK/analyzer"
}

@test "dispatcher BASH_ENV with no prior value reaches the analyzer unset" {
  export CAWS_MACHINE_RUNTIME=1 CAWS_SHARED_LIB_DIR="$RUNTIME/lib"
  export CAWS_PRIOR_BASH_ENV="" BASH_ENV="$RUNTIME/handler-env.sh"
  run observe
  [ "$status" -eq 0 ]
  [ "$output" = "unset" ]
}

@test "dispatcher BASH_ENV is replaced by the agent's saved value" {
  export CAWS_MACHINE_RUNTIME=1 CAWS_SHARED_LIB_DIR="$RUNTIME/lib"
  export CAWS_PRIOR_BASH_ENV="$WORK/agent-startup.sh" BASH_ENV="$RUNTIME/handler-env.sh"
  run observe
  [ "$status" -eq 0 ]
  [ "$output" = "set:$WORK/agent-startup.sh" ]
}

@test "a BASH_ENV the dispatcher did not set is passed through unchanged" {
  export CAWS_MACHINE_RUNTIME=1 CAWS_SHARED_LIB_DIR="$RUNTIME/lib"
  export CAWS_PRIOR_BASH_ENV="" BASH_ENV="$WORK/agent-startup.sh"
  run observe
  [ "$status" -eq 0 ]
  [ "$output" = "set:$WORK/agent-startup.sh" ]
}

@test "outside the machine runtime BASH_ENV is never altered" {
  unset CAWS_MACHINE_RUNTIME
  export CAWS_SHARED_LIB_DIR="$RUNTIME/lib"
  export CAWS_PRIOR_BASH_ENV="" BASH_ENV="$RUNTIME/handler-env.sh"
  run observe
  [ "$status" -eq 0 ]
  [ "$output" = "set:$RUNTIME/handler-env.sh" ]
}

@test "without a saved prior value the dispatcher BASH_ENV is not dropped" {
  export CAWS_MACHINE_RUNTIME=1 CAWS_SHARED_LIB_DIR="$RUNTIME/lib"
  unset CAWS_PRIOR_BASH_ENV
  export BASH_ENV="$RUNTIME/handler-env.sh"
  run observe
  [ "$status" -eq 0 ]
  [ "$output" = "set:$RUNTIME/handler-env.sh" ]
}

@test "the analyzer's exit status is returned through the wrapper" {
  printf '#!/bin/sh\nexit 7\n' > "$WORK/analyzer"
  export CAWS_MACHINE_RUNTIME=1 CAWS_SHARED_LIB_DIR="$RUNTIME/lib"
  export CAWS_PRIOR_BASH_ENV="" BASH_ENV="$RUNTIME/handler-env.sh"
  run observe
  [ "$status" -eq 7 ]
}
