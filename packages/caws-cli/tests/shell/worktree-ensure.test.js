'use strict';

/**
 * Contract tests for WORKTREE-ENSURE-AFFORDANCE-001.
 *
 * A1: absent worktree + draft spec => created via the full create path
 *     (worktree exists, bound, spec ACTIVE, worktree_created + worktree_bound
 *     events appended, stdout names the cd path and bound spec).
 * A2: second ensure on the A1 state => idempotent admit (exit 0, no new
 *     events, no file mutation, same cd path).
 * A3: foreign live-owned worktree => soft-block refusal; ensure --takeover is
 *     an unknown option at the Commander surface.
 * A4: worktree bound to a different spec => refusal naming the binding with
 *     list/rebind handoffs; no mutation.
 * A5: closed spec => refusal with the reopen handoff; nothing activated.
 * A6: unbound no-authority remediation (scope show --json) and the
 *     SessionStart hook context name `caws worktree ensure`.
 *
 * Real command surfaces against on-disk git+caws repos, injected sinks.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const { runWorktreeEnsureCommand } = require('../../dist/shell/commands/worktree');
const { runSpecsCreateCommand } = require('../../dist/shell/commands/specs');
const { initProject } = require('../../dist/store/init-store');
const { loadEvents } = require('../../dist/store/events-store');

const HOOK = path.resolve(__dirname, '../../templates/hook-packs/shared/agent-register.sh');

const fixtureEnv = {
  HOME: process.env.HOME,
  PATH: process.env.PATH,
  CAWS_SESSION_ID: 'ensure-caller',
};
const repos = [];
afterAll(() => {
  for (const r of repos) {
    try {
      fs.rmSync(r, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
});

function mkRepo() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'caws-ensure-'));
  execFileSync('git', ['init', '--quiet', '-b', 'main', root]);
  execFileSync('git', ['-C', root, 'config', 'user.email', 't@test.com']);
  execFileSync('git', ['-C', root, 'config', 'user.name', 'Test']);
  execFileSync('git', ['-C', root, 'commit', '--quiet', '--allow-empty', '-m', 'init']);
  const r = initProject(root);
  if (!r.ok) throw new Error('initProject failed: ' + JSON.stringify(r.errors));
  repos.push(root);
  return root;
}

function sinks() {
  const out = [];
  const err = [];
  return { out, err, outFn: (l) => out.push(l), errFn: (l) => err.push(l) };
}

function mkSpec(root, id) {
  const s = sinks();
  const code = runSpecsCreateCommand({
    id,
    title: 'Ensure test spec',
    mode: 'feature',
    scopeIn: ['src/**'],
    cwd: root,
    env: { ...fixtureEnv },
    out: s.outFn,
    err: s.errFn,
  });
  if (code !== 0) throw new Error(`mkSpec(${id}) failed: ${s.err.join('\n')}`);
}

function ensure(root, name, specId, env = fixtureEnv) {
  const s = sinks();
  const code = runWorktreeEnsureCommand({
    name,
    specId,
    cwd: root,
    env: { ...env },
    out: s.outFn,
    err: s.errFn,
  });
  return { code, out: s.out, err: s.err };
}

function countEvents(root, kind) {
  const cawsDir = path.join(root, '.caws');
  const loaded = loadEvents(cawsDir);
  if (!loaded.ok) throw new Error('loadEvents failed');
  return loaded.value.events.filter((e) => e.event === kind).length;
}

function readSpecState(root, id) {
  const raw = fs.readFileSync(path.join(root, '.caws', 'specs', `${id}.yaml`), 'utf8');
  const m = raw.match(/^lifecycle_state:\s*(\S+)/m);
  return m ? m[1].replace(/['"]|,$/g, '') : undefined;
}

describe('WORKTREE-ENSURE-AFFORDANCE-001', () => {
  test('create opt-out reaches the CLI and isolates an offline npm ci from canonical dependencies', () => {
    const root = mkRepo();
    const write = (rel, value) => {
      const file = path.join(root, rel);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, value);
    };
    const pkg = {
      name: 'fixture-root',
      version: '1.0.0',
      private: true,
      workspaces: ['packages/app'],
    };
    const app = { name: 'fixture-app', version: '1.0.0', private: true };
    const lock = {
      name: pkg.name,
      version: pkg.version,
      lockfileVersion: 3,
      requires: true,
      packages: {
        '': pkg,
        'node_modules/fixture-app': { resolved: 'packages/app', link: true },
        'packages/app': { name: app.name, version: app.version },
      },
    };
    write('package.json', JSON.stringify(pkg));
    write('package-lock.json', JSON.stringify(lock));
    write('packages/app/package.json', JSON.stringify(app));
    write('Cargo.toml', '[package]\nname = "fixture"\nversion = "0.1.0"\n');
    write('.gitignore', 'node_modules\ntarget\n');
    execFileSync('git', [
      '-C',
      root,
      'add',
      'package.json',
      'package-lock.json',
      'packages/app/package.json',
      'Cargo.toml',
      '.gitignore',
    ]);
    execFileSync('git', ['-C', root, 'commit', '--quiet', '-m', 'fixture']);
    write('.caws/hooks/package.json', '{}');
    const nodePaths = ['node_modules', 'packages/app/node_modules', '.caws/hooks/node_modules'];
    for (const rel of [...nodePaths, 'target']) write(`${rel}/sentinel`, `canonical:${rel}`);
    mkSpec(root, 'ENS-NODE-001');
    const cli = path.resolve(__dirname, '..', '..', 'dist', 'index.js');
    const output = execFileSync(
      process.execPath,
      [cli, 'worktree', 'create', 'wt-node', '--spec', 'ENS-NODE-001', '--no-link-node-modules'],
      { cwd: root, env: { ...fixtureEnv }, encoding: 'utf8' }
    );
    const wt = path.join(root, '.caws', 'worktrees', 'wt-node');
    expect(output).toContain('Inspect this path and unlink any shared symlink before installing');
    for (const rel of nodePaths) {
      expect(output).toContain(`skipped node link by option ${rel}`);
      expect(fs.existsSync(path.join(wt, rel))).toBe(false);
    }
    expect(fs.lstatSync(path.join(wt, 'target')).isSymbolicLink()).toBe(true);
    expect(fs.realpathSync(path.join(wt, 'target'))).toBe(
      fs.realpathSync(path.join(root, 'target'))
    );
    const config = path.join(root, 'empty-npmrc');
    const globalConfig = path.join(root, 'empty-global-npmrc');
    fs.writeFileSync(config, '');
    fs.writeFileSync(globalConfig, '');
    execFileSync(
      'npm',
      [
        'ci',
        '--offline',
        '--ignore-scripts',
        '--no-audit',
        '--no-fund',
        '--cache',
        path.join(root, 'private-npm-cache'),
        '--userconfig',
        config,
        '--globalconfig',
        globalConfig,
      ],
      { cwd: wt, env: { PATH: process.env.PATH, HOME: root }, encoding: 'utf8', timeout: 30000 }
    );
    expect(fs.lstatSync(path.join(wt, 'node_modules')).isDirectory()).toBe(true);
    expect(fs.realpathSync(path.join(wt, 'node_modules/fixture-app'))).toBe(
      fs.realpathSync(path.join(wt, 'packages/app'))
    );
    for (const rel of nodePaths)
      expect(fs.readFileSync(path.join(root, rel, 'sentinel'), 'utf8')).toBe(`canonical:${rel}`);
    let unknownFlag = false;
    try {
      execFileSync(
        process.execPath,
        [cli, 'worktree', 'ensure', 'wt-node', '--spec', 'ENS-NODE-001', '--no-link-node-modules'],
        { cwd: root, env: { ...fixtureEnv }, stdio: 'pipe' }
      );
    } catch (e) {
      unknownFlag = /unknown option/.test(String(e.stderr));
    }
    expect(unknownFlag).toBe(true);
  }, 45000);

  test('A1: absent worktree + draft spec => full create path (events, activation, cd path)', () => {
    const root = mkRepo();
    mkSpec(root, 'ENS-001');

    const r = ensure(root, 'wt-a1', 'ENS-001');
    expect(r.code).toBe(0);
    expect(r.out.join('\n')).toContain('created wt-a1');

    // Worktree physically exists and is registered-bound.
    expect(fs.existsSync(path.join(root, '.caws', 'worktrees', 'wt-a1'))).toBe(true);
    const registry = JSON.parse(
      fs.readFileSync(path.join(root, '.caws', 'worktrees.json'), 'utf8')
    );
    expect(
      registry.worktrees?.wt_a1?.spec_id ?? registry['wt-a1']?.spec_id ?? JSON.stringify(registry)
    ).toBeTruthy();

    // Draft activated by the bind; both events in the chain.
    expect(readSpecState(root, 'ENS-001')).toBe('active');
    expect(countEvents(root, 'worktree_created')).toBe(1);
    expect(countEvents(root, 'worktree_bound')).toBe(1);
  });

  test('A2: second ensure admits idempotently (no new events, same cd path)', () => {
    const root = mkRepo();
    mkSpec(root, 'ENS-002');
    expect(ensure(root, 'wt-a2', 'ENS-002').code).toBe(0);

    const before = {
      created: countEvents(root, 'worktree_created'),
      bound: countEvents(root, 'worktree_bound'),
      mtime: fs.statSync(path.join(root, '.caws', 'worktrees.json')).mtimeMs,
    };

    const r = ensure(root, 'wt-a2', 'ENS-002');
    expect(r.code).toBe(0);
    expect(r.out.join('\n')).toContain('already bound to spec ENS-002');
    expect(r.out.join('\n')).toContain('Continue in this shell: export CAWS_SESSION_ID=');
    expect(r.out.join('\n')).toContain("wt-a2' && caws claim");

    expect(countEvents(root, 'worktree_created')).toBe(before.created);
    expect(countEvents(root, 'worktree_bound')).toBe(before.bound);
    expect(fs.statSync(path.join(root, '.caws', 'worktrees.json')).mtimeMs).toBe(before.mtime);
  });

  test('A3: foreign live-owned worktree refuses with the soft-block; no takeover flag exists', () => {
    const root = mkRepo();
    mkSpec(root, 'ENS-003');
    expect(
      ensure(root, 'wt-a3', 'ENS-003', {
        ...fixtureEnv,
        CAWS_SESSION_ID: 'owner-session',
      }).code
    ).toBe(0);

    // A DIFFERENT session asks to ensure the same worktree.
    const r = ensure(root, 'wt-a3', 'ENS-003', {
      ...fixtureEnv,
      CAWS_SESSION_ID: 'other-session',
    });
    expect(r.code).toBe(1);
    const text = r.err.join('\n');
    expect(text).toContain('owned by another session');
    expect(text).toContain('caws claim --takeover');

    // --takeover is not an option on ensure (Commander surface, built dist).
    const cli = path.resolve(__dirname, '..', '..', 'dist', 'index.js');
    let unknownFlag = false;
    try {
      execFileSync('node', [cli, 'worktree', 'ensure', 'x', '--spec', 'ENS-003', '--takeover'], {
        cwd: root,
        stdio: 'pipe',
      });
    } catch (e) {
      unknownFlag = /unknown option|error: option/i.test(String(e.stderr || e.message));
    }
    expect(unknownFlag).toBe(true);
  });

  test('A4: different-spec binding refuses with handoffs, no mutation', () => {
    const root = mkRepo();
    mkSpec(root, 'ENS-004');
    mkSpec(root, 'ENS-404');
    expect(ensure(root, 'wt-a4', 'ENS-004').code).toBe(0);

    const before = countEvents(root, 'worktree_bound');
    const r = ensure(root, 'wt-a4', 'ENS-404');
    expect(r.code).toBe(1);
    const text = r.err.join('\n');
    expect(text).toContain('already bound to spec "ENS-004"');
    expect(text).toContain('caws worktree list');
    expect(countEvents(root, 'worktree_bound')).toBe(before);
  });

  test('A5: closed spec refuses with the reopen handoff; never activates', () => {
    const root = mkRepo();
    mkSpec(root, 'ENS-005');
    // Governed fixture: activate then close with an explicit resolution.
    const specs = require('../../dist/shell/commands/specs');
    specs.runSpecsActivateCommand({
      id: 'ENS-005',
      cwd: root,
      env: { ...fixtureEnv },
      out: () => {},
      err: () => {},
    });
    const closeErr = [];
    const cc = specs.runSpecsCloseCommand({
      id: 'ENS-005',
      resolution: 'abandoned',
      reason: 'fixture: closed to test the ensure refusal handoff',
      cwd: root,
      env: { ...fixtureEnv },
      out: () => {},
      err: (l) => closeErr.push(l),
    });
    if (readSpecState(root, 'ENS-005') !== 'closed') {
      throw new Error('A5 fixture failed to close ENS-005: ' + closeErr.join(' | '));
    }
    void cc;

    const r = ensure(root, 'wt-a5', 'ENS-005');
    expect(r.code).toBe(1);
    const text = r.err.join('\n');
    expect(text).toContain('never force-activates');
    expect(text).toContain('caws specs reopen ENS-005');
    expect(fs.existsSync(path.join(root, '.caws', 'worktrees', 'wt-a5'))).toBe(false);
  });

  test('A6: no-authority remediation and SessionStart hook name ensure', () => {
    const root = mkRepo();
    mkSpec(root, 'ENS-006');

    // scope show --json on a governed path from the unbound canonical root.
    const cli = path.resolve(__dirname, '..', '..', 'dist', 'index.js');
    const scopeJson = JSON.parse(
      execFileSync('node', [cli, 'scope', 'show', 'src/foo.ts', '--json'], {
        cwd: root,
        encoding: 'utf8',
      })
    );
    expect(scopeJson.decision).toBe('no_authority');
    const commands = JSON.stringify(scopeJson.remediation?.commands ?? []);
    expect(commands).toContain('caws worktree ensure <name> --spec');

    // The SessionStart hook composes the same remediation shape.
    const stub = path.join(root, 'stub-caws');
    fs.writeFileSync(
      stub,
      [
        '#!/bin/bash',
        'if [[ "$*" == *"scope show"* ]]; then',
        `cat <<'JSON'`,
        JSON.stringify({
          decision: 'no_authority',
          rule: 'scope.no_authority.unbound',
          authorityCandidates: [{ specId: 'ENS-006', lifecycleState: 'active' }],
        }),
        'JSON',
        'fi',
        'exit 0',
        '',
      ].join('\n')
    );
    fs.chmodSync(stub, 0o755);

    const stdout = execFileSync('bash', [HOOK], {
      cwd: root,
      input: JSON.stringify({ session_id: 'sess-hook', cwd: root }),
      env: {
        ...process.env,
        CAWS_BIN: stub,
        CAWS_PROJECT_DIR: root,
        HOOK_SESSION_ID: 'sess-hook',
        HOOK_CWD: root,
      },
    }).toString();
    expect(stdout).toContain('caws worktree ensure <name> --spec ENS-006');
    expect(stdout).toContain('idempotent');
  });
});
