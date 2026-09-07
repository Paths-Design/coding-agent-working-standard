'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const CLI = path.resolve(__dirname, '../../dist/index.js');
let root;
beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'caws-init-help-')); });
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));
function cli(args) {
  return spawnSync(process.execPath, [CLI, 'init', ...args], {
    cwd: root, encoding: 'utf8', env: { ...process.env, CAWS_HOME: path.join(root, 'machine') },
  });
}
test.each([
  ['adapters install', '--plan', '--agent-surface'],
  ['adapters configure', '--native-config-target', '--projects-root'],
  ['adapters migrate', '--projects-root', '--native-config-target'],
  ['adapters rollback', '--plan', '--from'],
  ['adapters adopt', '--from', '--projects-root'],
  ['migrate apply', '--from', '--plan'],
  ['diff', '--three-way', '--force'],
  ['port', '--from', '--projects-root'],
])('%s exposes only its operation options', (command, present, absent) => {
  const result = cli([...command.split(' '), '--help']);
  expect(result.status).toBe(0);
  expect(result.stdout).toContain(`Usage: caws init ${command}`);
  expect(result.stdout).toContain(present);
  expect(result.stdout).not.toContain(absent);
  expect(fs.readdirSync(root)).toEqual([]);
});
test.each([
  ['adapters', 'install', '--from', 'wrong.json'],
  ['--agent-surface', 'codex', 'adapters', 'install'],
  ['--plan', 'migrate', 'apply', '--from', 'wrong.json'],
  ['adapters', 'rollback', '--projects-root', '/unused-projects'],
  ['adapters', 'unknown'],
])('incompatible invocation %j cannot create machine or project state', (...args) => {
  const result = cli(args.filter(value => value !== undefined));
  expect(result.status).not.toBe(0);
  expect(fs.readdirSync(root)).toEqual([]);
});
test('install preview works outside a repository and --dry-run preserves its read-only meaning', () => {
  const plan = cli(['adapters', 'install', '--plan', '--json']);
  const alias = cli(['adapters', 'install', '--dry-run', '--json']);
  expect(plan.status).toBe(0);
  expect(alias.status).toBe(0);
  expect(JSON.parse(plan.stdout)).toEqual(JSON.parse(alias.stdout));
  expect(JSON.parse(plan.stdout).digest).toMatch(/^[a-f0-9]{64}$/);
  expect(fs.readdirSync(root)).toEqual([]);
});
