---
doc_id: caws-native-runtime
authority: architecture
status: active
title: Native runtime migration contract
owner: CAWS runtime maintainers
updated: 2026-10-18
audience: maintainer
---

# Native runtime migration contract

This contract governs the Rust and TypeScript replacement of first-party Python
implementations in CAWS. Implementation and adoption status live in the separate
[migration tracker](../internal/caws-runtime-modernization.md). A target
described here is not evidence that its implementation or native adoption
exists.

## Decision and strongest objection

Rust owns the native client, local transport, process startup, deadlines and
exact stdout/stderr/exit delivery. TypeScript owns governance and hook behavior
through callable modules, sharing existing CAWS kernel/store authority. Shell
execution is an explicit compatibility boundary for project extensions and
overrides. Stock implementations become in-process modules; putting the existing
subprocess chain behind a socket does not satisfy the migration.

The strongest objection to resident execution is that it removes the process
isolation and parent lifetime on which the existing runtime depends. It adds
uncertain delivery, restart and cache invalidation to enforcement. Therefore the
same TypeScript engine must work in one-shot mode before resident mode is
admitted. The one-shot path is a maintained execution mode, not a second policy
engine.

Rust must not reimplement claim, scope, spec, waiver or policy semantics. A
native binary provides no evidence that those semantics or native harness
delivery agree.

## Load-bearing assumptions and inspected evidence

The source baseline is `fb788cd241424ed3977081c9ad458b6c1fec7c59`.

| Assumption                                        | Status and evidence                                                                                                                                                                                                              | Consequence for design                                                                                          |
| ------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| Repeated process startup contributes to hook cost | Established structurally: `templates/hook-packs/shared/lib/run-handlers.sh:367` starts Python before and after each handler; 14 pre + 13 post handlers add 54 interpreter launches. Isolated latency contribution is unmeasured. | Remove orchestration subprocesses; measure the same workload before attributing speedups to language.           |
| Existing TypeScript can provide shared authority  | Established: strict kernel/store/shell/init compilation in `packages/caws-cli/tsconfig.vnext.json`; the build includes the kernel. Existing shell hooks do not all call a reusable in-process API.                               | Extract adapters to existing owners; audit each remaining Git/CLI dependency.                                   |
| Runtime behavior survives service reuse           | Refuted for a direct port: `runtime/caws-hook.py:40` and `:803` use process globals and request-specific environment.                                                                                                            | Pass immutable invocation context and injected dependencies; never mutate process environment per request.      |
| Every runtime error should deny                   | Refuted: `runtime/caws-hook.py:894` distinguishes pre-dispatch configuration errors, post-dispatch errors and bounded undeliverable Stop failures.                                                                               | Preserve event/phase-specific policy. A timeout is not a universal permission or universal lifecycle block.     |
| RPC success proves native refusal delivery        | Refuted: `runtime/caws-hook.py:148` supplies Codex refusal reasons on stderr, while Stop normalizes output differently.                                                                                                          | Transport status, native outcome, local flush and harness observation are separate facts.                       |
| Heartbeat expiry proves safe shutdown             | Unverified and insufficient: active requests and queued work can outlive a heartbeat.                                                                                                                                            | Heartbeats only influence idle retention. Demand, in-flight work and persistence govern shutdown.               |
| Cached policy remains current                     | Unverified; existing runtime resolves machine/repo configuration, overrides and canonical checkout on every invocation (`runtime/caws-hook.py:387`, `:695`).                                                                     | Validate request-time authority and code generation. File watchers are hints, not permission.                   |
| All ordinary checks can run without children      | Refuted as a blanket claim: Git/CLI calls and executable project/library overrides exist.                                                                                                                                        | Track removed stock fan-out separately from required Git and extension subprocesses.                            |
| Reconnection can safely retry a request           | Refuted for blind replay: handlers update leases, offers and journals; offer settlement follows local stdout handoff (`runtime/caws-hook.py:183`).                                                                               | Query a retained outcome; never silently rerun uncertain side effects.                                          |
| Native packaging is already supported             | Refuted: no tracked Rust crate/toolchain integration exists at the baseline. Node supports >=18; adding newer Node APIs would change support.                                                                                    | Prove target builds, package truth, executable identity, installation, trust, upgrade and rollback.             |
| Seven harness contracts remain equivalent         | Not established by source inspection. Registered events, native trust and failure channels differ.                                                                                                                               | Require per-surface installed observations; fixtures establish only their declared boundary.                    |
| Warm hooks meet a 100 ms target                   | Unverified proposal. Incident load exceeded 500 on 10 logical CPUs; no isolated benchmark exists.                                                                                                                                | Declare fixture/load/percentiles and bound queueing. Do not promise latency under arbitrary machine starvation. |

