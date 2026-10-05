'use strict';

/**
 * Routing for a merge-time lane-provenance refusal
 * [CAWS-DEFECT-WAIVER-NOTICE-OMITS-MERGE-PROVENANCE-REMEDY-01].
 *
 * `caws worktree merge` (and --dry-run) refuses when the lane branch carries a
 * commit touching a path outside the lane's scope. Neither a reprieve (skips a
 * PreToolUse hook guard) nor a waiver (filters `caws gates run`) reaches that
 * check; the remedy is `caws specs amend-scope <spec> --add-support <path>`.
 *
 * Everything here drives the REAL compiled writers, shell handlers, machine
 * hook dispatcher and `node dist/index.js` against REAL git repos in temp
 * dirs; nothing mocks git, the guard or the grant.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');

const { createSpec, amendScopeSpec } = require('../../dist/store/specs-writer');
const { loadSpecs } = require('../../dist/store/specs-store');
const { createWorktree } = require('../../dist/store/worktrees-writer');
const { initProject } = require('../../dist/store/init-store');
const { installMachineRuntime } = require('../../dist/init/machine-adapters');
const { runWorktreeMergeCommand } = require('../../dist/shell/commands/worktree');
const {
  runReprieveGrantCommand,
  runReprieveRevokeCommand,
  runReprieveShowCommand,
} = require('../../dist/shell/commands/reprieve');

const CLI = path.resolve(__dirname, '..', '..', 'dist', 'index.js');
const PKG_ROOT = path.resolve(__dirname, '..', '..');
const REPO_ROOT = path.resolve(PKG_ROOT, '..', '..');

const SESSION_ID = 'sess-merge-prov';
const SESSION = { session_id: SESSION_ID, platform: 'jest' };
const ACTOR = { kind: 'agent', id: 'merge-prov-agent', session_id: SESSION_ID };
const FUTURE_ISO = '2099-01-01T00:00:00Z';

const tmpRoots = [];

afterAll(() => {
  for (const r of tmpRoots) {
    try {
      fs.rmSync(r, { recursive: true, force: true });
    } catch {
      /* best effort cleanup */
    }
  }
});

function tmp(prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tmpRoots.push(dir);
  return dir;
}

function git(cwd, ...args) {
  return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' });
}

function mkRepo(prefix) {
  const root = tmp(prefix);
  execFileSync('git', ['init', '--quiet', '-b', 'main', root]);
  git(root, 'config', 'user.email', 't@test.com');
  git(root, 'config', 'user.name', 'Test');
  git(root, 'commit', '--quiet', '--allow-empty', '-m', 'init');
  return root;
}

function commitAll(repo, message) {
  git(repo, 'add', '-A');
  git(repo, 'commit', '--quiet', '--no-verify', '-m', message);
}

/**
 * A lane bound to a spec whose scope.in is only `work.txt`, with one lane
 * commit per path in `foreignPaths` (each outside scope). `otherLane` seeds a
 * second ACTIVE spec admitting the first foreign path.
 */
function buildLane(prefix, name, specId, foreignPaths, { otherLane } = {}) {
  const repo = mkRepo(prefix);
  const init = initProject(repo);
  if (!init.ok) throw new Error('initProject failed: ' + JSON.stringify(init.errors));
  const caws = path.join(repo, '.caws');
  const seeded = createSpec(caws, {
    id: specId,
    title: 'merge provenance fixture',
    mode: 'chore',
    actor: ACTOR,
    scopeIn: ['work.txt'],
  });
  if (!seeded.ok || seeded.value.kind !== 'success') {
    throw new Error('seed spec failed: ' + JSON.stringify(seeded));
  }
  if (otherLane !== undefined) {
    const other = createSpec(caws, {
      id: otherLane,
      title: 'other lane',
      mode: 'chore',
      actor: ACTOR,
      scopeIn: [foreignPaths[0]],
    });
    if (!other.ok || other.value.kind !== 'success') {
      throw new Error('seed other spec failed: ' + JSON.stringify(other));
    }
  }
  commitAll(repo, 'seed spec');
  const created = createWorktree(caws, { name, specId, session: SESSION, actor: ACTOR });
  if (!created.ok || created.value.kind !== 'success') {
    throw new Error('createWorktree failed: ' + JSON.stringify(created));
  }
  if (otherLane !== undefined) {
    // The second spec must be ACTIVE to count as a candidate lane.
    const other = createWorktree(caws, {
      name: `${name}-other`,
      specId: otherLane,
      session: SESSION,
      actor: ACTOR,
    });
    if (!other.ok || other.value.kind !== 'success') {
      throw new Error('createWorktree(other) failed: ' + JSON.stringify(other));
    }
  }
  const wtPath = path.join(caws, 'worktrees', name);
  fs.writeFileSync(path.join(wtPath, 'work.txt'), 'lane work\n');
  git(wtPath, 'add', 'work.txt');
  git(wtPath, 'commit', '--quiet', '-m', 'lane work');
  for (const f of foreignPaths) {
    fs.writeFileSync(path.join(wtPath, f), `not lane work: ${f}\n`);
    git(wtPath, 'add', f);
    git(wtPath, 'commit', '--quiet', '-m', `foreign ${f}`);
  }
  return { repo, caws, wtPath };
}

