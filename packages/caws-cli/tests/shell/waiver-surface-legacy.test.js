'use strict';

/**
 * CAWS-DEFECT-WAIVER-SURFACE-UNCONSULTED-01 — full CLI parse path.
 *
 * The waiver surface survived the pre-v11 cutover: no hook consults waivers
 * (hooks consult reprieves; the sole waiver consumer is the on-demand
 * `caws gates run` filter), yet the surface's claims let a real operator
 * create a waiver expecting a hook guard to lift (UPST-0001, revoked
 * "apparently waivers do nothing"). This suite pins the delineated surface:
 * the group/leaf help states the gate-run-only boundary, and a successful
 * create prints a byte-stable notice naming `caws reprieve grant` as the
 * hook-block path.
 */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const { initProject } = require('../../dist/store/init-store');
const { cleanupAll, makeTempRepo } = require('../helpers/git-repo-factory');

const CLI = path.resolve(__dirname, '..', '..', 'dist', 'index.js');

afterAll(() => {
  cleanupAll();
});

const POLICY = `version: 1
risk_tiers:
  "3":
    max_files: 500
    max_loc: 40000
    description: Low Risk
edit_rules:
  policy_and_code_same_pr: false
  require_signed_commits: false
gates:
  scope_boundary:
    enabled: true
    mode: block
`;

function mkRepo(withGate) {
  const root = makeTempRepo();
  const initialized = initProject(root);
  if (!initialized.ok) throw new Error('initProject failed: ' + JSON.stringify(initialized.errors));
  if (withGate) {
    fs.writeFileSync(path.join(root, '.caws', 'policy.yaml'), POLICY);
  }
  return root;
}

function spawnCli(root, args) {
  return spawnSync(process.execPath, [CLI, ...args], {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, CLAUDE_CODE_SESSION_ID: 'waiver-surface-test' },
  });
}

const NOTICE =
  /\(note: waivers suppress matching violations in `caws gates run` ONLY — they never lift a hook guard; for a hook block use `caws reprieve grant/;

test('A1: a successful waiver create prints the byte-stable gate-run-only notice', () => {
  const root = mkRepo(true);
  const r = spawnCli(root, [
    'waiver', 'create', 'WV-1',
    '--gate', 'scope_boundary',
    '--spec', 'SPEC-X',
    '--title', 'test waiver',
    '--reason', 'because',
    '--approved-by', 'reviewer',
    '--expires-at', '2026-12-31T00:00:00.000Z',
  ]);
  expect(r.status).toBe(0);
  expect(r.stdout).toMatch(NOTICE);
  expect(fs.existsSync(path.join(root, '.caws', 'waivers', 'WV-1.yaml'))).toBe(true);
});

test('A2: waiver group and leaf help state the gate-run-only boundary and name reprieves', () => {
  const root = mkRepo(false);
  const group = spawnCli(root, ['waiver', '--help']);
  const create = spawnCli(root, ['waiver', 'create', '--help']);
  expect(group.status).toBe(0);
  expect(create.status).toBe(0);
  for (const text of [group.stdout, create.stdout]) {
    expect(text).toMatch(/gates run/);
    expect(text).toMatch(/reprieve/);
    expect(text).toMatch(/never lifts a hook guard/i);
  }
});

test('A3: applicability is unchanged when policy declares no gates (accepts as before; notice appears regardless)', () => {
  const root = mkRepo(false);
  const r = spawnCli(root, [
    'waiver', 'create', 'WV-2',
    '--gate', 'scope_boundary',
    '--spec', 'SPEC-X',
    '--title', 'test waiver',
    '--reason', 'because',
    '--approved-by', 'reviewer',
    '--expires-at', '2026-12-31T00:00:00.000Z',
  ]);
  // Pre-slice behavior: the kernel validates shape and duplicate state only;
  // gate applicability is derived at gates-run time, so create ACCEPTS.
  expect(r.status).toBe(0);
  expect(fs.existsSync(path.join(root, '.caws', 'waivers', 'WV-2.yaml'))).toBe(true);
  // The boundary notice appears regardless of the gate list contents.
  expect(r.stdout).toMatch(NOTICE);
});