Source coordinates refer to the baseline hook-pack tree under
`packages/caws-cli/templates/hook-packs/`, except where a full path is given.

## Components and responsibility boundaries

1. **Native client.** Validate and bound stdin/frames, connect to a private
   user-owned endpoint, verify protocol/runtime generation, coordinate one
   startup, deliver exact native output and enforce a deadline with cleanup time
   reserved. It grants no project authority. A stale heartbeat file is not a
   health check.
2. **Invocation engine.** Parse once, resolve actual checkout and canonical
   authority separately, select policy and executable identities, evaluate
   ordered guards, compose output and produce an explicit native result. Every
   mutable dependency is scoped to an invocation or a documented serialized
   store.
3. **Authority adapters.** Reuse kernel/store APIs. Cache parsed material only
   with verified identities; do not replace current claims/specs with a lease or
   cached verdict. Consistent loading and changes during evaluation need hostile
   tests.
4. **Native response adapters.** Implement each harness's event-specific output,
   refusal and infrastructure-error policy. Stop budgets are scoped, persisted
   and distinguish an undischargeable adapter failure from a valid guard block.
5. **Journal and delivery custody.** Record selected identity, start, result and
   terminal state through the running process. Preserve a start before executing
   a handler. A failed journal write cannot erase a refusal. Local client flush
   does not establish harness visibility or tool execution. Durability
   guarantees name whether they cover process crash or power loss.
6. **Extension executor.** Preserve selection tiers, ordering, arguments,
   library overrides, environment, cwd and native outcome. Bound output,
   deadlines and owned process groups. Unknown applicability runs required
   enforcement.
7. **Resident host.** Execute the same engine; own admission, bounded queues,
   cancellation, per-project/session isolation, generations and idle transition.
   Slow extensions or rendering cannot starve required enforcement.
8. **Background workers.** Handle only operations whose contract permits delayed
   observation: rendering, aggregation and optional advice. Persist recoverable
   work before acknowledging that durability. Classify each operation before
   moving it; PostToolUse by itself does not make an operation deferrable.

Interfaces separate native transport, selection, authority reads, guard
evaluation, extension execution, journal, Stop budget and scheduling. The engine
depends on these interfaces. It is not a service locator and does not own every
store writer.

## Resident lifecycle

`absent -> starting -> ready -> draining -> stopped` has one startup owner and
versioned handshakes. Competing starters wait within the request deadline. Ready
services wait on IPC instead of polling. Agent activity keeps a service warm;
expired activity permits idle shutdown only with zero active requests and no
work that would be lost. A new request always creates demand, including when no
agent heartbeat exists. A draining generation does not admit new work.

Runtime generation and protocol identity are pinned per request. Upgrades drain
old generations without mixing their loaded modules with new bytes. Idle exit
and crash preserve the recoverable journal/spool, not a live process.
Per-request cancellation prevents request-owned children from mutating state
after completion. Disconnected or crashed requests have an explicit uncertain
terminal outcome; reconnection does not manufacture exactly-once execution.

The required machine workload includes at least thirteen simultaneous sessions
across at least four repositories. Bound worker and cache capacity across the
machine and admit work fairly by canonical project and session. Serialize only
operations sharing an owning state; preserve project-store transactions where
sessions mutate shared records. Rendering has separate bounded capacity from
required enforcement. Heartbeat expiry cannot evict in-flight work.
Qualification includes mixed harnesses, repeated session IDs across projects,
slow extensions, large transcripts, bursts, overload and generation changes,
with per-project and per-session measurements rather than aggregate-only
latency.

## Ranked failure modes and decision timing

