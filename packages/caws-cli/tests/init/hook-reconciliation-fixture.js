'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');
const { makeTempRepo, cleanupAll } = require('../helpers/git-repo-factory');
const runtime = require('../../dist/init/machine-adapters');
const { digest } = require('../../dist/init/hook-reconciliation');
const POLICY = '.caws/hooks/hook-policy.json';
const homes = [];
function setup() {
  const root = fs.realpathSync(makeTempRepo());
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'caws-reconcile-home-')));
  homes.push(home);
  runtime.installMachineRuntime({ home });
  fs.mkdirSync(path.join(root, '.caws/specs'), { recursive: true });
  fs.writeFileSync(path.join(root, '.caws/policy.yaml'), 'version: 1\n');
  for (const surface of ['codex', 'claude-code']) {
    const settingsDir = path.join(home, 'surfaces', surface);
    fs.mkdirSync(settingsDir, { recursive: true });
    fs.writeFileSync(
      path.join(settingsDir, 'settings.json'),
      JSON.stringify({ version: 1, enabled: true })
    );
  }
  const dir = path.join(root, '.caws/hooks/ext');
  fs.mkdirSync(dir, { recursive: true });
  for (const name of ['block-dangerous', 'marker', 'other']) {
    fs.writeFileSync(path.join(dir, name + '.sh'), '#!/bin/bash\nexit 0\n', { mode: 0o755 });
  }
  fs.writeFileSync(path.join(dir, 'helper.py'), 'VALUE = 1\n');
  const surface = {
    disabled: {},
    extensions: {
      pre_tool_use: [
        { handler: 'marker.sh', before: 'scope-guard.sh' },
        { handler: 'other.sh', before: 'scope-guard.sh' },
      ],
    },
    handlers: {
      'block-dangerous.sh': '.caws/hooks/ext/block-dangerous.sh',
      'marker.sh': '.caws/hooks/ext/marker.sh',
      'other.sh': '.caws/hooks/ext/other.sh',
    },
    libraries: { 'helper.py': '.caws/hooks/ext/helper.py' },
  };
  const file = path.join(home, 'state/projects', digest(root) + '.json');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(
    file,
    JSON.stringify(
      { version: 1, root, surfaces: { codex: surface, 'claude-code': surface } },
      null,
      2
    ) + '\n'
  );
  return { root, home, file };
}
function describe(root, home, surface) {
  const launcher = path.join(home, 'bin/caws-hook');
  return JSON.parse(
    execFileSync('python3', [launcher, surface, 'pre_tool_use', '--describe'], {
      cwd: root,
      env: { ...process.env, CAWS_HOME: home, CAWS_PROJECT_DIR: root },
      encoding: 'utf8',
    })
  );
}
module.exports = {
  setup,
  describeSelection: describe,
  POLICY,
  cleanup: () => {
    cleanupAll();
    for (const home of homes) fs.rmSync(home, { recursive: true, force: true });
  },
};
