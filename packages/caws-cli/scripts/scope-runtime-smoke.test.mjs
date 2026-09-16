import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, URL } from 'node:url';
import { isolatedEnvironment, observedSpawn } from './runtime-upgrade-smoke.mjs';

const entry = fileURLToPath(new URL('../dist/index.js', import.meta.url));
const quote = (text) => "'" + text.replaceAll("'", "'\\''") + "'";

// Unlike the Bats contract stubs, this fixture gives the real CLI conflicting
// canonical/lane answers. A correct path with the wrong cwd must fail here.
test('installed scope guard evaluates root and nested targets in their bound lane', () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'caws-scope-runtime-')));
  const repo = path.join(root, 'repo');
  const env = { ...isolatedEnvironment(root), CAWS_SESSION_ID: 'scope-runtime-owner', CI: 'true' };
  const artifactParent = process.env.CAWS_TEST_ARTIFACT_DIR;
  let artifacts;
  if (artifactParent) {
    fs.mkdirSync(artifactParent, { recursive: true });
    artifacts = fs.mkdtempSync(path.join(path.resolve(artifactParent), 'scope-runtime-'));
    env.CAWS_QUALIFICATION_ARTIFACT_DIR = artifacts;
  }
  const run = (command, args, cwd = repo, extra = {}) => {
    const result = observedSpawn(command, args, {
      cwd,
      env,
      encoding: 'utf8',
      timeout: 60000,
      ...extra,
    });
    assert.equal(
      result.status,
      0,
      `${command} ${args.join(' ')}: ${result.stderr}\n${result.stdout}`
    );
    return result.stdout;
  };
  const cli = (args, cwd = repo) => run(process.execPath, [entry, ...args], cwd);
  try {
    fs.mkdirSync(repo, { recursive: true });
    fs.mkdirSync(env.HOME, { recursive: true });
    run('git', ['init', '-q', '-b', 'main']);
    run('git', ['config', 'core.hooksPath', '/dev/null']);
    run('git', ['config', 'commit.gpgsign', 'false']);
    run('git', ['commit', '--allow-empty', '-qm', 'fixture root']);
    cli(['init', '--agent-surface', 'claude-code']);
    const spec = (id, scope) =>
      cli([
        'specs',
        'create',
        id,
        '--title',
        id,
        '--mode',
        'fix',
        '--risk-tier',
        '3',
        '--activate',
        '--module',
        'fixture',
        '--invariant',
        'Only the bound spec decides scope',
        '--acceptance',
        'Exercise scope decisions',
        ...scope.flatMap((p) => ['--scope-in', p]),
      ]);
    spec('SCOPE-OWNER-001', ['package.json', 'src/owned/']);
    spec('SCOPE-OTHER-001', ['package.json', 'blocked.json', 'src/owned/', 'src/other/']);
    cli(['worktree', 'create', 'wt-scope', '--spec', 'SCOPE-OWNER-001']);
    cli(['worktree', 'create', 'wt-other', '--spec', 'SCOPE-OTHER-001']);
    const lane = path.join(repo, '.caws/worktrees/wt-scope');
    // This shim selects the built CLI; it does not stub its decisions.
    const bin = path.join(root, 'bin');
    fs.mkdirSync(bin);
    fs.writeFileSync(
      path.join(bin, 'caws'),
      `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(entry)} "$@"\n`,
      { mode: 0o755 }
    );
    env.PATH = bin + path.delimiter + env.PATH;
    const strikesFile = path.join(
      env.HOME,
      '.caws/state/sessions/scope-runtime-owner/strikes.json'
    );
    const cases = [],
      failures = [];
    for (const [target, admitted, strikeCount] of [
      ['package.json', true, 0],
      ['src/owned/ok.ts', true, 0],
      ['blocked.json', false, 1],
      ['src/other/no.ts', false, 2],
      ['blocked.json', false, 3],
      ['package.json', true, 3],
    ]) {
      const canonical = JSON.parse(cli(['scope', 'show', target, '--json']));
      const bound = JSON.parse(cli(['scope', 'show', target, '--json'], lane));
      assert.equal(bound.boundSpecId, 'SCOPE-OWNER-001');
      assert.equal(bound.decision, admitted ? 'admit' : 'reject');
      assert.notEqual(
        canonical.decision,
        bound.decision,
        'fixture must distinguish canonical and lane authority'
      );
      const result = observedSpawn('bash', [path.join(repo, '.caws/hooks/scope-guard.sh')], {
        cwd: repo,
        env: { ...env, CAWS_PROJECT_DIR: repo, CAWS_AGENT_SURFACE: 'claude-code', HOOK_CWD: repo },
        encoding: 'utf8',
        timeout: 60000,
        input: JSON.stringify({
          cwd: repo,
          session_id: 'scope-runtime-owner',
          tool_name: 'Edit',
          tool_input: { file_path: path.join(lane, target) },
        }),
      });
      const strikes = fs.existsSync(strikesFile)
        ? JSON.parse(fs.readFileSync(strikesFile, 'utf8'))
        : {};
      cases.push({
        target,
        admitted,
        canonical,
        bound,
        strikes,
        exit_code: result.status,
        stdout: result.stdout,
        stderr: result.stderr,
      });
      if (artifacts)
        fs.writeFileSync(
          path.join(artifacts, 'scope-decisions.json'),
          JSON.stringify(cases, null, 2)
        );
      try {
        assert.equal(result.status, 0, result.stderr);
        assert.equal(strikes.scope_guard ?? 0, strikeCount);
        if (admitted) assert.equal(result.stdout, '', `admitted ${target}: ${result.stdout}`);
        else {
          assert.match(result.stdout, /not in the defined scope/);
          assert.match(result.stdout, /SCOPE-OWNER-001/);
          const response = JSON.parse(result.stdout);
          if (strikeCount === 1) {
            assert.match(response.hookSpecificOutput.additionalContext, /This edit proceeds/);
            assert.equal(response.hookSpecificOutput.permissionDecision, undefined);
          } else if (strikeCount === 2) {
            assert.equal(response.hookSpecificOutput.permissionDecision, 'ask');
          } else {
            assert.equal(response.decision, 'block');
          }
        }
      } catch (error) {
        failures.push({ target, message: error.message });
      }
    }
    assert.deepEqual(failures, [], JSON.stringify(failures, null, 2));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
