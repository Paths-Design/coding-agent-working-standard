---
doc_id: command-analysis
authority: reference
status: active
title: Bounded command analysis
owner: CAWS maintainers
updated: 2026-10-26
audience: consumer
---

# Bounded command analysis

## Literal inspection prefixes

`caws hooks inspection-prefix` reads shell source from stdin without executing
it or loading project authority. Its fixed response is
`caws.inspection-prefix.v1:allow`, `:unsupported`, or `:error`, followed by LF.
Exit 0 means positively classified, 1 means unsupported syntax or argument
roles, and 2 means a parse, runtime or resource failure. An analysis or
mutation-view allow result does not substitute for this predicate.

The pinned structural parser accepts complete newline-separated simple commands
with literal operands, including quoted operands. Reader, Git and sed argument
roles share definitions with effect analysis. The closed subset includes reader
utilities, explicit Git inspection subcommands, `git branch --show-current`,
`pwd` with its modeled options, sed print/delete/quit scripts, and explicitly
reviewed CAWS read routes. Assignments, redirections, expansions, substitutions,
operators, wrappers, control structures, lookup mutations, execution/output
options and unknown commands are unsupported. This syntax policy assumes trusted
ordinary executable lookup and Git configuration; it does not authenticate
executable identity or grant ownership.

CAWS read routes, option effects and literal operand roles live in the pure
`src/shell/analysis/caws-read-metadata.ts` module. Normal CLI registration uses
the same leaf definitions through the command catalog; inspection does not load
the catalog's store/lifecycle dependencies. Reviewed families include specs,
scope, status, doctor, worktree review/list, gates inspection, evidence readers,
event readers, waiver/reprieve readers, agent readers, working-tree check, goal
show and non-consuming message readers. Status/lifecycle/state and message-id
aliases retain their declared roles. `specs recover --out` writes, and
`specs verify-acs --run` executes tests: both decline projection. Unknown routes
or options, unreviewed option effects, invalid enums, missing/excess operands
and ambiguous option combinations also decline. This is a closed syntax
contract, not a check that referenced specs, files or messages exist.

Bare `caws` and literal absolute paths ending in `/caws` use the same contract
under normal trusted lookup/configuration assumptions. The basename does not
authenticate an arbitrary binary. Relative executable paths, wrappers,
assignments and lookup changes are unsupported. This does not prove general Node
payload safety or protection against a pre-existing shell function, hostile
PATH, or startup configuration; original raw interpreter-write checks and the
caller's trusted execution environment remain necessary.

The classifier limits input to 32 KiB, 64 commands, 4096 AST objects and
depth 64. A supervisor limits synchronous parsing in a worker to two seconds,
with a 64 MiB old-generation heap and 2 MiB stack. Input collection has a
separate two-second deadline. Submitted source is inert data.

`caws_blank_heredoc_bodies(input)` uses the predicate for a nonempty prefix
before a complete standalone quoted bare Node heredoc. The selected library
derives its physical managed generation from its own location and checks the
dispatcher's selected shared path and digest. It invokes only that generation's
absolute `native/node` and compiled `inspection-prefix-entry.js`, clearing
modeled Node startup controls. Ambient `CAWS_BIN` or `PATH` cannot select
classification. Only exit 0 with the exact versioned positive response permits
body projection. Missing, old, relocated or unmatched layouts and
protocol/runtime failures retain raw input. This relies on managed snapshot
verification and a trusted host, not stronger protection against filesystem
races. Fixtures exercise the binding contract; installed loader selection
requires separate native qualification.

The projection preserves prefix, header, delimiter, suffix and trailing bytes,
replacing only body lines with blank lines. The Node-first form needs no prefix
classifier. Cat/tee file-sink behavior remains separate. Node is executable
data, never a file sink or a read-only command: callers must retain the original
raw command for interpreter-write checks and inspect outer writes independently.

## Active write-guard integration

The diagnostic commands have different exit contracts. `caws hooks analyze`
returns 0 for bounded allow, 1 for deny and 2 for unresolved.
`caws hooks mutation-view` returns 0 when projection completes, including a
projection containing issues, and 2 for a caught decoding or outer-command
exception. Parser/backend analysis failures can become issues in a normally
returned projection. A consumer must inspect schema, issues and effect coverage;
exit zero is not a permission verdict.

