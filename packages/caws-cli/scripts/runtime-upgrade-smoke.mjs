#!/usr/bin/env node
// Qualify installed artifacts in disposable machine homes. Never consult the
// developer's CAWS registration, npm config, Git hooks, or agent identity.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const packageName = '@paths.design/caws-cli';
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');

export function isolatedEnvironment(root, inherited = process.env) {
  const home = path.join(root, 'home');
  const env = Object.fromEntries(['PATH', 'SystemRoot', 'COMSPEC', 'PATHEXT', 'TMPDIR', 'TMP', 'TEMP']
    .filter(key => inherited[key]).map(key => [key, inherited[key]]));
  return { ...env, HOME: home, USERPROFILE: home, CAWS_HOME: path.join(home, '.caws'),
    GIT_CONFIG_GLOBAL: path.join(home, '.gitconfig'), GIT_CONFIG_SYSTEM: '/dev/null',
    GIT_AUTHOR_NAME: 'Upgrade fixture', GIT_AUTHOR_EMAIL: 'fixture@example.invalid',
    GIT_COMMITTER_NAME: 'Upgrade fixture', GIT_COMMITTER_EMAIL: 'fixture@example.invalid',
    GIT_TERMINAL_PROMPT: '0', npm_config_cache: path.join(root, 'npm-cache'),
    npm_config_userconfig: path.join(home, '.npmrc'), npm_config_update_notifier: 'false',
    PYTHONDONTWRITEBYTECODE: '1' };
}

function run(command, args, cwd, env, options = {}) {
  const result = spawnSync(command, args, { cwd, env, encoding: 'utf8', timeout: 300000,
    maxBuffer: 8 * 1024 * 1024, ...options });
  if (result.status !== 0) throw new Error(`${command} ${args.join(' ')}: exit ${result.status}\n${result.error?.message ?? ''}\n${result.stdout}\n${result.stderr}`);
  return result.stdout;
}
const json = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));
function write(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}
function snapshot(root, accept = () => true) {
  const result = {};
  function visit(dir) {
    if (!fs.existsSync(dir)) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const file = path.join(dir, entry.name), relative = path.relative(root, file);
      if (!accept(relative)) continue;
      if (entry.isDirectory()) visit(file);
      else if (entry.isFile()) result[relative] = hash(fs.readFileSync(file));
      else throw new Error(`Unexpected fixture link: ${file}`);
    }
  }
  visit(root);
  return result;
}
const governance = repo => snapshot(path.join(repo, '.caws'), rel =>
  ['policy.yaml', 'specs', 'waivers', 'events.jsonl', 'worktrees.json', 'agents.json'].includes(rel.split(path.sep)[0]));

