# Slice 2 adjudication — 80-FN corpus vs. the capability lattice

**Spec:** `HOOK-CAPABILITY-ENGINE-002` (family-detector classifier closure for
the admitted 80-FN corpus).
**Authority:** the capability **lattice** (`lattice_decision` over abstract
facets) is the governed policy surface. The 80-FN corpus's
`expected_final_decision` is surgery-ward's *proposed* decision — a drift
signal, **non-binding** when the doc-calibrated lattice disagrees. The
architecture doc (`surgery-ward/.../terminal-use.commandfact-architecture.md`,
mirrored at `docs/architecture/command-capability-taxonomy.md`) is the source
of truth for facet calibration.

This table records every row whose decision **changed** between the
pre-calibration capability core (`228c980`, "activate the facet lattice") and
the doc-calibrated core (`522df5a`, "calibrate capability facets to the
architecture-doc lattice"), plus the single residual corpus-vs-lattice
disagreement. It separates two fundamentally different row types the maintainer
required be kept distinct:

- **`facet_miscalibration_corrected`** — a fixture/facet **repair against the
  architecture doc**. The *corpus was right*; my Slice-1 base facets were
  miscalibrated, so the pre-calibration lattice produced the wrong decision.
  These are **not** lattice adjudications — the lattice never "won" over the
  corpus here; the facets were simply wrong and were fixed to the doc.
- **`lattice_wins`** — a genuine corpus-vs-lattice disagreement that **survives
  doc-calibrated facets**. The corpus proposed one decision; the lattice,
  reading correctly-calibrated facets, deliberately produces another, and the
  doc backs the lattice. Only here is `resolution = lattice_wins` honest.

## Partition (all 80 rows)

| category | count | meaning |
|---|---:|---|
| `agree_unchanged` | 60 | lattice matched corpus both before and after calibration; no adjudication |
| `facet_miscalibration_corrected` | 19 | calibration fixed the lattice to match the corpus (doc-grounded facet repair) |
| `lattice_wins` | 1 | doc-calibrated lattice deliberately diverges from the corpus; doc backs the lattice |

**Closure invariant (all three categories):** every one of the 80 rows is
**non-allow** (16 deny, 64 ask). Zero silent allows. "No silent allow" is the
Slice-2 closure bar; matching the corpus's exact ask-vs-deny split is *not* —
the lattice owns that split.

---

## `lattice_wins` (1 row) — the only true adjudication

| row | command | corpus | lattice | facets (doc-calibrated) | resolution | rationale |
|---:|---|:--:|:--:|---|---|---|
| 7 | `kubectl delete pod pod-production-example-1` | deny | **ask** | kind=DESTROY, domain=remote_orchestrator, scope=**narrow**, reversibility=partial, blast=single | **lattice_wins** | Prod scope must come from the **namespace/context** (`-n production`), **not** a substring inside a resource **name**. A pod literally *named* `pod-production-example-1` in the default namespace is an ordinary single-pod delete (ask), not a prod-scoped cluster operation. The architecture doc explicitly flags the corpus's deny here as **"accidental correctness"** — the prototype denied it only because a `prod\|production` *regex* matched the name string. The facet model matches `PROD_SCOPE_INDICATORS` against tokens by **exact equality**, so `"pod-production-example-1" != "production"` → scope stays narrow → ask. Reconciling the corpus *down* to the lattice removes a false-deny that would otherwise teach operators that any resource with "production" in its name is undeletable. |

Doc citation: family-detector section, kubectl — `delete <pod> → ask`; the
`prod|production → deny` rule is scoped to **namespace/context**, and the doc's
own note: *"kubectl delete ns prod denies today only because the prod regex
fired — accidental correctness, fixed in Slice 2."* Slice 2 fixes exactly that:
prod scope is namespace-derived, the name substring no longer denies.

Contrast — rows that DO deny on prod scope (correctly), because `-n production`
puts `production` as a standalone positional token:
- row 6 `kubectl delete pods --all -n production` → deny (broad scope via `--all` AND prod scope via `production` token)
- row 8 `kubectl delete pod app-service-1 -n production` → deny (prod scope via the `production` token after `-n`)

---

## `facet_miscalibration_corrected` (19 rows) — doc-grounded facet repairs, NOT adjudications

These rows are grouped by the detector family whose **base facet** I
miscalibrated in Slice 1. In each case the pre-calibration lattice disagreed
with the corpus *because the facet was wrong*; the fix recalibrates the base
facet (or a lattice rule) to the doc, after which the lattice agrees with the
corpus. The corpus label was never overridden.

### docker `system prune` (rows 3, 41) — pre `deny` → `ask`

| row | command | pre | lattice | corpus |
|---:|---|:--:|:--:|:--:|
| 3 | `docker system prune` | deny | ask | ask |
| 41 | `docker system prune -a` | deny | ask | ask |

**Cause:** the lattice's broad-destruction rule denied on a bare
`blast_radius=multi`. **Fix:** the doc's lattice is `deny = irreversible |
prod-scope | governance-bypass`; broad blast **alone** is not a deny trigger.
The rule now denies on prod/broad **scope** or **cluster** blast only. `prune`
without `--volumes` is reclaimable-rebuild work → ask. `-a` is not an
irreversibility amplifier (the doc names only `--volumes`). Doc: *"system prune
→ ask; prune --volumes → deny (the --volumes irreversibility amplifier)."*
Witness it still denies: `docker system prune --volumes` → deny (amplifier
fires), `docker system prune -a --volumes` → deny.

### process kill — pkill / killall (rows 29, 30, 39, 71, 72, 73, 74) — pre `deny` → `ask`

| rows | example | pre | lattice | corpus |
|---|---|:--:|:--:|:--:|
| 29,30,39,71,72 | `pkill -f process-name` | deny | ask | ask |
| 73,74 | `killall nginx` | deny | ask | ask |

**Cause (two compounding facet bugs):** (a) base `reversibility` was
`irreversible`; (b) bare `-f` was treated as a universal force/irreversibility
amplifier. **Fix:** kill base reversibility is `partial` (a process restarts;
doc line: *"kill -9 → PROC_FORCE_KILL"* is ask-class, and *"pkill/killall/-f →
broad"* is breadth, not irreversibility). The irreversibility amplifier is
restricted to unambiguous **long** forms; bare `-f` is excluded because it means
`--full-cmdline` for pkill / `--follow` for logs / `--file` elsewhere. The
amplifier must never manufacture a deny from an ambiguous flag. Process-domain
`--force` is also exempted from deepening irreversibility (kill reversibility is
intrinsic to the signal, not the flag).

### filesystem `truncate -s 0` (rows 65, 66, 67, 68, 69) — pre `deny` → `ask`

| rows | example | pre | lattice | corpus |
|---|---|:--:|:--:|:--:|
| 65–69 | `truncate -s 0 file` | deny | ask | ask |

**Cause:** base `reversibility=irreversible`. **Fix:** `truncate -s 0` zeroes a
file's contents but the inode/path survive and the file is rewritable — base
`reversibility=partial` (ask). The doc says *"truncate -s 0 → ask/deny outside
scratch"*; the deny-**outside-scratch** refinement needs scratch-vs-non-scratch
path detection, deferred to **Slice 3**. Until then ask-class matches both the
corpus and the conservative-but-not-catastrophic posture. (`shred -u` stays
`irreversible` → deny — a true unrecoverable wipe; rows 60–64 unchanged.)

> Note on the earlier WIP comment: a Slice-1 code comment had described
> `truncate` as a "CSV-vs-doc adjudication (doc wins → deny)." That reading was
> wrong — it conflated `truncate` (content-zero, recoverable path) with `shred`
> (unrecoverable). The doc's "ask/deny **outside scratch**" makes the base
> ask-class, with deny gated on a Slice-3 scratch check. So this is a
> `facet_miscalibration_corrected` row, **not** a lattice adjudication. The
> stale comment is removed in `522df5a`.

### helm `uninstall` (rows 79, 80, 81) — pre `deny` → `ask`

| rows | example | pre | lattice | corpus |
|---|---|:--:|:--:|:--:|
| 79,80 | `helm uninstall myapp` | deny | ask | ask |
| 81 | `helm uninstall myapp --force` | deny | ask | ask |

**Cause:** base `blast_radius=multi` denied via the bare-multi rule; `--force`
deepened reversibility. **Fix:** same broad-destruction rule fix (multi blast
alone ≠ deny). `helm uninstall` removes a single release (partial, reversible
via `helm rollback`/reinstall) → ask. `--force` on helm only ignores
hook/resource errors — it does not make the removal less recoverable, so helm
is exempted from the `--force` irreversibility amplifier.

### kubectl `delete namespace` (row 44) — pre `ask` → `deny`

| row | command | pre | lattice | corpus |
|---:|---|:--:|:--:|:--:|
| 44 | `kubectl delete namespace my-namespace` | ask | deny | deny |

**Cause:** `delete` mapped to single/partial regardless of resource kind, so a
namespace delete under-tightened to ask. **Fix:** added longest-prefix rows for
cluster-scoped resources — `delete namespace|ns|crd|pv|pvc|secret` →
`blast=cluster, reversibility=irreversible` → deny. A namespace delete cascades
to every object inside it and is not pod-recreatable. Doc: *"delete
namespace|crd|pv|secret → deny (K8S_DELETE_BROAD)."* (row 43 `delete namespace
prod` was already deny pre-calibration — via the accidental prod-regex — and is
now deny **correctly**, via the cluster-blast facet, independent of the name.)

### terraform `apply -destroy` (row 45) — pre `ask` → `deny`

| row | command | pre | lattice | corpus |
|---:|---|:--:|:--:|:--:|
| 45 | `terraform apply -destroy` | ask | deny | deny |

**Cause:** `apply` mapped to `kind=MUTATE`, and the `-destroy` flag only
tightened reversibility — it never flipped the kind, so the MUTATE→ask branch
won. **Fix:** a destroy-**intent** flag (`-destroy`/`--destroy`) promotes
`MUTATE → DESTROY` + `irreversible` before reversibility tightening. `terraform
apply -destroy` is destruction, not mutation. Doc: *"destroy / apply -destroy →
deny."*

---

## How to regenerate this table

```bash
cd packages/caws-cli
git show 228c980:packages/caws-cli/templates/hook-packs/claude-code/classify_command.py > /tmp/pre.py
# run each corpus command through both /tmp/pre.py (pre-calibration) and the
# current template; category = agree_unchanged | facet_miscalibration_corrected
# (cur==corpus, pre!=corpus) | lattice_wins (cur!=corpus). See the test
# capability_engine_closure.test.js for the asserting version.
```

The closure test (`capability_engine_closure.test.js`) asserts: every row
non-allow (0 silent allows); the `lattice_wins` set is **exactly** `{row 7}`;
and each `facet_miscalibration_corrected` row's post-calibration decision equals
its corpus label. If a future facet change moves a row into or out of
`lattice_wins`, the test fails until this table is updated — the table is a
governed artifact, not documentation that can silently drift.
