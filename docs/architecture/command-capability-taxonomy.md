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

## Two completion bars (do not conflate)

- **Classifier-complete:** the classifier emits the correct `allow|ask|deny` with no silent allows
  on the admitted corpus. The capability slices (1–3) reach this bar.
- **Command-safety-complete:** classifier-complete **and** `ask` is operationally enforced by
  `block-dangerous.sh` (first-encounter `ask` becomes a blocking human-confirmation, not an
  advisory that exits 0). This is a separate enforcement slice. A hook that recognizes danger but
  still executes it is classifier-complete, not safety-complete.

## Trace labels (non-authoritative)

For debugging, the engine may attach a concrete capability label to its trace
(`CAWS_CLASSIFY_FACTS_DUMP=1`, stderr): e.g. `K8S_DELETE_BROAD`, `IAC_DESTROY`, `CONTAINER_PRUNE`,
`CONTAINER_VOLUME_RM`, `K8S_EXEC`, `K8S_COPY`, `K8S_TUNNEL`, `HTTP_MUTATE`, `PROC_FORCE_KILL`,
`FS_SHRED`, `FS_ZERO_FILE`, `SECRETS_READ`, `OPAQUE_EXEC`. These are evidence/debug aids mapping a
concrete observation to its abstract facets — they are **not** consulted by any decision branch and
**not** part of the stdout contract.
