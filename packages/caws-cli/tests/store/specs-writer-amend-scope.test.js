/**
 * CAWS-SCOPE-AMEND-COMMAND-001 — amendScopeSpec store writer.
 *
 * Governed scope.in/scope.out amendment: comment-preserving line-surgical
 * patch + updated_at bump + spec_scope_amended event + validate-before-write +
 * lifecycle guard + idempotency. The point is to eliminate the agent-issued
 * cherry-pick from the scope-amendment protocol.
 */

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const { amendScopeSpec } = require('../../dist/store/specs-writer');

function mkBareGitRepo(prefix) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  execFileSync('git', ['init', '--quiet', root]);
  execFileSync('git', ['-C', root, 'config', 'user.email', 't@t.com']);
  execFileSync('git', ['-C', root, 'config', 'user.name', 'T']);
  execFileSync('git', ['-C', root, 'commit', '--quiet', '--allow-empty', '-m', 'init']);
  fs.mkdirSync(path.join(root, '.caws', 'specs'), { recursive: true });
  return { root, cawsDir: path.join(root, '.caws') };
}

function rmrf(p) {
  try { fs.rmSync(p, { recursive: true, force: true }); } catch { /* ignore */ }
}

function readEvents(cawsDir) {
  const eventPath = path.join(cawsDir, 'events.jsonl');
  if (!fs.existsSync(eventPath)) return [];
  return fs.readFileSync(eventPath, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
}

const NOW = () => new Date('2026-05-30T02:30:00.000Z');
const ACTOR = { kind: 'agent', id: 'test-agent', session_id: 'sess-amend-test' };

function specYaml(id, { state = 'active', scopeIn = ['a/b.ts'], scopeOut = '[]', extra = '' } = {}) {
  const inLines = scopeIn.map((p) => `    - ${p}`).join('\n');
  const outBlock = scopeOut === '[]' ? '  out: []' : `  out:\n${scopeOut.map((p) => `    - ${p}`).join('\n')}`;
  // A closed spec must record a resolution to be schema-valid.
  const resolutionLine = state === 'closed' ? "resolution: completed\n" : '';
  return `id: ${id}
title: '${id} amend-scope fixture'
risk_tier: 3
mode: refactor
lifecycle_state: ${state}
${resolutionLine}created_at: '2026-05-01T00:00:00.000Z'
updated_at: '2026-05-15T12:00:00.000Z'
blast_radius:
  modules:
    - some/module
  data_migration: false
operational_rollback_slo: 5m
scope:
${extra}  in:
${inLines}
${outBlock}
invariants:
  - 'invariant one'
acceptance:
  - id: A1
    given: 'g'
    when: 'w'
    then: 't'
non_functional: {}
contracts: []
`;
}

function writeSpec(cawsDir, id, opts) {
  fs.writeFileSync(path.join(cawsDir, 'specs', `${id}.yaml`), specYaml(id, opts));
}

describe('CAWS-SCOPE-AMEND-COMMAND-001: amendScopeSpec', () => {
  let env;
  beforeEach(() => { env = mkBareGitRepo('caws-amend-scope-'); });
  afterEach(() => rmrf(env.root));

  // A1: --add appends to scope.in, bumps updated_at, appends the event.
  it('A1 adds a scope.in path, bumps updated_at, emits spec_scope_amended', () => {
    writeSpec(env.cawsDir, 'AMEND-1', { scopeIn: ['a/b.ts'] });
    const r = amendScopeSpec(env.cawsDir, {
      id: 'AMEND-1', addIn: ['c/d.ts'], now: NOW, actor: ACTOR,
    });
    expect(r.ok).toBe(true);

    const yaml = fs.readFileSync(path.join(env.cawsDir, 'specs', 'AMEND-1.yaml'), 'utf8');
    expect(yaml).toMatch(/^ {4}- a\/b\.ts$/m);
    expect(yaml).toMatch(/^ {4}- c\/d\.ts$/m);
    expect(yaml).toMatch(/updated_at: '2026-05-30T02:30:00\.000Z'/);

    const ev = readEvents(env.cawsDir).filter((e) => e.event === 'spec_scope_amended');
    expect(ev).toHaveLength(1);
    expect(ev[0].spec_id).toBe('AMEND-1');
    expect(ev[0].data.added_in).toEqual(['c/d.ts']);
    expect(ev[0].data.resulting_scope_in).toEqual(['a/b.ts', 'c/d.ts']);
  });

  // A1: --remove drops a scope.in path.
  it('A1 removes a scope.in path; event records removed_in', () => {
    writeSpec(env.cawsDir, 'AMEND-2', { scopeIn: ['a/b.ts', 'c/d.ts', 'e/f.ts'] });
    const r = amendScopeSpec(env.cawsDir, {
      id: 'AMEND-2', removeIn: ['c/d.ts'], now: NOW, actor: ACTOR,
    });
    expect(r.ok).toBe(true);
    const yaml = fs.readFileSync(path.join(env.cawsDir, 'specs', 'AMEND-2.yaml'), 'utf8');
    expect(yaml).not.toMatch(/^ {4}- c\/d\.ts$/m);
    expect(yaml).toMatch(/^ {4}- a\/b\.ts$/m);
    expect(yaml).toMatch(/^ {4}- e\/f\.ts$/m);
    const ev = readEvents(env.cawsDir).filter((e) => e.event === 'spec_scope_amended');
    expect(ev[0].data.removed_in).toEqual(['c/d.ts']);
    expect(ev[0].data.resulting_scope_in).toEqual(['a/b.ts', 'e/f.ts']);
  });

  // Comment preservation: an interleaved comment in the scope.in block survives.
  it('preserves interleaved comments in the scope block', () => {
    const id = 'AMEND-CMT-1';
    const yamlIn = specYaml(id, { scopeIn: ['a/b.ts'] }).replace(
      '  in:\n    - a/b.ts',
      '  in:\n    # a comment that must survive\n    - a/b.ts'
    );
    fs.writeFileSync(path.join(env.cawsDir, 'specs', `${id}.yaml`), yamlIn);
    const r = amendScopeSpec(env.cawsDir, { id, addIn: ['c/d.ts'], now: NOW, actor: ACTOR });
    expect(r.ok).toBe(true);
    const yaml = fs.readFileSync(path.join(env.cawsDir, 'specs', `${id}.yaml`), 'utf8');
    expect(yaml).toMatch(/# a comment that must survive/);
    expect(yaml).toMatch(/^ {4}- c\/d\.ts$/m);
  });

  // out: [] inline-empty expands to a block on first --add-out.
  it('expands inline-empty scope.out to a block on first add', () => {
    writeSpec(env.cawsDir, 'AMEND-OUT-1', { scopeIn: ['a/b.ts'], scopeOut: '[]' });
    const r = amendScopeSpec(env.cawsDir, { id: 'AMEND-OUT-1', addOut: ['x/y'], now: NOW, actor: ACTOR });
    expect(r.ok).toBe(true);
    const yaml = fs.readFileSync(path.join(env.cawsDir, 'specs', 'AMEND-OUT-1.yaml'), 'utf8');
    expect(yaml).toMatch(/^ {2}out:$/m);
    expect(yaml).toMatch(/^ {4}- x\/y$/m);
  });

  // A2: an amendment that would empty scope.in is refused; no write, no event.
  it('A2 refuses an amendment that empties scope.in (validate-before-write)', () => {
    writeSpec(env.cawsDir, 'AMEND-EMPTY-1', { scopeIn: ['only/one.ts'] });
    const before = fs.readFileSync(path.join(env.cawsDir, 'specs', 'AMEND-EMPTY-1.yaml'), 'utf8');
    const r = amendScopeSpec(env.cawsDir, {
      id: 'AMEND-EMPTY-1', removeIn: ['only/one.ts'], now: NOW, actor: ACTOR,
    });
    expect(r.ok).toBe(false);
    // No write, no event.
    expect(fs.readFileSync(path.join(env.cawsDir, 'specs', 'AMEND-EMPTY-1.yaml'), 'utf8')).toBe(before);
    expect(readEvents(env.cawsDir).filter((e) => e.event === 'spec_scope_amended')).toHaveLength(0);
  });

  // A2: a glob in scope.out is refused (out_glob_forbidden).
  it('A2 refuses a glob in scope.out', () => {
    writeSpec(env.cawsDir, 'AMEND-GLOB-1', { scopeIn: ['a/b.ts'] });
    const r = amendScopeSpec(env.cawsDir, {
      id: 'AMEND-GLOB-1', addOut: ['packages/foo/**'], now: NOW, actor: ACTOR,
    });
    expect(r.ok).toBe(false);
    expect(readEvents(env.cawsDir).filter((e) => e.event === 'spec_scope_amended')).toHaveLength(0);
  });

  // A3: a closed spec is refused (frozen scope).
  it('A3 refuses a closed spec', () => {
    writeSpec(env.cawsDir, 'AMEND-CLOSED-1', { state: 'closed', scopeIn: ['a/b.ts'] });
    const r = amendScopeSpec(env.cawsDir, { id: 'AMEND-CLOSED-1', addIn: ['c/d.ts'], now: NOW, actor: ACTOR });
    expect(r.ok).toBe(false);
    // Refused specifically for the frozen-lifecycle reason (not an id/parse error).
    expect(r.errors.some((e) => /lifecycle_state "closed"|frozen/.test(e.message))).toBe(true);
  });

  // A3: an unknown spec id is refused.
  it('A3 refuses an unknown spec id', () => {
    const r = amendScopeSpec(env.cawsDir, { id: 'NOPE-404', addIn: ['c/d.ts'], now: NOW, actor: ACTOR });
    expect(r.ok).toBe(false);
  });

  // A3: --add of an already-present path is an idempotent success (no dup, empty delta).
  it('A3 --add of an already-present path is idempotent (no duplicate line, empty added_in)', () => {
    writeSpec(env.cawsDir, 'AMEND-IDEM-1', { scopeIn: ['a/b.ts'] });
    const r = amendScopeSpec(env.cawsDir, { id: 'AMEND-IDEM-1', addIn: ['a/b.ts'], now: NOW, actor: ACTOR });
    expect(r.ok).toBe(true);
    const yaml = fs.readFileSync(path.join(env.cawsDir, 'specs', 'AMEND-IDEM-1.yaml'), 'utf8');
    // exactly one occurrence of the path as a list item
    const count = (yaml.match(/^ {4}- a\/b\.ts$/gm) || []).length;
    expect(count).toBe(1);
    const ev = readEvents(env.cawsDir).filter((e) => e.event === 'spec_scope_amended');
    expect(ev[0].data.added_in).toEqual([]);
  });

  // draft specs are amendable (active OR draft).
  it('amends a draft spec', () => {
    writeSpec(env.cawsDir, 'AMEND-DRAFT-1', { state: 'draft', scopeIn: ['a/b.ts'] });
    const r = amendScopeSpec(env.cawsDir, { id: 'AMEND-DRAFT-1', addIn: ['c/d.ts'], now: NOW, actor: ACTOR });
    expect(r.ok).toBe(true);
  });

  // no-op call (no add/remove) is refused with a clear message.
  it('refuses a call with no add/remove', () => {
    writeSpec(env.cawsDir, 'AMEND-NOOP-1', { scopeIn: ['a/b.ts'] });
    const r = amendScopeSpec(env.cawsDir, { id: 'AMEND-NOOP-1', now: NOW, actor: ACTOR });
    expect(r.ok).toBe(false);
  });
});
