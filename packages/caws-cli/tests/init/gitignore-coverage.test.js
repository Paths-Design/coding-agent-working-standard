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
  expect(findings[0].data.observations).toHaveLength(13);
  expect(findings[0].data.observations.every((r) => r.ignored && r.repository_rule)).toBe(true);
  expect(fs.readFileSync(path.join(root, '.gitignore'), 'utf8')).toBe(before);
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
    findings.find((f) => f.rule === 'shell.gitignore.machine_local_coverage').data.observations
  ).toHaveLength(13);
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
