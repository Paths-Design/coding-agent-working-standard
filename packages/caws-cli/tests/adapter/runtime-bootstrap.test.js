'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const lib = path.resolve(__dirname, '../../templates/hook-packs/shared/lib');

describe('shared bootstrap preserves context independently of registry source order', () => {
  let root;
  beforeEach(() => {
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "caws bootstrap ' ")));
  });
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  const cases = [false, true].flatMap((registryFirst) =>
    [false, true].flatMap((strict) =>
      [false, true].map((gitProject) => ({ registryFirst, strict, gitProject }))
    )
  );

  test.each(cases)('%j resolves root, surface, and CLI execution context', (scenario) => {
    const project = path.join(root, 'project');
    const hint = path.join(project, 'packages', 'nested');
    fs.mkdirSync(hint, { recursive: true });
    if (scenario.gitProject) {
      expect(spawnSync('git', ['init', '-q'], { cwd: project }).status).toBe(0);
    }
    const cli = path.join(root, 'fixture-cli');
    fs.writeFileSync(cli, '#!/bin/bash\npwd -P\n', { mode: 0o755 });
    const surface = path.join(lib, 'agent-surface.sh');
    const registry = path.join(lib, 'surfaces-registry.sh');
    const files = scenario.registryFirst ? [registry, surface] : [surface, registry];
    const result = spawnSync('/bin/bash', [
      '--noprofile', '--norc',
      '-c',
      `${scenario.strict ? 'set -euo pipefail;' : ''}
       source "$1"
       source "$2"
       source "$3"
       printf 'root=%s\nvendor=%s\nsurface=%s\n' "\${CAWS_PROJECT_DIR:-MISSING}" "\${CAWS_VENDOR_DIR:-MISSING}" "\${CAWS_PLATFORM_FLAG:-MISSING}"
       caws_run_cli`,
      'bootstrap-fixture', ...files, surface,
    ], {
      cwd: root,
      encoding: 'utf8',
      // Use the OS tools rather than user shell wrappers or startup files.
      env: { PATH: '/usr/bin:/bin', CAWS_AGENT_SURFACE: 'codex', CODEX_PROJECT_DIR: hint, CAWS_BIN: cli },
    });
    const expectedRoot = scenario.gitProject ? project : hint;
    expect({ status: result.status, stderr: result.stderr }).toEqual({ status: 0, stderr: '' });
    expect(result.stdout).toBe(`root=${expectedRoot}\nvendor=.codex\nsurface=codex\n${expectedRoot}\n`);
  });
});
