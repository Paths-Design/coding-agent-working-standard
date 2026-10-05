'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const { runGatesExplainCommand, runGatesListCommand } = require('../../dist/shell');
const { initProject } = require('../../dist/store/init-store');

const repos = [];
const NOW = new Date('2026-07-04T12:00:00.000Z');

afterAll(() => {
  for (const r of repos) {
    try {
      fs.rmSync(r, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
});

function mkRepo(prefix) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  execFileSync('git', ['init', '--quiet', '-b', 'main', root]);
  execFileSync('git', ['-C', root, 'config', 'user.email', 't@test.com']);
  execFileSync('git', ['-C', root, 'config', 'user.name', 'Test']);
  execFileSync('git', ['-C', root, 'commit', '--quiet', '--allow-empty', '-m', 'init']);
  repos.push(root);
  return root;
}

function setupCaws(repoRoot) {
  const r = initProject(repoRoot);
  if (!r.ok) throw new Error('initProject failed: ' + JSON.stringify(r.errors));
  return path.join(repoRoot, '.caws');
}

function readEvents(cawsDir) {
  const p = path.join(cawsDir, 'events.jsonl');
  return fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : null;
}

function writeWaiver(cawsDir, id, specId) {
  const waiversDir = path.join(cawsDir, 'waivers');
  fs.mkdirSync(waiversDir, { recursive: true });
  fs.writeFileSync(
    path.join(waiversDir, `${id}.yaml`),
    [
      `id: ${id}`,
      `title: Budget waiver`,
      `status: active`,
      `gates:`,
      `  - budget_limit`,
      `reason: Testing gate discovery`,
      `approved_by: reviewer@example.com`,
      `created_at: '2026-07-04T00:00:00.000Z'`,
      `expires_at: '2026-07-05T00:00:00.000Z'`,
      `scope:`,
      `  spec_id: ${specId}`,
      ``,
    ].join('\n')
  );
}

function tunePolicy(cawsDir) {
  const policyPath = path.join(cawsDir, 'policy.yaml');
  let raw = fs.readFileSync(policyPath, 'utf8');
  raw = raw.replace(
    / {2}god_object:\n {4}enabled: true\n {4}mode: warn\n/,
    [
      `  god_object:`,
      `    enabled: true`,
      `    mode: warn`,
      `    thresholds:`,
      `      warning: 1750`,
      `      critical: 2000`,
      ``,
    ].join('\n')
  );
  raw += [`waivers:`, `  max_active_waivers_per_gate: 2`, ``].join('\n');
  fs.writeFileSync(policyPath, raw);
}

function fixtureRepo() {
  const repoRoot = mkRepo('caws-gates-policy-discovery-');
  const caws = setupCaws(repoRoot);
  tunePolicy(caws);
  writeWaiver(caws, 'BUDGET-001', 'FEAT-001');
  return { repoRoot, caws };
}

function runList(repoRoot, opts = {}) {
  const out = [];
  const err = [];
  const code = runGatesListCommand({
    cwd: repoRoot,
    now: () => NOW,
    out: (line) => out.push(line),
    err: (line) => err.push(line),
    ...opts,
  });
  return { code, out: out.join('\n'), err: err.join('\n') };
}

function runExplain(repoRoot, gateId, opts = {}) {
  const out = [];
  const err = [];
  const code = runGatesExplainCommand({
    cwd: repoRoot,
    gateId,
    now: () => NOW,
    out: (line) => out.push(line),
    err: (line) => err.push(line),
    ...opts,
  });
  return { code, out: out.join('\n'), err: err.join('\n') };
}

describe('caws gates list/explain discovery', () => {
  test('list reports policy gates, budgets, thresholds, and effective waivers without mutating events', () => {
    const { repoRoot, caws } = fixtureRepo();
    const before = readEvents(caws);

    const result = runList(repoRoot, { specId: 'FEAT-001', json: true });

    expect(result.code).toBe(0);
    expect(result.err).toBe('');
    const payload = JSON.parse(result.out);
    expect(payload.read_only).toBe(true);
    expect(payload.spec_id).toBe('FEAT-001');
    expect(payload.gate_count).toBe(5);
    const budget = payload.gates.find((gate) => gate.gate_id === 'budget_limit');
    const godObject = payload.gates.find((gate) => gate.gate_id === 'god_object');
    // A fresh init declares the budget warn: honored as written, flagged advisory.
    expect(budget.mode).toBe('warn');
    expect(budget.advisory).toBe(true);
    expect(budget).not.toHaveProperty('declared_mode');
    expect(budget.enabled).toBe(true);
    expect(budget.effective_waiver_ids).toEqual(['BUDGET-001']);
    expect(godObject.mode).toBe('warn');
    expect(godObject.advisory).toBe(false);
    expect(godObject.thresholds).toEqual({ warning: 1750, critical: 2000 });
    expect(payload.risk_tiers['3'].max_files).toBe(30);
    expect(payload.waiver_policy).toEqual({ max_active_waivers_per_gate: 2 });
    expect(readEvents(caws)).toBe(before);
  });

  test('explain applies spec-scoped waiver matching and reports one gate', () => {
    const { repoRoot, caws } = fixtureRepo();
    const before = readEvents(caws);

    const matching = runExplain(repoRoot, 'budget_limit', {
      specId: 'FEAT-001',
      json: true,
    });
    const nonMatching = runExplain(repoRoot, 'budget_limit', {
      specId: 'OTHER-001',
      json: true,
    });

    expect(matching.code).toBe(0);
    expect(nonMatching.code).toBe(0);
    expect(JSON.parse(matching.out).gate.effective_waiver_ids).toEqual(['BUDGET-001']);
    expect(JSON.parse(nonMatching.out).gate.effective_waiver_ids).toEqual([]);
    expect(readEvents(caws)).toBe(before);
  });

  // A read surface must report the mode `gates run` applies. A policy that
  // still declares the budget `block` would otherwise read as an enforced
  // limit an agent has to trim work to meet.
  test('a budget declared block reads back as warn, with the declaration marked not honored', () => {
    const { repoRoot } = fixtureRepo();
    const policyPath = path.join(repoRoot, '.caws', 'policy.yaml');
    const raw = fs.readFileSync(policyPath, 'utf8');
    const declaredBlock = raw.replace(
      / {2}budget_limit:\n {4}enabled: true\n {4}mode: warn\n/,
      '  budget_limit:\n    enabled: true\n    mode: block\n'
    );
    expect(declaredBlock).not.toBe(raw);
    fs.writeFileSync(policyPath, declaredBlock);

    const listed = JSON.parse(runList(repoRoot, { json: true }).out);
    const budget = listed.gates.find((gate) => gate.gate_id === 'budget_limit');
    const scope = listed.gates.find((gate) => gate.gate_id === 'scope_boundary');
    expect([budget.mode, budget.declared_mode, budget.advisory]).toEqual(['warn', 'block', true]);
    expect(scope.mode).toBe('block');
    expect(scope).not.toHaveProperty('declared_mode');

    const listText = runList(repoRoot).out;
    expect(listText).toContain(
      '  - budget_limit: enabled=true mode=warn (policy declares block; not honored) advisory effective_waivers=0'
    );
    expect(listText).toContain('  - scope_boundary: enabled=true mode=block effective_waivers=0');

    const explained = runExplain(repoRoot, 'budget_limit');
    expect(explained.code).toBe(0);
    expect(explained.out.split('\n')).toEqual(
      expect.arrayContaining([
        '  mode=warn (policy declares block; not honored)',
        '  advisory: a risk-tier sizing goal; an overage is reported and never blocks',
      ])
    );
    expect(explained.out).not.toContain('mode=block');
  });

  test('unknown gate ids fail with the accepted gate set before mutation', () => {
    const { repoRoot, caws } = fixtureRepo();
    const before = readEvents(caws);

    const result = runExplain(repoRoot, 'not_a_gate');

    expect(result.code).toBe(1);
    expect(result.out).toBe('');
    expect(result.err).toContain('unknown gate');
    expect(result.err).toContain('budget_limit');
    expect(result.err).toContain('scope_boundary');
    expect(readEvents(caws)).toBe(before);
  });
});
