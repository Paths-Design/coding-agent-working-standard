## `caws specs reopen <id>` — governed closed→active transition (CAWS-SPEC-REOPEN-001)

**Mode:** feature · **Risk tier:** 2 · **Workflow:** full doctrine, new worktree off `main`

### The gap
`caws worktree merge` auto-closes the bound spec. If the work turns out unsatisfactory, there is **no governed path back to `active`**: `activate` refuses closed specs, `close` is idempotent-refused on already-closed, and the only backward path (`restore`) is for `archived→{draft,active}`. An agent (or human) is stuck — hand-editing the YAML is forbidden and would fail the kernel's `validate-semantics` (resolution-set-on-active rejection) anyway.

### The fix (mirrors `closeSpec`/`restoreArchivedSpec` exactly)
A new `closed → active` writer + CLI command. Follows the 9-step chain every spec writer uses (validate id → load → state-guard → raw-byte YAML patch → re-validate → event → dirty-capture → `withLifecycleLock`+`runLifecycleTransaction` → `attachAutoCommit`).

1. **New writer `reopenSpec` in `specs-writer.ts`** (mirror `closeSpec:1099` / `restoreArchivedSpec:3221`):
   - **State guard:** only `closed` specs may reopen. Refuse `active`/`draft` (use `activate`/edit) and `archived` (use `restore`) with a `nonActive...`-style diagnostic + `next_commands`.
   - **Patch:** set `lifecycle_state: active`, bump `updated_at`. **Remove** `resolution`, `closure_notes`, `superseded_by` via `removeTopLevelScalar` (MANDATORY — `validate-semantics.ts:108` rejects an active spec carrying `resolution`; `restoreArchivedSpec` does exactly this at `3263-3272`).
   - **Leave worktree bindings alone:** `worktree:` is already absent (close cleared it; the prior name lives only in the `spec_closed` event's `prior_worktree`). The spec reopens **unbound**; operator re-binds via `caws worktree create/bind` (which already requires `active`). Do NOT touch `worktrees.json`. This mirrors `restoreArchivedSpec`.
   - **Re-validate** the patched bytes through `parseAndValidateSpec` before write (the gate that catches a naive reopen leaving `resolution`).
   - **Event:** append `spec_reopened` (new; carry `previous_lifecycle_state: 'closed'` + optional `reason`). Event validation has **no type allowlist** (confirmed: `validateEventBody` checks intrinsic shape only), so it'll be accepted; adding the schema keeps the audit trail consistent.
   - **Transaction + autocommit:** same `withLifecycleLock`→`runLifecycleTransaction`→`attachAutoCommit(..., 'reopen', ...)` as close.

2. **New event schema** `packages/caws-kernel/src/schemas/events/spec_reopened.v1.json` (mirror `spec_restored.v1.json`). Not strictly load-bearing for acceptance, but completes the audit-trail parity every other transition has.

3. **CLI command** `runSpecsReopenCommand` in `specs.ts` (mirror `runSpecsCloseCommand`): positional `<id>` + optional `--reason <text>` (recorded on the event, NOT as `closure_notes` since that field is removed). `buildActorOrError` → `reopenSpec` → `surfaceAuditCommit`.

4. **Wiring:** add `reopen` leaf to `SPECS_COMMAND_META` (command-metadata.ts, near `close` at :373); export `runSpecsReopenCommand` from `shell/index.ts`; `defineLeaf(specsCmd, leafMeta(SPECS_COMMAND_META, 'reopen')).action(...)` in `register.ts` (near the close wiring at ~:980).

5. **Help-text coherence:** update `nonActiveCloseSpecError`'s `next_commands` (specs-writer.ts:255) + the closed-already diagnostic to mention `caws specs reopen`, so the surfaced guidance stops nudging only toward `archive`.

### Tests (`tests/shell/specs-reopen.test.js`, new — mirror `specs-close-handoff.test.js`)
- **Happy path:** write a closed fixture (`lifecycle_state: closed`, `resolution: completed`, `closure_notes:`) → `runSpecsReopenCommand` → assert exit 0, YAML now `lifecycle_state: active` and **no** `resolution`/`closure_notes` lines, `events.jsonl` contains `spec_reopened`.
- **Refusals (no mutation, byte-identical snapshot):** reopen an `active` spec → exit 1, names the conflict; reopen an `archived` spec → exit 1, points to `restore`; reopen a `draft` → exit 1.
- **Semantic guard:** a closed spec with `resolution` set reopens to an active spec with `resolution` GONE (proves the remove step; without it `parseAndValidateSpec` would reject the transaction).
- **Metadata:** `findLeaf('specs','reopen')` present with the `--reason` flag.
- **Idempotency:** reopening an already-active spec (post-reopen) → exit 1, no mutation.

### Steps
1. `git switch main`; `caws specs create CAWS-SPEC-REOPEN-001 --mode feature --risk-tier 2 --contract ...`; author YAML; commit.
2. `caws worktree create wt-spec-reopen --spec ...`. (Route governed mutations via `CAWS_SESSION_ID=<durable>`; edits via Bash/python file-payload to avoid the worktree-write-guard revert — the friction from slices 2–5 persists until the installed CLI carries slice 2's fix.)
3. Add `spec_reopened.v1.json` schema.
4. Add `reopenSpec` writer in `specs-writer.ts`.
5. Add `runSpecsReopenCommand` in `specs.ts`; wire `SPECS_COMMAND_META` + `register.ts` + `shell/index.ts`.
6. Update `nonActiveCloseSpecError` next_commands to mention reopen.
7. Add `tests/shell/specs-reopen.test.js`.
8. Build kernel+cli; run jest shell suite + the new test.
9. `caws doctor` + `caws gates run`; record evidence; `caws worktree merge`.

### Out of scope
- Reopening from `archived` (use existing `restore`).
- Restoring the `worktree:` binding on reopen (close cleared it deliberately; reopen → unbound → operator re-binds).
- Bumping the hook-pack version (this is a CLI/kernel change, not a hook-pack change — no `caws init` propagation needed).

### Files
- `packages/caws-kernel/src/schemas/events/spec_reopened.v1.json` (new)
- `packages/caws-cli/src/store/specs-writer.ts` (add `reopenSpec` + update `nonActiveCloseSpecError` next_commands)
- `packages/caws-cli/src/shell/commands/specs.ts` (add `runSpecsReopenCommand`)
- `packages/caws-cli/src/shell/command-metadata.ts` (add `reopen` leaf)
- `packages/caws-cli/src/shell/register.ts` + `shell/index.ts` (wire)
- `packages/caws-cli/tests/shell/specs-reopen.test.js` (new)
- `.caws/specs/CAWS-SPEC-REOPEN-001.yaml` (new)