'use strict';

/**
 * CAWS-DSH-HARNESS-PLUGIN-PARITY-001 A1/A4 — harness-plugin wiring observation.
 *
 * DSH's guard chain exists only when the active harness profile composes the
 * CAWS plugin bundle. `caws init --plan` and `caws doctor` consume this
 * observation, so its classifications are the difference between "reported
 * installed" and "actually governed".
 *
 * Covered here:
 *   - wired: profile selects the bundle, the bundle patch inserts all ids;
 *   - unwired: not installed, installed-but-not-selected, unresolvable,
 *     missing patch, patch without the CAWS ids;
 *   - unobserved: no profile environment, missing/invalid profile or patch —
 *     never silently upgraded to "unwired", because absence of evidence is not
 *     evidence of absence;
 *   - never throws on hostile input.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  observeHarnessPluginWiring,
  observeAllHarnessPluginWiring,
  harnessPluginFactsFor,
  renderHarnessPluginWiring,
} = require('../../dist/init/hook-packs/harness-plugin-wiring');

const BUNDLE = '@caws/dsh-bundle';
const IDS = ['caws-hooks', 'caws-session-log', 'caws-agents-lifecycle'];

function tmpdir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'caws-dsh-wiring-'));
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value, null, 2));
}

const PATCH_ALL = `- insert:
    - id: caws-hooks
      name: '@caws/dsh-bundle/hooks'
      config:
        surface: dsh
    - id: caws-session-log
      name: '@caws/dsh-bundle/session-log'
    - id: caws-agents-lifecycle
      name: '@caws/dsh-bundle/agents-lifecycle'
`;

/** Create a bundle checkout with a declared patch (unless suppressed). */
function makeBundle(root, { patch = PATCH_ALL, declared = true } = {}) {
  const dir = path.join(root, 'bundle');
  const pkg = { name: BUNDLE, version: '0.1.0', type: 'module' };
  if (declared) pkg.dsh = { bundle: { patch: './cordis.patch.yml' } };
  writeJson(path.join(dir, 'package.json'), pkg);
  if (patch !== null) fs.writeFileSync(path.join(dir, 'cordis.patch.yml'), patch);
  return dir;
}

/**
 * Create a profile directory. `dependency` defaults to a link: path into the
 * bundle checkout so resolution does not need a node_modules tree.
 */
function makeProfile({
  bundles = [BUNDLE],
  dependency = null,
  bundleDir = null,
  profilePackage = undefined,
} = {}) {
  const root = tmpdir();
  const profileDir = path.join(root, 'profile');
  fs.mkdirSync(profileDir, { recursive: true });
  const dependencies = {};
  if (dependency !== null) dependencies[BUNDLE] = dependency;
  else if (bundleDir !== null) dependencies[BUNDLE] = `link:${bundleDir}`;
  const manifest =
    profilePackage === undefined
      ? { name: 'dsh-profile-test', private: true, dependencies, dsh: { profile: { bundles } } }
      : profilePackage;
  writeJson(path.join(profileDir, 'package.json'), manifest);
  return { root, profileDir };
}

function envFor(profileDir) {
  return { DSH_PROFILE_DIR: profileDir, DSH_PROFILE: 'test-profile' };
}

function observe(profileDir) {
  return observeHarnessPluginWiring('dsh', { env: envFor(profileDir) });
}