`bash-write-guard.sh` requires
`caws hooks mutation-view --json --cwd <execution-cwd> --project <canonical-root>`,
with the original native execution envelope on JSON stdin. The CLI's literal
`{command}` request form is also available for direct callers. This separate
`caws.shell_mutation_view.v2` contract supplies shell tokens, source spans,
observed directories, interpreter payloads and effect knowledge, copy operand
roles, Git metadata coordinates and unresolved issues. It has no permission
verdict. Existing utility operand rules and the claim oracle determine whether a
recognized write is authorized. A missing or malformed backend fails closed
without falling back to the legacy lexer.

Every recognized interpreter invocation has an independent coverage entry and an
effect result: `readonly`, `finite-writes`, or `unresolved`. Issue-free
responses require ordered coverage to match every interpreter row. The v2 bridge
rejects missing knowledge, malformed results and incompatible v1 responses;
older consumers reject the v2 schema. These checks establish the trusted
backend's structural contract, not authentication of an arbitrary replacement
backend.

Every recognized `cp` or `mv` invocation also has an ordered `copyInvocations`
coverage entry and a `copyOperations` row. A row records `finite`, `readonly` or
`unresolved` knowledge, source operands, destination, directory mode, observed
cwd and source span. Both arrays are required, including when empty; missing,
malformed or unmatched rows refuse. The producer reuses the bounded evaluator
and does not execute shell expansions to obtain these roles.

The closed copy profile supports bare `cp` and `mv`, the `command` wrapper,
`--`, multiple source operands, target-directory options, and the modeled force,
interactive, no-clobber and verbose flags; `cp -p` is also modeled. Options
precede operands unless `--` explicitly ends option parsing. Unknown options,
environment wrappers, executable-path variants, known inherited loader
overrides, directory or symlink sources, recursive copies and preceding
filesystem changes, including changes inherited by nested shells, remain
unresolved. Standalone `--help` and `--version` have readonly roles. These
observations depend on the controlled host's ordinary utility selection; they do
not attest the executable selected by a native launcher.

`lib/copy-roles.sh` resolves regular-file operands against each row's proven cwd
and inspects at most 128 source/destination pairs. A missing cwd permits
absolute operands but cannot resolve relative ones. Directory destinations use
the original source operand's basename; the helper checks the resulting child.
An unknown source coordinate does not suppress the final-entry check for an
absolute destination or its named child. A copy's effective final symlink entry
is a hard refusal, including without a force flag and when approval is
available. The role projection does not retain force flags, and force-copy
fallback can unlink that entry when opening its referent fails. Known canonical
or foreign referent violations retain precedence. A destination-directory
symlink alone remains supported when the final child is regular. Missing
final-entry observations from an older helper fail closed. The helper permits
only existing destination parents and holds unmodeled entries, move-destination
symlinks and paths that cannot use the existing FILE transport. Existing
destinations and move sources must be regular files with one hard link;
unavailable link identity also holds. An external pathname cannot authorize a
copy through an inode shared with a foreign payload. Copy-source reads retain
their existing policy. These filesystem observations are a snapshot, not
protection against a later filesystem race.

`worktree-guard.sh` replaces its whole-command copy heuristic with these roles
for its selected copy calls. `bash-write-guard.sh` independently consumes the
same roles, including finite executable variables and nested literal Bash
sources. A worktree source copied to an external artifact directory does not
become a canonical destination merely because its source contains `packages/`.
An actual worktree-to-canonical destination refuses. Effective destination
writes and `mv` source deletions pass through the existing ownership oracle;
`cp` source reads retain their existing policy. Missing or incomplete roles
cannot grant admission.

A copy filesystem hold, other than the hard final-symlink refusal, uses the
existing human-decision channel only when the configured capability reports an
actual approval is required. Without it the mandatory guard exits 2. An
exit-zero response carrying `permissionDecision: ask` requests that decision; it
does not authorize execution. Known ownership violations retain precedence over
filesystem uncertainty. Guard fixtures establish the ask response envelope; they
do not establish a native approval interface or a qualified native launch.

The Bash consumer keeps removal-entry effects separate from referent writes. For
statically recognized `rm` with the modeled `f`, `r`, `R` and `--` options, a
final symlink is checked through its physical parent and literal final name.
Deleting an owned link does not write its referent; a foreign link remains a
foreign deletion entry even when its referent is owned. Unsupported removal
options retain entry observations and an unresolved hold. They cannot become
referent-only effects. Mixed operations on the same path retain their separate
roles. Missing, malformed or failed effect transport refuses.

