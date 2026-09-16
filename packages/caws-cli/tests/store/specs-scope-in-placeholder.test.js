'use strict';

/**
 * scope.in's create scaffold is part of the single-sourced placeholder
 * contract (CAWS-SPEC-SCOPE-IN-PLACEHOLDER-CONTRACT-001).
 *
 * Drives the REAL compiled writers against REAL .caws state in temp dirs.
 *
 * The defect these pin: the scaffold string lived as an inline literal in the
 * create renderer instead of beside MODULES_PLACEHOLDER / INVARIANTS_PLACEHOLDER.
 * So isScaffoldPlaceholder did not recognise it, placeholderFields did not
 * report it, and amend-scope --add appended a real path BESIDE it rather than
 * discharging it the way `amend --add-module` discharges MODULES_PLACEHOLDER.
 * Ten specs in the caws repo reached a terminal lifecycle state still carrying
 * it; eight of those carried it alongside a fully declared scope.in, which is
 * the appended-not-replaced signature.
 *
 * Every assertion below references the exported constant rather than spelling
 * the scaffold text out. That is the point of the slice — a test that hardcoded
 * its own copy could not detect the renderer drifting away from the constant,
 * which is the exact failure mode being closed.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const {
  createSpec,
  amendScopeSpec,
  isScaffoldPlaceholder,
  placeholderFields,
  SCOPE_IN_PLACEHOLDER,
} = require('../../dist/store/specs-writer');
const { initProject } = require('../../dist/store/init-store');
const { loadEvents } = require('../../dist/store/events-store');

/** The data block of the last spec_scope_amended event for `id`. */
function lastAmendEvent(caws, id) {
  const r = loadEvents(caws);
  if (!r.ok) throw new Error('loadEvents failed: ' + JSON.stringify(r.errors));
  const matches = r.value.events.filter(
    (e) => e.event === 'spec_scope_amended' && e.spec_id === id
  );
  if (matches.length === 0) throw new Error('no spec_scope_amended event for ' + id);
  return matches[matches.length - 1].data;
}

const ACTOR = { kind: 'agent', id: 'jest', platform: 'jest' };

const repos = [];
afterEach(() => {
  for (const repo of repos.splice(0)) {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

function mkCaws(prefix) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  execFileSync('git', ['init', '--quiet', '-b', 'main', root]);
  execFileSync('git', ['-C', root, 'config', 'user.email', 't@test.com']);
  execFileSync('git', ['-C', root, 'config', 'user.name', 'Test']);
  execFileSync('git', ['-C', root, 'commit', '--quiet', '--allow-empty', '-m', 'init']);
  repos.push(root);
  const r = initProject(root);
  if (!r.ok) throw new Error('initProject failed: ' + JSON.stringify(r.errors));
  return path.join(root, '.caws');
}

/** Create a spec, optionally with a declared scope.in. */
function seed(caws, id, scopeIn) {
  const input = { id, title: 'x', mode: 'chore', riskTier: 3, actor: ACTOR };
  if (scopeIn !== undefined) input.scopeIn = scopeIn;
  const r = createSpec(caws, input);
  if (!r.ok || r.value.kind !== 'success') {
    throw new Error('seed failed: ' + JSON.stringify(r));
  }
}

function scopeInOf(caws, id) {
  const yaml = fs.readFileSync(path.join(caws, 'specs', `${id}.yaml`), 'utf8');
  const lines = yaml.split('\n');
  const start = lines.findIndex((l) => /^ {2}in:\s*$/.test(l));
  if (start === -1) return [];
  const out = [];
  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i];
    if (/^\S/.test(line)) break;
    if (/^ {2}\S/.test(line) && !/^ {4}/.test(line)) break;
    const m = /^ {4}- (.*)$/.exec(line);
    if (m) {
      let v = m[1].trim();
      if (
        v.length >= 2 &&
        ((v[0] === "'" && v[v.length - 1] === "'") || (v[0] === '"' && v[v.length - 1] === '"'))
      ) {
        v = v.slice(1, -1);
      }
      out.push(v);
    }
  }
  return out;
}

function amend(caws, id, opts) {
  const r = amendScopeSpec(caws, { id, actor: ACTOR, ...opts });
  if (!r.ok) throw new Error('amend failed: ' + JSON.stringify(r.errors));
  return r.value;
}

