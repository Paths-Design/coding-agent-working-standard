// `caws waiver` — vNext singular command surface.
//
// Four subcommands, each a thin shell over the kernel + waivers-store:
//
//   create  — validateWaiver → writeWaiver (refuses duplicates).
//   list    — loadWaivers → render summaries; filters by effectiveness.
//   show    — loadWaivers → render detail; missing id is a domain error.
//   revoke  — markRevoked (refuses double-revoke and missing files).
//
// Discipline:
//   - Explicit waiver id on `create` (no auto-generation in 7a). Auto-id
//     would force naming and collision policy decisions that don't
//     belong on the authority surface.
//   - `status: active` is the only status `create` writes. Callers
//     cannot manufacture `expired` (expiry is derived) or `revoked`
//     (use `revoke` for that, which carries an audit record).
//   - Effectiveness is computed by the kernel (`waiverEffectiveness`).
//     The shell never re-derives it — that would risk diverging from
//     gates filtering. `list` defaults to "effective only" so an
//     operator surveying the waiver surface sees what actually applies
//     to gates right now.
//   - All writes go through `writeWaiver` / `markRevoked`. Those are
//     atomic and refuse silent overwrite, so even concurrent invocations
//     can't corrupt a waiver.
//
// Exit codes:
//   0 = command succeeds (including: list with zero results, show with
//       a valid id, revoke that succeeds).
//   1 = validation/domain failure: duplicate id, missing waiver,
//       invalid id/gate/expiry, already-revoked.
//   2 = repo-root or store composition failure.
//
// Event emission for waiver lifecycle is OUT OF SCOPE for 7a.4 — the
// existing `waiver_applied` event records *use*, not *creation*. A
// `waiver_created` / `waiver_revoked` event family belongs with 7b
// or later and is not gated by this slice.

import {
  isOk,
  validateWaiver,
  waiverEffectiveness,
  type Diagnostic,
  type Waiver,
  type WaiverEffectiveness,
} from '@paths.design/caws-kernel';

import {
  loadWaivers,
  markRevoked,
  resolveRepoRoot,
  STORE_RULES,
  writeWaiver,
} from '../../store';
import { renderDiagnostics } from '../render/diagnostic';
import { renderWaiverDetail, renderWaiverSummary } from '../render/waiver';
import { SHELL_RULES } from '../rules';

// ---------------------------------------------------------------------------
// Common option/result shapes.
// ---------------------------------------------------------------------------

export interface WaiverCommandBase {
  readonly cwd?: string;
  readonly now?: () => Date;
  readonly out?: (line: string) => void;
  readonly err?: (line: string) => void;
  readonly showData?: boolean;
}

function shellDiag(
  rule: string,
  message: string,
  subject?: string
): Diagnostic {
  // Shell-side ad-hoc diagnostics borrow the kernel/diagnostics authority
  // — the kernel's Authority enum is closed, and the rule prefix
  // `shell.*` is what distinguishes shell-owned diagnostics from kernel-
  // owned ones. Existing shell modules (resolve-session, gates contract)
  // follow the same convention.
  return {
    rule,
    authority: 'kernel/diagnostics',
    severity: 'error',
    message,
    ...(subject !== undefined ? { subject } : {}),
  };
}

function setupIO(opts: WaiverCommandBase) {
  const cwd = opts.cwd ?? process.cwd();
  const nowFn = opts.now ?? (() => new Date());
  const out = opts.out ?? ((s: string) => process.stdout.write(s + '\n'));
  const err = opts.err ?? ((s: string) => process.stderr.write(s + '\n'));
  const showData = opts.showData === true;
  return { cwd, nowFn, out, err, showData };
}

function resolveCaws(
  cwd: string,
  err: (line: string) => void,
  showData: boolean,
  cmd: string
): { cawsDir: string } | null {
  const r = resolveRepoRoot(cwd);
  if (!r.ok) {
    err(`caws ${cmd}: failed to resolve repo root.`);
    err(renderDiagnostics(r.errors, { showData }));
    return null;
  }
  return { cawsDir: r.value.cawsDir };
}

// ---------------------------------------------------------------------------
// caws waiver create
// ---------------------------------------------------------------------------

export interface WaiverCreateOptions extends WaiverCommandBase {
  readonly id: string;
  readonly title: string;
  readonly gates: readonly string[];
  readonly reason: string;
  readonly approvedBy: string;
  readonly expiresAt: string;
  /** Optional. When supplied, scopes the waiver to a single spec id. */
  readonly specId?: string;
  /** Validate and report only; do not write .caws/waivers/<id>.yaml. */
  readonly dryRun?: boolean;
  /** Emit machine-readable JSON for dry-run/create results. */
  readonly json?: boolean;
}

