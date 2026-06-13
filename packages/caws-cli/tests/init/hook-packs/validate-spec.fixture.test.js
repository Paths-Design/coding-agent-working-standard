/**
 * Shell fixture tests for the installed validate-spec.sh PostToolUse hook.
 *
 * CAWS-VALIDATE-SPEC-JSYAML-CONFLATION-001.
 *
 * The hook validates a written .caws/specs/*.yaml using an inline Node.js
 * `require('js-yaml')`. The defect this test pins: when `js-yaml` cannot be
 * resolved from the hook's node execution context, the hook MUST NOT report a
 * "YAML syntax error" for a spec it never actually parsed. It must distinguish
 * the missing-validator-dependency case (an environment condition) from a real
 * authoring error.
 *
 * Pattern: install the pack into a temp repo, then invoke the installed
 * .claude/hooks/validate-spec.sh with synthetic Claude Code hook stdin and a
 * controlled NODE_PATH:
 *   - A1: NODE_PATH pointing at a js-yaml-free directory (+ no project
 *     node_modules) → the require fails → the hook must NOT emit a syntax-error
 *     and must NOT tell the author to "fix the syntax".
 *   - A2: NODE_PATH pointing at the workspace node_modules (js-yaml present) +
 *     a malformed spec → the hook still emits the syntax-error message.
 */

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');

const { runInitCommand } = require('../../../dist/shell');

function mkBareGitRepo(prefix) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  execFileSync('git', ['init', '--quiet', root]);
  execFileSync('git', ['-C', root, 'config', 'user.email', 'test@test.com']);
  execFileSync('git', ['-C', root, 'config', 'user.name', 'Test']);
  execFileSync('git', ['-C', root, 'commit', '--quiet', '--allow-empty', '-m', 'init']);
  return root;
}

function rmrf(p) {
  if (fs.existsSync(p)) fs.rmSync(p, { recursive: true, force: true });
}

function installPack(repo) {
  runInitCommand({ cwd: repo, out: () => {}, err: () => {}, agentSurface: 'claude-code' });
}

/** A NODE_PATH directory from which `js-yaml` is resolvable. In this monorepo
 *  js-yaml is hoisted to the repo-root node_modules (the package-local
 *  node_modules does not carry it), so resolve it via Node itself and hand the
 *  hook the directory that contains it. In a real user repo, js-yaml comes from
 *  the project's own dependencies the same way. */
function jsYamlNodePath() {
  // require.resolve('js-yaml') -> .../node_modules/js-yaml/index.js
  // its node_modules dir is two levels up from the package's entry's dir.
  const entry = require.resolve('js-yaml');
  // .../node_modules/js-yaml/<...>/index.js  → walk up to the node_modules dir.
  const marker = `${path.sep}node_modules${path.sep}`;
  const idx = entry.lastIndexOf(marker);
  return entry.slice(0, idx + marker.length - 1);
}

/** Invoke the installed validate-spec.sh with a synthetic Write payload.
 *  `nodePath` controls whether the hook's inline `require('js-yaml')` resolves.
 *  A nonexistent directory => js-yaml unresolvable => sentinel path. */
function runValidateSpec(repo, specPath, nodePath) {
  const hook = path.join(repo, '.claude/hooks/validate-spec.sh');
  const payload = JSON.stringify({
    tool_name: 'Write',
    tool_input: { file_path: specPath },
    session_id: 'test-session',
    cwd: repo,
  });
  const result = spawnSync('bash', [hook], {
    input: payload,
    encoding: 'utf8',
    // Run from a tmp cwd with no node_modules so the ONLY js-yaml resolution
    // path is the NODE_PATH we set — otherwise node could walk up to a real
    // node_modules and resolve js-yaml even in the "missing" case.
    cwd: os.tmpdir(),
    env: {
      ...process.env,
      CLAUDE_PROJECT_DIR: repo,
      NODE_PATH: nodePath,
    },
  });
  return {
    code: result.status === null ? -1 : result.status,
    stdout: result.stdout || '',
    stderr: result.stderr || '',
  };
}

function writeSpec(repo, id, body) {
  fs.mkdirSync(path.join(repo, '.caws/specs'), { recursive: true });
  const p = path.join(repo, `.caws/specs/${id}.yaml`);
  fs.writeFileSync(p, body);
  return p;
}

const VALID_SPEC = [
  'id: VALID-001',
  "title: 'a valid spec'",
  'risk_tier: 3',
  'mode: chore',
  'lifecycle_state: active',
  'scope:',
  '  in:',
  '    - src/foo.ts',
  '',
].join('\n');

// Malformed: a mapping value that breaks indentation. js-yaml.load throws.
const MALFORMED_SPEC = ['id: BAD-001', 'scope:', ' in:', '   - x', '  out: []', ''].join('\n');

describe('validate-spec.sh: js-yaml dependency vs syntax error (CAWS-VALIDATE-SPEC-JSYAML-CONFLATION-001)', () => {
  let repo;
  beforeEach(() => {
    repo = mkBareGitRepo('caws-validate-spec-');
    installPack(repo);
  });
  afterEach(() => rmrf(repo));

  it('A1: js-yaml unresolvable -> does NOT claim a YAML syntax error on a valid spec', () => {
    const specPath = writeSpec(repo, 'VALID-001', VALID_SPEC);
    // NODE_PATH points at an empty dir: js-yaml is not resolvable here.
    const emptyNodeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'caws-no-jsyaml-'));
    try {
      const r = runValidateSpec(repo, specPath, emptyNodeDir);
      const combined = `${r.stdout}\n${r.stderr}`;
      // The defect signature: "YAML syntax error" + "Cannot find module 'js-yaml'"
      // + "fix the syntax". None of those may appear for a valid spec when the
      // parser is simply missing.
      expect(combined).not.toMatch(/YAML syntax error/);
      expect(combined).not.toMatch(/Please fix the syntax/);
      expect(combined).not.toMatch(/Cannot find module 'js-yaml'/);
      // Hook exits cleanly (PostToolUse advisory hooks exit 0).
      expect(r.code).toBe(0);
    } finally {
      rmrf(emptyNodeDir);
    }
  });

  it('A2: js-yaml present + malformed spec -> STILL emits the YAML syntax error', () => {
    const specPath = writeSpec(repo, 'BAD-001', MALFORMED_SPEC);
    const r = runValidateSpec(repo, specPath, jsYamlNodePath());
    const combined = `${r.stdout}\n${r.stderr}`;
    // Real parse failure must remain surfaced — the fix narrows only the
    // missing-dependency false positive, it does not weaken true detection.
    expect(combined).toMatch(/Spec validation failed/);
    expect(combined).toMatch(/YAML syntax error/);
  });

  it('A2b: js-yaml present + valid spec -> no syntax-error message', () => {
    const specPath = writeSpec(repo, 'VALID-001', VALID_SPEC);
    const r = runValidateSpec(repo, specPath, jsYamlNodePath());
    const combined = `${r.stdout}\n${r.stderr}`;
    expect(combined).not.toMatch(/YAML syntax error/);
    expect(r.code).toBe(0);
  });
});