describe('scope.in scaffold is part of the placeholder contract', () => {
  test('create with no --scope-in writes exactly the exported constant', () => {
    // Pins the renderer to the constant. If the renderer keeps its own copy of
    // the text and the constant drifts, this fails — which is the single-source
    // guarantee the other surfaces depend on.
    const caws = mkCaws('caws-scaffold-render-');
    seed(caws, 'SCAFFOLD-RENDER-001');
    expect(scopeInOf(caws, 'SCAFFOLD-RENDER-001')).toEqual([SCOPE_IN_PLACEHOLDER]);
  });

  test('create WITH --scope-in writes no scaffold at all', () => {
    // Non-vacuity control for the test above: proves the scaffold is the
    // no-paths-supplied fallback and not something create always emits.
    const caws = mkCaws('caws-scaffold-declared-');
    seed(caws, 'SCAFFOLD-DECLARED-001', ['src/a.ts']);
    expect(scopeInOf(caws, 'SCAFFOLD-DECLARED-001')).toEqual(['src/a.ts']);
  });

  test('isScaffoldPlaceholder recognises the scope.in scaffold', () => {
    expect(isScaffoldPlaceholder(SCOPE_IN_PLACEHOLDER)).toBe(true);
    // Non-vacuity: a real path must not be mistaken for a scaffold, or the
    // discharge below would silently delete declared scope.
    expect(isScaffoldPlaceholder('src/a.ts')).toBe(false);
  });

  test('placeholderFields reports scope.in while the scaffold stands', () => {
    const caws = mkCaws('caws-scaffold-fields-');
    seed(caws, 'SCAFFOLD-FIELDS-001');
    const yaml = fs.readFileSync(path.join(caws, 'specs', 'SCAFFOLD-FIELDS-001.yaml'), 'utf8');
    const parsed = require('js-yaml').load(yaml);
    expect(placeholderFields(parsed)).toContain('scope.in');

    // And stops reporting it once a real path discharges it.
    amend(caws, 'SCAFFOLD-FIELDS-001', { addIn: ['src/a.ts'] });
    const after = require('js-yaml').load(
      fs.readFileSync(path.join(caws, 'specs', 'SCAFFOLD-FIELDS-001.yaml'), 'utf8')
    );
    expect(placeholderFields(after)).not.toContain('scope.in');
  });

  test('amend-scope --add discharges the scaffold instead of appending beside it', () => {
    // The headline defect. Before the fix scope.in read [scaffold, src/a.ts].
    const caws = mkCaws('caws-scaffold-discharge-');
    seed(caws, 'SCAFFOLD-DISCHARGE-001');
    expect(scopeInOf(caws, 'SCAFFOLD-DISCHARGE-001')).toEqual([SCOPE_IN_PLACEHOLDER]);

    amend(caws, 'SCAFFOLD-DISCHARGE-001', { addIn: ['src/a.ts'] });

    expect(scopeInOf(caws, 'SCAFFOLD-DISCHARGE-001')).toEqual(['src/a.ts']);
  });

  test('a second amend leaves declared scope untouched', () => {
    // Guards against the discharge being over-eager: once the scaffold is gone
    // the removal set must not delete anything else.
    const caws = mkCaws('caws-scaffold-second-');
    seed(caws, 'SCAFFOLD-SECOND-001');
    amend(caws, 'SCAFFOLD-SECOND-001', { addIn: ['src/a.ts'] });
    amend(caws, 'SCAFFOLD-SECOND-001', { addIn: ['src/b.ts'] });
    expect(scopeInOf(caws, 'SCAFFOLD-SECOND-001')).toEqual(['src/a.ts', 'src/b.ts']);
  });

  test('a bare --remove does not discharge the scaffold', () => {
    // The scaffold means "nobody has declared this surface yet". Removing an
    // unrelated entry is not a declaration, so it must not silently empty
    // scope.in — that would turn a refuses-everything spec into a different
    // refuses-everything spec while erasing the signal that it was never scoped.
    const caws = mkCaws('caws-scaffold-remove-');
    seed(caws, 'SCAFFOLD-REMOVE-001');
    amend(caws, 'SCAFFOLD-REMOVE-001', { removeIn: ['src/not-there.ts'] });
    expect(scopeInOf(caws, 'SCAFFOLD-REMOVE-001')).toEqual([SCOPE_IN_PLACEHOLDER]);
  });

  test('discharge is reported as removed_in, not hidden', () => {
    // The discharge edits governance state, so it must appear in the outcome's
    // diff rather than happening invisibly.
    const caws = mkCaws('caws-scaffold-report-');
    seed(caws, 'SCAFFOLD-REPORT-001');
    amend(caws, 'SCAFFOLD-REPORT-001', { addIn: ['src/a.ts'] });
    const data = lastAmendEvent(caws, 'SCAFFOLD-REPORT-001');
    expect(data.removed_in).toEqual([SCOPE_IN_PLACEHOLDER]);
    expect(data.added_in).toEqual(['src/a.ts']);
    expect(data.resulting_scope_in).toEqual(['src/a.ts']);
  });

  test('amending a spec that never had a scaffold reports no removal', () => {
    // Non-vacuity for the report above, and the regression guard for routing
    // the discharge through the removal set: a normal --add must not start
    // claiming it removed something.
    const caws = mkCaws('caws-scaffold-noremoval-');
    seed(caws, 'SCAFFOLD-NOREMOVAL-001', ['src/a.ts']);
    amend(caws, 'SCAFFOLD-NOREMOVAL-001', { addIn: ['src/b.ts'] });
    expect(lastAmendEvent(caws, 'SCAFFOLD-NOREMOVAL-001').removed_in).toEqual([]);
    expect(scopeInOf(caws, 'SCAFFOLD-NOREMOVAL-001')).toEqual(['src/a.ts', 'src/b.ts']);
  });
});
