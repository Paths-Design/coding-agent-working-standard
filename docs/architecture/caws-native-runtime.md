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

## Payload custody and extension normalization

Unknown payload numerals remain opaque JSON tokens during transport. Rust
validates JSON grammar and object shape without converting extension values to
floating point. The TypeScript protocol compares source tokens, including
negative zero and nested values, rather than comparing two rounded JavaScript
projections. Hook stdin and nested JSON environment projections use source
spans; CAWS replaces its owned event metadata explicitly. An original-input hash
alone does not establish the value delivered to a consumer.

Native-generated process IDs and deadlines have a separate wire contract:
canonical unsigned integer tokens, followed by field-specific numeric bounds.
Checking only a JavaScript integer projection can accept a fractional token
whose tail rounded away. This representation check does not authenticate the
caller or establish that its process is a safe agent-termination target.

The decoded JavaScript payload is a convenience projection for audited fields,
not a lossless representation of extension values. Python decimal/exponent
serialization, nonstandard numeric values, sanitization and transport-threshold
behavior require separate qualification; exact integer observations do not
establish that broader parity.

Every non-stock selected handler uses the complete selected compatibility
dispatcher until input normalization is qualified. This preserves parser-owned
fields such as Codex's original tool name and file-path list. Preloading the
parser does not fill missing fields when a pre-set tool name makes it return
early. The direct executor remains component-tested; that does not authorize
production extension routing through a partial environment projection.

Parity includes guard strength and the complete caller-to-effect chain. Neither
compatible nouns and interfaces nor a successful local output handoff establish
that a prohibited tool was withheld or a latched agent terminated. The
containment qualification includes a subsequent request whose session identity
is absent. Agreement with a baseline that misses the latch is a failed safety
result, not acceptance. Effective surface-library selection must be traced
before attributing cache-production or recovery behavior to a shared
implementation.

First-party helpers execute through typed worker-local interfaces. A worker must
not wait for nested work queued behind its own state owner or a saturated worker
pool. Extension reentry requires an explicit supported path or an immediate
bounded refusal; increasing pool size cannot resolve that ownership cycle.
Qualification includes a reentrant extension and observes both its outcome and
the progress of unrelated sessions. This constrains host integration; a
reentrant daemon defect has not been demonstrated in the current one-shot code.

## Resident lifecycle

Process containment is a preserved safety obligation. Logical request identity,
cached session correlation, request-child ownership, agent termination targets,
and persistent-service ownership are separate contracts. Excluding an unsafe
identity-cache override does not discharge the danger latch's PID tracking and
termination behavior. The containment port must trace latch activation through
the next prohibited tool attempt, validate the actual caller's process instance,
signal the intended target, and observe the outcome. Resident-worker ancestry
cannot substitute for caller ancestry. A signal syscall succeeding is not an
observation that the agent exited.

A backend PID is not assumed to identify one logical session: the root and its
review subagent were observed under the same Codex process instance. Sharing by
the other active user chats has not been established. Before cutover, determine
the effective deployed target and its containment domain; do not claim isolated
session termination from a process-name or start-time match alone. Tests use
disposable owned processes and an independently observed surviving control,
never a live developer backend.

`absent -> starting -> ready -> draining -> stopped` has one startup owner and
versioned handshakes. Competing starters wait within the request deadline. Ready
services wait on IPC instead of polling. Agent activity keeps a service warm;
expired activity permits idle shutdown only with zero active requests and no
work that would be lost. A new request always creates demand, including when no
agent heartbeat exists. A draining generation does not admit new work.

Runtime generation and protocol identity are pinned per request. Upgrades drain
old generations without mixing their loaded modules with new bytes. Idle exit
and crash preserve the recoverable journal/spool, not a live process. Admission
has one owner per machine runtime home, independent of generation. Compatible
worker generations share that owner's capacity and fairness limits; starting a
generation cannot create another allowance. Replacing an incompatible host
requires an exclusive handover after its admitted executors have settled.
Requests waiting for that handover remain deadline-bounded and distinguish a
known not-admitted outcome from an uncertain execution. Generation overlap and
host replacement must be tested against observed worker counts, not each host's
own counters. This is a resident-host requirement, not implemented behavior.
Per-request cancellation prevents request-owned children from mutating state
after completion. Disconnected or crashed requests have an explicit uncertain
terminal outcome; reconnection does not manufacture exactly-once execution.

