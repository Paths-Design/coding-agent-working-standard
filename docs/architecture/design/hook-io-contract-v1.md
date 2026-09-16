# Hook I/O Contract: Bounded Input, Budgeted Output

Design note for the CAWS machine hook adapter. Two problems, deliberately
ordered: the input path is a correctness bug (it kills the hook on large
payloads); the output path is a cost/quality problem (it re-injects the same
advice without bound and drops whole cards on overflow). The input fix ships
first.

## 1. The contract today

**Input.** The harness writes the tool envelope to the hook's stdin.
`shared/lib/parse-input.sh` sanitizes it and exports the _entire_ payload:

| Line                         | Variable                                                                             | Content                  |
| ---------------------------- | ------------------------------------------------------------------------------------ | ------------------------ |
| `parse-input.sh:60-61`       | `HOOK_INPUT_JSON`                                                                    | whole sanitized envelope |
| `parse-input.sh:106,121-134` | `HOOK_TOOL_RESPONSE_JSON`                                                            | whole tool response      |
| `parse-input.sh:133`         | `HOOK_TOOL_INPUT_JSON`                                                               | whole tool input         |
| `parse-input.sh:121-134`     | `HOOK_TOOL_NAME`, `HOOK_FILE_PATH`, `HOOK_COMMAND`, `HOOK_CWD`, `HOOK_SESSION_ID`, … | bounded scalars          |

The payload therefore exists simultaneously in the process environment, in each
handler's stdin (`run-handlers.sh:283` pipes `$HOOK_INPUT_JSON` back in), and in
`audit.sh`'s log line.

**Output.** Each handler prints a JSON envelope on stdout.
`shared/lib/run-handlers.sh` extracts `.hookSpecificOutput.additionalContext`
and composes cards in handler order under one byte budget
(`run-handlers.sh:206-209`, default 32768, tunable via
`CAWS_HOOK_ADVISORY_BUDGET_BYTES`).

The budget variable appears only in the three `run-handlers.sh` copies (shared /
codex / kimi-code). It has no spec, no ADR, and no guide.

## 2. Measured behaviour

### 2.1 Input is unbounded and kills the hook

The environment is a fixed-size kernel resource. macOS `ARG_MAX` is 1 MB, so any
payload approaching it makes every subsequent `execve` fail with `E2BIG`.

Reproduced against the installed runtime (`~/.caws/lib/runtimes/e42d4b23…`, the
digest active at the end of the Sterling session
`01a08954-b5a9-72c2-b7b7-1be976264cee`):

| Tool-response payload | Result                                                                                                            |
| --------------------- | ----------------------------------------------------------------------------------------------------------------- |
| 241 B                 | rc 0                                                                                                              |
| 200 KB                | rc 0                                                                                                              |
| 700 KB                | rc 2 — `agent-surface.sh:412: python3: Argument list too long` + `Required runtime library failed: session-id.sh` |
| 900 KB – 1.2 MB       | rc 2, same                                                                                                        |

`agent-surface.sh:412` is the `CAWS_MACHINE_LIBRARIES` lookup inside
`caws_source_lib` — the _first_ fork in the dispatch chain, which is why the
error names `session-id.sh` rather than the real cause. `dispatch.sh` promotes
the source failure to `exit 2`, and the harness surfaces a non-zero PostToolUse
hook as a failed tool call.

The observed trigger was `view_image` on a 2.3 MB PNG: base64 in the tool
response blows through `ARG_MAX`. The same session hit the identical signature
at 03:23, 03:24, 03:58, 04:52, 09:10, and 21:51 — under the previous runtime
digest as well as the current one — so this is a latent ceiling, not a
regression from any particular install.

### 2.2 Output is not too large per call; it is unbounded across a session

Harvest of every Claude Code transcript under `~/.claude/projects/` (29
projects, 36 438 hook invocations; extractor: `tmp/hook-output-harvest.py`):

| Metric                                | Value                                            |
| ------------------------------------- | ------------------------------------------------ |
| Invocations carrying an injection     | 20 174                                           |
| Total injected bytes                  | 22 938 934 (~5.7 M tokens at 4 B/token)          |
| Per-injection p50 / p90 / p99 / max   | 1 148 / 2 308 / 2 314 / **9 923**                |
| Per-session median / mean / p90 / max | 23 218 / 96 788 / 309 510 / **1 300 269**        |
| Exit codes                            | 0: 35 932 · **141: 437** · 1: 35 · 2: 34         |
| Hook duration p50 / max               | **4 013 ms / 59 535 ms**                         |
| Injections whose text recurs          | 3 933 redundant calls, 2 185 815 redundant bytes |

Two conclusions the numbers force:

1. **The 32768-byte card budget is not the binding constraint.** The largest
   single injection measured is 9 923 B and p99 is 2 314 B. Tightening the
   per-card budget would not have prevented anything observed. The cost is
   _repetition_: 22.9 MB arrives as 20 174 small messages.
