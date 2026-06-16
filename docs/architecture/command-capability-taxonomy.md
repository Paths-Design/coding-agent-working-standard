# Command Capability Taxonomy

Status: active (capability classifier Slice 0 — `HOOK-CAPABILITY-ENGINE-000`)
Authority: this document is the governed source of truth for the capability model that
`packages/caws-cli/templates/hook-packs/claude-code/classify_command.py` implements and that
`.caws/command-adapters.schema.json` constrains. When the schema, the Python, and this doc
disagree, **this doc plus the schema win** — and the Python is corrected, not the doc.

## Why this exists

The shipped command-safety hook classified commands by regex and tool-name structure. A
falsification + stress campaign against a 4,882-command real-agent corpus
(surgery-ward `HOOK-COMMANDFACT-ARCHITECTURE-001`) found **80 dangerous commands the hook
silently allowed** — kubectl/docker/terraform/cloud/process/filesystem destructive operations
that were entirely ungoverned. A regex-patch approach was **falsified** (5/80 closure). The
durable fix is to classify by *what a command does to the world* — its **capability** — not by
the tool name or a token match.

The trap this taxonomy exists to avoid: **over-indexing on the tools the corpus happened to
contain.** The corpus was k8s/docker-heavy. If we governed "the tools in the corpus," a tool
nobody enumerated would stay ungoverned — the exact failure we are closing. So CAWS governs the
**capability facets and the policy lattice over them** (the core); the **tool→facet adapter
table** is data, shipped with sensible defaults and extensible by users (the periphery).

## The pipeline

```
raw command
  → parse        (segment, peel wrappers, resolve basenames, extract substitutions/payloads)
  → CommandFact  (typed facts about one command segment)
  → facets       (abstract: kind, domain, scope, reversibility, opacity, blast_radius)
  → policy       (the lattice maps facets → allow | ask | deny)
  → decision     ({"decision","reason"} on stdout)
```

The decision is driven by **facets**, never by concrete tool tokens. Concrete capability labels
(`K8S_DELETE_BROAD`, `IAC_DESTROY`, `CONTAINER_PRUNE`, `HTTP_MUTATE`, `PROC_FORCE_KILL`,
`FS_SHRED`, …) are retained **only** for trace/debug output and as human-readable adapter labels.
They do not appear in any decision branch. This is the property that lets a new tool family be
added as adapter rows with **no change to the policy table**.

## Abstract facets (the governed lattice input)

A `CommandFact` carries a `facets` object. Each facet is a small closed enum.

| Facet | Values | Meaning |
|---|---|---|
| `kind` | `READ` · `MUTATE` · `DESTROY` · `EXEC` · `PRIV_ESC` · `SECRETS_READ` · `NONE` | What the command *does*. `DESTROY` = removes/overwrites state; `MUTATE` = changes state recoverably; `EXEC` = runs further code (incl. remote/opaque); `PRIV_ESC` = elevates privilege; `SECRETS_READ` = reads credential material. |
| `domain` | `local` · `remote_orchestrator` · `cloud` · `container` · `iac` · `http` · `process` · `filesystem` · `unknown` | Where the effect lands. Used for reason text and for scope inference, not for the core decision. |
| `scope` | `narrow` · `broad` · `prod` · `unknown` | Blast scope. `broad` = `--all`/all-namespaces/wildcards; `prod` = production/staging/live target. |
| `reversibility` | `reversible` · `partial` · `irreversible` · `unknown` | Can the effect be undone. |
| `opacity` | `literal` · `opaque` · `none` | For `EXEC`: is the payload an inspectable literal, or opaque (`$VAR`/`$()`/backtick)? `none` = not an exec. |
| `blast_radius` | `single` · `multi` · `host` · `cluster` · `unknown` | How many entities are affected. |

### The facet → decision lattice

Evaluated top-down; first match wins. (Slice 0 ships this table as data; the **capability pass is
a stub returning `None`**, so the table governs nothing yet — Slices 2–3 activate it.)

1. `kind=PRIV_ESC` → **deny** (privilege escalation is never auto-allowed).
2. `kind=SECRETS_READ` → **deny** (credential exfiltration risk).
3. `kind=DESTROY` and `reversibility=irreversible` → **deny**.
4. `kind=DESTROY` and (`scope=prod` or `scope=broad` or `blast_radius∈{cluster,host,multi}`) → **deny**.
5. `kind=EXEC` and `opacity=opaque` → **ask** (cannot prove what will run).
6. `kind=EXEC` and `opacity=literal` → **recurse**: classify the literal payload, inherit its
   decision (so `eval "rm -rf /"` resolves identically to `sh -c "rm -rf /"`).
7. `kind=DESTROY` (narrow, reversible-ish) → **ask**.
8. `kind=MUTATE` and (`scope=prod` or `scope=broad`) → **deny**.
9. `kind=MUTATE` → **ask**.
10. `kind∈{READ,NONE}` → **allow**.

