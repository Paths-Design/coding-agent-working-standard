'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const SHARED = path.resolve(__dirname, '../../templates/hook-packs/shared');
const A = '01a19f1c-5c86-7a71-a7a5-2970c0067bb4';
const B = '01a19ee1-c1bc-7981-bf56-9f3b08b6b591';
const OTHER = '01a1a23f-8c8c-7d93-bb8f-bbd0c50fad87';
const NAMES = 'Python python3 python3.9 python3.11 python3.12 python3.13 python3.14';

// A real live ancestor serves multiple calls. Its record and start time stay
// fixed while the native envelope IDs change, as in the desktop incident.
const ANCHOR = `
import json, os, subprocess, sys
from pathlib import Path
root, hooks = map(Path, sys.argv[1:3])
request = json.load(sys.stdin)
env = dict(os.environ, CAWS_AGENT_PROCESS_NAMES=${JSON.stringify(NAMES)})
probe = subprocess.run(['bash', '-c', 'source "$1"; resolve_agent_pid_with_start "$2"',
    'bash', str(hooks/'lib/agent-pid.sh'), env['CAWS_AGENT_PROCESS_NAMES']],
    env=env, capture_output=True, text=True, check=True).stdout.splitlines()
assert int(probe[0]) == os.getpid(), probe
assert probe[1].isdigit(), probe
record = {'agent_pid': os.getpid(), 'session_id': ${JSON.stringify(OTHER)},
    'surface': 'codex', 'started_at': int(probe[1]), 'last_seen_at': '2026-01-01T00:00:00Z'}
sessions = root/'.caws/sessions'
sessions.mkdir(parents=True, exist_ok=True)
(sessions/('agent-pid-%d.json' % os.getpid())).write_text(json.dumps(record))
results = []
for call in request:
    child_env = dict(env, **call.get('env', {}))
    result = subprocess.run(['bash', '-c', call['script'], 'bash', str(hooks)],
        input=call.get('input', ''), env=child_env, cwd=root,
        capture_output=True, text=True, timeout=20)
    results.append({'status': result.returncode, 'stdout': result.stdout, 'stderr': result.stderr})
print(json.dumps(results))
`;

let root, hooks, home;
beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'caws-payload-identity-')));
  hooks = path.join(root, '.caws/hooks');
  home = path.join(root, 'home');
  fs.mkdirSync(home);
  fs.cpSync(SHARED, hooks, { recursive: true });
  // The fixture adapter names its sacrificial Python host. Production core
  // resolver/guard bytes are unchanged; only the host process name differs.
  const adapter = path.join(hooks, 'lib/agent-surface.sh');
  const text = fs.readFileSync(adapter, 'utf8');
  expect(text).toContain('CAWS_AGENT_PROCESS_NAMES="codex"');
  fs.writeFileSync(
    adapter,
    text.replace('CAWS_AGENT_PROCESS_NAMES="codex"', `CAWS_AGENT_PROCESS_NAMES="${NAMES}"`)
  );
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

function calls(request) {
  const result = spawnSync('python3', ['-c', ANCHOR, root, hooks], {
    input: JSON.stringify(request),
    encoding: 'utf8',
    timeout: 30000,
    env: {
      PATH: process.env.PATH,
      HOME: home,
      CAWS_HOME: path.join(home, '.caws'),
      CAWS_PROJECT_DIR: root,
      CAWS_AGENT_SURFACE: 'codex',
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_CONFIG_SYSTEM: '/dev/null',
      LC_ALL: 'C',
    },
  });
  expect({ status: result.status, error: result.error, stderr: result.stderr }).toEqual({
    status: 0,
    error: undefined,
    stderr: '',
  });
  return JSON.parse(result.stdout);
}

const loadResolver = 'source "$1/lib/agent-pid.sh"; source "$1/lib/session-id.sh"; ';

test.each(['resolve_caws_session_id', 'resolve_caws_session_id_with_payload'])(
  '%s retains two native chats under one foreign PID record',
  (resolver) => {
    const results = calls(
      [A, B].map((id) => ({
        script: `${loadResolver}${resolver} "$CHAT"`,
        env: { CHAT: id, CODEX_THREAD_ID: OTHER },
      }))
    );
    expect(results).toEqual([A, B].map((id) => ({ status: 0, stdout: `${id}\n`, stderr: '' })));
  }
);

