---
doc_id: command-analysis
authority: reference
status: active
title: Bounded command analysis
owner: CAWS maintainers
updated: 2026-10-19
audience: consumer
---

# Bounded command analysis

## Active write-guard integration

`bash-write-guard.sh` requires
`caws hooks mutation-view --json --cwd <execution-cwd> --project <canonical-root>`,
with the original decoded command in a JSON stdin object. This separate
`caws.shell_mutation_view.v1` contract supplies shell tokens, source spans,
observed directories, interpreter payloads, Git metadata coordinates and
unresolved issues. It has no permission verdict. Existing utility operand rules
and the claim oracle determine whether a recognized write is authorized. A
missing or malformed backend fails closed without falling back to the legacy
lexer.

Unknown execution cwd is carried as `null`, including through nested source. The
project directory may anchor syntax traversal but never becomes an observed
coordinate. Relative writes retain the specific unresolved-cwd refusal; absolute
targets remain independently checked. Unverified harness surfaces retain their
declared legacy project-coordinate assumption.

JavaScript and Python heredoc bodies remain interpreter data, so an arrow or
object literal does not become a shell redirect or brace expansion. Only actual
interpreter invocations produce payload records; quoted search text mentioning
an interpreter does not. Literal Bash heredoc and `-c` programs receive bounded
recursive shell inspection. Other shell semantics, opaque executable stdin,
unmodeled state-changing builtins and known execution-bearing options remain
unresolved. Source changes to interpreter preload/import environments also
remain unresolved.

Known `git add` and `git commit` operations carry their actual Git directory,
common directory and working tree in a distinct metadata channel. A constant
read-only Git query resolves these coordinates; the submitted operation is never
executed. Discovery caches at most eight contexts per projection, including
failures, with a 500 ms deadline and 64 KiB output limit per query and no retry.
Unprofiled application effects invalidate later filesystem observations. Nested
shell jobs also inherit parent effects; another unmodeled invocation or output
redirection anywhere in the enclosing source conservatively invalidates nested
metadata coordinates, including concurrent pipeline siblings. A sole inspected
literal Bash invocation is exempt from its own enclosing invocation's opacity;
mixed finite callees at that source position cannot borrow the exemption.
Unproven cwd, prior filesystem effects, redirected index files and failed or
bare-repository discovery remain unresolved. Both metadata directories receive
the foreign-repository check. External metadata layouts without an established
project boundary remain unresolved. The oracle separately matches the physical
working tree, derived from reciprocal metadata pointers, to a unique registry
entry and its stamped owner. An independently overridden `--work-tree` cannot
lend its identity to another worktree's metadata. Canonical metadata is
admitted; unknown identity, missing ownership and duplicate matches cannot grant
admission for a linked working tree. A namespaced response prevents an older
file-only oracle from silently accepting a metadata operation.

The interpreter check retains a limited write-verb/path co-occurrence heuristic
over actual payloads and bounded entry-script reads. It is weaker evidence than
a shell operand and feeds only the foreign-repository check, never the claim
oracle. A recognized write verb without an extractable path remains unresolved.
This does not prove arbitrary Node, Python or external programs read-only;
indirect calls, imports, dynamically selected behavior and concurrent file
replacement remain outside this source-level recognizer.

The projection shares the expansion engine's limits and adds shared limits of
4,096 emitted tokens, eight nested shell levels, 32 source jobs, 64 KiB
cumulative source and 256 KiB carried text. It stops projecting on exhaustion
and retains an unresolved issue. Original source is never executed to obtain an
expansion or trace. Inline nested source uses the original code word as a coarse
span when quote removal prevents character-level mapping.

This integration concerns the active write-guard handler. The optional
worktree-pin policy below is a separate consumer with a narrower admission
profile. Handler fixture checks do not establish live machine deployment or
custody through later native interceptors.

The admitted subset leaves unmodeled build tools such as `npm test` unresolved.
Enabling this optional guard for a full development workflow requires additional
program profiles or a separately defined runtime policy. Unknown effects do not
silently acquire permission. Jev, if used, classifies retained examples offline
to inform the design; it has no role in future-command admission.

Git uses native physical path resolution. Bash `cd` keeps a failure alternative,
invalidates PWD/OLDPWD, and leaves logical parent traversal unresolved unless
`-P` is explicit. Execution cwd metadata must come from the tool, not an assumed
session-root fallback.

