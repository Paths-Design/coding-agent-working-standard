/**
 * CAWS-SPECS-CREATE-SCOPE-IN-001 — createSpec scopeIn population (store layer).
 *
 * createSpec accepts an optional `scopeIn` array. When supplied, the rendered
 * spec's scope.in lists exactly those paths (first-seen order, de-duplicated)
 * in the same write — no follow-on amend, no hand-edit. When omitted, the
 * scaffold line is rendered (prior behavior, byte-for-byte).
 *
 * Asserts on the actual on-disk YAML and the kernel reload (loadSpecs), not on
 * mocks: a populated scope.in must round-trip through the schema as a real,
 * enforce-ready scope.
 */

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const { createSpec } = require('../../dist/store/specs-writer');
const { loadSpecs } = require('../../dist/store');

function mkGitCawsRepo(prefix) {
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

function readSpecYaml(cawsDir, id) {
  return fs.readFileSync(path.join(cawsDir, 'specs', `${id}.yaml`), 'utf8');
}

/** Parse the scope.in list out of the rendered YAML by hand (no yaml dep in
 * tests) — returns the array of quoted/unquoted entries under `scope:\n  in:`. */
function extractScopeIn(yaml) {
  const lines = yaml.split('\n');
  const out = [];
  let inScope = false;
  let inList = false;
  for (const line of lines) {
    if (line === 'scope:') { inScope = true; continue; }
    if (inScope && /^  in:\s*$/.test(line)) { inList = true; continue; }
    if (inList) {
      const m = line.match(/^    - '?(.*?)'?\s*$/);
      if (m) { out.push(m[1].replace(/''/g, "'")); continue; }
      break; // first non-list line (e.g. `  out:`) ends the in: list
    }
  }
  return out;
}

const NOW = () => new Date('2026-05-30T03:00:00.000Z');
const ACTOR = { kind: 'agent', id: 'test-agent', session_id: 'sess-create-scope-in' };

describe('createSpec --scope-in population (CAWS-SPECS-CREATE-SCOPE-IN-001)', () => {
  let env;
  afterEach(() => env && rmrf(env.root));

  // A1: paths supplied → scope.in is exactly those paths, no scaffold line.
  it('writes the supplied --scope-in paths into scope.in, in order', () => {
    env = mkGitCawsRepo('caws-create-scopein-a1-');
    const r = createSpec(env.cawsDir, {
      id: 'SCOPEIN-1',
      title: 'scope-in populated',
      mode: 'feature',
      riskTier: 3,
      scopeIn: ['src/render.js', 'tests/render.test.js'],
      now: NOW,
      actor: ACTOR,
    });
    expect(r.ok).toBe(true);
    expect(r.value.kind).toBe('success');

    const yaml = readSpecYaml(env.cawsDir, 'SCOPEIN-1');
    expect(extractScopeIn(yaml)).toEqual(['src/render.js', 'tests/render.test.js']);
    // The scaffold sentinel must NOT survive when paths are supplied.
    expect(yaml).not.toContain('list the file(s) or directories this spec authorizes');

    // The populated scope must round-trip through the kernel as a valid spec.
    // loadSpecs returns { specs, diagnostics } directly (not a Result wrapper).
    const loaded = loadSpecs(env.cawsDir);
    expect(loaded.diagnostics).toEqual([]);
    const spec = loaded.specs.find((s) => s.id === 'SCOPEIN-1');
    expect(spec).toBeDefined();
    expect(spec.scope.in).toEqual(['src/render.js', 'tests/render.test.js']);
  });

  // A2: no paths → unchanged prior behavior (scaffold line present, exactly one).
  it('renders the scaffold line when --scope-in is omitted (prior behavior)', () => {
    env = mkGitCawsRepo('caws-create-scopein-a2-');
    const r = createSpec(env.cawsDir, {
      id: 'SCOPEIN-2',
      title: 'scope-in omitted',
      mode: 'feature',
      riskTier: 3,
      now: NOW,
      actor: ACTOR,
    });
    expect(r.ok).toBe(true);
    expect(r.value.kind).toBe('success');

    const yaml = readSpecYaml(env.cawsDir, 'SCOPEIN-2');
    const scopeIn = extractScopeIn(yaml);
    expect(scopeIn).toHaveLength(1);
    expect(scopeIn[0]).toContain('list the file(s) or directories this spec authorizes');
  });

  // A2 variant: empty array behaves like omitted (defensive — handler guards,
  // but the store must not emit an empty scope.in which the schema would reject).
  it('treats an empty --scope-in array as omitted (renders the scaffold line)', () => {
    env = mkGitCawsRepo('caws-create-scopein-a2b-');
    const r = createSpec(env.cawsDir, {
      id: 'SCOPEIN-22',
      title: 'scope-in empty array',
      mode: 'feature',
      riskTier: 3,
      scopeIn: [],
      now: NOW,
      actor: ACTOR,
    });
    expect(r.ok).toBe(true);
    const yaml = readSpecYaml(env.cawsDir, 'SCOPEIN-22');
    expect(extractScopeIn(yaml)).toHaveLength(1);
  });

  // A3: duplicate paths → de-duplicated, first-seen order preserved.
  it('de-duplicates repeated --scope-in paths, preserving first-seen order', () => {
    env = mkGitCawsRepo('caws-create-scopein-a3-');
    const r = createSpec(env.cawsDir, {
      id: 'SCOPEIN-3',
      title: 'scope-in dedup',
      mode: 'feature',
      riskTier: 3,
      scopeIn: ['a.ts', 'b.ts', 'a.ts'],
      now: NOW,
      actor: ACTOR,
    });
    expect(r.ok).toBe(true);
    const yaml = readSpecYaml(env.cawsDir, 'SCOPEIN-3');
    expect(extractScopeIn(yaml)).toEqual(['a.ts', 'b.ts']);
  });

  // A path containing a single quote must be escaped so the YAML stays valid.
  it('escapes single quotes in a scope-in path so the YAML reloads', () => {
    env = mkGitCawsRepo('caws-create-scopein-quote-');
    const r = createSpec(env.cawsDir, {
      id: 'SCOPEIN-5',
      title: 'scope-in quote escape',
      mode: 'feature',
      riskTier: 3,
      scopeIn: ["src/o'brien.ts"],
      now: NOW,
      actor: ACTOR,
    });
    expect(r.ok).toBe(true);
    const loaded = loadSpecs(env.cawsDir);
    expect(loaded.diagnostics).toEqual([]);
    const spec = loaded.specs.find((s) => s.id === 'SCOPEIN-5');
    expect(spec.scope.in).toEqual(["src/o'brien.ts"]);
  });
});
