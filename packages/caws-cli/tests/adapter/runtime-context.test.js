'use strict';
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawnSync } = require('node:child_process');
const { installMachineRuntime } = require('../../dist/init/machine-adapters');
const cli = path.resolve(__dirname, '../../dist/index.js');

test('real CLI grant crosses repositories and a linked worktree; the real ownership guard still refuses a foreign session', () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'caws-context-')));
  const repo = path.join(root, 'project');
  const home = path.join(root, 'machine');
  fs.mkdirSync(repo);
  // Deliberately isolated human/agent environments. No grant targets the live
  // developer session or the real machine home.
  const human = {
    PATH: process.env.PATH,
    HOME: path.join(root, 'user'),
    CAWS_HOME: home,
    CI: 'true',
  };
  const owner = { ...human, CODEX_THREAD_ID: 'fixture-owner', CAWS_AGENT_SURFACE: 'codex' };
  function run(command, args, cwd = repo, env = owner) {
    const result = spawnSync(command, args, { cwd, env, encoding: 'utf8' });
    if (result.status !== 0)
      throw new Error(`${command} ${args.join(' ')}: ${result.stdout}\n${result.stderr}`);
    return result;
  }
  try {
    run('git', ['init', '-q', '-b', 'main']);
    run('git', ['config', 'user.email', 'fixture@example.invalid']);
    run('git', ['config', 'user.name', 'Fixture']);
    run('git', ['commit', '-q', '--allow-empty', '-m', 'fixture']);
    run(process.execPath, [cli, 'init', '--agent-surface', 'codex']);
    run(process.execPath, [
      cli,
      'specs',
      'create',
      'FIX-CONTEXT-001',
      '--title',
      'Fixture context',
      '--mode',
      'chore',
      '--risk-tier',
      '3',
      '--scope-in',
      'src',
      '--module',
      'fixture',
    ]);
    run(process.execPath, [cli, 'worktree', 'create', 'fixture', '--spec', 'FIX-CONTEXT-001']);
    const worktree = path.join(repo, '.caws/worktrees/fixture');
    const runtime = installMachineRuntime({ home });
    fs.writeFileSync(
      path.join(repo, '.caws/hooks/context.sh'),
      '#!/bin/bash\nprintf "session=%s root=%s policy=%s digest=%s\\n" "$CAWS_SESSION_ID" "$CAWS_PROJECT_DIR" "$CAWS_MACHINE_POLICY_ROOT" "$CAWS_ADAPTER_RUNTIME_DIGEST" >&2\n',
      { mode: 0o755 }
    );
    const policy = {
      version: 1,
      surfaces: {
        codex: {
          libraries: {},
          events: {
            pre_tool_use: {
              hooks_dir: '.caws/hooks',
              handlers: ['context.sh', 'worktree-write-guard.sh'],
            },
          },
        },
      },
    };
    fs.writeFileSync(path.join(repo, '.caws/hooks/adapter-policy.json'), JSON.stringify(policy));
    function dispatch(cwd, session) {
      return spawnSync('python3', [runtime.launcher, 'codex', 'pre_tool_use'], {
        cwd,
        encoding: 'utf8',
        env: {
          ...owner,
          CLAUDE_SESSION_ID: 'foreign-env',
          CODEX_THREAD_ID: 'foreign-env',
          CAWS_SESSION_ID: 'foreign-env',
          GIT_DIR: path.join(root, 'wrong-git-dir'),
        },
        input: JSON.stringify({
          cwd,
          session_id: session,
          tool_name: 'Write',
          tool_input: { file_path: path.join(worktree, 'src/example.ts') },
        }),
      });
    }
    const own = dispatch(worktree, 'fixture-owner');
    expect(own.status).toBe(0);
    expect(own.stderr).toContain(`session=fixture-owner root=${worktree} policy=${repo}`);
    const foreign = dispatch(worktree, 'fixture-foreign');
    expect(foreign.status).toBe(2);
    expect(foreign.stdout + foreign.stderr).toMatch(/claimed|owner|foreign/i);
    run(
      process.execPath,
      [
        cli,
        'reprieve',
        'grant',
        '--session',
        'fixture-foreign',
        '--surface',
        'codex',
        '--handlers',
        'worktree-write-guard.sh',
        '--reason',
        'isolated fixture grant',
        '--approved-by',
        'fixture-human',
        '--for',
        '5m',
      ],
      repo,
      human
    );
    for (const cwd of [repo, worktree]) {
      const allowed = dispatch(cwd, 'fixture-foreign');
      expect(allowed.status).toBe(0);
      expect(allowed.stderr).toContain(
        '[reprieve] worktree-write-guard.sh skipped for session fixture-foreign'
      );
    }
    const second = path.join(root, 'second');
    fs.mkdirSync(path.join(second, '.caws/hooks'), { recursive: true });
    run('git', ['init', '-q'], second);
    fs.writeFileSync(
      path.join(second, '.caws/hooks/worktree-write-guard.sh'),
      '#!/bin/bash\necho second-guard >&2\nexit 2\n',
      { mode: 0o755 }
    );
    policy.surfaces.codex.events.pre_tool_use.handlers = ['worktree-write-guard.sh'];
    fs.writeFileSync(path.join(second, '.caws/hooks/adapter-policy.json'), JSON.stringify(policy));
    expect(dispatch(second, 'fixture-foreign').status).toBe(0);
    expect(dispatch(second, 'another-session').status).toBe(2);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}, 30000);