`caws hooks analyze` inspects command source without running it. It returns
`allow` (exit 0), `deny` (1), or `unresolved` (2), with reasons and an expansion
trace. Unresolved means no permission proof: it is distinct from an observed
policy violation. Analysis never rewrites the submitted command.

```sh
caws hooks analyze --worktree /project/.caws/worktrees/own --cwd /project/.caws/worktrees/own --command 'P=src/example.ts; sed -n 1,40p "$P"' --json
```

For tooling, send a JSON object on stdin containing `command`, `cwd`,
`worktree`, and optionally `shell`. A native
`{tool_name:"Bash", tool_input: {command:...}, cwd:...}` envelope is also
accepted. Caller arguments override payload fields. `--worktree` is the trusted
pin in the installed guard; command text cannot choose it. The JSON schema is
`caws.hooks_analyze.v1`; reasons and trace entries use half-open JavaScript
string indices into the original source. The source budget counts UTF-8 bytes.
Custody refers to the exact decoded command string in a valid JSON envelope, not
the envelope's whitespace or serialization. Upstream sanitizer recovery is
outside this boundary; a dispatcher that repairs invalid input cannot establish
original command identity. JSON and argv are data transports; submitted source
is never interpolated into a shell program by the analyzer or its tests.

## Admitted mechanism

Git admission requires reciprocal linked-worktree metadata for the pin and a
constant read-only `git rev-parse` query for the effective context. The query
receives validated directories and metadata overrides through argv/environment;
it never receives the submitted subcommand or shell source. Its metadata,
common-directory and worktree results expose parent or nested repository
discovery that cwd containment alone cannot establish. Bare repositories,
unsupported query output and query failures are unresolved. Mapping gitfiles
must be ordinary, singly linked files.

Each analysis caches at most eight distinct discovery contexts. A query has a
500 ms deadline and a 64 KiB output limit. One timed-out metadata query may be
retried per analysis, for at most nine query attempts and 4.5 seconds of query
deadlines. Protocol and I/O failures are not retried; an unsuccessful recovery
remains unresolved. This retry never executes submitted source. Submitted file
writes and lifecycle effects invalidate subsequent Git admission, including
effects inside pipelines and subshells; shell-local cwd and bindings retain
their separate scope. Known Git metadata writes are unresolved. Git
configuration, repository creation and other unprofiled subcommands are
unresolved. This prevents a source-visible change from borrowing a repository
fact measured before that change.