export function qualify({ candidate = packageRoot, baseline = `${packageName}@12.1.0`, reportPath } = {}) {
  candidate = fs.realpathSync(candidate);
  if (!fs.existsSync(path.join(candidate, 'dist/index.js'))) throw new Error('Built candidate dist/index.js is required');
  if (json(path.join(candidate, 'package.json')).name !== packageName) throw new Error('Expected CAWS CLI candidate');
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'caws-runtime-upgrade-')));
  const env = isolatedEnvironment(root);
  fs.mkdirSync(env.HOME, { recursive: true });
  // Detached npm installation: no workspace dependencies or lifecycle repair.
  const consumer = path.join(root, 'consumer');
  write(path.join(consumer, 'package.json'), '{"private":true}');
  const entry = path.join(consumer, 'node_modules', packageName, 'dist/index.js');
  const cli = (cwd, ...args) => run(process.execPath, [entry, ...args], cwd, env);
  const git = (cwd, ...args) => run('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgsign=false', ...args], cwd, env);
  const step = message => console.log(`[runtime-upgrade] ${message}`);
  const report = { schemaVersion: 1, candidateVersion: json(path.join(candidate, 'package.json')).version,
    baseline, platform: process.platform, node: process.version, cases: [], proof: 'installed-artifact subprocess fixtures; native harness activation is separate' };
  try {
    step('install published baseline and materialize stock/custom projects');
    run('npm', ['install', '--ignore-scripts', '--no-audit', '--no-fund', baseline], consumer, env);
    report.baselineVersion = cli(consumer, '--version').trim();
    const fixtures = [];
    for (const surface of ['codex', 'claude-code']) {
      for (const custom of [false, true]) {
        const name = `${surface}-${custom ? 'custom' : 'stock'}`;
        const repo = path.join(root, name); fs.mkdirSync(repo);
        git(repo, 'init', '-q', '-b', 'main');
        git(repo, 'commit', '--allow-empty', '-qm', 'fixture');
        cli(repo, 'init', '--agent-surface', surface);
        const native = path.join(repo, surface === 'codex' ? '.codex/hooks.json' : '.claude/settings.json');
        assert.ok(fs.existsSync(native), `baseline native hooks missing: ${name}`);
        if (custom) {
          const hook = path.join(repo, '.caws/hooks/qualification-custom.sh');
          write(hook, '#!/bin/bash\necho qualification-custom-ran >&2\n');
          fs.chmodSync(hook, 0o755);
          const dispatcher = path.join(repo, '.caws/hooks/dispatch/pre_tool_use.sh');
          const bytes = fs.readFileSync(dispatcher, 'utf8');
          assert.ok(bytes.includes('HANDLERS=('));
          write(dispatcher, bytes.replace('HANDLERS=(', 'HANDLERS=(\n  "qualification-custom.sh"'));
        }
        git(repo, 'add', '.'); git(repo, 'commit', '-qm', 'baseline project');
        fixtures.push({ name, repo, surface, custom, native, before: governance(repo) });
      }
    }
    step('pack candidate, replace baseline package and install global runtime');
    const packed = JSON.parse(run('npm', ['pack', '--json', '--pack-destination', root], candidate, env));
    const tarball = path.join(root, packed[0].filename);
    report.tarballSha256 = hash(fs.readFileSync(tarball));
    run('npm', ['install', '--ignore-scripts', '--no-audit', '--no-fund', tarball], consumer, env);
    assert.equal(cli(consumer, '--version').trim(), report.candidateVersion);
    // Consumer resolution does not inherit workspace overrides or its lockfile.
    // Audit the actual upgraded installation before trusting the package check.
    const audit = JSON.parse(run('npm', ['audit', '--omit=dev', '--audit-level=low', '--json'], consumer, env));
    assert.equal(audit.metadata.vulnerabilities.total, 0);
    report.productionAudit = { vulnerabilities: audit.metadata.vulnerabilities,
      lockfileSha256: hash(fs.readFileSync(path.join(consumer, 'package-lock.json'))) };
    report.cases.push({ name: 'installed-production-audit', zeroFindings: true });
    const installed = JSON.parse(cli(consumer, 'init', 'adapters', 'install', '--json'));
    report.runtimeDigest = installed.digest;
    assert.equal(JSON.parse(cli(consumer, 'init', 'adapters', 'install', '--plan', '--json')).changed, false);
    for (const surface of ['codex', 'claude-code']) {
      cli(consumer, 'init', 'adapters', 'configure', '--agent-surface', surface, '--json');
      assert.equal(JSON.parse(cli(consumer, 'init', 'adapters', 'configure', '--agent-surface', surface, '--plan', '--json')).changed, false);
    }
    const blank = () => ({ disabled: {}, extensions: {}, handlers: {}, libraries: {} });
    // Mixed fleet: user transport defers while baseline native hooks remain.
    const hook = (f, event, extra = {}, runtimeEnv = {}) => spawnSync('python3',
      [path.join(env.CAWS_HOME, 'bin/caws-hook'), f.surface, event, '--system'], {
        cwd: f.cwd ?? f.repo, env: { ...env, ...runtimeEnv }, encoding: 'utf8', timeout: 60000,
        input: JSON.stringify({ cwd: f.cwd ?? f.repo, session_id: `qualification-${f.name}`,
          tool_name: 'Write', tool_input: { file_path: path.join(f.repo, f.surface === 'codex' ? '.codex' : '.claude', 'hooks/qualification-probe.sh'), content: 'forbidden fixture write' }, ...extra }),
      });
    const deferred = hook(fixtures[0], 'pre_tool_use');
    assert.equal(deferred.status, 0, deferred.stderr); assert.equal(deferred.stdout, '');
    for (const f of fixtures) {
      step(`migrate ${f.name}, retaining exact governance and reviewed custom behavior`);
      const before = snapshot(f.repo, rel => !rel.startsWith('.git'));
      const preview = JSON.parse(cli(f.repo, 'init', 'adapters', 'migrate', '--agent-surface', f.surface, '--plan', '--json'));
      assert.ok(preview.readOnly);
      assert.deepEqual(snapshot(f.repo, rel => !rel.startsWith('.git')), before);
      const policy = blank();
      if (f.custom) {
        policy.extensions.pre_tool_use = [{ handler: 'qualification-custom.sh', before: 'cwd-guard.sh' }];
        policy.handlers['qualification-custom.sh'] = '.caws/hooks/qualification-custom.sh';
      }
      const policyFile = path.join(root, `${f.name}-policy.json`); write(policyFile, JSON.stringify(policy));
      // --from encodes reviewed behavior; use it only for the custom case.
      const args = ['init', 'adapters', 'migrate', '--agent-surface', f.surface,
        ...(f.custom ? ['--from', policyFile] : []), '--json'];
      const applied = JSON.parse(cli(f.repo, ...args)); assert.equal(applied.results[0].ok, true);
      assert.equal(JSON.parse(cli(f.repo, ...args, '--plan')).results[0].changed, false);
      assert.deepEqual(governance(f.repo), f.before);
      const denial = hook(f, 'pre_tool_use');
      assert.equal(denial.status, 2, JSON.stringify({ fixture: f.name, stdout: denial.stdout, stderr: denial.stderr }));
      assert.match(denial.stderr + denial.stdout, /protected|scope|governed/i);
      if (f.custom) assert.match(denial.stderr, /qualification-custom-ran/);
      assert.deepEqual(governance(f.repo), f.before);
      report.cases.push({ name: f.name, migrated: true, denied: true, governancePreserved: true });
    }
    // A newly initialized project inherits system hooks without local copies.
    const fresh = path.join(root, 'fresh'); fs.mkdirSync(fresh);
    git(fresh, 'init', '-q', '-b', 'main'); git(fresh, 'commit', '--allow-empty', '-qm', 'fixture');
    cli(fresh, 'init', '--agent-surface', 'codex');
    assert.equal(fs.existsSync(path.join(fresh, '.caws/hooks')), false);
    assert.equal(fs.existsSync(path.join(fresh, '.codex/hooks.json')), false);
    report.cases.push({ name: 'fresh-global', noLocalHookCopies: true });
    // A linked checkout uses canonical policy and session output.
    const linked = path.join(root, 'linked');
    git(fixtures[0].repo, 'worktree', 'add', '-qb', 'linked', linked);
    const linkedDenial = hook({ ...fixtures[0], cwd: linked }, 'pre_tool_use');
    assert.equal(linkedDenial.status, 2, linkedDenial.stderr);
    report.cases.push({ name: 'linked-worktree', denied: true });

    step('exercise stock lifecycle and shared renderer from installed runtime');
    const prompt = 'Keep the migration evidence and this exact operator request.';
    const transcript = path.join(root, 'transcript.jsonl');
    const ts = '2026-09-07T12:00:00.000Z';
    const records = [
      { timestamp: ts, type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: prompt }] } },
      { timestamp: ts, type: 'response_item', payload: { type: 'function_call', name: 'exec_command', call_id: 'q-call', arguments: JSON.stringify({ cmd: 'pwd' }) } },
      { timestamp: ts, type: 'response_item', payload: { type: 'function_call_output', call_id: 'q-call', output: 'Process exited with code 0\nfixture-directory' } },
      { timestamp: ts, type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Migration evidence retained.' }] } },
    ];
    write(transcript, records.map(r => JSON.stringify(r)).join('\n') + '\n');
    for (const event of ['session_start', 'post_tool_use', 'pre_compact', 'stop']) {
      const result = hook(fixtures[0], event, { transcript_path: transcript, tool_name: 'Read', tool_input: { file_path: 'README.md' } });
      assert.equal(result.status, 0, `${event}: ${result.stderr}`);
    }
    const turn = json(path.join(fixtures[0].repo, '.caws/sessions', `qualification-${fixtures[0].name}`, 'turn-001.json'));
    assert.equal(turn.user, prompt);
    assert.match(JSON.stringify(turn.timeline), /q-call|fixture-directory|pwd/);
    report.cases.push({ name: 'lifecycle-renderer', userPreserved: true, toolPreserved: true });

    step('verify a single update reaches two migrated projects and rollback recovers');
    // Instrument disposable candidate templates, preserving stock behavior.
    // Never modify a live snapshot or the candidate being qualified.
    const templates = path.join(root, 'updated-templates');
    fs.cpSync(path.join(consumer, 'node_modules', packageName, 'templates/hook-packs'), templates, { recursive: true });
    const guard = path.join(templates, 'shared/protected-paths.sh');
    write(guard, fs.readFileSync(guard, 'utf8').replace('#!/bin/bash', '#!/bin/bash\necho qualification-updated-guard >&2'));
    const renderer = path.join(templates, 'shared/session_log_renderer.py');
    write(renderer, fs.readFileSync(renderer, 'utf8').replace('    raise SystemExit(main())',
      '    from pathlib import Path\n    import os\n    Path(os.environ["CAWS_QUALIFICATION_RENDER_MARKER"]).write_text("updated-renderer")\n    raise SystemExit(main())'));
    const module = path.join(consumer, 'node_modules', packageName, 'dist/init/machine-adapters.js');
    const update = JSON.parse(run(process.execPath, ['-e',
      'const m=require(process.argv[1]);process.stdout.write(JSON.stringify(m.installMachineRuntime({home:process.argv[2],templatesRoot:process.argv[3]})))', module, env.CAWS_HOME, templates], consumer, env));
    assert.notEqual(update.digest, installed.digest);
    for (const f of fixtures.filter(f => f.surface === 'codex')) {
      const marker = path.join(root, `${f.name}-render-marker`);
      const denial = hook(f, 'pre_tool_use'); assert.equal(denial.status, 2);
      assert.match(denial.stderr, /qualification-updated-guard/);
      const stop = hook(f, 'stop', { transcript_path: transcript }, { CAWS_QUALIFICATION_RENDER_MARKER: marker });
      assert.equal(stop.status, 0, stop.stderr); assert.equal(fs.readFileSync(marker, 'utf8'), 'updated-renderer');
      assert.deepEqual(governance(f.repo), f.before);
    }
    // Corrupt only the disposable active snapshot: refusal, then verified rollback.
    const activeFile = path.join(env.CAWS_HOME, 'lib/runtimes', update.digest, 'protected-paths.sh');
    fs.appendFileSync(activeFile, '\n# corruption control\n');
    const corrupt = hook(fixtures[0], 'pre_tool_use'); assert.equal(corrupt.status, 2); assert.match(corrupt.stderr, /Runtime modified/);
    const rollback = JSON.parse(cli(consumer, 'init', 'adapters', 'rollback', '--json'));
    assert.equal(rollback.digest, installed.digest);
    const recovered = hook(fixtures[0], 'pre_tool_use'); assert.equal(recovered.status, 2);
    assert.doesNotMatch(recovered.stderr, /qualification-updated-guard|Runtime modified/);
    report.cases.push({ name: 'update-corruption-rollback', twoProjectGuardAndRendererUpdate: true, recovered: true });
    report.ok = true;
    if (reportPath) write(path.resolve(reportPath), JSON.stringify(report, null, 2) + '\n');
    step(`PASS: ${report.cases.length} cases; candidate ${report.tarballSha256}`);
    return report;
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const options = {};
    for (let i = 2; i < process.argv.length; i += 2) {
      const flag = process.argv[i], value = process.argv[i + 1];
      const key = { '--package': 'candidate', '--baseline': 'baseline', '--report': 'reportPath' }[flag];
      if (!key || !value) throw new Error('Usage: runtime-upgrade-smoke.mjs [--package built-package] [--baseline package-or-tarball] [--report path]');
      options[key] = value;
    }
    qualify(options);
  } catch (error) {
    console.error(`[runtime-upgrade] FAIL: ${error.stack}`);
    process.exitCode = 1;
  }
}