function runMerge(repo, name, opts = {}) {
  const out = [];
  const err = [];
  const code = runWorktreeMergeCommand({
    cwd: repo,
    name,
    env: { ...process.env, CAWS_SESSION_ID: SESSION_ID },
    out: (line) => out.push(line),
    err: (line) => err.push(line),
    now: () => new Date('2026-08-06T12:00:00.000Z'),
    ...opts,
  });
  return { code, out: out.join('\n'), err: err.join('\n'), all: out.concat(err).join('\n') };
}

/** Everything an operator sees must route to --add-support and to nothing else. */
function expectRoutesOnlyToAddSupport(text, specId, paths) {
  for (const p of paths) {
    expect(text).toContain(`caws specs amend-scope ${specId}`);
    expect(text).toContain(`--add-support ${p}`);
  }
  expect(text).not.toMatch(/caws reprieve/i);
  expect(text).not.toMatch(/caws waiver/i);
  expect(text).not.toMatch(/reprieve/i);
  expect(text).not.toMatch(/waiver/i);
}

// ─── A3: the refusal itself carries the remedy ───────────────────────────────

describe('A3: a lane-provenance merge refusal names --add-support and nothing else', () => {
  test('the real merge refusal names amend-scope --add-support for the offending path', () => {
    const { repo, wtPath } = buildLane('wnmp-a3-', 'wt-a3', 'WNMP-A3-001', ['foreign.txt']);

    const result = runMerge(repo, 'wt-a3');

    expect(result.code).toBe(1);
    expect(result.err).toMatch(/outside spec scope: foreign\.txt/);
    expectRoutesOnlyToAddSupport(result.all, 'WNMP-A3-001', ['foreign.txt']);
    // Refusing wrote nothing: the lane still exists.
    expect(fs.existsSync(wtPath)).toBe(true);
    console.log('A3 merge refusal (code ' + result.code + '):\n' + result.err);
  });

  test('the dry run names the same remedy, as a finding and in next_commands', () => {
    const { repo } = buildLane('wnmp-a3d-', 'wt-a3d', 'WNMP-A3D-001', ['foreign.txt']);

    const text = runMerge(repo, 'wt-a3d', { dryRun: true });
    const withData = runMerge(repo, 'wt-a3d', { dryRun: true, showData: true });

    expect(text.code).toBe(1);
    expectRoutesOnlyToAddSupport(text.all, 'WNMP-A3D-001', ['foreign.txt']);
    // --data appends the structured dry-run payload after the findings.
    const payload = JSON.parse(withData.err.slice(withData.err.indexOf('\n{\n') + 1));
    expect(payload.can_proceed).toBe(false);
    expect(payload.next_commands[0]).toBe(
      'caws specs amend-scope WNMP-A3D-001 --add-support foreign.txt'
    );
    console.log('A3 dry-run (code ' + text.code + '):\n' + text.all);
  });

  test('every offending path is named, each with its own --add-support', () => {
    const { repo } = buildLane('wnmp-a3m-', 'wt-a3m', 'WNMP-A3M-001', [
      'b-foreign.txt',
      'a-foreign.txt',
    ]);

    const result = runMerge(repo, 'wt-a3m');

    expect(result.code).toBe(1);
    expectRoutesOnlyToAddSupport(result.all, 'WNMP-A3M-001', ['a-foreign.txt', 'b-foreign.txt']);
    // One amend-scope invocation lists both paths (deterministic sorted order).
    expect(result.err).toContain('--add-support a-foreign.txt --add-support b-foreign.txt');
  });

  test('a path another active lane already admits is named as a candidate lane, still without reprieve or waiver', () => {
    const { repo } = buildLane('wnmp-a3c-', 'wt-a3c', 'WNMP-A3C-001', ['foreign.txt'], {
      otherLane: 'WNMP-A3C-002',
    });

    const result = runMerge(repo, 'wt-a3c');

    expect(result.code).toBe(1);
    expect(result.err).toContain('active specs already admit the path: WNMP-A3C-002');
    expectRoutesOnlyToAddSupport(result.all, 'WNMP-A3C-001', ['foreign.txt']);
  });
});

