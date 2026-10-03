'use strict';
const fs = require('fs');
const path = require('path');
const { makeTempRepo, cleanupAll, git } = require('../helpers/git-repo-factory');
const { inspectGitignoreCoverage } = require('../../dist/init/gitignore-drift');
const { EPHEMERAL_CAWS_ENTRIES, renderManagedBlock } = require('../../dist/init/gitignore-manage');
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
