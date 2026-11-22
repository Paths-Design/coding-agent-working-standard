'use strict';

/**
 * The Stop worktree reminder speaks only for the stopping session's own lanes.
 *
 * CAWS-GUARD-FALSE-SIGNALS-001. The reminder listed every active lane in the
 * registry (28 names in one observed rc session) and told the stopping agent
 * "If your work is complete, run: caws worktree destroy <name>", adding that
 * "Other agents cannot commit to the base branch until all worktrees are
 * destroyed" -- which is false (governed merges land while lanes are active)
 * and invites one agent to destroy another's work. Ownership here is the
 * claim oracle's rule: registry owner session id equal to the stopping
 * session id.
 *
 * Every case spawns the real handler against a real git project and reads its
 * stderr; the script never decides, so its output text is the behavior.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');

const SHARED = path.resolve(__dirname, '../../templates/hook-packs/shared');
const SELF = 'stop-owner-fixture';

let fx;

function git(cwd, ...args) {
  return execFileSync('git', ['-c', 'core.hooksPath=/dev/null', ...args], {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' },
  });
}

function fixture(registry) {
  const base = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'caws-stop-owner-'));
  const project = path.join(base, 'project');
  fs.mkdirSync(path.join(project, '.caws'), { recursive: true });
  git(project, 'init', '-q', '-b', 'main');
  git(
    project,
    '-c',
    'user.name=Fixture',
    '-c',
    'user.email=fixture@example.invalid',
    'commit',
    '-q',
    '--allow-empty',
    '-m',
    'fixture'
  );
  const hooks = path.join(base, 'hooks');
  fs.cpSync(SHARED, hooks, { recursive: true });
  if (registry !== undefined) {
    fs.writeFileSync(path.join(project, '.caws/worktrees.json'), JSON.stringify(registry));
  }
  fx = { base, project, hooks };
}

afterEach(() => {
  if (fx) fs.rmSync(fx.base, { recursive: true, force: true });
  fx = undefined;
});

function lane(owner, extra = {}) {
  return {
    path: '/nowhere/' + Math.random().toString(16).slice(2),
    branch: 'b',
    baseBranch: 'main',
    spec_id: 'FIXTURE-1',
    ...(owner === undefined ? {} : { owner }),
    ...extra,
  };
}

/**
 * Run the handler. `session` is the payload session id (null omits it);
 * `viaEnv` exports the dispatcher-parsed HOOK_* variables, otherwise the
 * handler must parse the payload from stdin itself.
 */
function stop({ session = SELF, viaEnv = true } = {}) {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (key.startsWith('HOOK_') || key.startsWith('_CAWS_') || key.startsWith('CAWS_')) {
      delete env[key];
    }
  }
  const payload = { hook_event_name: 'Stop', cwd: fx.project };
  if (session !== null) payload.session_id = session;
  const input = JSON.stringify(payload);
  const hookEnv = viaEnv
    ? {
        HOOK_EVENT_NAME: 'Stop',
        HOOK_TOOL_NAME: '',
        HOOK_INPUT_JSON: input,
        HOOK_SESSION_ID: session === null ? 'unknown' : session,
        HOOK_CWD: fx.project,
      }
    : {};
  const result = spawnSync('/bin/bash', [path.join(fx.hooks, 'stop-worktree-check.sh')], {
    cwd: fx.project,
    input,
    encoding: 'utf8',
    timeout: 15000,
    env: {
      ...env,
      HOME: fx.base,
      CAWS_HOME: path.join(fx.base, '.caws'),
      CAWS_PROJECT_DIR: fx.project,
      CLAUDE_PROJECT_DIR: fx.project,
      ...hookEnv,
    },
  });
  expect(result.error).toBeUndefined();
  expect(result.status).toBe(0);
  return result.stderr;
}

const DESTROY = 'caws worktree destroy';
const FALSE_CLAIM = 'cannot commit to the base branch';