test('native identity survives normalization into downstream handler environment', () => {
  expect(
    calls([
      {
        script: `${loadResolver}id="$(resolve_caws_session_id_with_payload "$HOOK_SESSION_ID")"; caws_normalize_session_env "$id" >/dev/null; printf '%s\\n' "$CAWS_SESSION_ID"`,
        env: { HOOK_SESSION_ID: A, CAWS_SESSION_ID: OTHER },
      },
    ])
  ).toEqual([{ status: 0, stdout: `${A}\n`, stderr: '' }]);
});

test.each(['', 'unknown'])('unavailable payload %j preserves live PID fallback', (id) => {
  const [result] = calls([
    { script: `${loadResolver}resolve_caws_session_id "$CHAT"`, env: { CHAT: id } },
  ]);
  expect(result).toEqual({ status: 0, stdout: `${OTHER}\n`, stderr: '' });
});

test('absent payload retains the existing PID precedence over environment disagreement', () => {
  const [result] = calls([
    { script: `${loadResolver}resolve_caws_session_id`, env: { CAWS_SESSION_ID: A } },
  ]);
  expect(result.status).toBe(0);
  expect(result.stdout).toBe(`${OTHER}\n`);
  expect(result.stderr).toContain(`env/payload resolved ${A}`);
  expect(result.stderr).toContain(`process says ${OTHER}`);
});

test('native identity does not depend on consulting a PID reader', () => {
  const [result] = calls([
    {
      script: `source "$1/lib/session-id.sh"; read_session_id_from_agent_pid() { printf 'unexpected lookup' >&2; return 71; }; resolve_caws_session_id "$CHAT"`,
      env: { CHAT: A },
    },
  ]);
  expect(result).toEqual({ status: 0, stdout: `${A}\n`, stderr: '' });
});

test('real worktree guard admits each rightful native owner and refuses another native chat', () => {
  const registry = {};
  for (const [name, id] of [
    ['docs', A],
    ['pickup', B],
    ['rear', OTHER],
  ]) {
    const lane = path.join(root, '.caws/worktrees', name);
    fs.mkdirSync(lane, { recursive: true });
    registry[name] = {
      specId: 'IDENTITY-1',
      baseBranch: 'main',
      path: lane,
      owner: { session_id: id },
    };
  }
  fs.writeFileSync(path.join(root, '.caws/worktrees.json'), JSON.stringify(registry));
  const requests = [
    [A, 'docs'],
    [B, 'pickup'],
    [A, 'pickup'],
    [OTHER, 'docs'],
    [A, 'rear'],
  ].map(([id, name]) => ({
    script: 'source "$1/worktree-write-guard.sh"',
    input: JSON.stringify({
      tool_name: 'Write',
      cwd: root,
      session_id: id,
      permission_mode: 'bypassPermissions',
      tool_input: { file_path: path.join(registry[name].path, 'owned.txt'), content: 'x' },
    }),
  }));
  const results = calls(requests);
  for (const result of results.slice(0, 2))
    expect(result).toEqual({ status: 0, stdout: '', stderr: '' });
  for (const result of results.slice(2)) {
    expect(result.status).toBe(2);
    expect(result.stderr).toContain('DIFFERENT session');
  }
  for (const entry of Object.values(registry))
    expect(fs.existsSync(path.join(entry.path, 'owned.txt'))).toBe(false);
});

test('a third chat reprieve cannot transfer through the shared PID record', () => {
  const state = path.join(home, '.caws/state/sessions', OTHER);
  fs.mkdirSync(state, { recursive: true });
  fs.writeFileSync(
    path.join(state, `guard-reprieve-${OTHER}.json`),
    JSON.stringify({
      session_id: OTHER,
      created_at: new Date().toISOString(),
      expires_at: new Date(Date.now() + 60000).toISOString(),
      approved_by: 'fixture',
      reason: 'private fixture',
      handlers: ['worktree-write-guard.sh'],
    })
  );
  const results = calls(
    [A, B, OTHER].map((id) => ({
      env: { HOOK_SESSION_ID: id },
      script: `${loadResolver}source "$1/lib/reprieve.sh"; if caws_is_handler_reprieved worktree-write-guard.sh; then printf yes; else printf no; fi`,
    }))
  );
  expect(results).toEqual(['no', 'no', 'yes'].map((stdout) => ({ status: 0, stdout, stderr: '' })));
});
