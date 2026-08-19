'use strict';

/**
 * CAWS-SPEC-ACTIVATION-BINDS-001 — closing a draft names the governed exit.
 *
 * `close` is the verb an agent already knows, so it is what gets reached for
 * when a slice is abandoned. Since `specs create` now yields a draft, close-on-
 * draft moved from a corner case to a hot path — and it refused with a bare
 * "only active specs can be closed" and NO next command. The governed exit
 * (`retire-draft`, a recoverable tombstone) existed but nothing named it at the
 * moment of the refusal, which is exactly the shape that ends with an agent
 * running `git rm` on the spec and bypassing the audit trail.
 *
 * Both branches are pinned: discard it, or start it.
 */

const fs = require('fs');
const path = require('path');

const { initProject } = require('../../dist/store/init-store');
const { closeSpec } = require('../../dist/store/specs-writer');
const { cleanupAll, makeTempRepo } = require('../helpers/git-repo-factory');

const ACTOR = { kind: 'agent', id: 'close-draft-test', session_id: 'close-draft-test' };

afterAll(() => {
  cleanupAll();
});

function mkRepo() {
  const root = makeTempRepo();
  const initialized = initProject(root);
  if (!initialized.ok) throw new Error('initProject failed');
  return path.join(root, '.caws');
}

function writeSpec(cawsDir, id, lifecycleState, extra = '') {
  fs.writeFileSync(
    path.join(cawsDir, 'specs', `${id}.yaml`),
    `id: ${id}
title: 'Close handoff fixture'
risk_tier: 3
mode: chore
lifecycle_state: ${lifecycleState}
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
  - 'fixture'
acceptance:
  - id: A1
    given: 'fixture'
    when: 'fixture'
    then: 'fixture'
non_functional: {}
contracts: []
${extra}`
  );
}

function closeIt(cawsDir, id) {
  return closeSpec(cawsDir, {
    id,
    resolution: 'completed',
    reason: 'fixture closure notes',
    actor: ACTOR,
  });
}

describe('close on a non-active spec names the exit that applies', () => {
  test('a draft is offered retire-draft AND the start-it path, never a bare refusal', () => {
    const cawsDir = mkRepo();
    writeSpec(cawsDir, 'CLOSE-DRAFT-001', 'draft');

    const result = closeIt(cawsDir, 'CLOSE-DRAFT-001');

    expect(result.ok).toBe(false);
    const message = result.errors.map((d) => d.message).join('\n');
    expect(message).toContain('caws specs retire-draft CLOSE-DRAFT-001');
    expect(message).toContain('caws worktree create <name> --spec CLOSE-DRAFT-001');
    // The reason close is wrong here, not just that it is refused.
    expect(message).toContain('close writes a resolution asserting the work concluded');
    // Naming git rm as forbidden at the moment of the refusal is the point —
    // that is the bypass this handoff exists to pre-empt.
    expect(message).toContain('never `git rm`');
    // Machine-readable for a consumer that parses rather than reads.
    expect(result.errors[0].data.next_commands).toEqual([
      'caws specs retire-draft CLOSE-DRAFT-001',
      'caws worktree create <name> --spec CLOSE-DRAFT-001',
    ]);

    // Nothing was written: the spec is still a draft.
    expect(
      fs.readFileSync(path.join(cawsDir, 'specs', 'CLOSE-DRAFT-001.yaml'), 'utf8')
    ).toContain('lifecycle_state: draft');
  });

  test('an archived spec is told to restore, not to retire-draft', () => {
    const cawsDir = mkRepo();
    writeSpec(
      cawsDir,
      'CLOSE-ARCHIVED-002',
      'archived',
      "resolution: completed\nclosure_notes: 'fixture closure'\n"
    );

    const result = closeIt(cawsDir, 'CLOSE-ARCHIVED-002');

    expect(result.ok).toBe(false);
    const message = result.errors.map((d) => d.message).join('\n');
    expect(message).toContain('caws specs restore CLOSE-ARCHIVED-002');
    expect(message).not.toContain('retire-draft');
  });

  test('an already-closed spec keeps its own reopen/archive handoff', () => {
    const cawsDir = mkRepo();
    writeSpec(
      cawsDir,
      'CLOSE-CLOSED-003',
      'closed',
      "resolution: completed\nclosure_notes: 'fixture closure'\n"
    );

    const result = closeIt(cawsDir, 'CLOSE-CLOSED-003');

    expect(result.ok).toBe(false);
    const message = result.errors.map((d) => d.message).join('\n');
    expect(message).toContain('caws specs reopen CLOSE-CLOSED-003');
    expect(message).toContain('no closure metadata was changed');
  });

  test('an active spec still closes — the guard did not widen', () => {
    const cawsDir = mkRepo();
    writeSpec(cawsDir, 'CLOSE-ACTIVE-004', 'active');

    const result = closeIt(cawsDir, 'CLOSE-ACTIVE-004');

    expect(result.ok).toBe(true);
    expect(result.value.kind).toBe('success');
    expect(
      fs.readFileSync(path.join(cawsDir, 'specs', 'CLOSE-ACTIVE-004.yaml'), 'utf8')
    ).toContain('lifecycle_state: closed');
  });
});