// ─── A4: reprieve leaves readiness refused; --add-support flips it ───────────

describe('A4: only --add-support changes merge readiness', () => {
  test('one fixture, reset to a common checkpoint between arms', () => {
    const { repo, caws } = buildLane('wnmp-a4-', 'wt-a4', 'WNMP-A4-001', ['foreign.txt']);
    const home = path.join(tmp('wnmp-a4-home-'), 'machine');
    fs.mkdirSync(path.join(home, 'state', 'sessions'), { recursive: true });
    const specFile = path.join(caws, 'specs', 'WNMP-A4-001.yaml');

    // Whether a reprieve is ACTIVE for the owning session, as `caws reprieve
    // show --json` reports it (a revoke leaves an inactive tombstone behind).
    const reprieveActive = () => {
      let shown;
      const code = runReprieveShowCommand({
        cwd: repo,
        homeDir: home,
        env: {},
        out: (s) => {
          shown = JSON.parse(s);
        },
        err: () => {},
        json: true,
        session: SESSION_ID,
        surface: 'claude-code',
      });
      return code === 0 && shown !== undefined && shown.active === true;
    };

    const readiness = (label) => {
      const r = runMerge(repo, 'wt-a4', { dryRun: true });
      const observed = {
        label,
        exit: r.code,
        ready: r.code === 0,
        reprieveActive: reprieveActive(),
        support: loadSpecs(caws).specs.find((s) => s.id === 'WNMP-A4-001').scope.support ?? [],
      };
      console.log('A4 readiness ' + JSON.stringify(observed));
      return { ...observed, text: r.all };
    };

    // Checkpoint: refused on lane provenance, no reprieve, no support entry.
    const checkpoint = readiness('checkpoint');
    const checkpointSpecBytes = fs.readFileSync(specFile, 'utf8');
    expect(checkpoint.ready).toBe(false);
    expect(checkpoint.text).toMatch(/outside spec scope: foreign\.txt/);
    expect(checkpoint.reprieveActive).toBe(false);
    expect(checkpoint.support).toEqual([]);

    // Arm 1: a live reprieve for the owning session.
    const outLines = [];
    const grantCode = runReprieveGrantCommand({
      cwd: repo,
      homeDir: home,
      env: {},
      out: (s) => outLines.push(s),
      err: (s) => outLines.push(s),
      handlers: 'protected-paths.sh',
      reason: 'arm 1: a reprieve must not change merge readiness',
      approvedBy: '@test-human',
      expiresAt: FUTURE_ISO,
      session: SESSION_ID,
      surface: 'claude-code',
    });
    expect(grantCode).toBe(0);
    const afterReprieve = readiness('after-reprieve');
    expect(afterReprieve.reprieveActive).toBe(true);
    expect(afterReprieve.ready).toBe(false);
    expect(afterReprieve.exit).toBe(checkpoint.exit);
    expect(afterReprieve.text).toBe(checkpoint.text);

    // Reset to the checkpoint: revoke the reprieve; the spec bytes never moved.
    const revokeCode = runReprieveRevokeCommand({
      cwd: repo,
      homeDir: home,
      env: {},
      out: () => {},
      err: () => {},
      reason: 'reset fixture to checkpoint between arms',
      session: SESSION_ID,
      surface: 'claude-code',
    });
    expect(revokeCode).toBe(0);
    expect(fs.readFileSync(specFile, 'utf8')).toBe(checkpointSpecBytes);
    const reset = readiness('reset');
    expect(reset.ready).toBe(false);
    expect(reset.reprieveActive).toBe(false);
    expect(reset.text).toBe(checkpoint.text);

    // Arm 2: admit the offending path as support, with no reprieve active.
    const amended = amendScopeSpec(caws, {
      id: 'WNMP-A4-001',
      addSupport: ['foreign.txt'],
      actor: ACTOR,
    });
    expect(amended.ok).toBe(true);
    commitAll(repo, 'amend-scope: support foreign.txt');
    const afterSupport = readiness('after-add-support');
    expect(afterSupport.reprieveActive).toBe(false);
    expect(afterSupport.support).toEqual(['foreign.txt']);
    expect(afterSupport.ready).toBe(true);
    expect(afterSupport.exit).toBe(0);
    expect(afterSupport.text).not.toMatch(/outside spec scope/);
  });
});