Mandatory safety execution precedes discretionary admission. The current
one-shot frontend captures ancestry before Node, but latch/strike/escalation and
required Stop decisions execute after dispatch. A Busy result before that
dispatch cannot substitute for termination of the verified latched caller or
evaluation of the goal guard. A general queue before Node requires that complete
mandatory path to move with its canonical authority implementation; a reserved
slot alone does not establish the invariant under saturation.

Retained Node modules and invocation-owned descendants have different lifetimes.
The fresh native frontend must retain the actual executor Child and private
group; a daemon-parented compatibility guard cannot recover the caller's
ancestry by trusting a cached PID. Every subprocess port needs the same
request-owned execution boundary, including context Git, classifier Git,
utilities and process lookup. Normal executor cleanup must leave an unrelated
module worker alive. An opportunistic warm-worker borrow may fall back to the
existing one-shot path only before any request bytes might have been delivered.
This intermediate route preserves mandatory execution but does not establish
bounded cold fan-out. Returning a worker to idle requires handoff settlement and
actual resource drain; late frames, descriptors and capabilities from one
request cannot settle another. The existing Stop render descriptors are per
invocation and fill once; their numbers cannot stand in for a new request's
actual descriptor transfer.

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

Request cleanup must not kill intentionally persistent extension services.
Sterling's renderer client starts its daemon as a background Python child
without creating a new session or process group. The one-shot native supervisor
therefore cannot treat that first-start daemon as an ordinary disposable request
child and claim compatibility. Persistent services need explicit service-owned
lifetime and startup coordination, separately from request groups and agent
containment. Arbitrary descendants receive no blanket escape from cleanup.
Qualification starts with no renderer daemon, observes the first invocation
return, verifies the service remains alive and serves a second request, then
checks source-change retirement, cancellation and simultaneous startup. Warm
reuse alone cannot establish this boundary. This integration remains
unqualified.

Service creation and render admission share one ownership contract. A relay at
the selected interpreter invocation can reach Sterling's daemon start without
changing foreign source bytes, but cannot alone provide that contract: its
client sends requests directly through `/dev/tcp` and falls back inline after a
response timeout. The daemon writes render artifacts before sending its
response. A timeout therefore cannot authorize another renderer to repeat the
operation. The actual selected client needs an explicit broker integration, or
an explicitly selected compatibility adapter that owns both request admission
and fallback. Only known nonexecution permits immediate inline fallback;
dispatched work with a lost response remains unknown and serialized by its
project/service owner until its effect is resolved or cancellation settles.

Service declarations belong to the typed policy owner and effective selection.
They bind the selected handler, client, executable, daemon and declared source
closure to a named protocol adapter. Caller environment, PID/token leases and
heartbeats cannot create a capability or transfer child ownership. The native
service owner creates and retains its own child/group from the start; ordinary
request-group cleanup remains intact. Source generations share a project/service
serialization key, and replacement cannot write before the old writer settles.
Host-crash child cleanup and recovery of unknown partial writes require their
own mechanism and evidence; private IPC and normal idle exit do not prove them.

Cooperative renderer writers share the anchored custody directory at the
canonical project's `.caws/.render-writer-custody`. A private sibling
`.render-writer-provisioned` registration pins the custody directory's device
and inode. Exclusive registration precedes exclusive custody initialization;
partial provisioning, an absent registered directory or a replacement directory
refuses admission. Session-cache cleanup cannot create a new writer domain. This
registration records provisioning, not foreign-writer adoption or drain. The
project-wide key excludes source generation, session and machine home, so a
replacement generation or another `CAWS_HOME` cannot create a second owner for
the same output project while the canonical `.caws` root and provisioning
registration remain intact. Whole-governance-root replacement remains outside
the cooperative contract; the writer cache is separate from disposable session
output. The native owner and the cooperative one-shot launcher retain the actual
lifetime lock through owned child cleanup and both output EOFs; their directly
created writer inherits the lock descriptor across exec. Each backend lifetime
or one-shot operation also publishes a dispatch intent in the anchored journal
before its effect. An abandoned intent recovers as unknown and refuses
subsequent cooperative writers after the live lock is released. Timeout and
response loss do not clear that persistent fence. The journal has an internal
typed `not_started` result for observed preparation or spawn failures that
create no execution child. Publishing that result releases the reservation
without fabricating a process exit; failure to publish retains uncertainty.
Failures after child creation require the existing cleanup and outcome rules.
The journal has bounded retained history and refuses capacity exhaustion without
evicting an accepted operation; this implementation supplies no reset procedure.