| Severity | Trigger and failure                                                                                  | Cost                                                               | Resolve timing                                                                                           |
| -------- | ---------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------- |
| Critical | Stale cached claim/policy or Rust/TS authority disagreement permits a governed action                | Unauthorized mutation; later logs cannot undo it                   | Before any enforcement cutover; shared authority and freshness tests precede resident mode               |
| Critical | Client timeout/crash loses a denial while server work continues or is replayed                       | Permission gap, duplicate side effects and false delivery          | Define protocol, cancellation and uncertain outcomes before transport integration                        |
| High     | Globals, environment or mutable dependencies leak between concurrent requests                        | Wrong project/session policy, Stop counter or evidence custody     | Explicit context before engine reuse; interleaving tests before daemon admission                         |
| High     | Generic fail-closed errors trap Stop/teardown, or generic fail-open errors drop a guard verdict      | Session cannot act or leave; enforcement can disappear             | Preserve event/phase policy in the first response adapter                                                |
| High     | Stock modules bypass a project handler or library override, or reordered guards change first refusal | Consumer policy silently changes                                   | Before each handler is migrated and before adoption                                                      |
| High     | Single global FIFO, unbounded work or heartbeat-first work starves enforcement                       | Daemon concentrates the existing overload                          | Separate required admission from optional work; bound queue/output before resident adoption              |
| High     | Native install replaces a working generation without platform/trust/rollback proof                   | Machine-wide disruption across adopted projects                    | Before machine installation; package identity must be designed before release layout hardens             |
| High     | Request/outcome identity or persistent spool schema changes after deployment without migration       | Ambiguous recovery and unsafe retry; expensive data-format lock-in | Version before writing persistent resident state                                                         |
| Medium   | Heartbeat-based idle exit races an active request or upgrade                                         | Lost replies and duplicate startup                                 | Before resident lifecycle ships; one-shot work is independent                                            |
| Medium   | Language rewrite copies defective behavior or drops hostile parser cases                             | New implementation passes a weak equivalence oracle                | Preserve independent requirement fixtures throughout replacement; audit disagreements                    |
| Medium   | Removing legacy source/oracles before replacement is exercised                                       | Loss of diagnostic baseline and costly rollback                    | Delete only after consumers, fixtures, packaging and rollback are proven                                 |
| Medium   | Optimizing Rust code while repeated state loading/Git/CLI calls dominate                             | Rewrite cost without relevant latency improvement                  | Attribute timings before optimizing; transport and semantics can proceed with explicit unmeasured status |

The protocol and persistent state format are compounding decisions. Moving
policy to a second language and cutting over the shared runtime without rollback
are the expensive-to-reverse choices. A one-shot engine and explicit extension
boundary keep implementation order reversible.

## Functional acceptance and proof

| Criterion                     | Required observation and falsifier                                                                                                                                                                                                                             |
| ----------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Native delivery               | Compiled Rust client and actual TS engine preserve exit/stdout/stderr for bare exit 2, structured denial, Stop plain/JSON/malformed output, and configuration errors on every event; mutate refusal channel/exit to make tests fail                            |
| Authority freshness           | Keep engine resident while modifying claim, active spec, policy, runtime pointer, override bytes and linked checkout; next request observes each relevant change and cannot borrow another context                                                             |
| Process isolation replacement | Interleave two projects/sessions, one dispatched refusal and another malformed Stop/configuration request; outputs, counters, captures and journal paths match isolated runs                                                                                   |
| Extension compatibility       | Stock/repo/machine order, competing overrides, library overrides, arguments, cwd and environment are asserted against executed bytes; changes to order or source are detected                                                                                  |
| Lifecycle                     | Concurrent cold clients start one eligible service; idle expiry does not kill in-flight work; generation drain, restart, client kill and server kill leave explicit terminal/uncertain states and no unsafe replay                                             |
| Provenance                    | Forced interruption retains unmatched start and selected source identity; journal failure cannot replace denial; daemon result and client flush do not claim native visibility                                                                                 |
| Replacement coverage          | Source and package scans identify Python files, embedded programs, launch commands, tests/tooling, installed copies and foreign extensions separately; each feature has a proven destination and no first-party execution dependency remains                   |
| Performance                   | Same declared fixture compares baseline/candidate cold/warm p50/p95/p99, startup/queue/evaluation/journal time, memory and process counts at bounded concurrency; first-party orchestration fan-out is removed and overload returns a bounded, correct outcome |
| Packaging/adoption            | Clean unpacked package runs without Python; target executable+runtime identities agree; upgrade/rollback preserves governance; each supported harness demonstrates native trust, lifecycle, refusal and rendering                                              |
| Governance/review             | Focused checks, doctor, policy gates and independent committed-candidate feedback are grounded; only `caws specs evidence` records acceptance, followed by spec/event readback                                                                                 |

Warm first-party hooks below 100 ms are a proposed measured target. Git probes
and custom extensions have separately reported costs. Neither a zero-child
assertion for arbitrary extensions nor arbitrary-load responsiveness is an
acceptance claim.

## Execution order

- **Investigate:** inventory every Python/embedded consumer and native failure
  contract; attribute baseline cost; resolve lifecycle/identity persistence and
  platform packaging before they constrain consumers.
- **Implement:** native result adapter and isolated typed context, Rust client
  and shared protocol, one-shot engine, feature replacements, then the resident
  host and recovery. Tests exercise the consumer boundary at each step.
- **Change:** install/adoption and shared machine selection only after package,
  native harness and rollback evidence. Retire replaced implementations and
  update the tracker in the same logical change as each replacement.
