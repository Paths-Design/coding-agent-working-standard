'use strict';

/**
 * CAWS-SPEC-REOPEN-001 — caws specs reopen (closed -> active).
 *
 * The governed inverse of close. caws worktree merge auto-closes the bound
 * spec; if the work is later judged incomplete there was no sanctioned path
 * back to active. reopen transitions closed->active, removes the terminal
 * fields (resolution/closure_notes/superseded_by) so the active spec passes
 * validate-semantics, leaves the spec unbound, and appends spec_reopened.
 *
 * SUT: compiled surface — require('../../dist/store/specs-writer') (writer)
 * and require('../../dist/shell/commands/specs') (command).
 */

const fs = require('fs');
const path = require('path');

const { initProject } = require('../../dist/store/init-store');
const { runSpecsReopenCommand } = require('../../dist/shell/commands/specs');
const { COMMAND_SURFACE_METADATA } = require('../../dist/shell/command-metadata');

function findLeaf(groupName, leafName) {
  const group = COMMAND_SURFACE_METADATA.find((c) => c.name === groupName);
  if (!group || !group.subcommands) throw new Error(`missing group ${groupName}`);
  const leaf = group.subcommands.find((c) => c.name === leafName);
  if (!leaf) throw new Error(`missing leaf ${groupName} ${leafName}`);
  return leaf;
}
const { cleanupAll, makeTempRepo } = require('../helpers/git-repo-factory');

afterAll(() => {
  cleanupAll();
});

function writeClosedSpec(cawsDir, id, _extra = {}) {
  const body = `id: ${id}
title: '${id}'
risk_tier: 3
mode: chore
lifecycle_state: closed
resolution: completed
closure_notes: 'initial close'
created_at: '2026-07-30T00:00:00.000Z'
updated_at: '2026-07-30T00:00:00.000Z'
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
  - fixture
acceptance:
  - id: A1
    given: fixture
    when: fixture
    then: fixture
non_functional: {}
contracts: []
`;
  fs.writeFileSync(path.join(cawsDir, 'specs', `${id}.yaml`), body);
}

function writeSpecWithState(cawsDir, id, lifecycleState) {
  const body = `id: ${id}
title: '${id}'
risk_tier: 3
mode: chore
lifecycle_state: ${lifecycleState}
created_at: '2026-07-30T00:00:00.000Z'
updated_at: '2026-07-30T00:00:00.000Z'
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
  - fixture
acceptance:
  - id: A1
    given: fixture
    when: fixture
    then: fixture
non_functional: {}
contracts: []
`;
  fs.writeFileSync(path.join(cawsDir, 'specs', `${id}.yaml`), body);
}

function setupClosedRepo(id) {
  const root = makeTempRepo();
  const initialized = initProject(root);
  if (!initialized.ok) throw new Error('initProject failed');
  const cawsDir = path.join(root, '.caws');
  writeClosedSpec(cawsDir, id);
  return { root, cawsDir };
}

function runReopen(cwd, id, opts = {}) {
  const out = [];
  const err = [];
  const code = runSpecsReopenCommand({
    cwd,
    now: () => new Date('2026-07-30T12:00:00.000Z'),
    env: { ...process.env, CLAUDE_CODE_SESSION_ID: 'test-session' },
    id,
    out: (line) => out.push(line),
    err: (line) => err.push(line),
    ...opts,
  });
  return { code, out: out.join('\n'), err: err.join('\n') };
}