The shared ownership oracle uses the registry's physical worktree paths,
including locations preserved by migration. Worktree roots and descendants are
ownership-checked before canonical path allowlists. The Bash and Write/Edit
consumers preserve uncertainty for unavailable, overlapping or ambiguous payload
ownership rather than treating it as an unclaimed canonical path. Known foreign
ownership and canonical claims retain their protective precedence. A
directory-removal observation includes its contained scope: known literal claims
refuse, while unproved glob or YAML populations remain held. An owned symlink
does not become a deletion of its referent's directory. These checks use
filesystem observations; they do not fence later replacement or prove the
effects of an unsupported recursive operation.

A genuinely absent registry retains the uninitialized-project policy. An
observed registry must be a readable regular file with an object or array
container. Read, parse or type failures, a directory in its place, and dangling
links retain ownership uncertainty before either consumer's path allowlists.
File ownership retains LF characters in its environment-coordinate channel; Git
metadata and mutation projection fields keep their separate transport limits. If
Node is unavailable, Write/Edit permits the ungoverned base state only after a
successful bounded directory census proves the state directory or registry
absent. Existing, inaccessible or unobserved authority remains held.

The CLI response adds `execution: {command, cwd}` and `singleLifecycle` to the
projection. The bridge requires the exact decoded source to match all supplied
native `command`/`cmd` fields and uses the returned execution directory for
downstream ownership checks. A known directory is physical; an unknown directory
stays `null`. Caught decoding or outer-command failures return `execution:null`,
empty facts and a bounded issue. Normally returned parser and projection issues
retain the decoded execution record and any observed facts. Those bounded facts
survive later projection uncertainty so an independently observed foreign write
retains precedence.

Native `exec_command`/`shell_command` spellings require explicit Bash and
`tool_input.login:false`. Their `workdir` resolves against the original native
base `cwd`, never a CLI or session-root fallback. An existing absolute `workdir`
can establish a coordinate without a base; malformed supplied context remains an
issue. Supplied source, dialect and startup conflicts cannot select a harmless
substitute. `tool_input.cwd`, `env` and `environment` are explicitly unmodeled;
their presence is unresolved rather than interpreted as the launcher's context.
Ordinary metadata such as descriptions and timeouts has no such restriction. The
literal `Bash` compatibility profile retains its Bash assumption when no shell
is supplied, except for the known incompatible Codex producer. That assumption
does not establish a host's normalization or default executor settings.

The startup flag describes the supported Bash mode. It does not attest the
child's complete environment, interpreter startup hooks or executable identity;
the source profiles below retain their separate controlled-host assumptions.

