import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { validateArtifacts } from './ci-governance-artifacts.mjs';

test('CI validates portable artifacts without inventing local worktree state', () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'caws-ci-artifacts-')));
  const env = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' };
  for (const key of Object.keys(env)) if (key.startsWith('GIT_') && !['GIT_CONFIG_GLOBAL', 'GIT_CONFIG_SYSTEM'].includes(key)) delete env[key];
  const git = (...args) => execFileSync('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'commit.gpgsign=false', ...args], { cwd: root, env, encoding: 'utf8' }).trim();
  const write = (name, value) => { const file = path.join(root, '.caws', name); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify(value)); return file; };
  try {
    git('init', '-q', '-b', 'main'); git('commit', '--allow-empty', '-qm', 'baseline');
    const base = git('rev-parse', 'HEAD');
    const spec = { id: 'CI-FIXTURE-001', title: 'Portable fixture', risk_tier: 3, mode: 'chore', lifecycle_state: 'active', worktree: 'local-only',
      created_at: '2026-09-08T00:00:00Z', updated_at: '2026-09-08T00:00:00Z', blast_radius: { modules: ['ci'], data_migration: false }, operational_rollback_slo: '5m',
      scope: { in: ['src'], out: [] }, invariants: ['Preserve source'], acceptance: [{ id: 'A1', given: 'source', when: 'validated', then: 'checked' }], non_functional: {}, contracts: [] };
    const specFile = write('specs/CI-FIXTURE-001.yaml', spec);
    const waiver = { id: 'CI-VALID-WAIVER-001', title: 'Fixture waiver', status: 'active', gates: ['budget_limit'], reason: 'Fixture', approved_by: 'fixture',
      created_at: '2026-09-08T00:00:00Z', expires_at: '2026-09-09T00:00:00Z', scope: {} };
    const waiverFile = write('waivers/CI-VALID-WAIVER-001.yaml', waiver);
    git('add', '.'); git('commit', '-qm', 'candidate');
    const head = git('rev-parse', 'HEAD');
    const before = fs.readFileSync(specFile, 'utf8');
    assert.equal(validateArtifacts(root, base, head).ok, true);
    assert.equal(fs.existsSync(path.join(root, '.caws/worktrees.json')), false);
    assert.equal(fs.existsSync(path.join(root, '.caws/events.jsonl')), false);
    assert.equal(fs.readFileSync(specFile, 'utf8'), before);
    fs.writeFileSync(specFile, JSON.stringify({ ...spec, risk_tier: 99 }));
    assert.equal(validateArtifacts(root, base, head).ok, false, 'invalid spec must block');
    fs.writeFileSync(specFile, before);
    const duplicate = write('specs/duplicate.yaml', spec);
    assert.equal(validateArtifacts(root, base, head).ok, false, 'duplicate IDs outside the changed-file list must block');
    fs.unlinkSync(duplicate);
    fs.writeFileSync(waiverFile, JSON.stringify({ ...waiver, approved_by: 42 }));
    assert.equal(validateArtifacts(root, base, head).ok, false, 'invalid waiver must block');
    fs.writeFileSync(waiverFile, JSON.stringify(waiver));
    fs.unlinkSync(specFile); fs.symlinkSync('/etc/hosts', specFile);
    assert.throws(() => validateArtifacts(root, base, head), /escapes checkout/);
    assert.throws(() => validateArtifacts(root, 'missing-ref', head), /Cannot determine changed specs/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