function waiverJson(args: {
  readonly waiver: Waiver;
  readonly effectiveness: WaiverEffectiveness;
}): Record<string, unknown> {
  return {
    id: args.waiver.id,
    title: args.waiver.title,
    status: args.waiver.status,
    effectiveness: args.effectiveness,
    gates: args.waiver.gates,
    reason: args.waiver.reason,
    approved_by: args.waiver.approved_by,
    created_at: args.waiver.created_at,
    expires_at: args.waiver.expires_at,
    scope: args.waiver.scope ?? {},
    ...(args.waiver.revocation !== undefined
      ? { revocation: args.waiver.revocation }
      : {}),
  };
}

function buildCreateCandidate(opts: WaiverCreateOptions, now: Date): Record<string, unknown> {
  const candidate: Record<string, unknown> = {
    id: opts.id,
    title: opts.title,
    status: 'active',
    gates: opts.gates,
    reason: opts.reason,
    approved_by: opts.approvedBy,
    created_at: now.toISOString(),
    expires_at: opts.expiresAt,
  };
  if (opts.specId !== undefined) {
    candidate['scope'] = { spec_id: opts.specId };
  }
  return candidate;
}

export function runWaiverCreateCommand(opts: WaiverCreateOptions): number {
  const { cwd, nowFn, out, err, showData } = setupIO(opts);
  const now = nowFn();
  const ctx = resolveCaws(cwd, err, showData, 'waiver create');
  if (ctx === null) return 2;

  // Build the candidate waiver document. Validation is delegated to the
  // kernel — no parallel field-shape checks here.
  const candidate = buildCreateCandidate(opts, now);

  const validated = validateWaiver(candidate);
  if (!isOk(validated)) {
    err('caws waiver create: invalid waiver shape.');
    err(renderDiagnostics(validated.errors, { showData }));
    return 1;
  }

  if (opts.dryRun === true) {
    const load = loadWaivers(ctx.cawsDir);
    if (load.diagnostics.length > 0) {
      err(renderDiagnostics(load.diagnostics, { showData }));
    }
    const duplicate = load.waivers.find((w) => w.id === validated.value.id);
    if (duplicate !== undefined) {
      err(`caws waiver create --dry-run: waiver ${validated.value.id} already exists.`);
      err(
        renderDiagnostics(
          [
            shellDiag(
              STORE_RULES.WAIVERS_ALREADY_EXISTS,
              `Waiver ${validated.value.id} already exists.`,
              validated.value.id
            ),
          ],
          { showData }
        )
      );
      return 1;
    }
    const effectiveness = waiverEffectiveness(validated.value, now);
    if (opts.json === true) {
      out(JSON.stringify({
        ok: true,
        dry_run: true,
        read_only: true,
        would_write: true,
        waiver: waiverJson({ waiver: validated.value, effectiveness }),
      }, null, 2));
    } else {
      out(`caws waiver create --dry-run: valid waiver; would write .caws/waivers/${validated.value.id}.yaml`);
      out(
        renderWaiverDetail({
          waiver: validated.value,
          effectiveness,
          now,
        })
      );
    }
    return 0;
  }

  const write = writeWaiver(ctx.cawsDir, validated.value);
  if (!isOk(write)) {
    // The store distinguishes duplicate id (already_exists) from generic
    // I/O failure (write_io_failed). Exit code reflects the difference:
    // duplicate is a user-correctable domain error (1), I/O is a hard
    // store failure (2).
    const isDuplicate = write.errors.some(
      (d) => d.rule === STORE_RULES.WAIVERS_ALREADY_EXISTS
    );
    err(
      isDuplicate
        ? `caws waiver create: waiver ${validated.value.id} already exists.`
        : 'caws waiver create: failed to write waiver.'
    );
    err(renderDiagnostics(write.errors, { showData }));
    return isDuplicate ? 1 : 2;
  }

  out(
    renderWaiverDetail({
      waiver: validated.value,
      effectiveness: waiverEffectiveness(validated.value, now),
      now,
    })
  );
  return 0;
}

// ---------------------------------------------------------------------------
// caws waiver prune
// ---------------------------------------------------------------------------

export type WaiverPruneStatus = 'expired';

export interface WaiverPruneOptions extends WaiverCommandBase {
  readonly status: WaiverPruneStatus;
  /** Execute the plan. Defaults to dry-run. */
  readonly apply?: boolean;
  /** Emit machine-readable JSON. */
  readonly json?: boolean;
  /** Required with --apply. Recorded in each revocation.reason. */
  readonly reason?: string;
  /** Required with --apply. Recorded in each revocation.revoked_by. */
  readonly revokedBy?: string;
}

interface WaiverPruneTarget {
  readonly id: string;
  readonly gates: readonly string[];
  readonly scope: Record<string, unknown>;
  readonly expires_at: string;
  readonly effectiveness: WaiverEffectiveness;
  readonly action: 'revoke';
}

