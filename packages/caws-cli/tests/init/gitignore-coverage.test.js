'use strict';
const fs = require('fs');
const path = require('path');
const { makeTempRepo, cleanupAll, git } = require('../helpers/git-repo-factory');
const { inspectGitignoreCoverage } = require('../../dist/init/gitignore-drift');
const {
  EPHEMERAL_CAWS_ENTRIES,
  GITIGNORE_BLOCK_VERSION,
  computeGitignore,
  renderManagedBlock,
} = require('../../dist/init/gitignore-manage');
function repo(rules = EPHEMERAL_CAWS_ENTRIES.join('\n')) {
  const root = makeTempRepo();
  fs.mkdirSync(path.join(root, '.caws/specs'), { recursive: true });
  fs.writeFileSync(path.join(root, '.caws/specs/S.yaml'), 'id: S\n');
  fs.writeFileSync(path.join(root, '.gitignore'), rules + '\n');
  return root;
}
function observe(root) {
  return inspectGitignoreCoverage(root, path.join(root, '.caws'));
}
const localRuntimeProbes = [
  '.caws/worktrees/__caws_ignore_probe__',
  '.caws/worktrees.json',
  '.caws/agents.json',
  '.caws/leases/__caws_ignore_probe__',
  '.caws/claims/__caws_ignore_probe__',
  '.caws/cache/__caws_ignore_probe__',
  '.caws/sessions/__caws_ignore_probe__',
  '.caws/.render-writer-custody/__caws_ignore_probe__',
  '.caws/.render-writer-provisioned',
  '.caws/state/__caws_ignore_probe__',
  '.caws/hooks/.pristine/__caws_ignore_probe__',
  '.caws/duplication-cache.json',
  '.caws/events.jsonl',
  '.caws/events.jsonl.lock',
  'tmp/guard-strikes-__caws_ignore_probe__.json',
];
const custodyProbes = [
  '.caws-plan-snapshot-custody/v1/__caws_ignore_probe__',
  '.caws/plans/.caws-plan-snapshot-custody/v1/__caws_ignore_probe__',
  'docs/plans/.caws-plan-snapshot-custody/v1/__caws_ignore_probe__',
];
afterAll(cleanupAll);
test('v3 blocks upgrade in place to durable snapshot custody coverage without changing authored rules', () => {
  const existing = [
    '# authored before',
    'dist/',
    '# >>> caws gitignore (managed, v3) >>>',
    '.caws/cache/',
    '# <<< caws gitignore <<<',
    '# authored after',
    'local-only.txt',
    '',
  ].join('\n');
  const updated = computeGitignore(existing);
  expect(GITIGNORE_BLOCK_VERSION).toBe(4);
  expect(updated.outcome).toBe('block_updated');
  expect(updated.content).toBe(
    '# authored before\ndist/\n' + renderManagedBlock() + '\n# authored after\nlocal-only.txt\n'
  );
  expect(updated.content).toContain('**/.caws-plan-snapshot-custody/');
  expect(updated.content).toContain('must survive cache cleanup');
  expect(computeGitignore(updated.content)).toEqual({
    content: updated.content,
    outcome: 'unchanged',
  });
});
test('Git ignores only named snapshot custody directories at every plan depth and keeps authority and source plans trackable', () => {
  const root = repo(renderManagedBlock());
  const custody = [
    '.caws-plan-snapshot-custody/v1/publication.lock',
    '.caws/plans/.caws-plan-snapshot-custody/v1/owner.json',
    'docs/plans/nested/.caws-plan-snapshot-custody/v1/publication.lock',
  ];
  const source = [
    '.caws/specs/S.yaml',
    '.caws/policy.yaml',
    '.caws/waivers/W.yaml',
    '.caws/plans/source-plan.md',
    'docs/plans/nested/source-plan.yaml',
    'docs/plans/nested/.caws-plan-snapshot-custody-source/v1/owner.json',
  ];
  for (const name of [...custody, ...source]) {
    fs.mkdirSync(path.dirname(path.join(root, name)), { recursive: true });
    fs.writeFileSync(path.join(root, name), 'owned fixture\n');
  }
  // A single real Git query must return exactly the custody paths, with the
  // precise managed rule as their cause; a broad plans/ rule fails this oracle.
  const matches = git(root, [
    'check-ignore',
    '--no-index',
    '--verbose',
    '--',
    ...custody,
    ...source,
  ])
    .split('\n')
    .map((line) => line.split('\t'));
  expect(matches.map((match) => match[1])).toEqual(custody);
  for (const match of matches) {
    expect(match[0]).toMatch(/^\.gitignore:\d+:\*\*\/\.caws-plan-snapshot-custody\/$/);
  }
  // Successful normal staging proves source/authority trackability rather
  // than inferring it solely from their absence in check-ignore output.
  git(root, ['add', '--', ...source]);
  expect(git(root, ['ls-files', '--', ...source]).split('\n')).toEqual([...source].sort());
});
test('equivalent rules without managed markers protect all probes without a false missing-coverage warning', () => {
  const root = repo();
  const before = fs.readFileSync(path.join(root, '.gitignore'), 'utf8');
  const findings = observe(root);
  expect(findings.map((f) => f.rule)).toEqual(['shell.gitignore.managed_block_drift']);
  expect(findings[0].data.observations.map((r) => r.path).sort()).toEqual(
    [...localRuntimeProbes, ...custodyProbes].sort()
  );
  expect(findings[0].data.observations.every((r) => r.ignored && r.repository_rule)).toBe(true);
  expect(fs.readFileSync(path.join(root, '.gitignore'), 'utf8')).toBe(before);
});
test('root-only snapshot custody coverage cannot satisfy nested publication custody', () => {
  const root = repo(
    EPHEMERAL_CAWS_ENTRIES.filter((entry) => entry !== '**/.caws-plan-snapshot-custody/')
      .concat('/.caws-plan-snapshot-custody/')
      .join('\n')
  );
  const uncovered = observe(root).find(
    (f) => f.rule === 'shell.gitignore.ephemeral_state_untracked'
  );
  expect(uncovered.data.uncovered.map((r) => r.path).sort()).toEqual(custodyProbes.slice(1).sort());
  expect(uncovered.data.observations.find((r) => r.path === custodyProbes[0]).ignored).toBe(true);
});
test('nested Git negation exposes custody despite an intact root managed block', () => {
  const root = repo(renderManagedBlock());
  fs.mkdirSync(path.join(root, 'docs/plans'), { recursive: true });
  fs.writeFileSync(
    path.join(root, 'docs/plans/.gitignore'),
    '!.caws-plan-snapshot-custody/\n!.caws-plan-snapshot-custody/**\n'
  );
  const findings = observe(root);
  const uncovered = findings.find((f) => f.rule === 'shell.gitignore.ephemeral_state_untracked');
  expect(uncovered.data.uncovered.map((r) => r.path)).toEqual([custodyProbes[2]]);
  expect(uncovered.data.uncovered[0].source).toBe('docs/plans/.gitignore');
  expect(findings.some((f) => f.rule === 'shell.gitignore.managed_block_drift')).toBe(false);
});
test('existing untracked owner and lock at a non-probed plan location expose their actual nested negation', () => {
  const root = repo(renderManagedBlock());
  const custody = [
    'plans/team/.caws-plan-snapshot-custody/v1/owner.json',
    'plans/team/.caws-plan-snapshot-custody/v1/publication.lock',
  ];
  const source = ['plans/team/p.md', 'plans/team/.caws-plan-snapshot-custody-source/v1/owner.json'];
  for (const name of [...custody, ...source]) {
    fs.mkdirSync(path.dirname(path.join(root, name)), { recursive: true });
    fs.writeFileSync(path.join(root, name), 'owned fixture\n');
  }
  fs.writeFileSync(
    path.join(root, 'plans/team/.gitignore'),
    '!.caws-plan-snapshot-custody/\n!.caws-plan-snapshot-custody/**\n'
  );
  const findings = observe(root);
  expect(findings.map((f) => f.rule)).toEqual(['shell.gitignore.ephemeral_state_untracked']);
  const { uncovered, observations } = findings[0].data;
  expect(uncovered.map((r) => r.path).sort()).toEqual([...custody].sort());
  expect(uncovered.every((r) => r.source === 'plans/team/.gitignore')).toBe(true);
  expect(uncovered.every((r) => r.pattern === '!.caws-plan-snapshot-custody/**')).toBe(true);
  expect(observations.filter((r) => custodyProbes.includes(r.path)).map((r) => r.path)).toEqual(
    custodyProbes
  );
  expect(observations.filter((r) => custodyProbes.includes(r.path)).every((r) => r.ignored)).toBe(
    true
  );
  expect(observations.some((r) => source.includes(r.path))).toBe(false);
  expect(
    git(root, ['ls-files', '--others', '--exclude-standard', '--', ...source]).split('\n')
  ).toEqual([...source].sort());
});
test('protected actual custody at a non-probed location stays clean while adjacent source files remain untracked', () => {
  const root = repo(renderManagedBlock());
  const custody = [
    'plans/team/.caws-plan-snapshot-custody/v1/owner.json',
    'plans/team/.caws-plan-snapshot-custody/v1/publication.lock',
  ];
  const source = ['plans/team/p.md', 'plans/team/.caws-plan-snapshot-custody-source/v1/owner.json'];
  for (const name of [...custody, ...source]) {
    fs.mkdirSync(path.dirname(path.join(root, name)), { recursive: true });
    fs.writeFileSync(path.join(root, name), 'owned fixture\n');
  }
  expect(git(root, ['check-ignore', '--', ...custody]).split('\n')).toEqual(custody);
  expect(
    git(root, ['ls-files', '--others', '--exclude-standard', '--', ...source]).split('\n')
  ).toEqual([...source].sort());
  expect(observe(root)).toEqual([]);
});
test('force-staged snapshot custody is found at arbitrary depth without classifying authority or near misses as runtime', () => {
  const root = repo(renderManagedBlock());
  const custody = [
    '.caws-plan-snapshot-custody/v1/owner.json',
    '.caws/plans/.caws-plan-snapshot-custody/v1/publication.lock',
    'docs/plans/deep/.caws-plan-snapshot-custody/v1/owner.json',
  ];
  const source = [
    '.caws/specs/S.yaml',
    '.caws/policy.yaml',
    '.caws/waivers/W.yaml',
    '.caws/plans/source-plan.md',
    '.caws/plans/.caws-plan-snapshot-custody-source/v1/owner.json',
    'docs/plans/deep/source-plan.yaml',
  ];
  for (const name of [...custody, ...source]) {
    fs.mkdirSync(path.dirname(path.join(root, name)), { recursive: true });
    fs.writeFileSync(path.join(root, name), 'owned fixture\n');
  }
  git(root, ['add', '-f', '--', ...custody, ...source]);
  const findings = observe(root);
  expect(findings.map((f) => f.rule)).toEqual(['shell.gitignore.ephemeral_state_tracked']);
  expect(findings[0].data.tracked_paths.sort()).toEqual([...custody].sort());
});
test('a negation defeats exact managed formatting and already-tracked files stay independently visible', () => {
  const root = repo(renderManagedBlock() + '\n!.caws/events.jsonl');
  fs.writeFileSync(path.join(root, '.caws/agents.json'), '{}');
  git(root, ['add', '-f', '.caws/agents.json']);
  const findings = observe(root);
  expect(
    findings
      .find((f) => f.rule === 'shell.gitignore.ephemeral_state_untracked')
      .data.uncovered.map((r) => r.path)
  ).toEqual(['.caws/events.jsonl']);
  expect(
    findings.find((f) => f.rule === 'shell.gitignore.ephemeral_state_tracked').data.tracked_paths
  ).toEqual(['.caws/agents.json']);
});
test('info/exclude coverage is machine-local and broad caws exclusions expose hidden authority', () => {
  const root = repo('');
  fs.writeFileSync(path.join(root, '.git/info/exclude'), '.caws/\ntmp/\n');
  const findings = observe(root);
  expect(
    findings
      .find((f) => f.rule === 'shell.gitignore.machine_local_coverage')
      .data.observations.map((r) => r.path)
      .sort()
  ).toEqual([...localRuntimeProbes, custodyProbes[1]].sort());
  expect(
    findings
      .find((f) => f.rule === 'shell.gitignore.ephemeral_state_untracked')
      .data.uncovered.map((r) => r.path)
      .sort()
  ).toEqual([custodyProbes[0], custodyProbes[2]].sort());
  expect(
    findings
      .find((f) => f.rule === 'shell.gitignore.authority_ignored')
      .data.observations.map((r) => r.path)
  ).toEqual([
    '.caws/specs/__caws_ignore_probe__.yaml',
    '.caws/policy.yaml',
    '.caws/waivers/__caws_ignore_probe__.yaml',
  ]);
});