// ─── A2 / A6: reprieve and scope.support against a REAL hook guard ───────────

/**
 * A repo the machine runtime treats as a governed project with the system
 * surface enabled, plus a dispatcher call for a Write the shipped
 * protected-paths.sh guard refuses (a hook script under the vendor dir).
 */
function hookFixture() {
  const root = tmp('wnmp-hook-');
  const home = path.join(root, 'machine');
  installMachineRuntime({ home });
  fs.mkdirSync(path.join(home, 'surfaces', 'claude-code'), { recursive: true });
  fs.writeFileSync(
    path.join(home, 'surfaces', 'claude-code', 'settings.json'),
    JSON.stringify({ version: 1, enabled: true })
  );
  const repo = path.join(root, 'repo');
  fs.mkdirSync(path.join(repo, '.caws', 'specs'), { recursive: true });
  fs.writeFileSync(path.join(repo, '.caws', 'policy.yaml'), 'version: 1\n');
  execFileSync('git', ['init', '-q', '-b', 'main', repo]);
  const target = path.join(repo, '.claude', 'hooks', 'guard-under-test.sh');
  const dispatch = (sessionId) =>
    spawnSync(
      'python3',
      [path.join(home, 'bin', 'caws-hook'), 'claude-code', 'pre_tool_use', '--system'],
      {
        cwd: repo,
        encoding: 'utf8',
        env: { ...process.env, CAWS_HOME: home, CAWS_PROJECT_DIR: repo, CLAUDE_PROJECT_DIR: repo },
        input: JSON.stringify({
          tool_name: 'Write',
          tool_input: { file_path: target, content: 'x' },
          session_id: sessionId,
          cwd: repo,
        }),
      }
    );
  return { root, home, repo, target, dispatch };
}

describe('hook guards: reprieve is live, scope.support is not consulted', () => {
  test('A2: a real PreToolUse guard refuses, is skipped after caws reprieve grant for that session, and still refuses another session', () => {
    const { home, repo, dispatch } = hookFixture();

    const before = dispatch('sess-hook-a');
    expect(before.status).toBe(2);
    expect(before.stderr).toContain('[protected-paths.sh] BLOCKED');

    const granted = runReprieveGrantCommand({
      cwd: repo,
      homeDir: home,
      env: { CAWS_HOME: home },
      out: () => {},
      err: () => {},
      handlers: 'protected-paths.sh',
      reason: 'a hook block is the case a reprieve is for',
      approvedBy: '@test-human',
      expiresAt: FUTURE_ISO,
      session: 'sess-hook-a',
      surface: 'claude-code',
    });
    expect(granted).toBe(0);

    const after = dispatch('sess-hook-a');
    expect(after.status).toBe(0);
    expect(after.stderr).toContain('[reprieve] protected-paths.sh skipped for session sess-hook-a');
    expect(after.stderr).not.toContain('BLOCKED');

    // The skip is session-scoped: another session is still refused.
    const other = dispatch('sess-hook-b');
    expect(other.status).toBe(2);
    expect(other.stderr).toContain('[protected-paths.sh] BLOCKED');
    console.log(
      'A2 before: ' +
        before.status +
        ' ' +
        before.stderr.trim().split('\n')[0] +
        '\nA2 after grant: ' +
        after.status +
        ' ' +
        after.stderr.trim().split('\n')[0]
    );
  });

  test('A6: adding the blocked path to scope.support leaves the hook refusal byte-identical', () => {
    const { repo, target, dispatch } = hookFixture();
    const caws = path.join(repo, '.caws');
    const seeded = createSpec(caws, {
      id: 'WNMP-A6-001',
      title: 'support non-interference',
      mode: 'chore',
      actor: ACTOR,
      scopeIn: ['src/unrelated.txt'],
    });
    expect(seeded.ok && seeded.value.kind === 'success').toBe(true);

    const before = dispatch('sess-hook-a6');
    expect(before.status).toBe(2);
    expect(before.stderr).toContain('[protected-paths.sh] BLOCKED');

    const relative = path.relative(repo, target);
    const amended = amendScopeSpec(caws, {
      id: 'WNMP-A6-001',
      addSupport: [relative],
      actor: ACTOR,
    });
    expect(amended.ok).toBe(true);
    // The support entry really landed, so an unchanged refusal is not a no-op.
    const spec = loadSpecs(caws).specs.find((s) => s.id === 'WNMP-A6-001');
    expect(spec.scope.support).toEqual([relative]);

    const after = dispatch('sess-hook-a6');
    expect(after.status).toBe(2);
    expect(after.stdout).toBe(before.stdout);
    expect(after.stderr).toBe(before.stderr);
    console.log(
      'A6 refusal unchanged after support=' + relative + ': ' + after.stderr.trim().split('\n')[0]
    );
  });
});

