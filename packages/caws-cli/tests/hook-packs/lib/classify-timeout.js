// Shared inner-subprocess timeout for hook-pack tests that spawn the
// classifier (python3 classify_command.py).
//
// HOOK-PACK-SUBPROCESS-TIMEOUT-RELIABILITY-001: the classifier spawns were
// hard-coded to 5000 ms. python3's interpreter cold-start, under Jest worker
// contention (maxWorkers parallelism + disk/process-table pressure during the
// full hook-pack run), occasionally exceeded 5000 ms and aborted the spawn
// mid-flight, which the test reported as a FALSE failure ("classifier
// invocation failed" / "classifier exited null"). The classifier logic was
// fine — isolated runs passed; only the contended full run tripped.
//
// This helper centralizes the timeout so every classifier spawn shares one
// contention-safe default (15000 ms — the same value the bash/guard spawns in
// this suite already use) and a single env override for diagnostic stress runs.
//
// IMPORTANT: this changes ONLY the spawn timeout VALUE. It does not touch
// classifier semantics, the command-safety lattice, or any verdict. Callers
// keep their existing `r.error` / non-zero-status throws, so a genuinely hung
// classifier still aborts and FAILS LOUDLY — a timeout is never converted into
// allow/ask/silent-success.

'use strict';

/** Default classifier-spawn timeout (ms). Matches the suite's bash/guard
 * spawns, which already use 15000 ms for the same contention reason. */
const DEFAULT_CLASSIFY_TIMEOUT_MS = 15000;

/**
 * Resolve the classifier-spawn timeout in milliseconds.
 *
 * Honors the CAWS_TEST_CLASSIFY_TIMEOUT_MS env var when it is a positive finite
 * number; otherwise (unset, empty, zero/negative, or non-numeric) falls back to
 * the bounded 15000 ms default. Never returns 0 or a non-finite value, so a
 * misconfigured override cannot disable the timeout (which would let a hung
 * classifier hang the suite instead of failing).
 *
 * @param {NodeJS.ProcessEnv} [env] - environment to read (defaults to process.env)
 * @returns {number} timeout in ms, always a positive finite integer
 */
function classifyTimeoutMs(env) {
  const source = env || process.env;
  const raw = source.CAWS_TEST_CLASSIFY_TIMEOUT_MS;
  if (typeof raw === 'string' && raw.trim() !== '') {
    const parsed = Number(raw);
    if (Number.isFinite(parsed) && parsed > 0) {
      return parsed;
    }
  }
  return DEFAULT_CLASSIFY_TIMEOUT_MS;
}

module.exports = { classifyTimeoutMs, DEFAULT_CLASSIFY_TIMEOUT_MS };