**Scope/reversibility are modifiers, not separate verdicts:** a `MUTATE` that would be `ask`
escalates to `deny` at `prod`/`broad` scope (rule 8). **Mutation-amplifier flags**
(`--force --recursive --all --auto-approve -y/--yes --prune --delete --destroy --volumes`) raise
`scope`/`reversibility`, but **only in the presence of a mutation/destroy `kind`** — a bare
`--recursive` on a `READ` does not escalate (this avoids the routine-dev-loop overblock the v1
proposal caused).

## Engine rules (tool-agnostic; fire regardless of adapter recognition)

These live in the engine, not in any adapter, so an **unenumerated** tool is still governed:

- **Absolute-path basename resolution:** `/usr/bin/su` is classified as `su`.
- **Wrapper peel:** `env X=y CMD`, `command CMD`, `sudo CMD`, `nohup CMD`, `time CMD` →
  classify the inner `CMD` (and `sudo`/`su`/`doas` themselves carry `kind=PRIV_ESC`).
- **Opaque-exec recursion:** triggers `sh -c`/`bash -c`/`zsh -c`, `eval`, `exec`,
  `python -c`/`node -e`/`ruby -e`/`perl -e`, `xargs <shell> -c`. Literal payload recurses (rule 6);
  opaque payload → `ask` (rule 5); benign literal → `allow`.
- **Intent fallback for unknown tools:** a tool with no adapter is still scanned for a structural
  mutation/destroy signature (`delete|destroy|rm|remove|terminate|prune|apply` as a subcommand or
  verb) plus scope/amplifier/target evidence. Identity-alone never governs (keeps the old gap) and
  flags-alone never governs (avoids overblock) — it is verb **and** evidence.
- **Recursion budget:** one shared budget bounds total recursion depth across segmentation,
  wrapper unwrap, substitution, and opaque-exec recursion. Exhaustion yields `ask`, never a crash.

## The tool→facet adapter table

**Governed core (in the template, not user-editable as policy):** the facet enums above, the
lattice, and the engine rules.

**Default adapters (shipped in the template):** the corpus-surfaced tools — `kubectl` (with the
resource-alias map `ns→namespace`, `po→pod`, `svc→service`, `deploy→deployment`, …), `docker`,
`terraform`, `aws`/`az`/`gcloud`, `curl`, `kill`/`killall`, `shred`. Each adapter maps
`subcommand-path → facet assignment`. Unknown subcommand → no escalation from identity (the engine
intent-fallback + amplifier flags still apply).

**User extension (the `.caws/command-adapters.json` sidecar):** users add adapter rows for tools
the defaults don't cover. The sidecar is **JSON, not YAML** — the hook parses it with the Python
stdlib `json` module only (PyYAML is not available in the hook runtime, so a YAML sidecar would be
unparseable). It is governed by `.caws/command-adapters.schema.json` and is **strictly bounded**:

- It maps **only** `tool executable + subcommand/resource-alias → facet assignment`.
- It **cannot** define policy outcomes, override `allow`/`ask`/`deny`, or introduce new facet
  values / capability kinds. Those require a change to this doc + the schema + a CAWS spec.
- A malformed or authority-exceeding sidecar **fails closed**: the loader ignores it and the hook
  surfaces a diagnostic `ask`. A bad config never silently weakens the gate.

This is the same governance shape as `.caws/policy.yaml` + `policy.schema.json`: a governed config
surface with a schema, where the dangerous knobs are not exposed.

## ask enforcement: source + enforcement provenance (HOOK-ASK-ENFORCEMENT-001)

`ask` is not a single semantic class, so it is not uniformly enforced. The old classifier overloaded
`ask` — it included genuinely risky operations AND "unknown git/npm/gh family subcommand, cannot
prove read-only." `CAWS-DANGER-LATCH-CATASTROPHIC-ONLY-001` correctly relaxed `ask` to advisory
because blocking all of it recreated an over-governance failure (latching the session on
`git rebase`, `npm run jest`, `git commit --amend`). The capability lattice changes the situation:
some `ask`s now carry **structured semantic evidence** (`kind=DESTROY`, `domain=remote_orchestrator`,
`reversibility=partial`). Those are not the same as "unknown npm subcommand."

So the classifier emits **two additive fields** alongside `decision`/`reason`, and the enforcement
rule keys on them — it is **not** `ask -> block`:

| field | meaning |
|---|---|
| `source` | diagnostic provenance of the winning decision: `capability` \| `legacy_family` \| `regex` \| `rm_classifier` \| `find_delete` \| `classifier_error` \| `sidecar_error` \| `unknown` |
| `enforcement` | the wrapper contract `block-dangerous.sh` branches on: `pass` \| `advisory` \| `confirm` \| `block` |