2. **Repetition is extreme and mechanical.** The single most repeated advisory
   (`worktree-guard.sh`: "Merging into base branch (main) while worktrees are
   active…", 194 B) was injected **1 069 times** across 107 transcripts. Three
   variants of the base-branch commit NOTE total 992 injections. Per-call
   suppression cannot see any of this, because each call is a fresh process.

Two further findings worth their own slices, out of scope here:

- **437 exit-141 (SIGPIPE) invocations.** A handler dying on SIGPIPE may leave
  its PostToolUse work — session-log append, snapshot — half done.
- **p50 hook latency 4 s, max 59.5 s.** Hooks are on the critical path of every
  tool call; this is a separate latency budget problem.

### 2.3 The composer drops whole cards, cumulatively

The budget check builds a _running_ concatenation and admits a card only if the
run stays under budget (`run-handlers.sh:330-343`):

```
card A (1500 B) + card B (1500 B), budget 2000
→ A admitted; B omitted entirely;  stdout = A only
   stderr: [card-b.sh] optional advisory omitted: whole-card budget 3002 > 2000 bytes
```

The reported number is the cumulative candidate size, not the card being
refused, and a card that does not fit is never truncated to fit. One large card
therefore starves every later handler's advisory for that invocation.

## 3. The reference model: CASR

Sterling's Context Authority Surfacing Runtime
(`docs/architecture/contracts/0037-context_authority_surfacing_runtime_contract_v1.md`)
already solves this problem class for a hook that fires on every edit, and its
decisions transfer directly.

**Non-droppable structure, droppable prose.** `claude_hook.py` caps the whole
display at `_MAX_DISPLAY_TEXT_CHARS = 2100`, caps each card label at 200 chars,
and compacts only _basis prose_ to a 60-char floor. Verdict, scope, coordinates
and member identities render _before_ the budget is consulted, so budget
pressure can shorten an explanation but can never erase identity
(`CASR-EMPTY-GOVERNING-RELATION-OCCLUSION-01`). CASR-10 states the invariant:
"Packets are compact cards, not retrieved-document dumps."

**Session-scoped dedup, with authority-aware invalidation.**
`casr_hook_driver.py` keys suppression on `target + packet_ref` (a deterministic
content digest), stores the ledger per session in
`<repo>/.casr/spools/<session_id>/.casr-hook-seen.json`, fails open to an empty
dict on any error, and bounds the ledger by dropping the oldest half past
`_DEDUP_MAX_KEYS`. Critically, a _changed governor anchor_ bypasses suppression
for that edit — dedup must never hide a fact whose authority just moved.

**The dedup ledger is a measurement seam, not just a cache.** The same ledger is
read by `influence.classify.read_surfaced_from_dedup_ledger`, so the offline
influence/uptake pipeline can ask what was surfaced and whether behaviour
changed. CASR states plainly that whether advisories change behaviour is a
causal question, answerable only with a withheld-CASR / ON-OFF counterfactual.

**Conditional emission and terse gap-only form.** A projection with no
actionable target-specific content produces no output at all; an ungoverned-file
projection collapses to one line; the stable attachment ref is carried
machine-readably and not re-rendered per edit. The rationale is the same one our
numbers show: "a per-edit surface that spends the same line budget on a constant
projection trains its reader to skim."

**Typed failure memory.** §10 enumerates the failure classes the substrate
falsifies — including "too many low-signal cards were emitted" and "the packet
created false confidence by omitting a non-claim". Omission is a first-class
defect, not a silent optimisation.

## 4. Design

### 4.1 Input: make environment size O(1) in payload size (slice 1)

The environment must carry only bounded scalars. The unbounded bytes are needed
by exactly two consumers: `audit.sh` (which writes them to the observation log)
and `scan-secrets.sh` (which scans them). Everything else uses scalars or small
extracted fields.

- The dispatcher writes the sanitized payload once to a dispatch-owned temp file
  and exports `HOOK_PAYLOAD_FILE`.
- Bounded fields stay inline below a threshold; above it, only the file is
  authoritative and the inline variables are emptied with an explicit
  `HOOK_PAYLOAD_TRUNCATED=1` marker, so no consumer silently reads a partial
  value as complete.
- `audit.sh` and `scan-secrets.sh` read the file. The remaining handlers are
  unchanged.
- The dispatch removes the temp file on exit, the same lifecycle already used
  for `CAWS_HOOK_SETTLEMENT_FILE` (`caws-hook.py:301-304`).

Rejected alternatives: passing the payload on a file descriptor (fragile across
the handler exec chain and hard to test), and capping only the response JSON
while keeping the raw env (leaves the ceiling in place, just moves it).

### 4.2 Output, stage one: per-card admission and truncation instead of

whole-card refusal (slice 2a — shipped)

Implemented in the three `run-handlers.sh` copies (shared / codex / kimi-code).
The composer previously measured the **cumulative** candidate context against
the budget, so one oversized card did not merely omit itself: the running total
never shrank, and every later handler's advisory was dropped whole for that
invocation.

- Admission measures the card against the bytes **still available**, not the
  running total.
- A card that does not fit is **truncated to fit** with an explicit
  `… [truncated: N bytes elided]` marker. The guard's head (what fired, on what)
  survives; the reader is told the tail was cut. Nothing is silently dropped.
- When fewer than 64 bytes remain, the composer **declines** rather than
  emitting a marker with no content behind it, and reports the card's **own**
  size — never the cumulative sum, so an operator can tell which guard is too
  large.
- Control decisions bypass composition entirely: `decision: block`
  short-circuits at priority 3 untruncated in the shared core.
  `permissionDecision: deny` reaches that priority only through the codex
  override, which is why codex-surface coverage owns that form.

### 4.3 Output, stage two: per-session ledger (slice 2b — shipped)

Harvest first, design second. Measured over the transcript corpus: of 20,322
injections, **3,293 (16.2%) are session-wide repeats** of text the session had
already been given, and the worst session spent 238 of its 1,163 advisory
injections on duplicates. Only 795 of the repeats are _consecutive_; the rest
are re-surfaced after another card intervenes, so a consecutive-only guard would
miss roughly four fifths of the win.

Implemented as a per-session, exact-text ledger:

- **Key** = handler name plus sha256 over the advisory's exact bytes
  (`od`-based, so shell string normalization cannot make two different cards
  collide). Any wording or fact change therefore re-surfaces the advisory — the
  CASR freshness lesson, achieved by construction rather than by a separate
  change witness.
- **Ledger** =
  `<CAWS_HOME>/state/sessions/<percent-encoded-sid>/advisory-seen.txt`, the same
  per-session machine-state directory `reprieve.sh` already uses. It is
  operational cache (gitignored), never governance state, and never leaves the
  machine.
- **Bound** = `CAWS_HOOK_ADVISORY_DEDUP_MAX` (default 4096), appended then
  trimmed so the post-record count never exceeds the cap.
- **Fail-open** = an unknown session, a missing/unreadable/unwritable/oversized
  ledger, or a missing digest tool all mean _emit_. Dedup engages only when it
  can record, so it can never suppress advice it could not have recorded.
- **Auditable** = every suppression prints
  `[handler] advisory surfaced before in this session and suppressed` on stderr,
  so "the guard did not fire" stays distinguishable from "it fired and was
  deduplicated".
- **Recorded only on delivery, not on composition** = keys are staged in a
  dispatch-scoped file and committed at the end of the dispatch, and only when
  it returned without a blocking decision. A card the budget omitted, or that a
  later handler's block discarded, never reaches the model — so it is never
  recorded and its retry still surfaces. Two early cuts got this wrong and
  silently ate the retry.
- **Offer bypass** = a card carrying a machine-adapter message offer bypasses
  dedup entirely, because settlement reads the card that carries the offer. The
  offer sidecar is created before the handler runs so the composer can see it.

Borrowed from CASR: per-session keying, content identity, silence on repeat,
fail-open, bounded state. Deliberately **not** borrowed: CASR's Python bridge
and repo-layout coupling (this is bash plus the pack's own shipped helper), its
governor-anchor registry, its refresh **block** path (a CAWS advisory must never
gain denial authority), and its untended `spools/` growth — 1,855 session
directories with no TTL or prune. The ledger is trimmed rather than pruned by
age, and a ledger whose trim cannot be written is dropped outright: a fresh
ledger means "emit", whereas a stuck oversized one is a wrong-suppression risk.

**Two named limitations, not oversights.** First, suppression is invalidated by
_content change_, not by a witnessed authority change: a guard whose message is
identical while the underlying authority moved stays suppressed for the session.
Closing that needs a change witness CAWS does not have, and it is the one place
the CASR freshness barrier is stronger than this. Second, the key is taken after
the handler's stdout goes through command substitution, which strips a trailing
newline; two advisories differing only by a trailing newline are therefore
treated as identical. The model-visible text was already normalized the same way
before this change, so no _visible_ content is hidden, but the limitation is
real and is recorded here rather than claimed away.

## 5. Slices

| Slice | Scope                                                                                       | Proves                                                                                     |
| ----- | ------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| 1     | Bounded input: payload file + truncation marker; `audit.sh`/`scan-secrets.sh` read the file | A multi-MB tool response no longer fails the hook; env size is independent of payload size |
| 2a    | Composer: per-card admission, truncate-to-fit, accurate per-card refusal accounting         | One large card cannot starve later advisories                                              |
| 2b    | Session-scoped exact-text dedup ledger, bounded and fail-open                               | Repeated advisories stop recurring; changed advice still surfaces                          |

## 6. Non-claims

- The harvest covers Claude Code transcripts only. Codex and DSH hook output
  weight is not measured here.
- Token counts are estimated at 4 bytes/token, not tokenizer-measured.
- The per-session totals sum a whole transcript directory, which may include
  more than one logical session per file; per-session figures are therefore an
  upper bound on any single conversation.
- This note does not claim the advisories are worthless, only that their cost is
  unbounded and their repetition is mechanical. Whether they change behaviour is
  the counterfactual CASR leaves open, and it remains open here.
