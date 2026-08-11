// caws prepush — MULTI-AGENT-PUSH-RANGE-GUARD-001 command surface,
// reworked by CAWS-PREPUSH-PROVENANCE-REWORK-001.
//
// Thin command over the pure classifier (push-range/classify-range). It
// does the git READS (outgoing range, per-commit touched files, foreign
// worktree state, dirty-tree preflight, governed-merge coverage from
// events.jsonl), hands the collected facts to classifyRange(), renders
// the structured report, and returns an exit code.
//
// It NEVER invokes git push. v1 is prepush-first: `caws prepush`
// classifies + refuses; it does not wrap the transport. The operator runs
// `git push` themselves after a clean pass. (Per ADR 0001 + the
// maintainer's prepush-first v1 narrowing.)
//
// MUTATION POSTURE (changed by CAWS-PREPUSH-PROVENANCE-REWORK-001):
// classification is read-only, but `--ack <sha>` is a disclosed write —
// it records a durable operator acknowledgment in .caws/prepush-acks.json
// (SHA-keyed, atomic tmp+rename) so an acknowledged commit stays
// acknowledged across invocations and sessions (A5). Without --ack,
// prepush mutates nothing.
//
// REFUSAL SEMANTICS (changed by the same spec): the ONLY refusal classes
// are (a) unvetted direct-on-trunk commits — no worktree_merged coverage,
// no recognized CLI bookkeeping shape, no recorded acknowledgment — and
// (b) ERROR-severity foreign worktrees after liveness pruning (ghosts:
// dead owner + fully merged branch — are advisory, never ERROR). The
// legacy "attributable to the current slice" model is retired: in a
// multi-agent repo the pusher is never the author of the whole range, so
// that model refused the normal trunk-publish by construction. The
// per-commit spec attribution remains as advisory report output.

import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';

import {
  resolveRepoRoot,
  loadSpecs,
  loadWorktrees,
  loadEvents,
  loadLeases,
  defaultIsPidAlive,
} from '../../store';
import {
  classifyRange,
  type ClassifierSpec,
  type OutgoingCommit,
  type ForeignWorktree,
  type PushRangeReport,
  type PushTarget,
} from '../push-range/classify-range';

/** Injectable git runner: (args, cwd) -> stdout. Throws on non-zero. */
export type GitRunner = (args: readonly string[], cwd: string) => string;