describe('harness-plugin wiring observation (A1/A4)', () => {
  test('only surfaces with harness-plugin facts are observable', () => {
    expect(harnessPluginFactsFor('dsh')).toMatchObject({
      profileBundle: BUNDLE,
      pluginIds: IDS,
    });
    expect(harnessPluginFactsFor('claude-code')).toBeUndefined();
    expect(observeHarnessPluginWiring('claude-code')).toBeUndefined();
    expect(observeAllHarnessPluginWiring({ env: {} }).map((o) => o.surface)).toEqual(['dsh']);
  });

  test('WIRED when the profile selects the bundle and its patch inserts every id', () => {
    const root = tmpdir();
    const bundleDir = makeBundle(root);
    const { profileDir } = makeProfile({ bundleDir });
    const observation = observe(profileDir);
    expect(observation.kind).toBe('wired');
    expect(observation.profileName).toBe('test-profile');
    expect(observation.observedPluginIds).toEqual(IDS);
    expect(observation.missingPluginIds).toBeUndefined();
    const rendered = renderHarnessPluginWiring(observation).join('\n');
    expect(rendered).toContain('WIRED');
    expect(rendered).toContain(BUNDLE);
  });

  test('UNWIRED (not installed) when the profile neither declares nor selects the bundle', () => {
    const { profileDir } = makeProfile({ bundles: [] });
    const observation = observe(profileDir);
    expect(observation.kind).toBe('unwired');
    expect(observation.reason).toBe('bundle-not-installed');
    expect(observation.repair).toContain('dsh plugin --profile test-profile add');
    const rendered = renderHarnessPluginWiring(observation).join('\n');
    expect(rendered).toContain('NOT WIRED');
    expect(rendered).toContain('Repair:');
  });

  test('UNWIRED (installed but not selected) when the dependency exists but the bundle is absent from bundles', () => {
    const root = tmpdir();
    const bundleDir = makeBundle(root);
    const { profileDir } = makeProfile({ bundles: [], bundleDir });
    const observation = observe(profileDir);
    expect(observation.kind).toBe('unwired');
    expect(observation.reason).toBe('bundle-not-selected');
  });

  test('UNWIRED (unresolved) when the selected bundle package cannot be found', () => {
    const { profileDir } = makeProfile({
      bundles: [BUNDLE],
      dependency: `link:${path.join(tmpdir(), 'missing-bundle')}`,
    });
    const observation = observe(profileDir);
    expect(observation.kind).toBe('unwired');
    expect(observation.reason).toBe('bundle-unresolved');
  });

  test('UNWIRED (patch missing) when the bundle declares no dsh.bundle.patch', () => {
    const root = tmpdir();
    const bundleDir = makeBundle(root, { declared: false });
    const { profileDir } = makeProfile({ bundleDir });
    const observation = observe(profileDir);
    expect(observation.kind).toBe('unwired');
    expect(observation.reason).toBe('patch-missing');
  });

  test('UNWIRED (plugin-ids-missing) when the patch inserts only some CAWS ids', () => {
    const root = tmpdir();
    const bundleDir = makeBundle(root, {
      patch: `- insert:\n    - id: caws-hooks\n      name: '@caws/dsh-bundle/hooks'\n`,
    });
    const { profileDir } = makeProfile({ bundleDir });
    const observation = observe(profileDir);
    expect(observation.kind).toBe('unwired');
    expect(observation.reason).toBe('plugin-ids-missing');
    expect(observation.observedPluginIds).toEqual(['caws-hooks']);
    expect(observation.missingPluginIds).toEqual(['caws-session-log', 'caws-agents-lifecycle']);
    const rendered = renderHarnessPluginWiring(observation).join('\n');
    expect(rendered).toContain('missing plugin ids');
    expect(rendered).toContain('caws-agents-lifecycle');
  });

  test('id-targeted patch rows (no insert wrapper) are recognized', () => {
    const root = tmpdir();
    const patch = IDS.map((id) => `- id: ${id}\n  name: '@caws/dsh-bundle/${id}'\n`).join('');
    const bundleDir = makeBundle(root, { patch });
    const { profileDir } = makeProfile({ bundleDir });
    expect(observe(profileDir).kind).toBe('wired');
  });

  test('UNOBSERVED when no profile environment is readable', () => {
    const observation = observeHarnessPluginWiring('dsh', { env: {} });
    expect(observation.kind).toBe('unobserved');
    expect(observation.reason).toBe('no-profile-environment');
    expect(renderHarnessPluginWiring(observation).join('\n')).toContain('UNOBSERVED');
  });

  test('UNOBSERVED when the profile directory or package.json is missing', () => {
    const missingDir = path.join(tmpdir(), 'nope');
    expect(observe(missingDir).reason).toBe('profile-dir-missing');

    const root = tmpdir();
    const profileDir = path.join(root, 'profile');
    fs.mkdirSync(profileDir, { recursive: true });
    expect(observe(profileDir).reason).toBe('profile-package-missing');
  });

  test('UNOBSERVED (never wired) on invalid profile JSON or missing manifest shape', () => {
    const root = tmpdir();
    const profileDir = path.join(root, 'profile');
    fs.mkdirSync(profileDir, { recursive: true });
    fs.writeFileSync(path.join(profileDir, 'package.json'), '{ not json');
    expect(observe(profileDir).reason).toBe('profile-package-invalid');

    writeJson(path.join(profileDir, 'package.json'), { name: 'no-manifest' });
    expect(observe(profileDir).reason).toBe('profile-manifest-invalid');
  });

  test('UNOBSERVED when the bundle patch is unreadable or not a list', () => {
    const root = tmpdir();
    // Declared but absent.
    const absent = path.join(root, 'absent-bundle');
    writeJson(path.join(absent, 'package.json'), {
      name: BUNDLE,
      dsh: { bundle: { patch: './cordis.patch.yml' } },
    });
    const p1 = makeProfile({ bundleDir: absent });
    expect(observe(p1.profileDir).reason).toBe('patch-invalid');

    // Present but a YAML mapping instead of a list.
    const scalar = makeBundle(root, { patch: 'not: a list\n' });
    const p2 = makeProfile({ bundleDir: scalar });
    expect(observe(p2.profileDir).reason).toBe('patch-invalid');
  });

  test('never throws: malformed dependency specs and hostile manifests degrade to a verdict', () => {
    const root = tmpdir();
    const profileDir = path.join(root, 'profile');
    writeJson(path.join(profileDir, 'package.json'), {
      dependencies: { [BUNDLE]: 'file:../../../../../../etc/passwd' },
      dsh: { profile: { bundles: [BUNDLE] } },
    });
    const observation = observe(profileDir);
    expect(['unwired', 'unobserved']).toContain(observation.kind);
    expect(typeof observation.reason).toBe('string');
  });
});

