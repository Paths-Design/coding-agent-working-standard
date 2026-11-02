const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const entry = path.resolve(__dirname, '../../dist/runtime/describe-entry.js');
const events = [
  'pre_tool_use',
  'post_tool_use',
  'session_start',
  'stop',
  'pre_compact',
  'session_end',
];
let root;
beforeEach(() => {
  const parent = process.env.CAWS_DESCRIBE_ENTRY_ARTIFACT_DIR || os.tmpdir();
  fs.mkdirSync(parent, { recursive: true });
  root = fs.realpathSync(fs.mkdtempSync(path.join(parent, 'caws-describe-entry-')));
});
afterEach(() => {
  if (!process.env.CAWS_DESCRIBE_ENTRY_ARTIFACT_DIR)
    fs.rmSync(root, { recursive: true, force: true });
});
function run(event, context) {
  const argv = [
    entry,
    '--surface',
    'codex',
    '--event',
    event,
    '--runtime-digest',
    'a'.repeat(64),
    '--configuration',
    'system',
  ];
  const environment = {
    PATH: process.env.PATH,
    HOME: root,
    CAWS_HOME: path.join(root, 'machine'),
    ...(context ? { CAWS_NATIVE_DESCRIBE_CONTEXT: JSON.stringify(context) } : {}),
  };
  const result = spawnSync(process.execPath, argv, {
    cwd: root,
    env: environment,
    encoding: 'utf8',
    timeout: 5000,
    maxBuffer: 64 * 1024,
  });
  if (process.env.CAWS_DESCRIBE_ENTRY_ARTIFACT_DIR)
    fs.writeFileSync(
      path.join(root, 'observation.json'),
      JSON.stringify(
        {
          node: process.execPath,
          argv,
          status: result.status,
          signal: result.signal,
          error: result.error?.message,
          stdout: result.stdout,
          stderr: result.stderr,
          boundary: 'Real Node describe CLI; no installed native or harness admission',
        },
        null,
        2
      )
    );
  expect(result.error).toBeUndefined();
  expect(result.signal).toBeNull();
  return result;
}

test.each(events)('description context failure exits 2 without selection JSON for %s', (event) => {
  const result = run(event);
  expect(result.status).toBe(2);
  expect(result.stdout).toBe('');
  expect(result.stderr).toContain('[caws native describe] Error: Describe context is absent');
});

test('an inactive description remains an exact successful selection result', () => {
  const result = run('stop', {
    cwd: root,
    environment: {
      PATH: process.env.PATH,
      HOME: root,
      CAWS_HOME: path.join(root, 'machine'),
    },
  });
  expect(result.status).toBe(0);
  expect(result.stderr).toBe('');
  expect(JSON.parse(result.stdout)).toEqual({
    schema: 'caws.hook_selection.v1',
    status: 'inactive',
    surface: 'codex',
    event: 'stop',
    reason: 'outside a resolvable Git project',
    handlers: [],
  });
});
