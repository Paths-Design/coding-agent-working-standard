// Lifecycle-plane cross-repo containment (CAWS-LIFECYCLE-CROSS-REPO-CONTAINMENT-01).
//
// THE GAP THIS CLOSES. Every guard that adjudicates "is this write in another
// repository?" runs at a TOOL boundary: scope-guard.sh on Write/Edit,
// bash-write-guard.sh on Bash. The CAWS CLI itself has no such boundary — it
// resolves its repo root from `process.cwd()` and governs whatever repo it
// finds there. So a session rooted in repo A that runs `caws specs create`
// from inside repo B authors a spec, activates it, and appends hash-chained
// events into B's audit log, and nothing in the system observes that the
// session did not belong there. The tool-boundary guards cannot see it: the
// CLI is the one writing, and the CLI was invoked from a cwd that is locally
// consistent.
//
// This module is the missing third channel. It gives the CLI the same
// containment the two tool-boundary guards already enforce, on the four
// governed lifecycle mutations (`specs create`, `specs close`,
// `worktree create`, `worktree merge`).
//
// WHY A RECORDED ORIGIN AND NOT AN ENVIRONMENT VARIABLE. The obvious
// implementation reads `CLAUDE_PROJECT_DIR` / `CODEX_PROJECT_DIR` and compares.
// It does not work, and it fails in the most dangerous direction: those
// variables are set for HOOK invocations, not in the agent's own Bash
// environment. A containment keyed on them is inert for the caller it exists
// to contain (an agent shelling out `caws`) while active for the caller that
// never needed it (a hook, which the shared pack already `cd`s into the right
// root). So the root is learned from the session's own first governed use and
// recorded durably, machine-wide, where any later invocation from any cwd can
// read it.
//
// HOW THE ROOT IS LEARNED, AND WHY NOT BY POSITION ALONE. The first governed
// lifecycle command a session runs IN A REPO THAT ALREADY KNOWS IT pins that
// repo as the session's origin. "Already knows it" means the repo holds a
// lease for the session — the registration `agent-register.sh` writes at
// SessionStart. There is no privileged repo and no ordering assumption: a
// session first seen in B is pinned to B and is then refused in A. The pin is
// write-once — a later invocation from a different repo never rewrites it,
// because a record that the act being adjudicated can overwrite is not a
// record.
//
// The registration requirement is not decoration; it removes a false-positive
// class that pure position-based pinning creates. Test suites in this
// ecosystem routinely shell out to `caws` inside throwaway repos, and they
// inherit the agent's environment unless they scrub it (an observed, named
// failure class in this repo). Under pure trust-on-first-use, one such test
// run would pin the agent's LIVE session to a temp directory that is deleted
// seconds later, and every governed command in the agent's real repo would
// then be refused against a root that no longer exists. Requiring a lease
// makes the pin evidence-based: a throwaway repo has never registered the
// session, so it cannot claim it.
//
// This does not weaken the boundary. Registration governs only where a pin
// may be TAKEN, never where one may be ignored: an already-pinned session
// cannot unpin itself by registering somewhere else, because an existing
// record is never rewritten.
//
// FAIL DIRECTIONS, STATED. Three of them, deliberately not uniform:
//   - Caller cannot be identified (no harness session identity: a human
//     terminal, CI) -> NOT CONTAINED. A guard that cannot tell who is calling
//     must not refuse everyone; the alternative bricks every non-agent caller
//     on the machine.
//   - No record yet -> ADMIT and pin. Nothing is known to be violated.
//   - Record exists but is unreadable or structurally invalid -> REFUSE. An
//     unreadable origin is not an absent origin. Treating it as absent would
//     make corrupting one file the way to buy machine-wide reach, which is the
//     same door `reprieveReachesRepo` closes for a malformed `repo_root`.
//
// THE ESCAPE IS HUMAN-GRANTED, NOT A FLAG. The sibling lifecycle guard
// (`lifecycleCommitTargetAdmits` in commands/specs.ts) is escaped with
// `--allow-foreign-branch`, and that is right for it: parking the canonical
// checkout on a foreign branch is an operator's own mistake to override. This
// boundary is different. It exists because an agent under local pressure
// reached into a repo it was not working in, so an escape the agent can type
// is not an escape, it is the absence of a boundary. The only lift is a
// `caws reprieve grant` naming the lifecycle plane: human-approved, expiring,
// carrying a reason and an approver, and repo-scoped by default.

import * as fs from 'node:fs';
import * as path from 'node:path';