describe('CAWS-SPEC-REOPEN-001 — caws specs reopen', () => {
  test('A1: reopen a closed spec -> active, terminal fields removed, event appended', () => {
    const { root, cawsDir } = setupClosedRepo('REOPEN-A1-001');
    const specPath = path.join(cawsDir, 'specs', 'REOPEN-A1-001.yaml');
    const eventsPath = path.join(cawsDir, 'events.jsonl');

    const result = runReopen(root, 'REOPEN-A1-001');
    expect(result.code).toBe(0);
    expect(result.out).toContain('reopened REOPEN-A1-001');

    const yaml = fs.readFileSync(specPath, 'utf8');
    expect(yaml).toContain('lifecycle_state: active');
    // Terminal fields MUST be gone (validate-semantics rejects resolution-on-active).
    expect(yaml).not.toMatch(/^resolution:/m);
    expect(yaml).not.toMatch(/^closure_notes:/m);
    expect(yaml).not.toMatch(/^superseded_by:/m);

    // spec_reopened event appended.
    const events = fs.readFileSync(eventsPath, 'utf8');
    expect(events).toContain('spec_reopened');
    expect(events).toContain('"previous_lifecycle_state":"closed"');
  });

  test('A1: --reason is recorded on the event (not as closure_notes)', () => {
    const { root, cawsDir } = setupClosedRepo('REOPEN-REASON-001');
    const eventsPath = path.join(cawsDir, 'events.jsonl');

    const result = runReopen(root, 'REOPEN-REASON-001', { reason: 'work incomplete after merge' });
    expect(result.code).toBe(0);
    const events = fs.readFileSync(eventsPath, 'utf8');
    expect(events).toContain('"reason":"work incomplete after merge"');
  });

  test('A2: reopening an active spec is refused with no mutation', () => {
    const root = makeTempRepo();
    initProject(root);
    const cawsDir = path.join(root, '.caws');
    writeSpecWithState(cawsDir, 'REOPEN-ACTIVE-001', 'active');
    const specPath = path.join(cawsDir, 'specs', 'REOPEN-ACTIVE-001.yaml');
    const before = fs.readFileSync(specPath, 'utf8');

    const result = runReopen(root, 'REOPEN-ACTIVE-001');
    expect(result.code).toBe(1);
    expect(result.err).toContain('already active');

    // Byte-identical — no mutation on refusal.
    const after = fs.readFileSync(specPath, 'utf8');
    expect(after).toBe(before);
  });

  test('A2: reopening a draft spec is refused (points to activate)', () => {
    const root = makeTempRepo();
    initProject(root);
    const cawsDir = path.join(root, '.caws');
    writeSpecWithState(cawsDir, 'REOPEN-DRAFT-001', 'draft');

    const result = runReopen(root, 'REOPEN-DRAFT-001');
    expect(result.code).toBe(1);
    expect(result.err).toContain('activate');
  });

  test('A4: command metadata exposes the reopen leaf with --reason', () => {
    const leaf = findLeaf('specs', 'reopen');
    expect(leaf).toBeDefined();
    expect(leaf.name).toBe('reopen');
    const flags = leaf.options.map((o) => o.flag);
    expect(flags).toContain('--reason <text>');
  });

  test('group description matrix lists reopen alongside close (CAWS-DOCS-NEWCOMMANDS-001 — top-level help contract)', () => {
    // Closes the gap where a leaf is wired but the GROUP description string (the
    // top-level `caws --help` matrix an agent in another repo sees first) omits
    // it. The matrix is a separate string from the subcommand list.
    const group = COMMAND_SURFACE_METADATA.find((c) => c.name === 'specs');
    expect(group).toBeDefined();
    const leafNames = (group.subcommands || []).map((c) => c.name);
    // The group description's slash-list must contain every leaf name.
    for (const name of leafNames) {
      expect(group.description).toContain(name);
    }
    expect(group.description).toContain('reopen');
  });

  test('close-already error mentions reopen as a next command (CAWS-DOCS-NEWCOMMANDS-001 — in-flow discovery)', () => {
    // Closes the gap where the close-already diagnostic could drift to omit
    // reopen without a test failure. An agent that closes an already-closed
    // spec must learn reopen exists from the error.
    const root = makeTempRepo();
    initProject(root);
    const cawsDir = path.join(root, '.caws');
    writeClosedSpec(cawsDir, 'REOPEN-ERR-001');
    // Close is refused on an already-closed spec with a diagnostic. We exercise
    // it via the close command path to capture the real error text.
    const { runSpecsCloseCommand } = require('../../dist/shell/commands/specs');
    const out = [];
    const err = [];
    const code = runSpecsCloseCommand({
      cwd: root,
      now: () => new Date('2026-07-30T12:00:00.000Z'),
      env: { ...process.env, CLAUDE_CODE_SESSION_ID: 'test-session' },
      id: 'REOPEN-ERR-001',
      resolution: 'completed',
      out: (line) => out.push(line),
      err: (line) => err.push(line),
    });
    expect(code).toBe(1);
    const combined = out.join('\n') + '\n' + err.join('\n');
    expect(combined).toContain('reopen');
  });

  test('idempotency: reopening an already-active (post-reopen) spec is refused', () => {
    const { root } = setupClosedRepo('REOPEN-IDEM-001');
    // First reopen succeeds.
    const first = runReopen(root, 'REOPEN-IDEM-001');
    expect(first.code).toBe(0);
    // Second reopen (now active) is refused.
    const second = runReopen(root, 'REOPEN-IDEM-001');
    expect(second.code).toBe(1);
    expect(second.err).toContain('already active');
  });
});
