const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { initProject, loadEvents, loadSpecs, loadPolicy } = require('../../dist/store');
const { parseAndValidateSpec } = require('../../dist/kernel');
const { evaluateBudgetLimit } = require('../../dist/shell/gates/local-evaluators/budget-limit');
const { cleanupAll, makeTempRepo } = require('../helpers/git-repo-factory');
const CLI = path.resolve(__dirname, '../../dist/index.js');
afterAll(cleanupAll);
function setup() {
  const root = makeTempRepo();
  expect(initProject(root).ok).toBe(true);
  return root;
}
function cli(root, args) {
  return spawnSync(process.execPath, [CLI, ...args], {
    cwd: root,
    encoding: 'utf8',
    env: {
      ...process.env,
      CAWS_HOME: path.join(root, 'machine'),
      CLAUDE_CODE_SESSION_ID: 'tierless-fixture',
    },
  });
}
const args = [
  'specs',
  'create',
  'TIERLESS-001',
  '--title',
  'No classification step',
  '--mode',
  'feature',
  '--scope-in',
  'src',
  '--module',
  'src',
  '--invariant',
  'Scope remains enforced',
  '--acceptance',
  'given: a request; when: create runs; then: no tier is assigned',
];

test('built CLI creates and activates a tierless spec and verifies its tierless event chain', () => {
  const root = setup();
  const preview = cli(root, [...args, '--plan', '--json']);
  expect(preview.status).toBe(0);
  const plan = JSON.parse(preview.stdout);
  expect(plan.valid).toBe(true);
  expect(plan.candidate).not.toHaveProperty('risk_tier');
  expect(plan.command).not.toMatch(/--(?:risk-tier|tier)/);
  expect(fs.existsSync(path.join(root, '.caws/events.jsonl'))).toBe(false);
  const result = cli(root, args);
  expect(result.status).toBe(0);
  const cawsDir = path.join(root, '.caws');
  const bytes = fs.readFileSync(path.join(cawsDir, 'specs/TIERLESS-001.yaml'), 'utf8');
  expect(bytes).not.toContain('risk_tier');
  const spec = parseAndValidateSpec(bytes);
  expect(spec.ok).toBe(true);
  expect(spec.value.contracts).toEqual([]);
  const events = loadEvents(cawsDir);
  expect(events.ok).toBe(true);
  const created = events.value.events.find((e) => e.event === 'spec_created');
  expect(created.data).toEqual({
    title: 'No classification step',
    mode: 'feature',
    lifecycle_state: 'draft',
  });
  expect(cli(root, ['specs', 'activate', 'TIERLESS-001']).status).toBe(0);
  expect(loadSpecs(cawsDir).specs.find((s) => s.id === 'TIERLESS-001').lifecycle_state).toBe(
    'active'
  );
  expect(loadEvents(cawsDir).ok).toBe(true);
});

test.each(['--risk-tier', '--tier'])('retired %s flag is rejected before any write', (flag) => {
  const root = setup();
  const result = cli(root, [...args, flag, '3']);
  expect(result.status).not.toBe(0);
  expect(result.stderr).toContain(`unknown option '${flag}'`);
  expect(fs.existsSync(path.join(root, '.caws/specs/TIERLESS-001.yaml'))).toBe(false);
  expect(fs.existsSync(path.join(root, '.caws/events.jsonl'))).toBe(false);
});

test('help and current generated reference do not offer tier selection', () => {
  const root = setup();
  const help = cli(root, ['specs', 'create', '--help']);
  expect(help.status).toBe(0);
  expect(help.stdout).not.toMatch(/--(?:risk-tier|tier)|Tier [123]|tier [123]/);
  expect(help.stdout).toContain('--contract');
  expect(help.stdout).toContain('--security');
  const reference = fs.readFileSync(
    path.resolve(__dirname, '../../docs/command-reference.md'),
    'utf8'
  );
  expect(reference).not.toMatch(/--risk-tier|--tier <n>/);
});

test('tierless validation and sizing never assign a hidden legacy tier', () => {
  const root = setup();
  expect(cli(root, args).status).toBe(0);
  const bytes = fs.readFileSync(path.join(root, '.caws/specs/TIERLESS-001.yaml'), 'utf8');
  const experimental =
    bytes +
    '\nexperimental_mode:\n  enabled: true\n  rationale: bounded experiment\n  expires_at: "2099-01-01T00:00:00Z"\n';
  expect(parseAndValidateSpec(experimental).ok).toBe(true);
  const tierless = parseAndValidateSpec(bytes);
  expect(tierless.ok).toBe(true);
  const loaded = loadPolicy(path.join(root, '.caws'));
  expect(loaded.errors).toEqual([]);
  expect(loaded.policy.risk_tiers['3'].max_files).toBeGreaterThan(0);
  const result = evaluateBudgetLimit({
    spec: tierless.value,
    policy: loaded.policy,
    repoRoot: root,
    stagedChanges: [{ path: 'src/a.js', insertions: 1000, deletions: 0 }],
  });
  expect(result.violations).toEqual([]);
  expect(result.observed).toEqual({
    files_changed: 1,
    loc_changed: 1000,
    max_files: null,
    max_loc: null,
  });
  expect(parseAndValidateSpec(bytes + '\nrisk_tier: 3\n').ok).toBe(true);
  expect(parseAndValidateSpec(bytes + '\nrisk_tier: 2\n').ok).toBe(false);
  expect(parseAndValidateSpec(bytes + '\nrisk_tier: invalid\n').ok).toBe(false);
  expect(parseAndValidateSpec(bytes.replace('mode: feature', 'mode: development')).ok).toBe(false);
});