const defaultGitRunner: GitRunner = (args, cwd) =>
  execFileSync('git', [...args], {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).toString();

export interface PrepushCommandOptions {
  readonly cwd?: string;
  /** Default 'origin'. */
  readonly remote?: string;
  /** Default 'main'. */
  readonly branch?: string;
  /** Explicit base ref override; defaults to `<remote>/<branch>`. */
  readonly base?: string;
  /** SHAs the operator acknowledges (repeatable --ack). */
  readonly ack?: readonly string[];
  /** The current session's active spec id (for current-slice-match). */
  readonly specId?: string;
  readonly out?: (line: string) => void;
  readonly err?: (line: string) => void;
  /** Injectable git runner for tests. */
  readonly git?: GitRunner;
  readonly showData?: boolean;
}

interface GitFacts {
  readonly commits: OutgoingCommit[];
  readonly dirtyPaths: readonly string[];
}

/**
 * One registered worktree the caller asks us to attribute commits to. The
 * branch is what `git branch --contains` reports against; the name is the
 * registry key we surface in findings.
 */
interface RegisteredWorktreeRef {
  readonly name: string;
  readonly branch?: string;
}

/**
 * Parse NUL-delimited `git status --porcelain=v1 -z` output into the set of
 * dirty paths. The `-z` form is the only robust parse: it does NOT quote or
 * escape paths, and renames/copies emit the new path and the old path as two
 * separate NUL-terminated fields immediately following the 3-char status
 * prefix. We surface both sides of a rename so the operator sees the full
 * dirty footprint. Lines are `XY <path>\0` (and for R/C, `<orig>\0` follows).
 */
function parseDirtyPathsZ(zOutput: string): string[] {
  const fields = zOutput.split('\0').filter((f) => f.length > 0);
  const paths: string[] = [];
  for (let i = 0; i < fields.length; i++) {
    const field = fields[i]!;
    // Each status record is `XY <path>`; XY is two status chars + a space.
    const status = field.slice(0, 2);
    const p = field.slice(3);
    if (p.length > 0) paths.push(p);
    // Rename (R) and copy (C) entries carry the original path in the NEXT
    // NUL-terminated field with no status prefix — consume it too.
    if (status[0] === 'R' || status[0] === 'C') {
      const orig = fields[i + 1];
      if (orig !== undefined) {
        paths.push(orig);
        i++; // skip the original-path field we just consumed
      }
    }
  }
  return paths;
}

/**
 * Best-effort attribution of a commit SHA to a registered worktree's branch
 * via `git branch --contains <sha>`. Returns the worktree NAME when exactly
 * one registered branch contains the commit AND that branch is not the base
 * branch we're pushing (a commit on the push branch itself is not "from a
 * foreign worktree"). Returns undefined on any ambiguity or git failure —
 * attribution is best-effort and NEVER fabricates an origin (invariant 3).
 */
function attributeOriginWorktree(
  git: GitRunner,
  repoRoot: string,
  sha: string,
  registered: readonly RegisteredWorktreeRef[]
): string | undefined {
  let containing: Set<string>;
  try {
    const out = git(['branch', '--contains', sha, '--format=%(refname:short)'], repoRoot);
    containing = new Set(
      out
        .split('\n')
        .map((s) => s.trim())
        .filter(Boolean)
    );
  } catch {
    return undefined; // git read failed — degrade silently.
  }
  const matches = registered.filter(
    (wt) => wt.branch !== undefined && containing.has(wt.branch)
  );
  if (matches.length !== 1) return undefined; // none, or ambiguous → undefined.
  return matches[0]!.name;
}

/**
 * Probe whether a branch is merged into the push base. Returns true (treated
 * as "unmerged" by the caller) when the branch is NOT an ancestor of base.
 * On any git failure we return false — we do not escalate on an unreadable
 * merge state (invariant 3: failed observation is non-escalating).
 */
function branchIsUnmerged(
  git: GitRunner,
  repoRoot: string,
  branch: string,
  baseRef: string
): boolean {
  try {
    // `merge-base --is-ancestor` exits 0 when branch IS an ancestor of base
    // (i.e. merged), non-zero otherwise. The runner throws on non-zero.
    git(['merge-base', '--is-ancestor', branch, baseRef], repoRoot);
    return false; // ancestor → merged.
  } catch {
    // Non-zero exit means "not an ancestor" (unmerged) — but a genuine git
    // error (bad ref) lands here too. Distinguish by verifying the branch
    // resolves; if it doesn't, we cannot claim it's unmerged.
    try {
      git(['rev-parse', '--verify', '--quiet', `${branch}^{commit}`], repoRoot);
      return true; // branch resolves but is not an ancestor → unmerged.
    } catch {
      return false; // branch unresolvable → no escalation.
    }
  }
}

/** One physical git worktree as reported by `git worktree list`. */
interface PhysicalWorktree {
  readonly path: string;
  readonly branch?: string;
}

/**
 * Enumerate physical git worktrees via `git worktree list --porcelain`.
 * This is git's ground truth — it includes worktrees created OUTSIDE CAWS
 * (the session-13 class) that are absent from .caws/worktrees.json. Returns
 * an empty list on any git failure (non-escalating; invariant 3).
 */
function listPhysicalWorktrees(
  git: GitRunner,
  repoRoot: string
): PhysicalWorktree[] {
  let out: string;
  try {
    out = git(['worktree', 'list', '--porcelain'], repoRoot);
  } catch {
    return [];
  }
  const result: PhysicalWorktree[] = [];
  let curPath: string | undefined;
  let curBranch: string | undefined;
  const flush = () => {
    if (curPath !== undefined) {
      result.push({
        path: curPath,
        ...(curBranch !== undefined ? { branch: curBranch } : {}),
      });
    }
    curPath = undefined;
    curBranch = undefined;
  };
  for (const line of out.split('\n')) {
    if (line.startsWith('worktree ')) {
      flush();
      curPath = line.slice('worktree '.length).trim();
    } else if (line.startsWith('branch ')) {
      // `branch refs/heads/<name>` — normalize to the short name.
      curBranch = line.slice('branch '.length).trim().replace(/^refs\/heads\//, '');
    }
    // `detached`, `HEAD <sha>`, `bare`, blank — ignored for our purposes.
  }
  flush();
  return result;
}

/** Collect the outgoing range + per-commit touched files + dirty state. */
function collectGitFacts(
  git: GitRunner,
  repoRoot: string,
  baseRef: string,
  registered: readonly RegisteredWorktreeRef[]
): GitFacts {
  // Dirty working-tree paths via NUL-delimited porcelain v1 (-z): robust for
  // renames and non-ASCII/quoted paths, which the line-based parse mangled.
  const status = git(['status', '--porcelain=v1', '-z'], repoRoot);
  const dirtyPaths = parseDirtyPathsZ(status);

  // Outgoing range SHAs, newest-first.
  const revs = git(
    ['rev-list', `${baseRef}..HEAD`],
    repoRoot
  )
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean);

  const commits: OutgoingCommit[] = revs.map((sha) => {
    const subject = git(['log', '-1', '--format=%s', sha], repoRoot).trim();
    const files = git(
      ['diff-tree', '--no-commit-id', '--name-only', '-r', sha],
      repoRoot
    )
      .split('\n')
      .map((s) => s.trim())
      .filter(Boolean);
    const origin = attributeOriginWorktree(git, repoRoot, sha, registered);
    return {
      // Full 40-char SHA, lowercase (CAWS-PREPUSH-PROVENANCE-REWORK-001
      // A6): acks match against the full form; display truncates.
      sha: sha.toLowerCase(),
      subject,
      touchedFiles: files,
      ...(origin !== undefined ? { originWorktree: origin } : {}),
    };
  });

  return { commits, dirtyPaths };
}

/**
 * Collect every SHA covered by a governed merge: each worktree_merged
 * event's merge commit plus its lane range. Post-extension events record
 * the range explicitly (lane_tip + base_before); pre-extension events are
 * derived from the merge commit's parents. An unreadable ledger or an
 * underivable range degrades to less coverage (those commits surface as
 * unvetted — the operator can ack) — a toolchain fault must not fabricate
 * a refusal (spec invariant).
 */
function collectGovernedMergeShas(
  git: GitRunner,
  repoRoot: string,
  cawsDir: string
): ReadonlySet<string> {
  const covered = new Set<string>();
  const eventsResult = loadEvents(cawsDir);
  if (!eventsResult.ok) return covered;
  for (const ev of eventsResult.value.events) {
    if (ev.event !== 'worktree_merged') continue;
    const data = ev.data as
      | { merge_commit?: unknown; lane_tip?: unknown; base_before?: unknown }
      | undefined;
    const mergeCommit =
      typeof data?.merge_commit === 'string' ? data.merge_commit : undefined;
    if (mergeCommit === undefined) continue;
    covered.add(mergeCommit.toLowerCase());
    const laneTip =
      typeof data?.lane_tip === 'string' ? data.lane_tip : undefined;
    const baseBefore =
      typeof data?.base_before === 'string' ? data.base_before : undefined;
    const rangeSpec =
      laneTip !== undefined && baseBefore !== undefined
        ? `${baseBefore}..${laneTip}`
        : `${mergeCommit}^1..${mergeCommit}^2`;
    try {
      const out = git(['rev-list', rangeSpec], repoRoot);
      for (const line of out.split('\n')) {
        const s = line.trim();
        if (s) covered.add(s.toLowerCase());
      }
    } catch {
      // Underivable range (shallow clone, pruned objects) — degrade to
      // merge-commit-only coverage for this event.
    }
  }
  return covered;
}

// ─── Durable ack store (CAWS-PREPUSH-PROVENANCE-REWORK-001 A5) ──────────
//
// .caws/prepush-acks.json: operator acknowledgments of unvetted direct
// commits, keyed by full SHA. Durable across invocations and sessions so
// a moving trunk costs only the delta — previously acked SHAs never
// demand re-acknowledgment. Written ONLY when --ack matches a range
// commit (atomic tmp+rename); read leniently (absent is normal; malformed
// degrades to empty with a diagnostic — never a refusal).

interface PrepushAckRecord {
  readonly sha: string;
  readonly acked_at: string;
}

function ackStorePath(cawsDir: string): string {
  return path.join(cawsDir, 'prepush-acks.json');
}

export function loadAckStore(cawsDir: string): {
  acks: PrepushAckRecord[];
  diagnostic?: string;
} {
  let raw: string;
  try {
    raw = fs.readFileSync(ackStorePath(cawsDir), 'utf8');
  } catch {
    return { acks: [] }; // absent is normal — no acks recorded yet.
  }
  try {
    const parsed = JSON.parse(raw) as { acks?: unknown };
    const acks = Array.isArray(parsed?.acks)
      ? parsed.acks.filter(
          (a): a is PrepushAckRecord =>
            typeof a === 'object' &&
            a !== null &&
            typeof (a as PrepushAckRecord).sha === 'string' &&
            /^[0-9a-f]{40}$/.test((a as PrepushAckRecord).sha) &&
            typeof (a as PrepushAckRecord).acked_at === 'string'
        )
      : [];
    return { acks };
  } catch (e) {
    return {
      acks: [],
      diagnostic: `caws prepush: .caws/prepush-acks.json is malformed (${(e as Error).message}) — treating as empty. No recorded acks applied.`,
    };
  }
}

export function saveAckStore(
  cawsDir: string,
  acks: readonly PrepushAckRecord[]
): void {
  const p = ackStorePath(cawsDir);
  const tmp = `${p}.tmp.${process.pid}`;
  fs.writeFileSync(
    tmp,
    JSON.stringify({ version: 1, acks }, null, 2) + '\n',
    'utf8'
  );
  fs.renameSync(tmp, p);
}

const ACK_SHA_RE = /^[0-9a-f]{7,40}$/;

/**
 * Normalize --ack flags against the outgoing range's full SHAs (A6): a
 * valid hex prefix (7-40 chars, so `git rev-list` output works verbatim)
 * matching exactly one range commit resolves to that commit's full SHA.
 * Zero or multiple matches produce a diagnostic naming the ack — an ack
 * is never silently ignored.
 */
export function normalizeCliAcks(
  cliAcks: readonly string[],
  rangeShas: readonly string[],
  report: (line: string) => void
): string[] {
  const matched: string[] = [];
  for (const raw of cliAcks) {
    const ack = raw.trim().toLowerCase();
    if (!ACK_SHA_RE.test(ack)) {
      report(
        `caws prepush: --ack "${raw}" is not a valid hex SHA prefix (7-40 chars) — not recorded.`
      );
      continue;
    }
    const hits = rangeShas.filter((s) => s.startsWith(ack));
    if (hits.length === 1) {
      matched.push(hits[0]!);
    } else if (hits.length === 0) {
      report(
        `caws prepush: --ack ${ack} did not match any commit in the outgoing range — not recorded.`
      );
    } else {
      report(
        `caws prepush: --ack ${ack} is ambiguous (${hits.length} outgoing commits match) — not recorded.`
      );
    }
  }
  return matched;
}

function renderReport(report: PushRangeReport, out: (s: string) => void): void {
  out(`prepush: outgoing range ${report.baseRef}..HEAD → ${report.target.remote} ${report.target.branch}`);
  if (report.commits.length === 0) {
    out('  (no outgoing commits)');
  }
  for (const c of report.commits) {
    const flag =
      c.governanceClass === 'governed_merge'
        ? 'governed-merge'
        : c.governanceClass === 'cli_bookkeeping'
          ? 'bookkeeping'
          : c.governanceClass === 'acked_exception'
            ? 'acknowledged'
            : 'UNVETTED';
    const specs = c.inferredSpecIds.length > 0 ? c.inferredSpecIds.join(',') : '(none)';
    out(`  ${c.sha.slice(0, 12)} [${flag}] ${c.subject}`);
    out(`      specs: ${specs}  via: ${c.provenanceSource}  files: ${c.touchedFiles.length}`);
    if (c.originWorktree !== undefined) {
      out(`      origin-worktree: ${c.originWorktree}`);
    }
  }
  for (const f of report.foreignWorktrees) {
    out(`  [${f.severity}] foreign worktree ${f.name} (${f.path})${f.branch ? ' @ ' + f.branch : ''}`);
    for (const r of f.reasons) out(`      - ${r}`);
    if (f.remediation !== undefined) out(`      remediation: ${f.remediation}`);
  }
}

/**
 * Run the prepush guard. Returns 0 on clean pass, 1 on refusal, 2 on a
 * setup/composition error.
 */
export function runPrepushCommand(opts: PrepushCommandOptions): number {
  const cwd = opts.cwd ?? process.cwd();
  const out = opts.out ?? ((s: string) => process.stdout.write(s + '\n'));
  const err = opts.err ?? ((s: string) => process.stderr.write(s + '\n'));
  const git = opts.git ?? defaultGitRunner;
  const remote = opts.remote ?? 'origin';
  const branch = opts.branch ?? 'main';
  const target: PushTarget = { remote, branch };
  const baseRef = opts.base ?? `${remote}/${branch}`;

  // 1. Repo root.
  const rootResult = resolveRepoRoot(cwd);
  if (!rootResult.ok) {
    err('caws prepush: failed to resolve repo root (not a git repository?).');
    return 2;
  }
  const { repoRoot, cawsDir } = rootResult.value;

  // 2. Load the worktree registry FIRST — its branches feed per-commit origin
  //    attribution (git branch --contains) inside collectGitFacts.
  const wtResult = loadWorktrees(cawsDir);
  const registry: Record<
    string,
    {
      specId?: string;
      path?: string;
      branch?: string;
      owner?: { session_id?: unknown };
    }
  > = wtResult.ok ? wtResult.value : {};
  const registered: RegisteredWorktreeRef[] = Object.entries(registry).map(
    ([name, rec]) => ({
      name,
      ...(typeof rec?.branch === 'string' ? { branch: rec.branch } : {}),
    })
  );

  // 3. Collect git facts (range + per-commit origin + dirty state). Wrap git
  //    failures as exit 2.
  let facts: GitFacts;
  try {
    facts = collectGitFacts(git, repoRoot, baseRef, registered);
  } catch (e) {
    err(`caws prepush: git read failed for base "${baseRef}": ${(e as Error).message}`);
    return 2;
  }

  // 4. A8 — dirty-tree / governed-path preflight, BEFORE range classification.
  //    A dirty working tree means provenance is ambiguous (whose change is
  //    this?) — refuse early so the operator resolves it before publishing.
  if (facts.dirtyPaths.length > 0) {
    err('caws prepush: refusing — working tree is dirty before classification.');
    for (const p of facts.dirtyPaths) err(`  dirty: ${p}`);
    err('  Commit or stash these (and confirm they are yours) before prepush.');
    return 1;
  }

  // 4b. Governed-merge coverage from the events ledger + durable acks.
  //     (CAWS-PREPUSH-PROVENANCE-REWORK-001.) The events ledger is the
  //     provenance record: every commit a governed merge landed is covered
  //     by construction. Durable acks cover the human-blessed exceptions.
  const governedMergeShas = collectGovernedMergeShas(git, repoRoot, cawsDir);
  const ackStore = loadAckStore(cawsDir);
  if (ackStore.diagnostic !== undefined) err(ackStore.diagnostic);
  const rangeShas = facts.commits.map((c) => c.sha);
  const cliAcks = normalizeCliAcks(opts.ack ?? [], rangeShas, err);
  // Persist newly matched acks — the one disclosed write (A5). A
  // persistence failure is non-fatal: the ack still applies to this run.
  const alreadyRecorded = new Set(ackStore.acks.map((a) => a.sha));
  const freshAcks = cliAcks.filter((s) => !alreadyRecorded.has(s));
  if (freshAcks.length > 0) {
    try {
      saveAckStore(cawsDir, [
        ...ackStore.acks,
        ...freshAcks.map((sha) => ({ sha, acked_at: new Date().toISOString() })),
      ]);
      for (const sha of freshAcks) {
        out(`  acknowledged: ${sha.slice(0, 12)} recorded in .caws/prepush-acks.json`);
      }
    } catch (e) {
      err(
        `caws prepush: failed to persist acks (${(e as Error).message}) — acknowledgment applies to this run only.`
      );
    }
  }
  const ackedShas = [...ackStore.acks.map((a) => a.sha), ...cliAcks];

  // 5. Load specs (control-plane facts for attribution).
  const specsLoad = loadSpecs(cawsDir);
  const specs: ClassifierSpec[] = specsLoad.specs
    .filter((s) => s.lifecycle_state === 'active' || s.lifecycle_state === 'closed')
    .map((s) => ({
      specId: s.id,
      scopeIn: s.scope.in,
      lifecycleState: s.lifecycle_state,
    }));

  // 6. Foreign worktrees, from git's PHYSICAL truth joined against the
  //    registry. A foreign worktree is any physical worktree that is NOT the
  //    current checkout (repoRoot) and is NOT the one bound to the current
  //    slice. For each we observe (read-only):
  //      - unregistered: its branch is absent from .caws/worktrees.json
  //        (ADR Q4 condition b — the session-13 "created outside CAWS" class);
  //      - unmerged:     its branch is not an ancestor of the push base
  //        (ADR Q4 condition a);
  //      - originates:   handled per-commit via originWorktree attribution,
  //        which classifyForeignWorktree reads (ADR Q4 condition c).
  //    Enumerating physical worktrees (not just the registry) is what lets the
  //    guard catch an unregistered sibling worktree at all.
  let repoRootReal: string;
  try {
    repoRootReal = fs.realpathSync(repoRoot);
  } catch {
    repoRootReal = repoRoot;
  }
  const registeredBranches = new Set(
    registered.map((r) => r.branch).filter((b): b is string => b !== undefined)
  );
  const currentSliceBranches = new Set(
    Object.entries(registry)
      .filter(([, rec]) => opts.specId !== undefined && rec?.specId === opts.specId)
      .map(([, rec]) => rec?.branch)
      .filter((b): b is string => typeof b === 'string')
  );
  const nameByBranch = new Map(
    registered
      .filter((r) => r.branch !== undefined)
      .map((r) => [r.branch as string, r.name])
  );

  // Agent-liveness substrate for ghost detection (A7): a registered
  // worktree whose owner session has no live lease (stopped/absent, or a
  // dead pid) and whose branch is fully merged is residue — advisory,
  // never ERROR. Leases are operational cache; an unreadable leases dir
  // degrades to "liveness unknown" (the legacy escalation applies).
  const leasesResult = loadLeases(cawsDir);
  const leases = leasesResult.ok ? leasesResult.value.leases : {};

  const foreignWorktrees: ForeignWorktree[] = [];
  for (const phys of listPhysicalWorktrees(git, repoRoot)) {
    let physReal: string;
    try {
      physReal = fs.realpathSync(phys.path);
    } catch {
      physReal = phys.path;
    }
    // Skip the current checkout (where the push originates from).
    if (physReal === repoRootReal) continue;
    // Skip the worktree bound to the current slice — it is not "foreign".
    if (phys.branch !== undefined && currentSliceBranches.has(phys.branch)) continue;

    const unregistered =
      phys.branch === undefined || !registeredBranches.has(phys.branch);
    const unmerged =
      phys.branch !== undefined &&
      branchIsUnmerged(git, repoRoot, phys.branch, baseRef);
    // Prefer the registry name when known; fall back to the branch or path.
    const name =
      (phys.branch !== undefined ? nameByBranch.get(phys.branch) : undefined) ??
      phys.branch ??
      phys.path;
    // Liveness of the registered owner's session, when evaluable.
    let ownerSessionLive: boolean | undefined;
    const ownerSid = registry[name]?.owner?.session_id;
    if (typeof ownerSid === 'string' && ownerSid.length > 0) {
      const lease = leases[ownerSid];
      ownerSessionLive =
        lease !== undefined &&
        lease.status === 'active' &&
        (typeof lease.pid !== 'number' || defaultIsPidAlive(lease.pid));
    }
    foreignWorktrees.push({
      name,
      path: phys.path,
      ...(phys.branch !== undefined ? { branch: phys.branch } : {}),
      unregistered,
      unmerged,
      ...(ownerSessionLive !== undefined ? { ownerSessionLive } : {}),
    });
  }

  // 7. Classify (pure).
  const report = classifyRange({
    commits: facts.commits,
    specs,
    ...(opts.specId !== undefined ? { currentSpecId: opts.specId } : {}),
    foreignWorktrees,
    governedMergeShas: [...governedMergeShas],
    ackedShas,
    baseRef,
    target,
  });

  // 8. Render + decide.
  renderReport(report, out);
  if (report.refused) {
    err('caws prepush: REFUSED. The outgoing range contains direct-on-trunk');
    err('  commits governance never touched (no governed-merge coverage, no');
    err('  recognized CLI bookkeeping shape, no recorded acknowledgment), or');
    err('  an ERROR-severity foreign worktree. Acknowledge specific commits');
    err('  with --ack <sha> after confirming they belong in this push (acks');
    err('  are recorded durably in .caws/prepush-acks.json), or resolve the');
    err('  foreign worktree, then re-run. This is a governed pre-push check;');
    err('  it does NOT run git push.');
    if (report.unvettedShas.length > 0) {
      err(
        `  unvetted (unacknowledged): ${report.unvettedShas.map((s) => s.slice(0, 12)).join(', ')}`
      );
    }
    return 1;
  }

  out('caws prepush: range is fully provenance-covered. Safe to git push.');
  return 0;
}