import { machineHome } from '../../init/machine-adapters';
import { assertMachinePath } from '../../init/machine-paths';
import { loadLeases, writeFileAtomic } from '../../store';
import {
  LIFECYCLE_PLANE_HANDLER,
  consultLifecycleReprieve,
  sanitizeSessionId,
  type ReprieveRecord,
} from '../commands/reprieve';
import { resolveSession } from './resolve-session';

/**
 * The durable pin. One file per session under the machine state directory,
 * alongside that session's reprieve record.
 */
export interface SessionOriginRecord {
  readonly session_id: string;
  /** Canonical repo root (git --git-common-dir based) this session is rooted in. */
  readonly repo_root: string;
  readonly recorded_at: string;
  /** The governed command that pinned it, e.g. "specs create". */
  readonly recorded_by: string;
  /** The resolver tier the identity came from at pin time. Audit only. */
  readonly source: string;
}

/**
 * Whether an identity source denotes a STABLE agent session, and is therefore
 * contained.
 *
 * The three omissions are each deliberate:
 *   - `minted` — an identity this invocation just created because none
 *     existed. There is no prior session to contain, and `worktree create`
 *     mints, so containing it would refuse the very command that establishes
 *     a lane.
 *   - `capsule` — a capsule is bound to one shell AND one worktree, so it is
 *     already repo-local by construction; a second containment layer over it
 *     can only produce false refusals.
 *   - `cursor_env` — `CURSOR_TRACE_ID` is a trace id, not a session id. It is
 *     documented in types.ts as low-stability; pinning a value that rotates
 *     per request would write an unbounded number of single-use records and
 *     contain nothing.
 *
 * Evaluated per call rather than held in a module-level Set on purpose. A
 * module-level constant is initialized once at import, before any test can
 * select a variant of it, so each entry in the list would be unfalsifiable —
 * no test could distinguish "this source is contained" from "this entry was
 * deleted". Membership IS the policy here, so it has to be decidable at
 * decision time and provable one entry at a time.
 */
export function isContainedSource(source: string): boolean {
  return [
    'surface_pinned_env',
    'claude_env',
    'claude_code_env',
    'codex_thread_env',
    'dsh_env',
    'caws_env',
    'hook_env',
    'durable_hook_envelope',
    'agent_pid_record',
  ].includes(source);
}

export type ContainmentDecision =
  /** Caller is not a contained identity, or could not be resolved at all. */
  | { readonly kind: 'not_applicable'; readonly reason: string }
  /** No record existed; this invocation pinned the session to this repo. */
  | { readonly kind: 'pinned'; readonly record: SessionOriginRecord }
  /** Recorded origin is this repo. */
  | { readonly kind: 'admit'; readonly record: SessionOriginRecord }
  /** Recorded origin is elsewhere, but an active human grant lifts it. */
  | {
      readonly kind: 'admit_reprieved';
      readonly record: SessionOriginRecord;
      readonly targetRoot: string;
      readonly reprieve: ReprieveRecord;
    }
  /** Recorded origin is a different repo and no grant applies. */
  | {
      readonly kind: 'refuse_foreign';
      readonly record: SessionOriginRecord;
      readonly targetRoot: string;
      readonly recordPath: string;
    }
  /** A record exists but cannot be trusted. */
  | {
      readonly kind: 'refuse_unreadable';
      readonly recordPath: string;
      readonly detail: string;
    };

export interface LifecycleContainmentArgs {
  /** Human-facing command name, e.g. "specs create". */
  readonly command: string;
  /** Canonical repo root the command would act on. */
  readonly repoRoot: string;
  readonly cawsDir: string;
  readonly cwd: string;
  readonly env: NodeJS.ProcessEnv;
  readonly now: () => Date;
  /** Test seam; defaults to machineHome(env). */
  readonly homeDir?: string;
}

/** Best-effort canonicalization. A recorded root whose directory no longer
 * exists still compares by its resolved textual form rather than throwing. */
function realpathOrResolve(p: string): string {
  try {
    return fs.realpathSync(p);
  } catch {
    return path.resolve(p);
  }
}

/**
 * Whether this repo has registered the session — the evidence that lets it
 * take the pin. Lease presence only; `agents.json` is deliberately not
 * consulted, because it is a last-active cache that is explicitly never an
 * authority source (see session/types.ts).
 *
 * Any failure reading the lease store answers "no". Being unable to prove
 * registration must not become a way to acquire a pin.
 */
function repoKnowsSession(cawsDir: string, sessionId: string): boolean {
  try {
    const result = loadLeases(cawsDir);
    if (!result.ok) return false;
    return Object.prototype.hasOwnProperty.call(result.value.leases, sessionId);
  } catch {
    return false;
  }
}