// ─── A5: operator copy surfaces ──────────────────────────────────────────────

function sentences(text) {
  return text
    .replace(/\s+/g, ' ')
    .split(/(?<=[.!?])\s+(?=[A-Z`(])/)
    .map((s) => s.trim())
    .filter(Boolean);
}

const PROVENANCE = /lane[- ]provenance|outside the spec(?:'s)? scope|outside spec scope/i;

describe('A5: operator copy routes a lane-provenance merge refusal to --add-support', () => {
  const run = (...args) =>
    spawnSync(process.execPath, [CLI, ...args], {
      cwd: tmp('wnmp-a5-'),
      encoding: 'utf8',
      env: { ...process.env, CAWS_QUIET: '1' },
    });

  const surfaces = {
    'README.md': () => fs.readFileSync(path.join(PKG_ROOT, 'README.md'), 'utf8'),
    'docs/api/cli.md': () => fs.readFileSync(path.join(REPO_ROOT, 'docs', 'api', 'cli.md'), 'utf8'),
    'docs/command-reference.md': () =>
      fs.readFileSync(path.join(REPO_ROOT, 'docs', 'command-reference.md'), 'utf8'),
    'worktree merge --help': () => run('worktree', 'merge', '--help').stdout,
    'reprieve --help': () => run('reprieve', '--help').stdout,
    'waiver --help': () => run('waiver', '--help').stdout,
    'waiver create --help': () => run('waiver', 'create', '--help').stdout,
  };

  test.each(['worktree merge --help', 'reprieve --help'])(
    'the rendered %s names amend-scope --add-support for a lane-provenance refusal',
    (surface) => {
      const text = surfaces[surface]().replace(/\s+/g, ' ');
      expect(text).toContain('caws specs amend-scope <spec> --add-support <path>');
    }
  );

  test.each(['README.md', 'docs/api/cli.md'])(
    '%s names amend-scope --add-support for a lane-provenance refusal',
    (surface) => {
      const text = surfaces[surface]().replace(/\s+/g, ' ');
      expect(text).toContain('caws specs amend-scope <spec> --add-support <path>');
    }
  );

  test('no sentence on any surface that discusses a lane-provenance refusal points at a waiver or a reprieve grant', () => {
    let provenanceSentences = 0;
    for (const [name, read] of Object.entries(surfaces)) {
      for (const sentence of sentences(read())) {
        if (!PROVENANCE.test(sentence)) continue;
        provenanceSentences += 1;
        expect({ name, sentence, waiver: /waiver/i.test(sentence) }).toEqual({
          name,
          sentence,
          waiver: false,
        });
        expect({ name, sentence, grant: /reprieve grant/i.test(sentence) }).toEqual({
          name,
          sentence,
          grant: false,
        });
      }
    }
    // Vacuity guard: the census must actually find the provenance copy.
    expect(provenanceSentences).toBeGreaterThanOrEqual(4);
  });
});
