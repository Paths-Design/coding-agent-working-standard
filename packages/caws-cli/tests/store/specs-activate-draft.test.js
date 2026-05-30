// CAWS-SPECS-ACTIVATE-DRAFT-001 — store-level activation tests.

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const { activateSpec, createSpec } = require('../../dist/store/specs-writer');
const { initProject } = require('../../dist/store');

const ACTOR = { id: 'activate-test-actor', kind: 'human' };
const NOW = () => new Date('2026-05-29T09:30:00.000Z');

function mkCawsGitRepo(prefix) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  execFileSync('git', ['init', '--quiet', '-b', 'main', root]);
  execFileSync('git', ['-C', root, 'config', 'user.email', 'test@test.com']);
  execFileSync('git', ['-C', root, 'config', 'user.name', 'Test User']);
  execFileSync('git', ['-C', root, 'commit', '--quiet', '--allow-empty', '-m', 'init']);
  const result = initProject(root);
  if (!result.ok) throw new Error('initProject failed in fixture');
  execFileSync('git', ['-C', root, 'add', '.caws/']);
  execFileSync('git', ['-C', root, 'commit', '--quiet', '-m', 'chore: bootstrap caws']);
  return { root, cawsDir: path.join(root, '.caws') };
}

function rmrf(p) {
  if (p && fs.existsSync(p)) fs.rmSync(p, { recursive: true, force: true });
}

function seedSpec(fixture, id, initialState = 'draft', riskTier = 3, contracts = []) {
  const result = createSpec(fixture.cawsDir, {
    id,
    title: id,
    mode: 'chore',
    riskTier,
    initialState,
    now: NOW,
    actor: ACTOR,
  });
  expect(result.ok).toBe(true);
  if (contracts.length > 0) {
    const specPath = path.join(fixture.cawsDir, 'specs', `${id}.yaml`);
    let body = fs.readFileSync(specPath, 'utf8');
    body = body.replace('contracts: []', [
      'contracts:',
      ...contracts.flatMap((c) => [
        `  - name: ${c.name}`,
        `    type: ${c.type}`,
      ]),
    ].join('\n'));
    fs.writeFileSync(specPath, body);
  }
  execFileSync('git', ['-C', fixture.root, 'add', '.caws/']);
  execFileSync('git', ['-C', fixture.root, 'commit', '--quiet', '-m', `seed ${id}`]);
}

function eventsFor(cawsDir, specId) {
  const log = path.join(cawsDir, 'events.jsonl');
  if (!fs.existsSync(log)) return [];
  return fs.readFileSync(log, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line))
    .filter((e) => e.spec_id === specId);
}

describe('activateSpec', () => {
  let fixture;
  afterEach(() => rmrf(fixture?.root));

  it('activates a draft, preserves body, refreshes updated_at, and appends spec_activated', () => {
    fixture = mkCawsGitRepo('activate-store-a1-');
    seedSpec(fixture, 'ACTIVATE-001', 'draft');
    const specPath = path.join(fixture.cawsDir, 'specs/ACTIVATE-001.yaml');

    const result = activateSpec(fixture.cawsDir, {
      id: 'ACTIVATE-001',
      now: NOW,
      actor: ACTOR,
    });

    expect(result.ok).toBe(true);
    const body = fs.readFileSync(specPath, 'utf8');
    expect(body).toMatch(/^lifecycle_state: active$/m);
    expect(body).toMatch(/^updated_at: '2026-05-29T09:30:00.000Z'$/m);
    expect(body).toContain("title: 'ACTIVATE-001'");
    expect(body).toContain('scope:');

    const activated = eventsFor(fixture.cawsDir, 'ACTIVATE-001')
      .filter((e) => e.event === 'spec_activated');
    expect(activated).toHaveLength(1);
    expect(activated[0].data).toEqual({
      previous_lifecycle_state: 'draft',
      lifecycle_state: 'active',
    });
    expect(activated[0].event_hash).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it('refuses an active spec without mutation', () => {
    fixture = mkCawsGitRepo('activate-store-a2-');
    seedSpec(fixture, 'ACTIVE-001', 'active');
    const specPath = path.join(fixture.cawsDir, 'specs/ACTIVE-001.yaml');
    const before = fs.readFileSync(specPath, 'utf8');

    const result = activateSpec(fixture.cawsDir, {
      id: 'ACTIVE-001',
      now: NOW,
      actor: ACTOR,
    });

    expect(result.ok).toBe(false);
    expect(result.errors[0].message).toMatch(/lifecycle_state "active"/);
    expect(fs.readFileSync(specPath, 'utf8')).toBe(before);
    expect(eventsFor(fixture.cawsDir, 'ACTIVE-001').filter((e) => e.event === 'spec_activated')).toHaveLength(0);
  });

  it('refuses a draft that fails active semantic validation', () => {
    fixture = mkCawsGitRepo('activate-store-a3-');
    seedSpec(fixture, 'TIER2-001', 'draft', 3);
    const specPath = path.join(fixture.cawsDir, 'specs/TIER2-001.yaml');
    const draftTier2 = fs.readFileSync(specPath, 'utf8')
      .replace('mode: chore', 'mode: feature')
      .replace('risk_tier: 3', 'risk_tier: 2');
    fs.writeFileSync(specPath, draftTier2);
    execFileSync('git', ['-C', fixture.root, 'add', '.caws/specs/TIER2-001.yaml']);
    execFileSync('git', ['-C', fixture.root, 'commit', '--quiet', '-m', 'make tier2 draft']);

    const result = activateSpec(fixture.cawsDir, {
      id: 'TIER2-001',
      now: NOW,
      actor: ACTOR,
    });

    expect(result.ok).toBe(false);
    expect(result.errors.map((e) => e.message).join('\n')).toMatch(/contract/i);
    expect(fs.readFileSync(specPath, 'utf8')).toMatch(/^lifecycle_state: draft$/m);
  });
});