export function originRecordPath(home: string, sessionId: string): string {
  return path.join(home, 'state', 'sessions', sanitizeSessionId(sessionId), 'origin.json');
}

function parseOriginRecord(raw: unknown, sessionId: string): SessionOriginRecord | null {
  if (raw === null || typeof raw !== 'object') return null;
  const rec = raw as Partial<SessionOriginRecord>;
  if (typeof rec.session_id !== 'string' || rec.session_id !== sessionId) return null;
  if (typeof rec.repo_root !== 'string' || rec.repo_root.length === 0) return null;
  if (!path.isAbsolute(rec.repo_root)) return null;
  if (typeof rec.recorded_at !== 'string' || rec.recorded_at.length === 0) return null;
  if (typeof rec.recorded_by !== 'string' || rec.recorded_by.length === 0) return null;
  if (typeof rec.source !== 'string' || rec.source.length === 0) return null;
  return rec as SessionOriginRecord;
}

/**
 * Decide containment without emitting anything. Exported so the decision is
 * testable independently of its rendering — a refusal's WORDING is the part
 * most likely to drift, and a test that asserts only "exit 1" cannot see it.
 */
export function evaluateLifecycleContainment(args: LifecycleContainmentArgs): ContainmentDecision {
  const sessionResult = resolveSession({
    cawsDir: args.cawsDir,
    worktreeRoot: args.cwd,
    env: args.env,
    now: args.now,
    // Read-only: minting an identity here would make the containment check
    // itself a write, and would hand every unidentified caller a fresh
    // `minted` id that is excluded below anyway.
    allowMint: false,
  });
  if (!sessionResult.ok) {
    return { kind: 'not_applicable', reason: 'no resolvable session identity' };
  }
  const { source } = sessionResult.value;
  const sessionId = sessionResult.value.identity.session_id;
  if (!isContainedSource(source)) {
    return { kind: 'not_applicable', reason: `session source "${source}" is not contained` };
  }

  let home: string;
  try {
    home = args.homeDir ?? machineHome(args.env);
  } catch {
    // An unusable CAWS_HOME is an environment problem, not an authority
    // signal. Do not convert it into a refusal of ordinary in-repo work.
    return { kind: 'not_applicable', reason: 'machine home unavailable' };
  }

  const recordPath = originRecordPath(home, sessionId);
  try {
    assertMachinePath(home, recordPath);
  } catch (error) {
    return {
      kind: 'refuse_unreadable',
      recordPath,
      detail: (error as Error).message,
    };
  }

  const targetRoot = realpathOrResolve(args.repoRoot);

  // No separate symlink check here: assertMachinePath above lstats EVERY
  // component from the machine home through the leaf, so a symlinked record
  // file — or a symlinked per-session directory — is already refused. A
  // second check would be a branch no input can reach.
  let contents: string;
  try {
    contents = fs.readFileSync(recordPath, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      return {
        kind: 'refuse_unreadable',
        recordPath,
        detail: (error as Error).message,
      };
    }
    // First governed use by this session. Pin it here only if this repo has
    // actually registered the session; otherwise leave no record at all, so a
    // throwaway repo cannot claim a session that merely passed through it.
    if (!repoKnowsSession(args.cawsDir, sessionId)) {
      return {
        kind: 'not_applicable',
        reason: 'no origin recorded and this repo holds no lease for the session',
      };
    }
    const record: SessionOriginRecord = {
      session_id: sessionId,
      repo_root: targetRoot,
      recorded_at: args.now().toISOString(),
      recorded_by: args.command,
      source,
    };
    const written = writeOriginRecord(recordPath, record);
    if (!written.ok) {
      // A pin we could not persist must not become a silent no-containment
      // mode on every subsequent call, but it also must not block work the
      // session is entitled to do here. Admit and say nothing was pinned.
      return { kind: 'not_applicable', reason: `origin record not writable: ${written.detail}` };
    }
    return { kind: 'pinned', record };
  }

  let parsed: SessionOriginRecord | null;
  try {
    parsed = parseOriginRecord(JSON.parse(contents), sessionId);
  } catch (error) {
    return {
      kind: 'refuse_unreadable',
      recordPath,
      detail: `unparseable JSON (${(error as Error).message})`,
    };
  }
  if (parsed === null) {
    return {
      kind: 'refuse_unreadable',
      recordPath,
      detail: 'record is structurally invalid or names a different session',
    };
  }

  if (realpathOrResolve(parsed.repo_root) === targetRoot) {
    return { kind: 'admit', record: parsed };
  }

  const grant = consultLifecycleReprieve({
    sessionId,
    repoRoot: targetRoot,
    handler: LIFECYCLE_PLANE_HANDLER,
    now: args.now(),
    env: args.env,
    homeDir: home,
  });
  if (grant.granted) {
    return { kind: 'admit_reprieved', record: parsed, targetRoot, reprieve: grant.record };
  }

  return { kind: 'refuse_foreign', record: parsed, targetRoot, recordPath };
}