Conditional `test`/`[` profiles admit data-only string/file predicates and
literal integer comparisons. Variable-reference predicates and compound
expressions are unresolved. Normal redirection targets preserve quote-sensitive
field splitting; here-strings keep their distinct no-splitting behavior. The
[Bash redirection rules](https://www.gnu.org/s/bash/manual/html_node/Redirections.html)
and [Git discovery rules](https://git-scm.com/docs/git/2.56.0.html) define these
boundaries.

The pinned ISC-licensed `unbash` parser produces a Bash AST. A typed interpreter
tracks literal assignments in source order, finite loops, branch alternatives,
cwd changes, pipeline/subshell scope, quotation and default-IFS field splitting.
Arguments expand before command-local prefix assignments apply. Repeated Git
`-C` options compose in order, with the final directory checked through physical
filesystem resolution. A literal or finite variable containing a known filename
does not become suspicious merely because it uses a variable.

Utility profiles distinguish executable names, options, scripts, targets and
data. Sed admits a small grammar of numeric/`$` addresses with `p`, `d`, `=`, or
`q`. Execution forms such as `e` and `s///e` are denied; other script grammars,
script files and editing options are unresolved. Quoted opaque filenames are
admitted after `--`; opaque scripts and Git targets are unresolved. Nested
command substitutions are recursively inspected as read producers and their
output stays opaque. No substitution runs during analysis. `bash -x` would
execute expansions before tracing them and cannot serve as this preflight.

Declaration commands have no admitted profile. Their assignment arguments stay
unresolved; original scalar values are inspected for nested producers without
reconstructing ordinary argv or changing parent bindings. Nested policy
violations retain their original source coordinates and denial precedence.

Known wrappers `command` and `env` preserve the argument-role checks. Unknown
applications, inline interpreters, functions, arithmetic, process substitution,
parameter operations, background execution and other unsupported syntax are
unresolved. A parser recovery/error, dependency failure, or exceeded budget is
also unresolved. Limits are 64 KiB source, 4,096 visits, 16 AST depth, 32 states
or argument alternatives, 32 loop iterations and eight wrapper levels. The first
visit or depth exhaustion ends interpretation with one budget reason; an earlier
denial remains a denial. The source-size limit applies before parsing, but the
visit limit does not establish a bound on the parser's own work.

## Policy and assumptions

The opt-in worktree pin guard requires an initial cwd inside its worktree,
except for individually analyzed `caws worktree merge|destroy|create|ensure`
invocations. A lifecycle command does not exempt neighboring commands. Git
targeting the canonical checkout or another worktree is denied. Git targeting
the pinned lane or scratch outside the canonical project remains admitted. Git
metadata overrides are checked separately. A missing pinned directory releases
the pin so a merged session can create its next lane.

This is a source-level guard, not a process sandbox. Its load-bearing host
contract is non-POSIX Bash with its keyword option disabled, default IFS,
ordinary scalar bindings without inherited integer/nameref attributes,
`lastpipe` disabled, trusted executable resolution, no unmodeled
aliases/functions/startup hooks, and stable repository mappings during check and
execution. Known source changes to these assumptions are unresolved. Executable
identity, Git configuration/hooks, application internals, concurrent filesystem
replacement, and the actual harness execution environment are not proved by an
AST. Stronger containment requires runtime filesystem/process policy. Native
`exec_command`/`shell_command` inputs require an explicit supported shell;
native Bash also requires `login:false`. Native `workdir` is the execution cwd,
resolved against the caller's base cwd; conflicting command fields are
unresolved. The normalized name `Bash` alone does not establish a native
command's dialect. `CAWS_BIN` and the pin environment are trusted launcher
configuration; validating a response schema does not authenticate a malicious
replacement CLI. Known inherited POSIX/keyword settings are refused. Their
assignment rules can change the executable or Git environment selected by later
source. The
[Bash mode contract](https://www.gnu.org/s/bash/manual/html_node/Bash-POSIX-Mode.html)
and
[environment rules](https://www.gnu.org/software/bash/manual/html_node/Environment.html)
define that distinction. Named file descriptor allocations are unsupported
because they mutate shell bindings independently of ordinary assignments.
Unquoted tilde prefixes are unresolved in ordinary words, assignment values and
assignment-shaped arguments. Bash expands them before parameter expansion,
including after assignment colons; treating the resulting bytes as literal data
can hide a state-changing `printf` format. Quoted and escaped tildes remain
data. See the
[Bash tilde rules](https://www.gnu.org/s/bash/manual/html_node/Tilde-Expansion.html).

The assumptions have different evidence:

| Dependency                                                                                      | Status and decisive check                                                                                                                                                                             |
| ----------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Submitted expansions remain inert during analysis.                                              | Established for the exercised corpus by compiled-consumer, installed-handler and packaged sentinel checks; unsupported syntax stays unresolved.                                                       |
| Git discovery matches the pin's reciprocal metadata.                                            | Established for real linked-worktree, unmapped, forged, nested-foreign and source-visible mapping-change fixtures; concurrent replacement remains outside the host contract.                          |
| Argument roles distinguish options from data.                                                   | Established only for the declared closed profiles and paired fixtures. Unknown options are unresolved; `uniq`'s second operand is an output, and ripgrep decompression is outside the reader profile. |
| Bash startup state, executable identity and repository configuration satisfy the host contract. | Assumed, not established by source analysis. Native adoption must verify or enforce these properties.                                                                                                 |
| The actual executor receives the checked command and cwd.                                       | Unverified across the full native hook chain; later command transformations require rechecking or binding to the final invocation.                                                                    |

Git subcommand options use closed argument-role profiles. An option such as
`--grep` consumes its data operand; identical bytes in an executable option
position receive a different result. Unmodeled options, including output-file
options and arbitrary formatting languages, remain unresolved. Source-visible
writes invalidate later Git observations across subshell and pipeline
boundaries. Concurrent pipeline siblings invalidate each other's Git
observations regardless of their textual order. Discovery timeouts, incompatible
output and I/O failures have distinct reason codes and infrastructure remedies.
They remain unresolved; simplifying shell source does not establish the missing
repository fact.

These boundaries determine the main failure modes:

| Severity | Trigger and cost                                                                                                         | Disposition                                                                                                                    |
| -------- | ------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------ |
| Critical | Executing expansion to learn argv performs the prohibited effect before authorization.                                   | Excluded: source parsing only; sentinel tests must remain inert.                                                               |
| Critical | A later interceptor changes an admitted command or cwd, applying a decision to a different invocation.                   | Resolve before native activation: bind or recheck the final effective invocation.                                              |
| High     | Losing prefix-assignment order, branch alternatives, quotes or nested producers can admit foreign Git or executable sed. | Resolve before adoption: hostile corpus and mutation controls.                                                                 |
| High     | Host functions, configuration, symlink changes or another shell disagree with the model.                                 | Retained boundary: declare dialect and host assumptions; use runtime isolation for adversarial enforcement.                    |
| High     | Malformed input, parser recovery, resource exhaustion or invalid CLI response becomes allow.                             | Resolve before adoption: explicit unresolved results and fail-closed installed-consumer tests.                                 |
| Medium   | Expanding utility support with string heuristics accumulates exceptions that become hard to replace.                     | Add typed role profiles with paired benign/hostile fixtures; classification may prioritize work but cannot authorize commands. |
| Medium   | A runtime upgrade reaches concurrent projects with a stale CLI.                                                          | Isolated package/runtime validation and rollback first; preserve ordered CLI, runtime, native setup.                           |

The strongest objection to native activation is the final execution binding: a
later interceptor can change the checked invocation. Within the declared payload
boundary, agreement between the model and the shell remains a host assumption.
Widening the subset requires independent examples that distinguish a correct
interpretation from a plausible incorrect one.

## Verification and adoption

Native adoption must bind the decision to the final effective command and cwd.
The shared `quiet-merge.sh` interceptor follows blocking guards and can prepend
a canonical-root `cd`. A decision about its input cannot authorize that changed
invocation. Full-chain validation or rechecking after transformations is an
adoption prerequisite; direct installed-handler tests establish only the payload
boundary they exercise. The guard remains opt-in while that integration is
unverified.

`tests/shell/command-analysis.test.js` drives the compiled consumer over stdin
and checks decisions, deterministic traces, source spans and absent side
effects. `tests/shell/hooks-analysis.test.js` checks the public CLI and exact
payload transport. `tests/hooks/bats/worktree-pin-guard.bats` installs the
actual pack in isolated HOME/CAWS_HOME and checks benign admission,
quoted/variable Git refusal, mixed lifecycle commands, missing infrastructure
and release/repoint behavior. The parser dependency and native ESM loader must
also work from a packed install.

Functional completion requires these observable results, hostile negative
controls that fail when the policy is removed, a non-executing historical replay
with provenance gaps retained, doctor/gates, and independent feedback grounded
on the committed candidate. Counts alone do not establish semantics. Private
replay inputs and generated evidence remain outside the source ledger.

The historical warning survey found 207 distinct native refusals: Sterling 178,
RC 14, full-stack-ds 14, paths-design-suite 1. The terminal harvest contains
265,615 records and 27 exact warning outcomes, 25 overlapping that index. The
remaining 182 indexed commands are recoverable from specifically indexed source
records. The union contains 209 distinct incidents. Only 27 replay records have
explicit historical cwd and two commands are redacted. Lexical presence of a
variable or a refusal is not a false-positive judgment; in-place edits and
computed scripts need separate adjudication.

The replay driver uses an explicit counterfactual owned-worktree context and
never executes retained commands. Nine independently labeled examples provide
representative comparisons; they do not establish ground truth for every record.
A benign-labeled command naming a deleted historical worktree retains its
admission disagreement and context limit. A sanitized equivalent in an existing
worktree tests the finite-loop mechanism separately. Replay admission counts are
not historical false-positive rates.

Investigate the smallest unsupported pattern with a live decision behind it;
implement its role/value refinement with independent controls; change runtime
policy only after installed-consumer and rollback evidence. A probabilistic
classifier can label sanitized historical patterns or propose profiles, while
the deterministic analyzer remains the admission authority.

The pin guard remains opt-in in the shared dispatcher. Installing the package or
passing isolated tests does not establish global runtime adoption, native
execution in each harness, or changes to Claude Code's internal classifier.