This protocol covers adopted launch paths. Sterling's reviewed unchanged daemon
and one-shot renderer do not acquire the fence, and its unchanged client permits
inline rendering after a lost response. Atomic artifact replacement protects
individual JSON files from tearing; it does not exclude concurrent writers. The
CAWS cooperative client successor routes rendering through the native one-shot
launcher and leaves the selected hook on refusal or uncertainty, without
invoking the legacy fallback or spawning an unmanaged daemon. Selecting that
successor for every foreign writer and positively draining the previous writers
are external migration obligations. A missing lease, answering port, PID record,
private policy declaration or installed helper does not establish that drain.
The opt-in native owner and private qualification fixtures do not establish
shared-output Sterling adoption or eligibility for machine cutover.

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

Each parity claim names a preserved behavior and its dependency chain, not only
a file, command, schema, or language replacement. In particular, danger-latch
containment requires retained latch/warning records, resolved session and
process-instance observations, signal attempts and observed target exit, native
refusal bytes, and a surviving unrelated-process control. Prove that the blocked
tool did not execute. Include wrong-session, reused-PID, unavailable-target,
read-only/reset exceptions, file tools and resident-caller cases according to
the governing contract. These checks are blocking dependencies of replacement;
passing classifier, protocol or identity tests does not establish them.

Scenario evidence retains exact commands, revision/build/source identities, raw
output bytes, exit status, relevant state before/after, and observed consumer
results. Print concrete selected artifacts after execution. Identify how the
tests could pass while the intended behavior is absent, what was not verified,
and which additional observation would settle each material gap. Missing
artifacts leave the claim open rather than being replaced by a passing tally.

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

The next implementation milestone is an executable one-shot path through the
native client, typed engine, selected production guards and native result.
Finish bounded component work already in flight, then prioritize that path over
adding more isolated ports. It needs actual handler, environment, override,
journal and Stop/handoff behavior; a fixture engine cannot discharge that
milestone.

- **Investigate:** map current guard behavior and retained failure lineage to
  the consumer path; attribute baseline cost and settle package/rollback
  boundaries. Historical ledger descriptions guide probes, not current authority
  claims.
- **Implement:** integrate the one-shot path and prove positive and refusal
  behavior through it. Replace remaining features with their consumers, then run
  that same engine under the resident host and thirteen-session workload.
- **Change:** qualify an isolated packaged adoption and rollback before
  selecting it for active machine sessions. Machine-wide replacement requires
  full parity with the previous selected version, including supported native
  harness and project-override behavior; component or partial-path success
  cannot trigger installation. Once that parity is established, install the
  replacement on this machine and verify its selected execution. Retire each old
  consumer only after its real replacement is selected and checked. Keep the
  full migration open until every replacement, supported harness and acceptance
  obligation is discharged.

## Authority boundaries and reconstruction falsifiers

Sterling's sibling `docs/theory/sterling-inversions.md` identifies the risk of
retaining familiar components while substituting their authority model. It is a
reference for this review, not an additional source of CAWS write authority.
CAWS's [failure lineage](../failure-lineage.md) preserves incident intent and
residuals; current contracts and executable consumers establish current
behavior.

| Tempting substitution                                                           | Required CAWS boundary                                                                                                      | Discriminating observation                                                                                                                                  |
| ------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| An available daemon, fresh lease or cached verdict establishes permission       | Runtime availability and agent visibility confer no authority; current canonical project/spec/claim policy remains decisive | Keep the host warm, withdraw a relevant binding or change policy, and observe the next real guarded request refuse without borrowing cached permission      |
| A project/session queue replaces shared-state authority and transactions        | Scheduling owns capacity and declared execution order; existing governed writers own shared mutations and audit             | Concurrent same-project sessions cannot lose a governed update, bypass scope, or produce spec evidence without its corresponding event                      |
| A valid frame or exit zero establishes that governance ran                      | Wire validity, engine execution, native delivery and harness action remain separate observations                            | A real guarded write is withheld by the native harness; corrupt identity, omit a required handler, or alter the refusal channel and the check fails         |
| A common error fallback is equivalent to refusal                                | Valid guard refusals, configuration failure, execution uncertainty and undeliverable Stop infrastructure remain distinct    | Repeated valid Stop blocks never spend the infrastructure budget; only the documented unavailable-result sequence releases with an explicit diagnostic      |
| Better speed, a new language or passing component tests establishes replacement | Performance changes cost; exercised production consumers establish preserved behavior and replacement                       | An unpacked candidate selects the actual replacement, exercises its guard and override paths, survives rollback, and no longer invokes the retired consumer |

The tracker records component, package, installation, native observation and
retirement separately. No status or acceptance follows from retaining the nouns,
removing a Python filename, counting tests, or improving latency alone.
