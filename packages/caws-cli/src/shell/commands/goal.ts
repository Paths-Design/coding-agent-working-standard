// `caws goal set | show | clear` — bind THIS session's stop to a spec's
// acceptance criteria (CAWS-GOAL-AC-STOP-GATE-01).
//
// The binding is a single file, `.caws/sessions/<session>/goal.json`, read by
// the Stop handler `goal-ac-gate.sh`. That handler re-derives the spec's
// acceptance with `caws specs verify-acs --json` and refuses the stop while any
// criterion is unproven, so the session keeps working instead of stopping on an
// unproven claim.
//
// Division of authority, which is the whole point of the design:
//   - the SPEC owns the bar (its acceptance criteria),
//   - `caws specs evidence` remains the only writer of acceptance truth,
//   - this command only says "hold me to spec S", and
//   - the gate only READS the verdicts.
// Nothing here can mark a criterion passed, close a spec, or move scope.
//
// `clear` is deliberately reachable by the agent, not human-only. The gate's
// block budget already guarantees a goal can never trap a session, so the
// escape is not what makes it safe — which means gating it behind a human buys
// no safety and costs recoverability. What matters instead is that releasing
// your own goal is never SILENT: clear prints a durable record line naming the
// spec it dropped, so the release is visible in the transcript the evaluator
// reads rather than being an invisible state change.

import * as fs from 'node:fs';
import * as path from 'node:path';

import { loadSpecs } from '../../store/specs-store';
import { resolveRepoRoot, writeFileAtomic } from '../../store';
import { renderDiagnostics } from '../render/diagnostic';
import { resolveSession } from '../session/resolve-session';

/** Sidecar holding the gate's consecutive-block budget. Written by the hook. */
const BLOCK_COUNTER_FILENAME = 'goal-blocks';
const BINDING_FILENAME = 'goal.json';

export interface GoalCommandOptions {
  readonly specId?: string;
  readonly cwd?: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly now?: () => Date;
  readonly out?: (line: string) => void;
  readonly err?: (line: string) => void;
  readonly showData?: boolean;
}

interface GoalContext {
  readonly cawsDir: string;
  readonly sessionId: string;
  readonly sessionDir: string;
  readonly bindingPath: string;
  readonly counterPath: string;
}

type ContextResult = { ok: true; value: GoalContext } | { ok: false; code: number };

function resolveContext(
  verb: string,
  opts: GoalCommandOptions,
  err: (line: string) => void
): ContextResult {
  const cwd = opts.cwd ?? process.cwd();
  const showData = opts.showData === true;

  // resolveRepoRoot resolves the CANONICAL .caws even from a linked worktree,
  // which is required here: session dirs are only ever written to canonical, so
  // a worktree-local path would bind a goal the hook can never find. The hook
  // resolves the same root via `git rev-parse --git-common-dir`.
  const rootRes = resolveRepoRoot(cwd);
  if (!rootRes.ok) {
    err(`caws goal ${verb}: failed to resolve repo root.`);
    err(renderDiagnostics(rootRes.errors, { showData }));
    return { ok: false, code: 2 };
  }
  const { cawsDir } = rootRes.value;

  const sessionRes = resolveSession({
    cawsDir,
    worktreeRoot: cwd,
    env: opts.env ?? process.env,
    now: opts.now ?? (() => new Date()),
    allowMint: true,
  });
  if (!sessionRes.ok) {
    err(`caws goal ${verb}: could not resolve this session's identity.`);
    err(renderDiagnostics(sessionRes.errors, { showData }));
    return { ok: false, code: 2 };
  }
  const sessionId = sessionRes.value.identity.session_id;
  const sessionDir = path.join(cawsDir, 'sessions', sessionId);

  return {
    ok: true,
    value: {
      cawsDir,
      sessionId,
      sessionDir,
      bindingPath: path.join(sessionDir, BINDING_FILENAME),
      counterPath: path.join(sessionDir, BLOCK_COUNTER_FILENAME),
    },
  };
}

function readBinding(bindingPath: string): { spec_id?: string; set_at?: string } | undefined {
  try {
    const raw = fs.readFileSync(bindingPath, 'utf8');
    const obj = JSON.parse(raw) as { spec_id?: unknown; set_at?: unknown };
    return {
      ...(typeof obj.spec_id === 'string' ? { spec_id: obj.spec_id } : {}),
      ...(typeof obj.set_at === 'string' ? { set_at: obj.set_at } : {}),
    };
  } catch {
    return undefined;
  }
}