/**
 * A1/A2 — init consumes the observation. The plan must report the verdict as
 * structured data, and the apply activation panel must say NOT WIRED with the
 * exact repair (never imply that installing the pack made the guard chain
 * live).
 */
describe('caws init --agent-surface dsh wiring integration (A1/A2)', () => {
  const { execFileSync } = require('child_process');
  const { initProject } = require('../../dist/store/init-store');
  const { runInitCommand } = require('../../dist/shell/commands/init');

  const ORIGINAL = {
    DSH_PROFILE_DIR: process.env.DSH_PROFILE_DIR,
    DSH_PROFILE: process.env.DSH_PROFILE,
    DSH_HOME: process.env.DSH_HOME,
  };

  afterEach(() => {
    for (const [key, value] of Object.entries(ORIGINAL)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  function makeInitializedRepo() {
    const root = tmpdir();
    execFileSync('git', ['init', '-q', root], { stdio: 'ignore' });
    const initialized = initProject(root);
    if (!initialized.ok) throw new Error('initProject failed');
    return root;
  }

  function runInit(repo, { plan, env }) {
    Object.assign(process.env, env);
    const lines = [];
    const errors = [];
    const home = tmpdir();
    const code = runInitCommand({
      cwd: repo,
      home,
      agentSurface: 'dsh',
      ...(plan ? { plan: true, json: true } : {}),
      out: (line) => lines.push(line),
      err: (line) => errors.push(line),
    });
    return { code, lines, errors, text: lines.join('\n') };
  }

  test('--plan --json exposes a wired observation for a composing profile', () => {
    const root = tmpdir();
    const bundleDir = makeBundle(root);
    const { profileDir } = makeProfile({ bundleDir });
    const repo = makeInitializedRepo();
    const result = runInit(repo, {
      plan: true,
      env: { DSH_PROFILE_DIR: profileDir, DSH_PROFILE: 'test-profile' },
    });
    expect(result.code).toBe(0);
    const plan = JSON.parse(result.text);
    expect(plan.read_only).toBe(true);
    expect(plan.selected_surface.surface).toBe('dsh');
    expect(plan.harness_plugin_wiring).toMatchObject({
      surface: 'dsh',
      kind: 'wired',
      profileName: 'test-profile',
    });
    expect(plan.harness_plugin_wiring.observedPluginIds).toEqual(IDS);
  });

  test('--plan --json exposes an unwired observation with the repair', () => {
    const { profileDir } = makeProfile({ bundles: [] });
    const repo = makeInitializedRepo();
    const result = runInit(repo, {
      plan: true,
      env: { DSH_PROFILE_DIR: profileDir, DSH_PROFILE: 'test-profile' },
    });
    expect(result.code).toBe(0);
    const plan = JSON.parse(result.text);
    expect(plan.harness_plugin_wiring.kind).toBe('unwired');
    expect(plan.harness_plugin_wiring.repair).toContain(
      'dsh plugin --profile test-profile add @caws/dsh-bundle'
    );
  });

  test('the apply activation panel says NOT WIRED and prints the repair', () => {
    const { profileDir } = makeProfile({ bundles: [] });
    const repo = makeInitializedRepo();
    const result = runInit(repo, {
      plan: false,
      env: { DSH_PROFILE_DIR: profileDir, DSH_PROFILE: 'test-profile' },
    });
    expect(result.code).toBe(0);
    expect(result.text).toContain('Hook plane: NOT WIRED');
    expect(result.text).toContain('CAWS guards will NOT run');
    expect(result.text).toContain('dsh plugin --profile test-profile add @caws/dsh-bundle');
    expect(result.text).not.toContain('Hooks are installed and wired');
  });

  test('unobserved environment renders UNOBSERVED rather than a guessed verdict', () => {
    const repo = makeInitializedRepo();
    delete process.env.DSH_PROFILE_DIR;
    delete process.env.DSH_PROFILE;
    const lines = [];
    const code = runInitCommand({
      cwd: repo,
      home: tmpdir(),
      agentSurface: 'dsh',
      out: (line) => lines.push(line),
      err: () => {},
    });
    expect(code).toBe(0);
    expect(lines.join('\n')).toContain('Hook plane: UNOBSERVED');
  });
});

/**
 * A3 end-to-end — `caws doctor` consumes the snapshot observation. The kernel
 * rule has its own unit suite; this arm proves the store actually observes the
 * active profile and that the rule fires through the CLI only in the
 * installed-and-unwired split-brain.
 */
describe('caws doctor surfaces the unwired DSH profile end to end (A3)', () => {
  const { spawnSync } = require('child_process');
  const { initProject } = require('../../dist/store/init-store');
  const DIST = path.resolve(__dirname, '..', '..', 'dist', 'index.js');

  const DSH_MARKER = `<!--
# CAWS-MANAGED-HOOK
# hook_pack: dsh
# hook_pack_version: 4
# caws_min_major: 11
# lineage_refs: 1
-->

# DSH surface doctrine fixture
`;

  function makeMarkedRepo() {
    const root = tmpdir();
    require('child_process').execFileSync('git', ['init', '-q', root], { stdio: 'ignore' });
    fs.writeFileSync(path.join(root, 'README.md'), 'fixture\n');
    const initialized = initProject(root);
    if (!initialized.ok) throw new Error('initProject failed');
    fs.mkdirSync(path.join(root, '.dsh'), { recursive: true });
    fs.writeFileSync(path.join(root, '.dsh', 'AGENTS.md'), DSH_MARKER);
    return root;
  }

  function runDoctor(repo, profileDir) {
    return spawnSync(process.execPath, [DIST, 'doctor'], {
      cwd: repo,
      encoding: 'utf8',
      env: { ...process.env, DSH_PROFILE_DIR: profileDir, DSH_PROFILE: 'test-profile' },
      timeout: 120000,
    });
  }

  test('an installed DSH pack plus an unwired profile emits the warning', () => {
    const repo = makeMarkedRepo();
    const { profileDir } = makeProfile({ bundles: [] });
    const result = runDoctor(repo, profileDir);
    const output = `${result.stdout}\n${result.stderr}`;
    expect(output).toContain('doctor.hooks.harness_plugin_unwired');
    expect(output).toContain('@caws/dsh-bundle');
  });

  test('a wired profile stays silent', () => {
    const repo = makeMarkedRepo();
    const root = tmpdir();
    const bundleDir = makeBundle(root);
    const { profileDir } = makeProfile({ bundleDir });
    const result = runDoctor(repo, profileDir);
    const output = `${result.stdout}\n${result.stderr}`;
    expect(output).not.toContain('doctor.hooks.harness_plugin_unwired');
  });
});