function isWaiverPruneStatus(value: unknown): value is WaiverPruneStatus {
  return value === 'expired';
}

function pruneTarget(w: Waiver, now: Date): WaiverPruneTarget {
  return {
    id: w.id,
    gates: w.gates,
    scope: w.scope === undefined ? {} : { ...w.scope },
    expires_at: w.expires_at,
    effectiveness: waiverEffectiveness(w, now),
    action: 'revoke',
  };
}

export function runWaiverPruneCommand(opts: WaiverPruneOptions): number {
  const { cwd, nowFn, out, err, showData } = setupIO(opts);
  const now = nowFn();
  const isApply = opts.apply === true;

  if (!isWaiverPruneStatus(opts.status)) {
    err(
      `caws waiver prune: invalid --status. Got ${JSON.stringify(opts.status)}; expected expired.`
    );
    return 1;
  }
  if (isApply && (typeof opts.reason !== 'string' || opts.reason.length === 0)) {
    err('caws waiver prune --apply: --reason "<text>" is required.');
    return 1;
  }
  if (isApply && (typeof opts.revokedBy !== 'string' || opts.revokedBy.length === 0)) {
    err('caws waiver prune --apply: --revoked-by <id> is required.');
    return 1;
  }

  const ctx = resolveCaws(cwd, err, showData, 'waiver prune');
  if (ctx === null) return 2;
  const load = loadWaivers(ctx.cawsDir);
  if (load.diagnostics.length > 0) {
    err(renderDiagnostics(load.diagnostics, { showData }));
  }

  const targets = load.waivers
    .filter((w) => waiverEffectiveness(w, now) === 'expired')
    .map((w) => pruneTarget(w, now));

  if (!isApply) {
    if (opts.json === true) {
      out(JSON.stringify({
        ok: true,
        dry_run: true,
        read_only: true,
        status: opts.status,
        count: targets.length,
        targets,
      }, null, 2));
    } else {
      out(`caws waiver prune: ${targets.length} expired waiver(s) would be revoked.`);
      if (targets.length === 0) out('  (none)');
      for (const target of targets) {
        out(`  - ${target.id} gates=${target.gates.join(',')} expires_at=${target.expires_at}`);
      }
      out('  Re-run with --apply --reason "<text>" --revoked-by <id> to revoke these waivers.');
    }
    return 0;
  }

  const revoked: Record<string, unknown>[] = [];
  for (const target of targets) {
    const result = markRevoked(ctx.cawsDir, target.id, {
      now,
      revoked_by: opts.revokedBy!,
      reason: opts.reason!,
    });
    if (!isOk(result)) {
      err(`caws waiver prune --apply: failed to revoke ${target.id}.`);
      err(renderDiagnostics(result.errors, { showData }));
      return 2;
    }
    revoked.push(
      waiverJson({
        waiver: result.value,
        effectiveness: waiverEffectiveness(result.value, now),
      })
    );
  }

  if (opts.json === true) {
    out(JSON.stringify({
      ok: true,
      dry_run: false,
      read_only: false,
      status: opts.status,
      count: revoked.length,
      revoked,
    }, null, 2));
  } else {
    out(`caws waiver prune --apply: revoked ${revoked.length} expired waiver(s).`);
    if (revoked.length === 0) out('  (none)');
    for (const item of revoked) out(`  - ${item.id}`);
  }
  return 0;
}

// ---------------------------------------------------------------------------
// caws waiver list
// ---------------------------------------------------------------------------

export interface WaiverListOptions extends WaiverCommandBase {
  /** Include waivers whose stored status is 'revoked'. Default false. */
  readonly includeRevoked?: boolean;
  /** Include waivers whose expires_at is in the past. Default false. */
  readonly includeExpired?: boolean;
}

