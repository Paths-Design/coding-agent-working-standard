'use strict';

/**
 * Close-requires-closure-notes regression gate
 * (CAWS-GUARD-ALLOWLIST-SYNC-001, Defect 2).
 *
 * The defect this suite pins: caws specs close treated
 * --reason / --closure-notes / --notes / --note as optional. Omit all four and
 * the spec closed silently with no closure_notes — losing the audit trail and
 * costing downstream agents loops (they re-open to find out what happened,
 * then re-close with notes).
 *
 * The fix enforces a non-empty reason in BOTH layers:
 *   - runSpecsCloseCommand (shell): refuse with a clear message before
 *     ctx/actor resolution.
 *   - closeSpec (store): refuse with LIFECYCLE_PLAN_REJECTED before any byte
 *     mutation or spec_closed event.
 *
 * Mirrors specs-close-closure-notes-alias.test.js conventions.
 */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const { runSpecsCloseCommand } = require('../../dist/shell/commands/specs');
const { closeSpec } = require('../../dist/store/specs-writer');
const { initProject } = require('../../dist/store/init-store');
const { cleanupAll, makeTempRepo } = require('../helpers/git-repo-factory');

const CLI = path.resolve(__dirname, '..', '..', 'dist', 'index.js');

afterAll(() => {
  cleanupAll();
});

function mkRepo() {
  const root = makeTempRepo();
  const initialized = initProject(root);
  if (!initialized.ok) throw new Error('initProject failed: ' + JSON.stringify(initialized.errors));
  return root;
}

function writeActiveSpec(cawsDir, id) {
  const body = `id: ${id}
title: 'Close requires notes fixture'
risk_tier: 3
mode: chore
lifecycle_state: active
created_at: '2026-07-04T00:00:00.000Z'
updated_at: '2026-07-04T00:00:00.000Z'
blast_radius:
  modules:
    - tests
  data_migration: false
operational_rollback_slo: 5m
scope:
  in:
    - tests
  out: []
invariants:
  - 'fixture spec'
acceptance:
  - id: A1
    given: 'fixture'
    when: 'fixture'
    then: 'fixture'
non_functional: {}
contracts: []
`;
  fs.writeFileSync(path.join(cawsDir, 'specs', `${id}.yaml`), body);
}

function readBytes(p) {
  return fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : null;
}

function snapshot(cawsDir, specId) {
  return {
    spec: readBytes(path.join(cawsDir, 'specs', `${specId}.yaml`)),
    events: readBytes(path.join(cawsDir, 'events.jsonl')),
  };
}

function runClose(root, id, opts = {}) {
  const out = [];
  const err = [];
  const code = runSpecsCloseCommand({
    cwd: root,
    env: { ...process.env, CLAUDE_CODE_SESSION_ID: 'specs-close-requires-notes-test' },
    id,
    resolution: 'completed',
    out: (line) => out.push(line),
    err: (line) => err.push(line),
    showData: true,
    now: () => new Date('2026-07-04T12:00:00.000Z'),
    ...opts,
  });
  return { code, out: out.join('\n'), err: err.join('\n') };
}

function runCli(root, args) {
  return spawnSync(process.execPath, [CLI, ...args], {
    cwd: root,
    encoding: 'utf8',
    env: {
      ...process.env,
      CAWS_QUIET: '1',
      CLAUDE_CODE_SESSION_ID: 'specs-close-requires-notes-cli-test',
    },
  });
}

