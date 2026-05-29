# Command-Capability Taxonomy — Integration Candidate (NOT adopted)

> **Status:** Candidate / under evaluation. This document records a possible
> future integration for `classify_command.py`. It is **not** an adopted
> decision and nothing in the shipped classifier depends on it. Do not treat
> the referenced dataset as ground truth for safety decisions until its
> classifications are validated (see Provenance).

## What

A structured command-capability dataset exists at
`surgery-ward/surgery_ward_training_bundle/terminal-use.csv` (a sibling repo,
not this one): ~750 rows covering ~601 distinct command families. Each row
carries a command family, a `VerbClass` (read/write/exec/delete/config/
observe/network_client/mutate/privilege/…), a matching regex `Pattern`, ~30
boolean capability flags (`FS_READ`, `FS_WRITE`, `FS_DELETE`,
`EXEC_ARBITRARY`, `PROC_SIGNAL`, `NET_OUTBOUND`, `PRIV_ESC`, `SECRETS_READ`,
`KERNEL_MUTATE`, `CLOUD_MUTATE`, `IAC_APPLY`, …), and `Requires_Sudo` /
`Reversible` / `Risk` (safe/moderate/dangerous/destructive) columns.

Distribution: 350 read / 159 write / 79 exec rows; 497 safe / 214 moderate /
29 dangerous / 10 destructive.

## Why it is interesting for the danger-latch classifier

`classify_command.py` currently uses a small hand-maintained read-only
allow-list (`ALLOWED_GIT_SUBCOMMANDS`, `ALLOWED_GH_ACTIONS`,
`ALLOWED_NPM_SUBCOMMANDS`, `MEANINGFUL_COMMAND_KW`) plus per-command
special-cases. We have calibrated it reactively three times
(`DANGER-LATCH-CALIBRATION-001` read-only set, `DANGER-LATCH-WORKFLOW-
CALIBRATION-001` add/commit/checkout, `WORKTREE-LIST-CALIBRATION-001`
worktree list, `DANGER-LATCH-UX-001` rm scratch paths). Each was a real
first-contact over-trigger found in the field. This dataset is a candidate
*systematic* enumeration of the read-only/safe surface — a way to replace
whack-a-mole with a gap report.

## Three possible uses, in order of value / safety

1. **Gap audit (safe, no guard change).** Run the dataset's
   `read` + `safe` + `Requires_Sudo=no` + `Reversible=yes` rows through the
   *current* classifier and report every command it sends to "ask". Those are
   over-trigger candidates. Pure analysis; the output is the input to a future
   allow-list-widening slice. **This is the recommended first step.**
2. **Allow-list widening (medium, reviewed not bulk).** Use the read/safe set
   to *propose* additions to the read-only allow surface — each reviewed, not
   mechanically imported. The classifier's value is its conservatism
   (hybrid fail-closed: unknown → ask); bulk import would trade that away.
3. **Capability-flag classification model (high value, large scope).** The 30
   capability columns are a richer model than flat allow/ask/deny. A future
   classifier could decide on flags (admit iff `FS_WRITE=0 ∧ EXEC_ARBITRARY=0
   ∧ PRIV_ESC=0 ∧ NET_OUTBOUND=0`, etc.). This is an architecture change, not
   a calibration.

## Provenance and trust caveats (read before using)

- **The dataset appears model-generated** (601 commands with uniform
  capability vectors is not hand-authored). Treat every classification as a
  *hypothesis*, not ground truth. A row that mis-labels a destructive command
  `Risk=safe` would punch a hole in the guard if imported blindly.
- **The classifier is a safety boundary; this CSV is training data.** They
  have different trust requirements — the classifier must be conservative and
  auditable; the dataset is broad and probabilistic. The second must not
  silently relax the first.
- **Pattern granularity differs.** The dataset uses family-level regexes
  (`^(status|log|…)\b`); the classifier uses flag-aware per-subcommand
  special-cases (`git checkout -b` allow vs bare `git checkout` ask). A
  mechanical import would lose the flag-level distinctions the calibrations
  added deliberately.

## Owner / next step

Dataset validation and any adoption decision are owned outside this hook-pack
work (the user is evaluating the CSV separately). If pursued, the entry point
is the gap audit (use 1) under a new spec
(e.g. `CLASSIFIER-CAPABILITY-AUDIT-001`). Until then this is a pointer, not a
work program.