```text
decision=allow                         -> enforcement=pass      (exit 0)
decision=deny                          -> enforcement=block     (hard block + latch, as before)
decision=ask, source=capability,       -> enforcement=block     (refuse THIS command with a
  reason="opaque execution …"             prescriptive remediation, but DO NOT arm the latch —
                                          CAWS-CLASSIFY-LITERAL-OPAQUE-EXEC-READONLY-001; see below)
decision=ask, source=capability        -> enforcement=confirm   (warn FIRST occurrence, then block +
  (all other reasons)                     latch the SECOND — distinct from a catastrophic deny)
decision=ask, source=classifier_error  -> enforcement=confirm   (fail-closed; cannot prove safe)
decision=ask, source=legacy_family|regex|rm_classifier|find_delete
                                       -> enforcement=advisory  (reason on stderr, exit 0, no latch —
                                                                  CATASTROPHIC-ONLY-001 preserved)
```

**Opaque-exec is refused without arming the latch (CAWS-CLASSIFY-LITERAL-OPAQUE-EXEC-READONLY-001).**
An inline interpreter payload the classifier cannot prove (`python3 -c`/`node -e` with a `$VAR`,
`$()`, or backtick — `kind=EXEC`, `opacity=opaque`, lattice rule 5) is still `decision=ask,
source=capability`, but `block-dangerous.sh` gives it a dedicated enforcement: it emits a `block`
with an actionable remediation (write the probe to a `.py`/`.js` file and run it by path, or use the
Read tool for inspection) and **does not** write the per-session danger latch. The command itself is
still refused — it never runs — so recall is unchanged; what is removed is the sticky session-wide
freeze and the human-only reset round-trip. The motivating evidence: the danger latch's benign
false-positive resets were dominated by read-only `$VAR`-in-path recon one-liners (e.g.
`python3 -c "json.load(open('$ART'))"`) that armed the latch and forced a human reset for a command
that only needed rewriting to a file. The carve-out is keyed to the exact opaque-exec reason string,
so it does not weaken catastrophic deny (`rm -rf /` still latches) or the warn-first→arm escalation
for other capability asks (`HTTP_MUTATE`, `PROC_KILL`, `DESTROY`). This is the protected-paths.sh
pattern — refuse the specific command with a self-service alternative — minus the latch.

`enforcement` is **additive**: a consumer reading only `.decision`/`.reason` is unaffected; both new
fields are always present for a stable contract. `block-dangerous.sh` is the first consumer that
branches on `enforcement`. There is **no new decision tier** — `kubectl delete pod` / `aws s3 rm key`
/ `curl POST` / `kill -9` / `docker system prune` stay semantically `ask` (risky but not categorically
catastrophic); the wrapper makes that `ask` operationally meaningful. A `capability-deny` tier is
explicitly **not** created (it would muddle the lattice).

**This is a transition architecture.** Legacy-family `ask` staying advisory is a *compatibility
class*, not a permanent two-class moral distinction. The long-term direction is to migrate meaningful
legacy families into explicit capability mappings (where they can be enforced precisely); once
migrated, the family-default `ask` path shrinks. Until then, advisory is the honest treatment of
old-classifier uncertainty.

### Substrate / ecology boundary

This split encodes the project's core extensibility principle: **CAWS does not know more than the
project developers about every command surface in their repo.**

```text
CAWS owns:                                  Projects own:
- the capability facet vocabulary           - tool/subcommand/resource adapter mappings
- the lattice semantics                        (the .caws/command-adapters.json sidecar)
- enforcement behavior for capability risk   - local command aliases
- schema constraints preventing             - repo-specific operational surfaces
  policy override                           - migration of legacy-family uncertainty
                                               into explicit capability mappings
```

Baking a fixed classification into the release would force a CAWS publish every time a repo's
operational surface matures, and would govern the substrate the project owns. The sidecar lets a
project say "in our repo, this command maps to this capability"; CAWS applies the policy lattice.

## Two completion bars (do not conflate)

- **Classifier-complete:** the classifier emits the correct `allow|ask|deny` with no silent allows
  on the admitted corpus. The capability slices (1–3) reach this bar.
- **Command-safety-complete:** classifier-complete **and** capability-derived `ask` is operationally
  enforced by `block-dangerous.sh` (`enforcement=confirm` becomes a blocking human-confirmation, not
  an advisory that exits 0). **HOOK-ASK-ENFORCEMENT-001 reaches this bar for the capability surface.**
  Legacy-family `ask` remaining advisory is acknowledged compatibility debt (tracked for migration
  into the capability substrate), not a silent gap — a hook that recognized a *capability* danger no
  longer executes it without confirmation.

## Trace labels (non-authoritative)

For debugging, the engine may attach a concrete capability label to its trace
(`CAWS_CLASSIFY_FACTS_DUMP=1`, stderr): e.g. `K8S_DELETE_BROAD`, `IAC_DESTROY`, `CONTAINER_PRUNE`,
`CONTAINER_VOLUME_RM`, `K8S_EXEC`, `K8S_COPY`, `K8S_TUNNEL`, `HTTP_MUTATE`, `PROC_FORCE_KILL`,
`FS_SHRED`, `FS_ZERO_FILE`, `SECRETS_READ`, `OPAQUE_EXEC`. These are evidence/debug aids mapping a
concrete observation to its abstract facets — they are **not** consulted by any decision branch and
**not** part of the stdout contract.