The
[Codex 0.163.0 producer](https://github.com/openai/codex/blob/83086188ae0614bd882818ff1aa23f3194962012/codex-rs/core/src/tools/handlers/unified_exec/exec_command.rs)
constructs `Bash.command` from raw `cmd`. Its executor separately selects shell,
login mode and per-call workdir; the hook's
[cwd comes from the turn environment](https://github.com/openai/codex/blob/83086188ae0614bd882818ff1aa23f3194962012/codex-rs/core/src/hook_runtime.rs).
Updating `command` preserves those hidden original arguments. This producer
projection cannot certify the execution contract above. Native adoption requires
complete producer metadata or a controlled execution boundary; an explicit-Bash
fixture alone cannot establish that contract for other calls.

The trusted launcher's `CAWS_AGENT_SURFACE=codex` makes native envelopes return
`execution-contract` unresolved in both CLI consumers, including envelopes with
caller-supplied shell fields or native aliases. CLI shell flags cannot lift this
restriction. Literal diagnostic analysis remains available and confers no native
permission. Installing this candidate would therefore block affected Codex shell
calls. The deployed runtime must be retained until a qualified producer or the
owned execution boundary is demonstrated; this refusal is not benign admission.

`singleLifecycle` is a restricted lifecycle fact, not permission. It identifies
only one foreground, literal `caws worktree merge|destroy` invocation with a
name and closed option arities. Assignments, redirections, expansions, pipelines
and compound neighbors receive no fact. A bounded constant Git query must
resolve the decoded execution cwd to the same physical canonical project
selected by the lifecycle CLI. Foreign projects, independent repositories nested
inside the project, and failed discovery receive no rewrite fact.
`quiet-merge.sh` verifies source and directory custody before prefixing a
shell-quoted canonical directory. Missing facts or backend failures leave the
command untouched. Quoted lifecycle mentions cannot reroot another command after
the write guard has checked it.

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
command substitutions keep bindings and cwd local while carrying shared
filesystem effects into later analysis, including command-local prefix
assignments. Nested shell jobs also inherit parent effects; another unmodeled
invocation or output redirection anywhere in the enclosing source conservatively
invalidates nested metadata coordinates, including concurrent pipeline siblings.
A sole inspected literal Bash invocation is exempt from its own enclosing
invocation's opacity; mixed finite callees at that source position cannot borrow
the exemption. Unproven cwd, prior filesystem effects, redirected index files
and failed or bare-repository discovery remain unresolved. Both metadata
directories receive the foreign-repository check. External metadata layouts
without an established project boundary remain unresolved. The oracle separately
matches the physical working tree, derived from reciprocal metadata pointers, to
a unique registry entry and its stamped owner. An independently overridden
`--work-tree` cannot lend its identity to another worktree's metadata. Canonical
metadata is admitted; unknown identity, missing ownership and duplicate matches
cannot grant admission for a linked working tree. A namespaced response prevents
an older file-only oracle from silently accepting a metadata operation.

Mapping uncertainty applies to recognized metadata writes in this consumer;
read-only Git invocations do not acquire an ownership requirement from the
separate worktree-pin policy. This does not prove application internals or Git
configuration safe: trusted executable/configuration assumptions and the
limited-recognizer residual remain in force.

The bounded Node source profile parses the complete submitted payload without
executing it. Supported plain data, local functions, console output and explicit
filesystem APIs produce effect knowledge. Only proven write operands enter
foreign-repository and worktree ownership checks; a path used by a read API does
not become a write target because a write occurs elsewhere in the payload.
Unrecognized calls, unsafe aliasing, dynamic targets, unsupported syntax and
exhausted budgets remain unresolved even when no write verb appears. Python
programs and file-based interpreter entry points remain unresolved. Reading a
script before execution would not bind those bytes to the eventual launch.

The profile assumes ordinary Node builtins and controlled startup; it is a
source-analysis contract, not runtime confinement. Preloads selected by the
submitted source and assignments to tracked startup bindings remain unresolved.
Ordinary application bindings, such as `NODE_ENV` or `NODE_OPTIONS_DATA`, do not
by themselves invalidate this profile. Weak path-literal co-occurrence
observations remain separate legacy diagnostics and confer no write permission
or mutation finding in the mandatory v2 consumer. Arbitrary external
applications retain the explicitly limited recognizer boundary.

`caws.node-source-effects.v1` uses Acorn 8.15.0 to parse complete script source
with ECMAScript 2022 grammar. It admits `const` bindings, plain own-data arrays
and objects, directly applied local arrows, nonempty array maps with direct
arrow callbacks, console output and one-argument JSON serialization. Filesystem
capabilities come only from literal builtin `fs` or `node:fs` imports. The
admitted APIs are `readFileSync`, `readdirSync`, `writeFileSync` and
`appendFileSync`; optional encoding must be a string. Read options objects are
unresolved because their flags can request truncation. The startup-control
policy matches exact names: `NODE_OPTIONS`, `NODE_PATH`, `NODE_V8_COVERAGE`,
`NODE_COMPILE_CACHE`, `NODE_REDIRECT_WARNINGS`, `NODE_REPL_EXTERNAL_MODULE`,
`NODE_REPL_HISTORY`, `NODE_ICU_DATA`, `OPENSSL_CONF` and `OPENSSL_ENGINES`.
Similarly named application data, such as `NODE_OPTIONS_DATA`, is not a startup
setting. Inherited `NODE_PATH` alone cannot replace these builtins. Empty
inherited `NODE_OPTIONS` and `NODE_V8_COVERAGE` are inactive; source rebinding
cannot borrow those exceptions because an inherited export attribute survives a
plain assignment. Coverage, compile-cache, warning-file and native configuration
settings therefore cannot borrow a harmless payload's effects. The
[Node coverage startup code](https://github.com/nodejs/node/blob/v22.19.0/lib/internal/process/pre_execution.js)
and
[environment contract](https://nodejs.org/download/release/v22.19.0/docs/api/cli.html#environment-variables)
define the known exceptions. This is source analysis under a controlled host;
the launcher must own the actual child's environment and qualify the runtime
version and its startup contract before using these effects to admit execution.

Node option validation continues after the selected code operand until `--`,
`-`, or the first positional argument. Trailing preloads and other unmodeled
options remain unresolved. Repeated code selectors also remain unresolved; they
cannot lend the first payload's effects to a later program. Arguments after the
option boundary remain data. Print operands with empty or leading-dash values,
escape transformations and `--print=value` are outside this profile. The
[pinned Node option parser](https://github.com/nodejs/node/blob/v22.19.0/src/node_options-inl.h)
and its
[option definitions](https://github.com/nodejs/node/blob/v22.19.0/src/node_options.cc)
define these distinctions; Python and Bash code options retain their separate
argument rules.

The language profile bounds source and cumulative abstract strings at 64 KiB,
the complete AST at 8,192 nodes and depth 64, abstract values at 4,096, and
evaluation at 32,768 steps. Exceeded limits return unresolved. It does not read
entry scripts or execute submitted functions to learn their effects.

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
accepted under the declared compatibility profile, excluding native Codex
admission. `--command` selects direct source mode; `--cwd` configures literal
requests, while native execution cwd comes from the original envelope. Supplied
shell declarations must agree. `--worktree` is the trusted pin in the installed
guard; command text cannot choose it. The JSON schema is
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

Known wrappers `command` and `env` preserve the argument-role checks. The `env`
profile models Bash-identifier assignment names; other assignment forms remain
unresolved rather than becoming fictitious executable names hiding the child.
Unknown applications, inline interpreters, functions, arithmetic, process
substitution, parameter operations, background execution and other unsupported
syntax are unresolved. A parser recovery/error, dependency failure, or exceeded
budget is also unresolved. Limits are 64 KiB source, 4,096 visits, 16 AST depth,
32 states or argument alternatives, 32 loop iterations and eight wrapper levels.
The first visit or depth exhaustion ends interpretation with one budget reason;
an earlier denial remains a denial. The source-size limit applies before
parsing, but the visit limit does not establish a bound on the parser's own
work.

## Policy and assumptions

The opt-in worktree pin guard requires an initial cwd inside its worktree,
except for individually analyzed `caws worktree merge|destroy|create|ensure`
invocations. A lifecycle command does not exempt neighboring commands. Git
targeting the canonical checkout or another worktree is denied. Git targeting
the pinned lane or scratch outside the canonical project remains admitted. Git
metadata overrides are checked separately. A missing pinned directory releases
the pin so a merged session can create its next lane.

An `allow` from this pin policy is not a read-only certificate or write
ownership. Known top-level output redirections can satisfy the pin policy; their
effects invalidate later Git observations. The mandatory write guard
independently checks their projected target operands. Output inside a read
substitution remains outside the reader profile.

This is a source-level guard, not a process sandbox. Its load-bearing host
contract is non-POSIX Bash with its keyword option disabled, default IFS,
ordinary scalar bindings without inherited integer/nameref attributes,
`lastpipe` disabled, trusted executable resolution, no unmodeled
aliases/functions/startup hooks, and stable repository mappings during check and
execution. Known source changes to these assumptions are unresolved. Executable
identity, Git configuration/hooks, application internals, concurrent filesystem
replacement, and the actual harness execution environment are not proved by an
AST. Source-selected `PAGER` values at Git invocations are unresolved unless
every known value disables the pager (`cat` or empty); Git can interpret this
value through a shell when stdout is a terminal. This check preserves the
trusted inherited-configuration assumption and does not require non-terminal
execution. Nested Bash jobs retain uncertainty at Git consumers when source
rebindings could change exported Git or pager variables; they cannot borrow the
launcher's earlier environment as proof. Known inherited pager entries are
exported; source bindings that disable those pagers are preserved in nested
analysis, including their exact expansion values. Other export transitions are
not modeled. Stronger containment requires runtime filesystem/process policy.
Native `exec_command`/`shell_command` inputs require an explicit supported
shell; native Bash also requires `login:false`. Native `workdir` is the
execution cwd, resolved against the caller's base cwd; conflicting command
fields are unresolved. The normalized name `Bash` alone does not establish a
native command's dialect. The mandatory bridge selects `${CAWS_BIN:-caws}`; its
inherited executable and `PATH` are host assumptions. A response schema does not
authenticate the analyzer. Native adoption must bind both the Node executable
and analyzer CLI bytes to the selected generation and retain that identity
through the handler, bridge and child launch. Pointing `CAWS_BIN` at a CLI
script alone leaves its interpreter selection unbound. Known inherited
POSIX/keyword settings are refused. Their assignment rules can change the
executable or Git environment selected by later source. The
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

| Dependency                                                                                      | Status and decisive check                                                                                                                                                                                                            |
| ----------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Submitted expansions remain inert during analysis.                                              | Established for the exercised corpus by compiled-consumer, installed-handler and packaged sentinel checks; unsupported syntax stays unresolved.                                                                                      |
| Git discovery matches the pin's reciprocal metadata.                                            | Established for real linked-worktree, unmapped, forged, nested-foreign and source-visible mapping-change fixtures; concurrent replacement remains outside the host contract.                                                         |
| Argument roles distinguish options from data.                                                   | Established only for the declared closed profiles and paired fixtures. Unknown options are unresolved; `uniq`'s second operand is an output, and ripgrep decompression is outside the reader profile.                                |
| Bash startup state, executable identity and repository configuration satisfy the host contract. | Assumed, not established by source analysis. Native adoption must verify or enforce these properties.                                                                                                                                |
| The selected generation supplies the analyzer's Node executable and CLI bytes through launch.   | Unqualified: the handler environment and mandatory bridge retain inherited `CAWS_BIN` or `PATH` selection. Native generation identity must reach this consumer; schema validation does not establish it.                             |
| The actual executor receives the checked command and cwd.                                       | Validated host `execution_workdir` establishes a directory coordinate. The known reduced Codex command projection does not bind complete shell, startup or final launch context. Later transformations also require reauthorization. |

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

The strongest objection to native activation is the missing final execution
binding: the producer can omit launch parameters and a later interceptor can
change the checked invocation. Within the declared payload boundary, agreement
between the model and the shell remains a host assumption. Widening the subset
requires independent examples that distinguish a correct interpretation from a
plausible incorrect one.

## Execution boundary proposal

This design is proposed, not an implemented executor or an activated native
contract. It places preparation, authorization and launch under one owner. A
parser or an optional command wrapper cannot supply that ownership by itself.
The matching Codex release's reduced hook payload is insufficient input.

Interpreter source profiles establish bounded effect knowledge and send proven
write operands to ownership checks. Opaque interpreter programs have no such
proof. The proposed execution boundary must enforce the source profile's host
and byte-custody assumptions or establish confinement before admitting them.

The prerequisite is a trusted integration at the host's final launch point. That
integration must associate the call with its authenticated session, provide
every effective execution parameter, and require the CAWS result for every
explicitly covered execution entry point. A host integration may replace the
covered tool or veto its final spawn; either route must demonstrate that another
covered tool cannot bypass the boundary. The inspected CAWS native runtime
launches hook engines, not user commands. Its identity resolver accepts payload
and environment identifiers; those are not authenticated caller proof. No
existing inspected entry point establishes both properties. An unavailable
integration leaves native activation unavailable; a voluntarily invoked wrapper
does not establish complete mediation.

The proposed internal sequence is:

1. **Prepare.** Resolve an absolute executable and its identity, exact argv,
   physical cwd, an owned environment copy, and owned stdin bytes. Choose either
   direct argv execution or an explicitly supported Bash mode with controlled
   startup. Preserve submitted shell source exactly in argv. Apply lifecycle or
   other permitted rewrites before analysis. Derive project, session, worktree,
   spec and authority revision from the trusted integration and canonical CAWS
   state, never from caller assertions. Select a versioned effect profile and
   bounded deadline, output and cleanup limits. Unsupported or missing context
   produces unresolved without launching the user program.
2. **Authorize.** Analyze the prepared source without executing expansions. Run
   potentially uncooperative parser/dependency work in a killable analysis
   worker with a pre-spawn deadline; a same-process timer cannot interrupt a
   synchronous parser. Analysis failure or timeout leaves zero user launches.
   Evaluate pin constraints separately from binding, ownership and scope. A
   lexical `allow` is not a read-only classification or write permission. An
   opaque program with no recognized writes receives no permission merely
   because its projection is empty; it needs an established effect profile or
   separately enforced confinement. Produce deny, unresolved, or an internal
   single-use permit bound to the immutable prepared record and authority
   revision. Define a versioned, unambiguous execution digest for comparison and
   audit. A serialized digest or an agent-supplied allow response is not a
   permit.
3. **Launch.** Consume the private permit once, check expiry and cancellation,
   and spawn from that same owned record. Any change to source, executable,
   argv, cwd, environment, stdin, startup or profile invalidates admission and
   requires preparation and authorization again. Copy mutable buffers and maps;
   a shallowly frozen object is insufficient. Refusal, malformed response,
   timeout, missing context and an already consumed permit produce zero user
   process launches.
4. **Finish.** Bound output, terminate and reap according to the declared
   process-control capability, and retain partial output and a truthful outcome:
   completed, failed, cancelled or indeterminate. Do not retry an indeterminate
   execution automatically. A receipt records observations and custody, not
   governance authority or acceptance. Environment values, stdin and command
   source are private data, not default diagnostic output.

A claim that committed revocation prevents a later launch needs a shared
authority fence around final validation and spawn, observed by every relevant
authority writer. A last-minute reread alone leaves a race. The inspected store
does not provide this join. Hold such a fence only through spawn, not the entire
child lifetime: a child lifecycle command may itself need the authority writer.
Revocation after spawn can request cancellation but cannot undo effects already
performed. These are separate promises and must have separate tests.

The design also retains executable/path replacement and descendant-escape
limits. Hashing a binary and then spawning its pathname is not atomic execution
of those bytes. Physical cwd resolution does not freeze the filesystem. Process
group termination does not prove containment of escaped descendants. Stronger
claims require demonstrated OS capabilities; typed admission alone supplies
none.

The expensive decisions to settle before implementing an executor are:

| Priority | Trigger and cost                                                                                                                                                                    | Required disposition                                                                                                       |
| -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| Critical | A host supplies reduced context or retains a covered bypass. A correct CAWS decision then governs a different invocation or none of its launches.                                   | Prove trusted final-launch integration first. Do not build authority on the existing reduced hook projection.              |
| Critical | A public permit, caller-supplied identity, late rewrite or mutable prepared record transfers admission to another call. Foreign writes or lifecycle operations may be irreversible. | Keep permits private and single-use; establish caller provenance and custody before the first executable slice.            |
| High     | Revocation races final spawn, or a fence is held while a lifecycle child needs the writer. The result is stale authority or a deadlock.                                             | Define the authority serialization contract before promising revocation semantics; test both orderings and child progress. |
| High     | Empty mutation facts authorize an opaque program. Its unobserved writes evade scope checks.                                                                                         | Define admitted effect profiles or enforced confinement before admitting that program class.                               |
| High     | Cancellation or output failure leaves an ambiguous execution and an automatic retry duplicates effects.                                                                             | Implement bounded cleanup and indeterminate outcomes with the first launch slice.                                          |
| Medium   | A persisted permit schema or broad utility compatibility surface spreads before the owner/host contract is proven.                                                                  | Keep the first permit internal and profiles narrow. Broader protocols and utilities can be deferred.                       |

Functional completion of this boundary requires the following evidence; source
analysis fixtures cannot substitute for the host integration rows:

| Criterion                             | Decisive proof                                                                                                                                                                                                      |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Exact execution custody               | An instrumented child observes executable, argv, cwd, environment, stdin and startup matching the admitted record. Mutating each field after admission yields zero launches.                                        |
| Trusted identity and complete routing | A pinned host routes every declared covered entry point through the boundary. Forged session fields and an alternate tool cannot bypass refusal. Repeat after restart.                                              |
| Useful benign behavior                | The fixed-range `sed`/validated-reader case with a computed data operand launches once; quoted JavaScript braces remain data. Its execution trace matches the prepared record. Analysis itself creates no sentinel. |
| Dangerous variants remain blocked     | Paired cases for executable sed, nested producers, foreign Git, foreign writes, conflicting context, unsupported startup and exhausted analysis produce zero user launches.                                         |
| Authority and rewrite custody         | Foreign, missing, ambiguous, inactive and one-sided bindings refuse. A lifecycle rewrite is authorized only after project-preserving preparation; an old permit cannot launch rewritten source.                     |
| Revocation ordering                   | Pause just before launch, commit revocation through the real writer, then resume: zero launches under the shared fence. Reverse ordering demonstrates only the explicitly bounded post-spawn cancellation promise.  |
| Permit lifecycle                      | Replay, expiry, cancellation and cross-invocation reuse each produce zero launches. No caller can manufacture a permit from a serialized decision.                                                                  |
| Failure and cleanup                   | Deadline, output cap, broken stdin, spawn failure and cancellation preserve bounded partial output, reaping and honest outcomes; ambiguous completion never retries itself.                                         |

Investigate the pinned host's final resolved launch integration and bypass
inventory first. Implement the smallest proven integration plus an owned
prepared record and hostile custody tests before widening tool support. Change
native adoption from a parser-only rollout to an execution-contract rollout;
keep the pure analyzer useful independently. Jev may classify retained examples
offline during design, but is not a runtime authorization dependency.

## Verification and adoption

Native adoption must bind the decision to the final effective command and cwd.
The shared `quiet-merge.sh` interceptor follows blocking guards and can prepend
a canonical-root `cd`. A decision about its input cannot authorize that changed
invocation. Full-chain validation or rechecking after transformations is an
adoption prerequisite; direct installed-handler tests establish only the payload
boundary they exercise. The worktree pin guard is opt-in. The shared bash-write
guard is mandatory; ordinary runtime installation changes the default handlers
consumed by existing enabled registrations. Documentation is not an activation
gate. The candidate's native Codex refusal prevents reduced metadata from
producing admission, but does not qualify a rollout that blocks benign commands.
Native adoption requires demonstrated execution-contract support and an isolated
canary before replacing the deployed runtime.

The declared analysis topology contains three suites:
`tests/shell/command-analysis.test.js`,
`tests/shell/interpreter-effects.test.js` and
`tests/shell/mutation-view.test.js`. Together they check bounded decisions,
effect profiles, deterministic traces, source spans, projection semantics and
absent submitted side effects. The public CLI transport and mandatory guard
consumer have separate checks. From the repository root, run the candidate's
normal emission and these focused consumers:

```bash
cd packages/caws-cli
npm run build
node ../../node_modules/jest/bin/jest.js --config jest.config.js \
  --selectProjects caws-cli --runInBand --runTestsByPath \
  tests/shell/command-analysis.test.js \
  tests/shell/interpreter-effects.test.js \
  tests/shell/mutation-view.test.js \
  tests/shell/hooks-analysis.test.js \
  tests/hooks/bash-write-guard-analysis.test.js \
  tests/hooks/bash-write-guard-interpreter-cross-repo.test.js \
  tests/hooks/worktree-claim-oracle.test.js \
  tests/hooks/guard-path-identity.test.js \
  tests/init/pack-fingerprint.test.js \
  tests/ci/mutation-contract.test.js
npm run mutation:run:analysis
```

The mutation command uses `mutation-policy.json` and the declared three-suite
topology through `stryker.analysis.conf.js`. It must cover all six registered
sources: `analyze.ts`, `git-context.ts`, `interpreter-effects.ts`,
`mutation-view.ts`, `policies.ts` and `words.ts`. The runner applies the
unchanged 80% floor separately to every file through
`scripts/assert-mutation-report.mjs`; zero valid mutants, invalid/pending
verdicts and unallowed exclusions do not pass. A single-file diagnostic,
aggregate score, narrowed test configuration or Stryker process exit zero does
not establish this full contract. Retain raw commands, actual statuses, source
and test identities, failed attempts and meaningful survivor analysis.

Use repository-installed Bats for `tests/hooks/bats/worktree-pin-guard.bats` and
the mandatory guard fixtures in isolated HOME/CAWS_HOME. Check benign admission,
quoted/variable foreign Git refusal, mixed lifecycle commands, missing
infrastructure and release/repoint behavior. A private packed installation must
also carry and load the actual parser dependency and native ESM loader, and
exercise its shipped guard consumer with preserved refusal and output semantics.
Package tests with synthetic execution metadata remain separate from a real
host's final-launch contract.

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
never executes retained commands. Independent source labels cover the complete
209-record union; source review resolves differences between those labels and
the declared policy before a fresh replay. The frozen adjudication retains the
original expectations and each changed expectation's rationale. Its prior
observations never supply the replay oracle. Full mode verifies corpus and label
hashes, matches each source hash and compares every adjudicated expectation;
representative mode remains available without implying full coverage. Replay
admission counts are not historical false-positive rates or native execution
proof. Retained private labels and reports remain outside the source ledger.

Investigate the smallest unsupported pattern with a live decision behind it;
implement its role/value refinement with independent controls; change runtime
policy only after installed-consumer and rollback evidence. A probabilistic
classifier can label sanitized historical patterns or propose profiles, while
the deterministic analyzer remains the admission authority.

The pin guard remains opt-in in the shared dispatcher. Installing the package or
passing isolated tests does not establish global runtime adoption, native
execution in each harness, or changes to Claude Code's internal classifier.
