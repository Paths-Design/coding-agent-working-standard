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

function specYaml(id, { state = 'active', scopeIn = ['a/b.ts'], scopeOut = '[]', extra = '', worktree = null } = {}) {
  const inLines = scopeIn.map((p) => `    - ${p}`).join('\n');
  const outBlock = scopeOut === '[]' ? '  out: []' : `  out:\n${scopeOut.map((p) => `    - ${p}`).join('\n')}`;
  // A closed spec must record a resolution to be schema-valid.
  const resolutionLine = state === 'closed' ? "resolution: completed\n" : '';
  // A worktree-bound spec carries a worktree: field (WORKTREE-CLAIM-COMPOSE-WARN-001).
  const worktreeLine = worktree ? `worktree: ${worktree}\n` : '';
  return `id: ${id}
title: '${id} amend-scope fixture'
risk_tier: 3
mode: refactor
lifecycle_state: ${state}
${worktreeLine}${resolutionLine}created_at: '2026-05-01T00:00:00.000Z'
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

  // ── scope.support (WORKTREE-SUPPORT-SCOPE-001) ──────────────────────────

  // First --add-support on a spec WITHOUT a support: block creates the block
  // under scope: and appends the item; event carries the support fields.
  it('A4 --add-support creates the support block on a spec that lacks it', () => {
    writeSpec(env.cawsDir, 'AMEND-SUP-1', { scopeIn: ['a/b.ts'] });
    const r = amendScopeSpec(env.cawsDir, {
      id: 'AMEND-SUP-1', addSupport: ['FRICTION-LOG.md'], now: NOW, actor: ACTOR,
    });
    expect(r.ok).toBe(true);
    const yaml = fs.readFileSync(path.join(env.cawsDir, 'specs', 'AMEND-SUP-1.yaml'), 'utf8');
    expect(yaml).toMatch(/^ {2}support:$/m);
    expect(yaml).toMatch(/^ {4}- FRICTION-LOG\.md$/m);
    // scope.in is untouched.
    expect(yaml).toMatch(/^ {4}- a\/b\.ts$/m);

    const ev = readEvents(env.cawsDir).filter((e) => e.event === 'spec_scope_amended');
    expect(ev).toHaveLength(1);
    expect(ev[0].data.added_support).toEqual(['FRICTION-LOG.md']);
    expect(ev[0].data.resulting_scope_support).toEqual(['FRICTION-LOG.md']);
    // scope.in delta is empty (support-only amend).
    expect(ev[0].data.added_in).toEqual([]);
    expect(ev[0].data.resulting_scope_in).toEqual(['a/b.ts']);
  });

  // A support-only amendment is NOT refused by the at-least-one-change guard.
  it('A4 a support-only amend is accepted (not refused as no-op)', () => {
    writeSpec(env.cawsDir, 'AMEND-SUP-2', { scopeIn: ['a/b.ts'] });
    const r = amendScopeSpec(env.cawsDir, {
      id: 'AMEND-SUP-2', addSupport: ['docs/x.md'], now: NOW, actor: ACTOR,
    });
    expect(r.ok).toBe(true);
  });

  // --remove-support drops a support item; event records removed_support.
  it('A4 --remove-support drops a support path', () => {
    writeSpec(env.cawsDir, 'AMEND-SUP-3', {
      scopeIn: ['a/b.ts'],
      extra: '  support:\n    - keep.md\n    - drop.md\n',
    });
    const r = amendScopeSpec(env.cawsDir, {
      id: 'AMEND-SUP-3', removeSupport: ['drop.md'], now: NOW, actor: ACTOR,
    });
    expect(r.ok).toBe(true);
    const yaml = fs.readFileSync(path.join(env.cawsDir, 'specs', 'AMEND-SUP-3.yaml'), 'utf8');
    expect(yaml).toMatch(/^ {4}- keep\.md$/m);
    expect(yaml).not.toMatch(/^ {4}- drop\.md$/m);
    const ev = readEvents(env.cawsDir).filter((e) => e.event === 'spec_scope_amended');
    expect(ev[0].data.removed_support).toEqual(['drop.md']);
    expect(ev[0].data.resulting_scope_support).toEqual(['keep.md']);
  });

  // ── compose-trap warning (WORKTREE-CLAIM-COMPOSE-WARN-001) ──────────────

  // B-A1: --add a repo-root deliverable to a WORKTREE-BOUND spec → warns,
  // but the amendment still succeeds.
  it('B-A1 warns when --add pulls a root deliverable into a worktree-bound spec', () => {
    writeSpec(env.cawsDir, 'WARN-1', { scopeIn: ['src/**'], worktree: 'wt-warn-1' });
    const r = amendScopeSpec(env.cawsDir, {
      id: 'WARN-1', addIn: ['FRICTION-LOG.md'], now: NOW, actor: ACTOR,
    });
    expect(r.ok).toBe(true);
    // The amendment STILL happened.
    const yaml = fs.readFileSync(path.join(env.cawsDir, 'specs', 'WARN-1.yaml'), 'utf8');
    expect(yaml).toMatch(/^ {4}- FRICTION-LOG\.md$/m);
    // ...and a compose-trap warning is attached.
    expect(r.value.kind).toBe('success');
    expect(r.value.warnings).toBeDefined();
    expect(r.value.warnings.length).toBe(1);
    expect(r.value.warnings[0]).toMatch(/WORKTREE-CLAIMED/);
    expect(r.value.warnings[0]).toMatch(/--add-support FRICTION-LOG\.md/);
  });

  // B-A2: an in-tree (non-root) --add on a worktree-bound spec → NO warning.
  it('B-A2 does NOT warn for an in-tree (non-root) --add on a worktree-bound spec', () => {
    writeSpec(env.cawsDir, 'WARN-2', { scopeIn: ['src/**'], worktree: 'wt-warn-2' });
    const r = amendScopeSpec(env.cawsDir, {
      id: 'WARN-2', addIn: ['src/new/file.ts'], now: NOW, actor: ACTOR,
    });
    expect(r.ok).toBe(true);
    expect(r.value.warnings).toBeUndefined();
  });

  // B-A3: a root --add on an UNBOUND spec (no worktree:) → NO warning.
  it('B-A3 does NOT warn for a root --add on an unbound spec', () => {
    writeSpec(env.cawsDir, 'WARN-3', { scopeIn: ['src/**'] }); // no worktree
    const r = amendScopeSpec(env.cawsDir, {
      id: 'WARN-3', addIn: ['ROOT-FILE.md'], now: NOW, actor: ACTOR,
    });
    expect(r.ok).toBe(true);
    expect(r.value.warnings).toBeUndefined();
  });

  // B-A4: --add-support of a root deliverable on a worktree-bound spec → NO warning
  // (support is the recommended class; it never claims).
  it('B-A4 does NOT warn for --add-support of a root deliverable', () => {
    writeSpec(env.cawsDir, 'WARN-4', { scopeIn: ['src/**'], worktree: 'wt-warn-4' });
    const r = amendScopeSpec(env.cawsDir, {
      id: 'WARN-4', addSupport: ['FRICTION-LOG.md'], now: NOW, actor: ACTOR,
    });
    expect(r.ok).toBe(true);
    expect(r.value.warnings).toBeUndefined();
  });

  // B: idempotent re-add (already present) produces no delta → no warning.
  it('B does NOT warn on an idempotent re-add (no added_in delta)', () => {
    writeSpec(env.cawsDir, 'WARN-5', { scopeIn: ['src/**', 'FRICTION-LOG.md'], worktree: 'wt-warn-5' });
    const r = amendScopeSpec(env.cawsDir, {
      id: 'WARN-5', addIn: ['FRICTION-LOG.md'], now: NOW, actor: ACTOR,
    });
    expect(r.ok).toBe(true);
    expect(r.value.warnings).toBeUndefined();
  });

  // ── CAWS-CLI-AMEND-SCOPE-REMOVE-OUT-QUOTED-NOOP-001 ─────────────────────
  // --remove/--remove-out/--remove-support must match a sequence entry by its
  // PARSED scalar value, not the raw YAML line text. A single-quoted entry
  // ('a/b.ts') previously failed to match the unquoted arg and silently no-op'd
  // while the command still reported success.

  // Helper: a spec whose scope.out entries are SINGLE-QUOTED on disk, exactly
  // as `caws specs create --scope-in` / hand-authoring with quotes produces.
  function writeSpecQuotedOut(cawsDir, id, { scopeIn = ['a/b.ts'], scopeOut = [] }) {
    const inLines = scopeIn.map((p) => `    - ${p}`).join('\n');
    const outLines = scopeOut.map((p) => `    - '${p}'`).join('\n'); // QUOTED
    const yaml = `id: ${id}
title: '${id} quoted-out fixture'
risk_tier: 3
mode: refactor
lifecycle_state: active
created_at: '2026-05-01T00:00:00.000Z'
updated_at: '2026-05-15T12:00:00.000Z'
blast_radius:
  modules:
    - some/module
  data_migration: false
operational_rollback_slo: 5m
scope:
  in:
${inLines}
  out:
${outLines}
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
    fs.writeFileSync(path.join(cawsDir, 'specs', `${id}.yaml`), yaml);
  }

  // A1: --remove-out on a single-QUOTED scope.out entry actually removes it.
  it('A1 --remove-out removes a single-quoted scope.out entry (the bug)', () => {
    writeSpecQuotedOut(env.cawsDir, 'QUOTED-OUT-1', {
      scopeIn: ['a/b.ts'],
      scopeOut: ['packages/x/ir.ts', 'packages/x/frameworks'],
    });
    const r = amendScopeSpec(env.cawsDir, {
      id: 'QUOTED-OUT-1', removeOut: ['packages/x/ir.ts'], now: NOW, actor: ACTOR,
    });
    expect(r.ok).toBe(true);
    const yaml = fs.readFileSync(path.join(env.cawsDir, 'specs', 'QUOTED-OUT-1.yaml'), 'utf8');
    // The quoted line is gone, in either quote form…
    expect(yaml).not.toMatch(/^ {4}- '?packages\/x\/ir\.ts'?$/m);
    // …and the sibling quoted entry survives.
    expect(yaml).toMatch(/^ {4}- 'packages\/x\/frameworks'$/m);
    const ev = readEvents(env.cawsDir).filter((e) => e.event === 'spec_scope_amended');
    expect(ev[0].data.removed_out).toEqual(['packages/x/ir.ts']);
    expect(ev[0].data.resulting_scope_out).toEqual(['packages/x/frameworks']);
  });

  // A2: --remove-out on a BARE scope.out entry still works (no regression).
  it('A2 --remove-out still removes a bare (unquoted) scope.out entry', () => {
    writeSpec(env.cawsDir, 'BARE-OUT-1', {
      scopeIn: ['a/b.ts'],
      scopeOut: ['packages/x/ir.ts', 'packages/x/frameworks'],
    });
    const r = amendScopeSpec(env.cawsDir, {
      id: 'BARE-OUT-1', removeOut: ['packages/x/ir.ts'], now: NOW, actor: ACTOR,
    });
    expect(r.ok).toBe(true);
    const yaml = fs.readFileSync(path.join(env.cawsDir, 'specs', 'BARE-OUT-1.yaml'), 'utf8');
    expect(yaml).not.toMatch(/^ {4}- packages\/x\/ir\.ts$/m);
    expect(yaml).toMatch(/^ {4}- packages\/x\/frameworks$/m);
    const ev = readEvents(env.cawsDir).filter((e) => e.event === 'spec_scope_amended');
    expect(ev[0].data.removed_out).toEqual(['packages/x/ir.ts']);
  });

  // A3: a --remove-out that matches nothing is reported honestly — the event's
  // removed_out delta is empty (it did not falsely claim a removal).
  it('A3 --remove-out of an unmatched path reports an empty removal delta', () => {
    writeSpecQuotedOut(env.cawsDir, 'NOMATCH-OUT-1', {
      scopeIn: ['a/b.ts'],
      scopeOut: ['packages/x/ir.ts'],
    });
    const r = amendScopeSpec(env.cawsDir, {
      id: 'NOMATCH-OUT-1', removeOut: ['packages/x/NOT-THERE.ts'], now: NOW, actor: ACTOR,
    });
    expect(r.ok).toBe(true);
    const ev = readEvents(env.cawsDir).filter((e) => e.event === 'spec_scope_amended');
    // Honest: nothing matched, so nothing was removed.
    expect(ev[0].data.removed_out).toEqual([]);
    expect(ev[0].data.resulting_scope_out).toEqual(['packages/x/ir.ts']);
    // And the on-disk entry is untouched.
    const yaml = fs.readFileSync(path.join(env.cawsDir, 'specs', 'NOMATCH-OUT-1.yaml'), 'utf8');
    expect(yaml).toMatch(/^ {4}- 'packages\/x\/ir\.ts'$/m);
  });

  // A4: the same quote-insensitive matching applies to scope.in (--remove).
  it('A4 --remove removes a single-quoted scope.in entry', () => {
    const id = 'QUOTED-IN-1';
    const yaml = `id: ${id}
title: '${id} quoted-in fixture'
risk_tier: 3
mode: refactor
lifecycle_state: active
created_at: '2026-05-01T00:00:00.000Z'
updated_at: '2026-05-15T12:00:00.000Z'
blast_radius:
  modules:
    - some/module
  data_migration: false
operational_rollback_slo: 5m
scope:
  in:
    - 'a/keep.ts'
    - 'a/drop.ts'
  out: []
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
    fs.writeFileSync(path.join(env.cawsDir, 'specs', `${id}.yaml`), yaml);
    const r = amendScopeSpec(env.cawsDir, {
      id, removeIn: ['a/drop.ts'], now: NOW, actor: ACTOR,
    });
    expect(r.ok).toBe(true);
    const out = fs.readFileSync(path.join(env.cawsDir, 'specs', `${id}.yaml`), 'utf8');
    expect(out).not.toMatch(/^ {4}- '?a\/drop\.ts'?$/m);
    expect(out).toMatch(/^ {4}- 'a\/keep\.ts'$/m);
    const ev = readEvents(env.cawsDir).filter((e) => e.event === 'spec_scope_amended');
    expect(ev[0].data.removed_in).toEqual(['a/drop.ts']);
  });

  // A4: the same quote-insensitive matching applies to scope.support.
  it('A4 --remove-support removes a single-quoted scope.support entry', () => {
    writeSpec(env.cawsDir, 'QUOTED-SUP-1', {
      scopeIn: ['a/b.ts'],
      extra: "  support:\n    - 'keep.md'\n    - 'drop.md'\n",
    });
    const r = amendScopeSpec(env.cawsDir, {
      id: 'QUOTED-SUP-1', removeSupport: ['drop.md'], now: NOW, actor: ACTOR,
    });
    expect(r.ok).toBe(true);
    const yaml = fs.readFileSync(path.join(env.cawsDir, 'specs', 'QUOTED-SUP-1.yaml'), 'utf8');
    expect(yaml).not.toMatch(/^ {4}- '?drop\.md'?$/m);
    expect(yaml).toMatch(/^ {4}- 'keep\.md'$/m);
    const ev = readEvents(env.cawsDir).filter((e) => e.event === 'spec_scope_amended');
    expect(ev[0].data.removed_support).toEqual(['drop.md']);
  });

  // Idempotent ADD must also respect quote-normalization: re-adding a path that
  // is present only in QUOTED form must not create a bare duplicate line.
  it('idempotent --add does not duplicate a path already present in quoted form', () => {
    writeSpecQuotedOut(env.cawsDir, 'QUOTED-DUP-1', {
      scopeIn: ['a/b.ts'],
      scopeOut: ['packages/x/ir.ts'],
    });
    const r = amendScopeSpec(env.cawsDir, {
      id: 'QUOTED-DUP-1', addOut: ['packages/x/ir.ts'], now: NOW, actor: ACTOR,
    });
    expect(r.ok).toBe(true);
    const yaml = fs.readFileSync(path.join(env.cawsDir, 'specs', 'QUOTED-DUP-1.yaml'), 'utf8');
    // Exactly one occurrence of the path (quoted), no bare duplicate.
    const occ = (yaml.match(/^ {4}- '?packages\/x\/ir\.ts'?$/gm) || []).length;
    expect(occ).toBe(1);
    const ev = readEvents(env.cawsDir).filter((e) => e.event === 'spec_scope_amended');
    expect(ev[0].data.added_out).toEqual([]); // already present → no delta
  });
});