function writeOriginRecord(
  recordPath: string,
  record: SessionOriginRecord
): { ok: true } | { ok: false; detail: string } {
  try {
    fs.mkdirSync(path.dirname(recordPath), { recursive: true, mode: 0o700 });
    const result = writeFileAtomic(recordPath, `${JSON.stringify(record, null, 2)}\n`);
    if (!result.ok) {
      return { ok: false, detail: result.errors.map((d) => d.message).join('; ') };
    }
    return { ok: true };
  } catch (error) {
    return { ok: false, detail: (error as Error).message };
  }
}

/**
 * The call every governed lifecycle command makes before its first write.
 * Returns true when the operation may proceed.
 *
 * Both admitting outcomes that are not the ordinary case ANNOUNCE themselves:
 * a pin, because the session should know which repo it is now bound to, and a
 * reprieved crossing, because a boundary crossed silently is a boundary that
 * teaches nothing.
 */
export function lifecycleContainmentAdmits(
  args: LifecycleContainmentArgs & {
    readonly out: (line: string) => void;
    readonly err: (line: string) => void;
  }
): boolean {
  const decision = evaluateLifecycleContainment(args);
  switch (decision.kind) {
    case 'not_applicable':
    case 'admit':
      return true;
    case 'pinned':
      args.out(
        `caws ${args.command}: this session is now rooted in ${decision.record.repo_root} for governed lifecycle commands.`
      );
      return true;
    case 'admit_reprieved':
      args.out(
        `caws ${args.command}: crossing into ${decision.targetRoot} under an active reprieve (approved by ${decision.reprieve.approved_by}, expires ${decision.reprieve.expires_at}).`
      );
      args.out(`  This session's recorded root is ${decision.record.repo_root}.`);
      return true;
    case 'refuse_foreign':
      for (const line of renderForeignRefusal(args.command, decision)) args.err(line);
      return false;
    case 'refuse_unreadable':
      args.err(
        `caws ${args.command}: refusing — this session has an origin record that cannot be read: ${decision.detail}`
      );
      args.err(`  record: ${decision.recordPath}`);
      args.err(
        '  An unreadable origin is not an absent origin; admitting here would make a corrupt file a way to reach every repo on this machine.'
      );
      args.err(
        '  Ask the operator to inspect that file and delete it if it is residue; the next governed command re-pins this session.'
      );
      return false;
  }
}

/**
 * The refusal text.
 *
 * It deliberately names NO route that another channel refuses — the defect
 * class fixed in CAWS-GUARD-REMEDIATION-CROSS-REPO-CONSISTENCY-01, where
 * block-dangerous.sh offered "write it to a script file and run it by path"
 * for a target bash-write-guard.sh would refuse anyway. There is no
 * `cd`-somewhere suggestion here and no flag, because neither is a way
 * through: the containment reads the recorded origin, not the cwd, and a flag
 * the caller can type is not an authorization.
 */
function renderForeignRefusal(
  command: string,
  decision: Extract<ContainmentDecision, { kind: 'refuse_foreign' }>
): string[] {
  return [
    `caws ${command}: refusing — this session is rooted in another repository.`,
    `  session root: ${decision.record.repo_root}`,
    `  target repo:  ${decision.targetRoot}`,
    '  A governed lifecycle mutation writes spec state and appends hash-chained events into the target',
    '  repository. Doing that from a session that belongs elsewhere leaves that repo with governance',
    '  records no session in it is accountable for.',
    '  Changing directory does not change this: the boundary reads the recorded session root, not the cwd.',
    '  Do the work from a session started in the target repository, or ask the operator for a grant:',
    `    caws reprieve grant --handlers ${LIFECYCLE_PLANE_HANDLER} --reason "<why this crossing is safe>" --approved-by "<their id>" --for 30m`,
    `  (run in ${decision.targetRoot}; the grant is scoped to that repo unless --all-repos is passed)`,
    `  recorded origin: ${decision.recordPath}`,
  ];
}
