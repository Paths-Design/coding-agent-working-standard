'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const yaml = require('js-yaml');
const root = path.resolve(__dirname, '../../../..');
const readWorkflow = name => yaml.load(fs.readFileSync(path.join(root, '.github/workflows', name), 'utf8'));

test('the tag publish job depends on qualification of the same checkout', () => {
  const release = readWorkflow('release.yml');
  // `needs` became a list when the mutation floor was added as a second
  // blocking gate. Assert qualification is still required rather than pinning
  // the arity, which would fail on any future gate. That the mutation gate is
  // also present is owned by release-path-integrity.test.js.
  expect(release.jobs.release.needs).toContain('qualification');
  expect(release.jobs.qualification.uses).toBe('./.github/workflows/release-qualification.yml');
  const qualification = readWorkflow('release-qualification.yml');
  expect(qualification.on).toHaveProperty('workflow_call');
  expect(qualification.on.push.branches).toContain('main');
  const upgrades = qualification.jobs['package-upgrade'];
  expect(upgrades.strategy.matrix.os).toEqual(['ubuntu-latest', 'macos-latest']);
  expect(upgrades.strategy.matrix.node).toEqual(['18', '20', '22']);
  const runs = upgrades.steps.map(step => step.run).filter(Boolean);
  expect(runs).toContain('node packages/caws-cli/scripts/runtime-upgrade-smoke.mjs --report qualification-report.json');
  expect(qualification.jobs.tests.steps.map(step => step.run)).toContain('npm test -w @paths.design/caws-cli -- --coverage --maxWorkers=2');
});

test('prerelease routing and fixture isolation contracts execute under Node', () => {
  const result = spawnSync(process.execPath, ['--test', 'scripts/release-tag-publish.test.mjs', 'scripts/ci-governance-artifacts.test.mjs'], { cwd: root, encoding: 'utf8' });
  expect({ status: result.status, stderr: result.stderr }).toEqual({ status: 0, stderr: '' });
  expect(result.stdout).toContain('# fail 0');
});