export function runGoalSetCommand(opts: GoalCommandOptions): number {
  const out = opts.out ?? ((s: string) => process.stdout.write(s + '\n'));
  const err = opts.err ?? ((s: string) => process.stderr.write(s + '\n'));
  const nowFn = opts.now ?? (() => new Date());

  const specId = opts.specId;
  if (typeof specId !== 'string' || specId.length === 0) {
    err('caws goal set: a <spec-id> argument is required.');
    return 1;
  }

  const ctxRes = resolveContext('set', opts, err);
  if (!ctxRes.ok) return ctxRes.code;
  const ctx = ctxRes.value;

  // Refuse a goal naming a spec that does not exist or does not load. Binding to
  // an unresolvable spec would be indistinguishable, at stop time, from the
  // gate-failure path: the agent would get refusals it cannot act on until the
  // budget runs out. Catch it here, where the remediation is obvious.
  const specs = loadSpecs(ctx.cawsDir);
  const spec = specs.specs.find((s) => s.id === specId);
  if (spec === undefined) {
    err(`caws goal set: no loadable spec "${specId}" in ${path.join(ctx.cawsDir, 'specs')}.`);
    err('  List available specs with: caws specs list');
    return 1;
  }

  // No empty-acceptance check here on purpose. The kernel schema already
  // requires a non-empty `acceptance`, so a spec with none does not validate
  // and never reaches this list — a guard here would be a branch that cannot
  // execute, and cannot be tested. The refusal above covers it, and
  // tests/shell/goal.test.js pins that a criteria-less spec is refused by that
  // path rather than by a second check here.
  const acceptance = spec.acceptance;

  const binding = {
    spec_id: specId,
    set_at: nowFn().toISOString(),
    set_by_session: ctx.sessionId,
  };
  try {
    fs.mkdirSync(ctx.sessionDir, { recursive: true });
  } catch (e) {
    err(`caws goal set: could not create ${ctx.sessionDir}: ${(e as Error).message}`);
    return 1;
  }
  const w = writeFileAtomic(ctx.bindingPath, JSON.stringify(binding, null, 2) + '\n');
  if (!w.ok) {
    err('caws goal set: failed to write the goal binding.');
    err(renderDiagnostics(w.errors, { showData: opts.showData === true }));
    return 1;
  }
  // A fresh goal starts with a fresh budget; a leftover counter from a previous
  // goal would spend blocks this one never used.
  try {
    fs.rmSync(ctx.counterPath, { force: true });
  } catch {
    /* best effort — a stale counter costs blocks, it does not break the gate */
  }

  out(`goal set: this session will not stop until ${specId} passes verify-acs.`);
  out(`  criteria held: ${acceptance.map((a) => a.id).join(', ')}`);
  out(`  session:       ${ctx.sessionId}`);
  out('');
  out('  Only verdict=verified counts as met. not_rederived is narrative-only');
  out('  evidence, not proof — record real proof with: caws specs evidence');
  out(`  Check the live verdicts any time with: caws specs verify-acs ${specId}`);
  out('  Release the goal with: caws goal clear');
  return 0;
}

export function runGoalShowCommand(opts: GoalCommandOptions): number {
  const out = opts.out ?? ((s: string) => process.stdout.write(s + '\n'));
  const err = opts.err ?? ((s: string) => process.stderr.write(s + '\n'));

  const ctxRes = resolveContext('show', opts, err);
  if (!ctxRes.ok) return ctxRes.code;
  const ctx = ctxRes.value;

  const binding = readBinding(ctx.bindingPath);
  if (binding?.spec_id === undefined) {
    out('goal: none set for this session.');
    out(`  session: ${ctx.sessionId}`);
    out('  Set one with: caws goal set <spec-id>');
    return 0;
  }

  out(`goal: ${binding.spec_id}`);
  out(`  session:  ${ctx.sessionId}`);
  if (binding.set_at !== undefined) out(`  set at:   ${binding.set_at}`);

  // The counter is the gate's, not ours — report it, never edit it.
  let counter = '';
  try {
    counter = fs.readFileSync(ctx.counterPath, 'utf8').trim();
  } catch {
    /* absent counter means no consecutive blocks yet */
  }
  if (counter.length > 0) {
    const [, n] = counter.split('\t');
    out(`  consecutive blocks so far: ${n ?? '0'}`);
  } else {
    out('  consecutive blocks so far: 0');
  }
  out('');
  out(`  Re-derive the live verdicts with: caws specs verify-acs ${binding.spec_id}`);
  return 0;
}

export function runGoalClearCommand(opts: GoalCommandOptions): number {
  const out = opts.out ?? ((s: string) => process.stdout.write(s + '\n'));
  const err = opts.err ?? ((s: string) => process.stderr.write(s + '\n'));

  const ctxRes = resolveContext('clear', opts, err);
  if (!ctxRes.ok) return ctxRes.code;
  const ctx = ctxRes.value;

  const binding = readBinding(ctx.bindingPath);
  if (binding?.spec_id === undefined) {
    out('goal: none set for this session; nothing to clear.');
    return 0;
  }

  try {
    fs.rmSync(ctx.bindingPath, { force: true });
    fs.rmSync(ctx.counterPath, { force: true });
  } catch (e) {
    err(`caws goal clear: failed to remove the binding: ${(e as Error).message}`);
    return 1;
  }

  // Loud and specific by design. Clearing is allowed, but it is a release of a
  // bar this session set for itself, so it must be legible in the transcript
  // rather than being an invisible state change. Naming the spec is what makes
  // the record reviewable after the fact.
  out(`goal cleared: this session is no longer held to ${binding.spec_id}.`);
  out('  The acceptance criteria were NOT met by clearing — the gate simply');
  out('  stopped enforcing them. Recorded evidence is unchanged.');
  out(`  Re-bind with: caws goal set ${binding.spec_id}`);
  return 0;
}
