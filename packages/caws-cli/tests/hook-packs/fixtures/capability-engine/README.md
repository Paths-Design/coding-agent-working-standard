# Capability-engine verification fixtures

CAWS-owned committed surface for the command-safety capability engine
(`HOOK-CAPABILITY-ENGINE-*`). Surgery-ward is the evidence *source*; CAWS owns
the *regression corpus and admission gate* that actually govern merges.

## Files

| File | Purpose |
|------|---------|
| `fn_closure_corpus.json` | The 80 known false-negatives, converted from the committed surgery-ward CSV via Python `csv.DictReader` (RFC-4180; commands contain commas/quoted JSON). `target_slice:2, active:false` — inactive until Slice 2 activates closure. Each row carries `expected_facets` + `expected_final_decision`; Slice 2 asserts against those, **never** against `reason` prose. `detector_capability` is a trace label only. |
| `fact_probes.json` | 10–15 hand-authored named probes asserting the exact structural facts Slice 2 depends on (basename resolution, wrapper peel, scope, amplifier flags, payload opacity, substitution recursion, parse_confidence), plus the deep-escaped `sh -c` `known_gap` row carried forward to Slice 3. |
| `zero_change_harness.py` | The zero-decision-change proof: current template vs the pre-capability-engine baseline blob over the full real-agent corpus. |

The shadow-liveness test that consumes these is
`packages/caws-cli/tests/hook-packs/capability_engine_shadow.test.js` (runs in
the default `npx jest` once present; tests the shipped TEMPLATE).

## The 4,882-command corpus (NOT committed here)

The full real-agent corpus is **intentionally not committed** to this repo — it
is 4,882 real agent commands (operational data without clear provenance for a
package repo). It lives in the surgery-ward repo:

```
<surgery-ward>/tmp/hook-review/commands_extracted.txt    # tag<TAB>cmd per line
```

Regenerate via `surgery-ward/tmp/hook-review/stress_extract.py` if absent.

## Running the zero-change harness

```bash
# AC mode (acceptance evidence) — HOSTILE TO FALSE SUCCESS:
#   exits nonzero unless it ran EXACTLY 4882 rows with changed=0 AND errors=0;
#   a missing/short corpus is a distinct SKIP that can never be a pass; and it
#   self-validates that the baseline blob lacks the capability markers while the
#   current template has them (so a wrong SHA cannot pass silently).
python3 packages/caws-cli/tests/hook-packs/fixtures/capability-engine/zero_change_harness.py \
  --require-corpus --expected-count 4882

# Local/dev mode — may SKIP (exit 0) when the corpus is absent.
python3 .../zero_change_harness.py
```

A `result:"PASS"` JSON summary with `total:4882, changed:0, errors:0,
baseline_markers_absent:true, current_markers_present:true` is the decisive
Slice 1 A3 artifact. The harness writes `stress_changed.tsv` (header-only on a
clean pass).

## Slice activation

`target_slice` + `active` gate the 80-FN rows during construction so the default
suite does not go red waiting for unimplemented closure. **At Slice 2 close,
flip them active / wire a `test:classifier:admission` target** so the corpus runs
by default — env-gating must not outlive the slice (it would turn governance into
tribal knowledge).
