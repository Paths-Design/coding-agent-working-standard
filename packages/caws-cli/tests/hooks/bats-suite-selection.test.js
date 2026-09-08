const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const yaml = require('js-yaml');

const pkgRoot = path.resolve(__dirname, '../..');
const scripts = require('../../package.json').scripts;
const workflow = yaml.load(fs.readFileSync(path.join(pkgRoot, '../../.github/workflows/pr-checks.yml'), 'utf8'));
const bats = require.resolve('bats/bin/bats');

function instrumentCount(script) {
  const selection = script.match(/\bbats (tests\/hooks\/[\w/-]+)/);
  expect(selection).not.toBeNull();
  return Number(execFileSync(bats, [
    '--count', '--filter', '^environment sanity: /bin/bash', selection[1],
  ], { cwd: pkgRoot, encoding: 'utf8' }).trim());
}

test('the general CI suite excludes the platform-specific Bash instrument', () => {
  expect(workflow.jobs.hook_bats.steps.some((step) => step.run === 'npm run test:bats')).toBe(true);
  expect(instrumentCount(scripts['test:bats'])).toBe(0);
});

test('the macOS CI suite still selects the mandatory Bash instrument', () => {
  expect(workflow.jobs.hook_bats_bash32_macos['runs-on']).toBe('macos-latest');
  expect(workflow.jobs.hook_bats_bash32_macos.steps.some((step) => step.run === 'npm run test:bats:macos')).toBe(true);
  expect(typeof scripts['test:bats:macos']).toBe('string');
  expect(instrumentCount(scripts['test:bats:macos'])).toBe(1);
});