export function runWaiverListCommand(opts: WaiverListOptions = {}): number {
  const { cwd, nowFn, out, err, showData } = setupIO(opts);
  const ctx = resolveCaws(cwd, err, showData, 'waiver list');
  if (ctx === null) return 2;

  const load = loadWaivers(ctx.cawsDir);
  // Surface load diagnostics on stderr but do NOT discard valid waivers.
  if (load.diagnostics.length > 0) {
    err(renderDiagnostics(load.diagnostics, { showData }));
  }

  const now = nowFn();
  const includeRevoked = opts.includeRevoked === true;
  const includeExpired = opts.includeExpired === true;

  type Row = { waiver: Waiver; effectiveness: WaiverEffectiveness };
  const rows: Row[] = [];
  for (const w of load.waivers) {
    const eff = waiverEffectiveness(w, now);
    if (eff === 'revoked' && !includeRevoked) continue;
    if (eff === 'expired' && !includeExpired) continue;
    rows.push({ waiver: w, effectiveness: eff });
  }

  if (rows.length === 0) {
    // Distinguish "no waivers at all" from "no waivers match the filter".
    const msg =
      load.waivers.length === 0
        ? 'No waivers in .caws/waivers/.'
        : 'No waivers match the current filter (use --include-revoked / --include-expired to widen).';
    out(msg);
    return 0;
  }

  // Stable ordering: effective first, then revoked, then expired; within
  // each group sort by id ascending. Predictable list output is much
  // easier to scan and to assert against in tests.
  const order: Record<WaiverEffectiveness, number> = {
    active: 0,
    not_applicable: 1,
    revoked: 2,
    expired: 3,
  };
  rows.sort((a, b) => {
    const o = order[a.effectiveness] - order[b.effectiveness];
    if (o !== 0) return o;
    return a.waiver.id.localeCompare(b.waiver.id);
  });

  out(`Waivers (${rows.length} shown of ${load.waivers.length} total):`);
  for (const r of rows) out(renderWaiverSummary(r));
  return 0;
}

// ---------------------------------------------------------------------------
// caws waiver show
// ---------------------------------------------------------------------------

export interface WaiverShowOptions extends WaiverCommandBase {
  readonly id: string;
}

export function runWaiverShowCommand(opts: WaiverShowOptions): number {
  const { cwd, nowFn, out, err, showData } = setupIO(opts);
  const now = nowFn();
  if (typeof opts.id !== 'string' || opts.id.length === 0) {
    err('caws waiver show: id is required.');
    err(`(rule: ${SHELL_RULES.WAIVER_MISSING_ID})`);
    return 1;
  }
  const ctx = resolveCaws(cwd, err, showData, 'waiver show');
  if (ctx === null) return 2;

  const load = loadWaivers(ctx.cawsDir);
  if (load.diagnostics.length > 0) {
    err(renderDiagnostics(load.diagnostics, { showData }));
  }
  const found = load.waivers.find((w) => w.id === opts.id);
  if (found === undefined) {
    err(`caws waiver show: waiver ${opts.id} not found.`);
    err(
      renderDiagnostics(
        [shellDiag(SHELL_RULES.WAIVER_NOT_FOUND, `Waiver ${opts.id} not found.`, opts.id)],
        { showData }
      )
    );
    return 1;
  }
  out(
    renderWaiverDetail({
      waiver: found,
      effectiveness: waiverEffectiveness(found, now),
      now,
    })
  );
  return 0;
}

// ---------------------------------------------------------------------------
// caws waiver revoke
// ---------------------------------------------------------------------------

export interface WaiverRevokeOptions extends WaiverCommandBase {
  readonly id: string;
  /** Optional revoker identity recorded in revocation.revoked_by. */
  readonly revokedBy?: string;
  /** Optional reason recorded in revocation.reason. */
  readonly reason?: string;
}

export function runWaiverRevokeCommand(opts: WaiverRevokeOptions): number {
  const { cwd, nowFn, out, err, showData } = setupIO(opts);
  const now = nowFn();
  if (typeof opts.id !== 'string' || opts.id.length === 0) {
    err('caws waiver revoke: id is required.');
    err(`(rule: ${SHELL_RULES.WAIVER_MISSING_ID})`);
    return 1;
  }
  const ctx = resolveCaws(cwd, err, showData, 'waiver revoke');
  if (ctx === null) return 2;

  const result = markRevoked(ctx.cawsDir, opts.id, {
    now,
    ...(opts.revokedBy !== undefined ? { revoked_by: opts.revokedBy } : {}),
    ...(opts.reason !== undefined ? { reason: opts.reason } : {}),
  });
  if (!isOk(result)) {
    // markRevoked uses STORE_RULES.WAIVERS_NOT_FOUND for missing files and
    // STORE_RULES.WAIVERS_ALREADY_EXISTS for "already revoked" (semantics
    // overload acknowledged in the store comment). Both are domain
    // errors → exit 1. Other failures (I/O, validation) are exit 2.
    const isDomain = result.errors.some(
      (d) =>
        d.rule === STORE_RULES.WAIVERS_NOT_FOUND ||
        d.rule === STORE_RULES.WAIVERS_ALREADY_EXISTS
    );
    err(
      isDomain
        ? `caws waiver revoke: cannot revoke ${opts.id}.`
        : 'caws waiver revoke: failed to revoke waiver.'
    );
    err(renderDiagnostics(result.errors, { showData }));
    return isDomain ? 1 : 2;
  }
  out(
    renderWaiverDetail({
      waiver: result.value,
      effectiveness: waiverEffectiveness(result.value, now),
      now,
    })
  );
  return 0;
}
