const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const helper = path.resolve(
  __dirname,
  '../../templates/hook-packs/shared/lib/session-render-writer.sh'
);
let root;
beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'caws-render-writer-client-')));
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

function fixture() {
  const recorder = path.join(root, 'native-recorder');
  // Boundary recorder only: tests argv custody and shell fallback behavior,
  // never OS locking, native child ownership or installed source adoption.
  fs.writeFileSync(
    recorder,
    '#!/bin/sh\nprintf \'%s\\000\' "$@" > "$RECORD"\nexit "${RESULT:-0}"\n',
    { mode: 0o700 }
  );
  const project = path.join(root, 'project');
  const fields = [
    path.join(project, '.caws/sessions/session-1'),
    project,
    'session-1',
    'started',
    'model',
    'branch',
    'head',
    '0',
    'start',
    path.join(root, 'transcript\nUS\x1f.jsonl'),
    '',
    '',
  ];
  return {
    recorder,
    project,
    fields,
    environment: {
      PATH: '/usr/bin:/bin',
      RECORD: path.join(root, 'argv.bin'),
      CAWS_HOME: path.join(root, 'home'),
      CAWS_ROOT: project,
      CAWS_RENDER_WRITER_NATIVE: recorder,
      CAWS_RENDER_WRITER_GENERATION: 'a'.repeat(64),
      CAWS_RENDER_WRITER_PYTHON: '/usr/bin/python3',
    },
  };
}
function readRecordedArguments(file) {
  const bytes = fs.readFileSync(file);
  expect(bytes.at(-1)).toBe(0);
  // Remove the final record delimiter only. Empty trailing argv fields remain
  // distinct records, including the renderer's empty audit/outcome arguments.
  return bytes.toString('utf8').split('\0').slice(0, -1);
}
function run(body, args, environment) {
  return spawnSync('/bin/bash', ['-c', 'source "$1"\nshift\n' + body, 'test', helper, ...args], {
    env: environment,
    cwd: root,
    encoding: 'utf8',
    timeout: 3000,
  });
}

test('cooperative one-shot preserves canonical ownership, generation and all twelve opaque fields', () => {
  const f = fixture();
  const renderer = path.join(root, "renderer ' $(touch injected).py");
  const result = run(
    'caws_session_render_writer "$@"',
    [f.project, '/usr/bin/python3', renderer, ...f.fields],
    f.environment
  );
  expect(result.status).toBe(0);
  expect(readRecordedArguments(f.environment.RECORD)).toEqual([
    'render-writer',
    '--home',
    f.environment.CAWS_HOME,
    '--canonical-project',
    f.project,
    '--output-directory',
    f.fields[0],
    '--session-id',
    'session-1',
    '--source-generation',
    'a'.repeat(64),
    '--timeout-ms',
    '30000',
    '--',
    '/usr/bin/python3',
    '-I',
    '-S',
    '-B',
    renderer,
    ...f.fields,
  ]);
  expect(fs.existsSync(path.join(root, 'injected'))).toBe(false);
});

test.each(['0', '2', '75', '137'])(
  'adopted legacy client permits no unfenced fallback after native status %s',
  (status) => {
    const f = fixture();
    const result = run(
      'if slrd_try_render "$@"; then printf served; else touch FALLBACK; fi',
      [path.join(root, 'hooks'), path.join(root, 'untrusted-lease.json'), ...f.fields],
      { ...f.environment, RESULT: status }
    );
    expect(result.status).toBe(status === '0' ? 0 : 75);
    expect(result.stdout).toBe(status === '0' ? 'served' : '');
    expect(fs.existsSync(path.join(root, 'FALLBACK'))).toBe(false);
    expect(readRecordedArguments(f.environment.RECORD).slice(-12)).toEqual(f.fields);
  }
);

test.each([
  [
    'missing native',
    (env) => {
      delete env.CAWS_RENDER_WRITER_NATIVE;
    },
  ],
  [
    'relative native',
    (env) => {
      env.CAWS_RENDER_WRITER_NATIVE = 'native';
    },
  ],
  [
    'missing home',
    (env) => {
      delete env.CAWS_HOME;
    },
  ],
  [
    'generation not a digest',
    (env) => {
      env.CAWS_RENDER_WRITER_GENERATION = 'not-a-generation';
    },
  ],
  [
    'invalid timeout',
    (env) => {
      env.CAWS_RENDER_WRITER_TIMEOUT_MS = '1; touch injected';
    },
  ],
  [
    'missing interpreter',
    (env) => {
      delete env.CAWS_RENDER_WRITER_PYTHON;
    },
  ],
])('partial adoption refuses %s before launching native or inline renderer', (_name, change) => {
  const f = fixture();
  change(f.environment);
  const result = run(
    'if slrd_try_render "$@"; then :; else touch FALLBACK; fi',
    [path.join(root, 'hooks'), path.join(root, 'lease'), ...f.fields],
    f.environment
  );
  expect(result.status).toBe(75);
  expect(fs.existsSync(f.environment.RECORD)).toBe(false);
  expect(fs.existsSync(path.join(root, 'FALLBACK'))).toBe(false);
});

test('cooperative daemon spawn is refused rather than creating a detached writer', () => {
  const f = fixture();
  const result = run('slrd_spawn "$@"\ntouch SPAWNED', [], f.environment);
  expect(result.status).toBe(75);
  expect(result.stderr).toContain('unmanaged daemon startup refused');
  expect(fs.existsSync(path.join(root, 'SPAWNED'))).toBe(false);
});

test.each(['0', '75'])(
  'actual stock session logger routes explicit adoption through custody (status %s)',
  (status) => {
    const f = fixture();
    fs.mkdirSync(f.project);
    fs.writeFileSync(f.fields[9], 'private transcript input');
    const logger = path.resolve(__dirname, '../../templates/hook-packs/shared/session-log.sh');
    const result = spawnSync('/bin/bash', [logger], {
      cwd: f.project,
      encoding: 'utf8',
      timeout: 3000,
      env: {
        ...f.environment,
        RESULT: status,
        CAWS_AGENT_SURFACE: 'codex',
        CAWS_PROJECT_DIR: f.project,
        HOOK_TOOL_NAME: '',
        HOOK_SESSION_ID: 'session-1',
        HOOK_EVENT_NAME: 'Stop',
        HOOK_CWD: f.project,
        HOOK_TRANSCRIPT_PATH: f.fields[9],
      },
    });
    expect(result.status).toBe(Number(status));
    const recorded = readRecordedArguments(f.environment.RECORD);
    expect(recorded.slice(0, 8)).toEqual([
      'render-writer',
      '--home',
      f.environment.CAWS_HOME,
      '--canonical-project',
      f.project,
      '--output-directory',
      f.fields[0],
      '--session-id',
    ]);
    expect(recorded[8]).toBe('session-1');
    expect(recorded.slice(-3)).toEqual([
      f.fields[9],
      path.join(f.project, '.codex/logs/audit.log'),
      path.join(f.fields[0], 'hook-events.jsonl'),
    ]);
  }
);
