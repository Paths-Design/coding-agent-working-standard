---
doc_id: command-analysis
authority: reference
status: active
title: Bounded command analysis
owner: CAWS maintainers
updated: 2026-10-18
audience: consumer
---

# Bounded command analysis

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

Known wrappers `command` and `env` preserve the argument-role checks. Unknown
applications, inline interpreters, functions, arithmetic, process substitution,
parameter operations, background execution and other unsupported syntax are
unresolved. A parser recovery/error, dependency failure, or exceeded budget is
also unresolved. Limits are 64 KiB source, 4,096 visits, 16 AST depth, 32 states
or argument alternatives, 32 loop iterations and eight wrapper levels.

## Policy and assumptions

The opt-in worktree pin guard requires an initial cwd inside its worktree,
except for individually analyzed `caws worktree merge|destroy|create|ensure`
invocations. A lifecycle command does not exempt neighboring commands. Git
targeting the canonical checkout or another worktree is denied. Git targeting
the pinned lane or scratch outside the canonical project remains admitted. Git
metadata overrides are checked separately. A missing pinned directory releases
the pin so a merged session can create its next lane.

This is a source-level guard, not a process sandbox. Its load-bearing host
contract is Bash with default IFS, `lastpipe` disabled, trusted executable
resolution, no unmodeled aliases/functions/startup hooks, and stable repository
mappings during check and execution. Known source changes to these assumptions
are unresolved. Executable identity, Git configuration/hooks, application
internals, concurrent filesystem replacement, and the actual harness execution
environment are not proved by an AST. Stronger containment requires runtime
filesystem/process policy. Native `exec_command`/`shell_command` inputs require
an explicit supported shell; native Bash also requires `login:false`. Native
`workdir` is the execution cwd, resolved against the caller's base cwd;
conflicting command fields are unresolved. The normalized name `Bash` alone does
not establish a native command's dialect. `CAWS_BIN` and the pin environment are
trusted launcher configuration; validating a response schema does not
authenticate a malicious replacement CLI.

These boundaries determine the main failure modes:

| Severity | Trigger and cost                                                                                                         | Disposition                                                                                                                    |
| -------- | ------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------ |
| Critical | Executing expansion to learn argv performs the prohibited effect before authorization.                                   | Excluded: source parsing only; sentinel tests must remain inert.                                                               |
| High     | Losing prefix-assignment order, branch alternatives, quotes or nested producers can admit foreign Git or executable sed. | Resolve before adoption: hostile corpus and mutation controls.                                                                 |
| High     | Host functions, configuration, symlink changes or another shell disagree with the model.                                 | Retained boundary: declare dialect and host assumptions; use runtime isolation for adversarial enforcement.                    |
| High     | Malformed input, parser recovery, resource exhaustion or invalid CLI response becomes allow.                             | Resolve before adoption: explicit unresolved results and fail-closed installed-consumer tests.                                 |
| Medium   | Expanding utility support with string heuristics accumulates exceptions that become hard to replace.                     | Add typed role profiles with paired benign/hostile fixtures; classification may prioritize work but cannot authorize commands. |
| Medium   | A runtime upgrade reaches concurrent projects with a stale CLI.                                                          | Isolated package/runtime validation and rollback first; preserve ordered CLI, runtime, native setup.                           |

The strongest objection is semantic disagreement with the real shell. A bounded
subset plus explicit uncertainty is preferable to an expansion runner, but it
does not remove that objection. Widening the subset requires independent
examples that distinguish a correct interpretation from a plausible incorrect
one.

## Verification and adoption

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