describe('caws specs close: closure notes are required (shell layer)', () => {
  test('refuses with no --reason/--closure-notes/--notes/--note', () => {
    const root = mkRepo();
    const cawsDir = path.join(root, '.caws');
    writeActiveSpec(cawsDir, 'CLOSE-REQ-001');
    const before = snapshot(cawsDir, 'CLOSE-REQ-001');

    const result = runClose(root, 'CLOSE-REQ-001');

    expect(result.code).toBe(1);
    expect(result.err).toContain('--reason');
    expect(result.err).toContain('required');
    // No mutation, no event.
    expect(snapshot(cawsDir, 'CLOSE-REQ-001')).toEqual(before);
    expect(readBytes(path.join(cawsDir, 'events.jsonl'))).toBeNull();
  });

  test('refuses with a whitespace-only reason', () => {
    const root = mkRepo();
    const cawsDir = path.join(root, '.caws');
    writeActiveSpec(cawsDir, 'CLOSE-REQ-002');
    const before = snapshot(cawsDir, 'CLOSE-REQ-002');

    const result = runClose(root, 'CLOSE-REQ-002', { reason: '   ' });

    expect(result.code).toBe(1);
    expect(result.err).toContain('required');
    expect(snapshot(cawsDir, 'CLOSE-REQ-002')).toEqual(before);
  });

  test('succeeds with a non-empty --note', () => {
    const root = mkRepo();
    const cawsDir = path.join(root, '.caws');
    writeActiveSpec(cawsDir, 'CLOSE-REQ-003');

    const result = runClose(root, 'CLOSE-REQ-003', { note: 'work complete; tests green' });

    expect(result.code).toBe(0);
    expect(result.out).toContain('closed CLOSE-REQ-003');
    const spec = readBytes(path.join(cawsDir, 'specs', 'CLOSE-REQ-003.yaml'));
    expect(spec).toContain('lifecycle_state: closed');
    expect(spec).toContain('closure_notes');
    expect(readBytes(path.join(cawsDir, 'events.jsonl'))).toContain('spec_closed');
  });

  test('succeeds with --closure-notes alias', () => {
    const root = mkRepo();
    const cawsDir = path.join(root, '.caws');
    writeActiveSpec(cawsDir, 'CLOSE-REQ-004');

    const result = runClose(root, 'CLOSE-REQ-004', { closureNotes: 'closed via alias' });

    expect(result.code).toBe(0);
    const spec = readBytes(path.join(cawsDir, 'specs', 'CLOSE-REQ-004.yaml'));
    expect(spec).toContain("closure_notes: 'closed via alias'");
  });

  test('spawned CLI refuses with no notes flag', () => {
    const root = mkRepo();
    const cawsDir = path.join(root, '.caws');
    writeActiveSpec(cawsDir, 'CLOSE-REQ-005');
    const before = snapshot(cawsDir, 'CLOSE-REQ-005');

    const result = runCli(root, ['specs', 'close', 'CLOSE-REQ-005', '--resolution', 'completed']);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('required');
    expect(snapshot(cawsDir, 'CLOSE-REQ-005')).toEqual(before);
  });
});

describe('closeSpec: closure notes are required (store layer)', () => {
  const ACTOR = { kind: 'agent', id: 'test-agent', session_id: 'specs-close-requires-notes-test' };

  test('refuses with no reason — LIFECYCLE_PLAN_REJECTED, no file change', () => {
    const root = mkRepo();
    const cawsDir = path.join(root, '.caws');
    writeActiveSpec(cawsDir, 'CLOSE-REQ-101');
    const before = snapshot(cawsDir, 'CLOSE-REQ-101');

    const result = closeSpec(cawsDir, {
      id: 'CLOSE-REQ-101',
      resolution: 'completed',
      actor: ACTOR,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some((d) => d.rule === 'store.lifecycle.plan_rejected')).toBe(true);
      expect(result.errors.some((d) => /closure notes/i.test(d.message))).toBe(true);
    }
    // No mutation, no event.
    expect(snapshot(cawsDir, 'CLOSE-REQ-101')).toEqual(before);
  });

  test('refuses with an empty-string reason', () => {
    const root = mkRepo();
    const cawsDir = path.join(root, '.caws');
    writeActiveSpec(cawsDir, 'CLOSE-REQ-102');

    const result = closeSpec(cawsDir, {
      id: 'CLOSE-REQ-102',
      resolution: 'completed',
      reason: '',
      actor: ACTOR,
    });

    expect(result.ok).toBe(false);
  });

  test('succeeds with a non-empty reason', () => {
    const root = mkRepo();
    const cawsDir = path.join(root, '.caws');
    writeActiveSpec(cawsDir, 'CLOSE-REQ-103');

    const result = closeSpec(cawsDir, {
      id: 'CLOSE-REQ-103',
      resolution: 'completed',
      reason: 'store-layer close with notes',
      actor: ACTOR,
    });

    expect(result.ok).toBe(true);
    const spec = readBytes(path.join(cawsDir, 'specs', 'CLOSE-REQ-103.yaml'));
    expect(spec).toContain('lifecycle_state: closed');
    expect(spec).toContain('closure_notes');
  });
});