describe('stop-worktree-check reminder ownership', () => {
  test('names only the stopping session lanes and counts the rest without naming them', () => {
    fixture({
      'mine-a': lane({ session_id: SELF, platform: 'claude-code' }),
      'mine-b': lane({ session_id: SELF, platform: 'claude-code' }, { status: 'active' }),
      'theirs-1': lane({ session_id: 'peer-1', platform: 'codex' }),
      'theirs-2': lane('peer-2'),
    });
    const err = stop();
    expect(err).toContain('REMINDER: this session owns 2 active worktree(s): mine-a, mine-b.');
    expect(err).toContain('caws worktree merge <name>');
    expect(err).toContain(
      '2 other active worktree(s) belong to other sessions and are not yours to merge or destroy.'
    );
    expect(err).not.toContain('theirs-1');
    expect(err).not.toContain('theirs-2');
    expect(err).not.toContain(DESTROY);
    expect(err).not.toContain(FALSE_CLAIM);
  });

  test('a session owning no lane gets a count of foreign lanes and no names or destroy step', () => {
    fixture({
      'theirs-1': lane({ session_id: 'peer-1' }),
      'theirs-2': lane({ session_id: 'peer-2' }),
      'theirs-3': lane(undefined),
    });
    const err = stop();
    expect(err).toContain(
      'REMINDER: this session owns no active worktrees. 3 active worktree(s) belong to other sessions and are not yours to merge or destroy.'
    );
    expect(err).not.toMatch(/theirs-\d/);
    expect(err).not.toContain(DESTROY);
    expect(err).not.toContain(FALSE_CLAIM);
  });

  test('without a usable session id no lane is named or attributed', () => {
    fixture({
      'mine-a': lane({ session_id: SELF }),
      'theirs-1': lane({ session_id: 'peer-1' }),
    });
    for (const viaEnv of [true, false]) {
      const err = stop({ session: null, viaEnv });
      expect(err).toContain(
        "REMINDER: 2 active worktree(s) are registered, but this session's identity is unavailable, so ownership could not be attributed."
      );
      expect(err).toContain('caws worktree list');
      expect(err).not.toContain('mine-a');
      expect(err).not.toContain('theirs-1');
      expect(err).not.toContain(DESTROY);
    }
  });

  test('the session id is read from the stdin payload when the dispatcher exported none', () => {
    fixture({
      'mine-a': lane({ session_id: SELF }),
      'theirs-1': lane({ session_id: 'peer-1' }),
    });
    const err = stop({ viaEnv: false });
    expect(err).toContain('REMINDER: this session owns 1 active worktree(s): mine-a.');
    expect(err).not.toContain('theirs-1');
  });

  test('ownership is exact session id equality, as in the claim oracle', () => {
    fixture({
      'prefixed-self': lane({ session_id: 'session-' + SELF }),
      'self-prefix': lane({ session_id: SELF.slice(0, 8) }),
    });
    const err = stop();
    expect(err).toContain('REMINDER: this session owns no active worktrees. 2 active worktree(s)');
    expect(err).not.toContain('prefixed-self');
  });

  test('lanes that are not active are neither listed nor counted', () => {
    fixture({
      'mine-merged': lane({ session_id: SELF }, { status: 'merged' }),
      'mine-live': lane({ session_id: SELF }, { status: 'fresh' }),
      'theirs-gone': lane({ session_id: 'peer-1' }, { status: 'destroyed' }),
    });
    const err = stop();
    expect(err).toContain('REMINDER: this session owns 1 active worktree(s): mine-live.');
    expect(err).not.toContain('mine-merged');
    expect(err).not.toContain('other active worktree');
  });

  test('an empty registry keeps the no-worktrees reminder without a destroy step', () => {
    fixture({});
    const err = stop();
    expect(err).toContain('REMINDER: No active worktrees.');
    expect(err).toContain('caws worktree create <name> --spec <id>');
    expect(err).not.toContain(DESTROY);
  });

  test('a project without a registry prints nothing', () => {
    fixture(undefined);
    expect(stop()).toBe('');
  });
});
