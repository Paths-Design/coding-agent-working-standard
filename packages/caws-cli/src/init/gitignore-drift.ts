// Observe Git protection independently of init managed-block formatting.
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { DoctorFinding } from '../kernel';
import { resolveGitBinary } from '../store/git-binary';
import { storeDiagnostic } from '../store/repo-root';
import { EPHEMERAL_CAWS_ENTRIES, computeGitignore } from './gitignore-manage';

export const GITIGNORE_DRIFT_RULE = 'shell.gitignore.ephemeral_state_untracked';
function ephemeral(name: string): boolean {
  return EPHEMERAL_CAWS_ENTRIES.some((entry) =>
    entry.endsWith('/')
      ? name.startsWith(entry)
      : entry.includes('*')
        ? name.startsWith('tmp/guard-strikes-') && name.endsWith('.json')
        : name === entry
  );
}
export function inspectGitignoreCoverage(repoRoot: string, cawsDir: string): DoctorFinding[] {
  if (!fs.existsSync(path.join(repoRoot, '.git'))) return [];
  try {
    if (!fs.readdirSync(path.join(cawsDir, 'specs')).some((n) => /\.ya?ml$/.test(n))) return [];
  } catch {
    return [];
  }
  const findings: DoctorFinding[] = [];
  let existing: string | null = null;
  try {
    existing = fs.readFileSync(path.join(repoRoot, '.gitignore'), 'utf8');
  } catch {
    /* absent */
  }
  const { outcome } = computeGitignore(existing);
  const probes = EPHEMERAL_CAWS_ENTRIES.map((entry) =>
    entry.endsWith('/')
      ? entry + '__caws_ignore_probe__'
      : entry.replace('*', '__caws_ignore_probe__')
  );
  const authority = [
    '.caws/specs/__caws_ignore_probe__.yaml',
    '.caws/policy.yaml',
    '.caws/waivers/__caws_ignore_probe__.yaml',
  ];
  const env = { ...process.env };
  for (const key of [
    'GIT_DIR',
    'GIT_WORK_TREE',
    'GIT_INDEX_FILE',
    'GIT_COMMON_DIR',
    'GIT_OBJECT_DIRECTORY',
    'GIT_ALTERNATE_OBJECT_DIRECTORIES',
  ])
    delete env[key];
  const git = (args: string[], input?: string): string => {
    try {
      return execFileSync(resolveGitBinary(), ['-C', repoRoot, ...args], {
        env,
        input,
        encoding: 'utf8',
        timeout: 10000,
        maxBuffer: 16 * 1024 * 1024,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (e) {
      const error = e as { status?: number; stdout?: string };
      if (args[0] === 'check-ignore' && error.status === 1 && typeof error.stdout === 'string')
        return error.stdout;
      throw e;
    }
  };
  const report = (
    rule: string,
    message: string,
    severity: 'warning' | 'info',
    data: Record<string, unknown>
  ) =>
    findings.push(
      storeDiagnostic(rule, message, { severity, subject: '.gitignore', data }) as DoctorFinding
    );
  try {
    const tracked = git(['ls-files', '-z', '--cached', '--', '.caws/', 'tmp/'])
      .split('\0')
      .filter((n) => n && ephemeral(n));
    const fields = git(
      ['check-ignore', '--no-index', '--stdin', '-z', '-v', '--non-matching'],
      [...probes, ...authority].join('\0') + '\0'
    ).split('\0');
    const rows: {
      path: string;
      source: string;
      line: string;
      pattern: string;
      ignored: boolean;
      repository_rule: boolean;
    }[] = [];
    for (let i = 0; i + 3 < fields.length; i += 4) {
      const [source, line, pattern, name] = fields.slice(i, i + 4) as [
        string,
        string,
        string,
        string,
      ];
      const relative = path.relative(repoRoot, path.resolve(repoRoot, source));
      rows.push({
        path: name,
        source,
        line,
        pattern,
        ignored: pattern !== '' && !pattern.startsWith('!'),
        repository_rule:
          source !== '' &&
          !relative.startsWith('..') &&
          !path.isAbsolute(relative) &&
          !relative.startsWith('.git/'),
      });
    }
    if (rows.length !== probes.length + authority.length)
      throw new Error('Git returned incomplete ignore observations');
    const runtime = rows.filter((r) => probes.includes(r.path));
    const uncovered = runtime.filter((r) => !r.ignored),
      local = runtime.filter((r) => r.ignored && !r.repository_rule);
    if (uncovered.length)
      report(
        GITIGNORE_DRIFT_RULE,
        'Required runtime probes are not git-ignored. Review the named rules and negations; caws init maintains the repository ignore block.',
        'warning',
        { uncovered, observations: runtime, gitignore_outcome_if_init_ran: outcome }
      );
    if (local.length)
      report(
        'shell.gitignore.machine_local_coverage',
        'Runtime ignore coverage depends on machine-local Git rules and is not supplied by the repository.',
        'warning',
        { observations: local }
      );
    if (tracked.length)
      report(
        'shell.gitignore.ephemeral_state_tracked',
        'Runtime state is already tracked; ignore rules do not remove index entries. Review ownership before untracking.',
        'warning',
        { tracked_paths: tracked }
      );
    const hiddenAuthority = rows.filter((r) => authority.includes(r.path) && r.ignored);
    if (hiddenAuthority.length)
      report(
        'shell.gitignore.authority_ignored',
        'Ignore rules hide CAWS authority paths; review the named rules without deleting authority.',
        'warning',
        { observations: hiddenAuthority }
      );
    if (outcome !== 'unchanged')
      report(
        'shell.gitignore.managed_block_drift',
        'The managed ignore block differs from init formatting; actual Git coverage is reported separately.',
        'info',
        { gitignore_outcome_if_init_ran: outcome, observations: runtime }
      );
  } catch (e) {
    report(
      'shell.gitignore.observation_unavailable',
      'Git ignore coverage could not be observed: ' + (e as Error).message,
      'warning',
      { gitignore_outcome_if_init_ran: outcome }
    );
  }
  return findings;
}
export function detectGitignoreDrift(repoRoot: string, cawsDir: string): DoctorFinding | null {
  return inspectGitignoreCoverage(repoRoot, cawsDir)[0] ?? null;
}
