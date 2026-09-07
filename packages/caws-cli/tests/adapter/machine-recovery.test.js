'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { installMachineRuntime, verifyRuntime } = require('../../dist/init/machine-adapters');
test('machine recovery targets canonical project state and never writes into its snapshot', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'caws-machine-recovery-'));
  try {
    const home = path.join(root, 'machine');
    const repo = path.join(root, 'project');
    fs.mkdirSync(repo);
    expect(spawnSync('git', ['init', '-q'], { cwd: repo }).status).toBe(0);
    const installed = installMachineRuntime({ home });
    const runtime = path.join(home, 'lib/runtimes', installed.digest);
    const latch = path.join(repo, '.claude/hooks/state/danger-latch-fixture.json');
    fs.mkdirSync(path.dirname(latch), { recursive: true });
    fs.writeFileSync(latch, JSON.stringify({ reason: 'fixture control' }));
    const invoke = (project) => spawnSync('bash', [path.join(runtime, 'reset-danger-latch.sh'), '--session', 'fixture', '--reason', 'fixture recovery'], {
      cwd: root, encoding: 'utf8', env: { ...process.env, CAWS_HOME: home, CAWS_MACHINE_RUNTIME: '1', CAWS_PROJECT_DIR: project, CAWS_AGENT_SURFACE: 'claude-code' },
    });
    const missing = invoke('.');
    expect(missing.status).toBe(2);
    expect(fs.existsSync(latch)).toBe(true);
    const result = invoke(repo);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('Reset 1 danger latch(es)');
    expect(fs.existsSync(latch)).toBe(false);
    const audit = fs.readFileSync(path.join(repo, '.claude/logs/danger-latch-resets.log'), 'utf8').trim();
    expect(JSON.parse(audit).reason).toBe('fixture recovery');
    expect(fs.existsSync(path.join(home, 'lib/.claude'))).toBe(false);
    expect(verifyRuntime(home, installed.digest)['reset-danger-latch.sh']).toMatch(/^[a-f0-9]{64}$/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
