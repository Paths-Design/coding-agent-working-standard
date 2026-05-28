/**
 * CAWS-CLOSE-SPEC-BLOCK-SCALAR-CLOSURE-NOTES-001
 *
 * Regression coverage for closeSpec when a hand-authored spec already
 * carries rich multi-line `closure_notes: |` content. The close command
 * must not attempt to scalar-replace that block value; preserve the YAML
 * notes and record the new reason on the spec_closed event.
 */

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const { closeSpec } = require('../../dist/store/specs-writer');

function mkBareGitRepo(prefix) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  execFileSync('git', ['init', '--quiet', root]);
  execFileSync('git', ['-C', root, 'config', 'user.email', 't@t.com']);
  execFileSync('git', ['-C', root, 'config', 'user.name', 'T']);
  execFileSync('git', [
    '-C', root, 'commit', '--quiet', '--allow-empty', '-m', 'init',
  ]);
  fs.mkdirSync(path.join(root, '.caws', 'specs'), { recursive: true });
  return { root, cawsDir: path.join(root, '.caws') };
}

function rmrf(p) {
  try { fs.rmSync(p, { recursive: true, force: true }); } catch { /* ignore */ }
}

function readEvents(cawsDir) {
  const eventPath = path.join(cawsDir, 'events.jsonl');
  if (!fs.existsSync(eventPath)) return [];
  return fs.readFileSync(eventPath, 'utf8')
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

const NOW = () => new Date('2026-05-28T22:00:00.000Z');
const ACTOR = { kind: 'agent', id: 'test-agent', session_id: 'sess-close-test' };

function specYaml(id, closureNotes = '') {
  return `id: ${id}
title: 'close spec regression'
risk_tier: 3
mode: fix
lifecycle_state: active
created_at: '2026-05-01T00:00:00.000Z'
updated_at: '2026-05-15T12:00:00.000Z'
${closureNotes}blast_radius:
  modules:
    - some/module
  data_migration: false
operational_rollback_slo: 5m
scope:
  in:
    - some/module
  out: []
invariants:
  - 'invariant one'
acceptance:
  - id: A1
    given: 'given'
    when: 'when'
    then: 'then'
non_functional: {}
contracts: []
`;
}

describe('CAWS-CLOSE-SPEC-BLOCK-SCALAR-CLOSURE-NOTES-001: closeSpec closure_notes handling', () => {
  let env;
  beforeEach(() => { env = mkBareGitRepo('caws-close-notes-'); });
  afterEach(() => rmrf(env.root));

  it('preserves block-scalar closure_notes and records --reason on the spec_closed event', () => {
    const specPath = path.join(env.cawsDir, 'specs', 'NOTES-1.yaml');
    const notes = `closure_notes: |
  A1: Existing rich closure note.
  A2: Another line that must remain byte-for-byte.
`;
    fs.writeFileSync(specPath, specYaml('NOTES-1', notes));

    const r = closeSpec(env.cawsDir, {
      id: 'NOTES-1',
      resolution: 'completed',
      reason: 'short merge reason',
      mergeCommit: 'abcdef1',
      actor: ACTOR,
      now: NOW,
    });

    expect(r.ok).toBe(true);
    expect(r.value.kind).toBe('success');

    const patched = fs.readFileSync(specPath, 'utf8');
    expect(patched).toMatch(/^lifecycle_state: closed$/m);
    expect(patched).toMatch(/^resolution: completed$/m);
    expect(patched).toContain(notes);
    expect(patched).not.toMatch(/^closure_notes: 'short merge reason'$/m);

    const closeEvent = readEvents(env.cawsDir).find((e) => e.event === 'spec_closed');
    expect(closeEvent).toBeDefined();
    expect(closeEvent.data).toMatchObject({
      resolution: 'completed',
      closure_notes: 'short merge reason',
      merge_commit: 'abcdef1',
    });
  });

  it('preserves block-scalar closure_notes when closed without --reason', () => {
    const specPath = path.join(env.cawsDir, 'specs', 'NOTES-2.yaml');
    const notes = `closure_notes: |
  Pre-authored notes remain the durable closure narrative.
`;
    fs.writeFileSync(specPath, specYaml('NOTES-2', notes));

    const r = closeSpec(env.cawsDir, {
      id: 'NOTES-2',
      resolution: 'completed',
      actor: ACTOR,
      now: NOW,
    });

    expect(r.ok).toBe(true);
    expect(r.value.kind).toBe('success');

    const patched = fs.readFileSync(specPath, 'utf8');
    expect(patched).toContain(notes);
    const closeEvent = readEvents(env.cawsDir).find((e) => e.event === 'spec_closed');
    expect(closeEvent.data).toEqual({ resolution: 'completed' });
  });

  it('preserves existing scalar insertion behavior when closure_notes is absent', () => {
    const specPath = path.join(env.cawsDir, 'specs', 'NOTES-3.yaml');
    fs.writeFileSync(specPath, specYaml('NOTES-3'));

    const r = closeSpec(env.cawsDir, {
      id: 'NOTES-3',
      resolution: 'completed',
      reason: 'plain close',
      actor: ACTOR,
      now: NOW,
    });

    expect(r.ok).toBe(true);
    expect(r.value.kind).toBe('success');

    const patched = fs.readFileSync(specPath, 'utf8');
    expect(patched).toMatch(/^closure_notes: 'plain close'$/m);
  });
});
