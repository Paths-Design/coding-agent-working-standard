'use strict';

/**
 * opencode adapter payload carries the session working directory
 * (CAWS-DEFECT-CLAIM-ORACLE-CWD-RELATIVE-PATH-01).
 *
 * bash-write-guard answers ask_uncertain for a relative mutation target when
 * the payload has no usable `cwd`. The opencode plugin used to send no `cwd`,
 * and opencode has no ask, so every relative Bash write there would have been
 * refused. These tests transpile the shipped plugin.ts, drive its real
 * tool.execute.before / tool.execute.after hooks against a stub dispatcher that
 * records the payload it receives, and run that payload through the shared
 * parse-input.sh so the assertion is on HOOK_CWD, the value the guards read.
 *
 * Mutation runs set OPENCODE_PLUGIN_MUTATE_FROM / _TO to apply one literal
 * replacement to the transpiled plugin; a FROM that is absent throws, so a
 * mutant that changes nothing cannot "survive".
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const ts = require('typescript');

const PACK_DIR = path.resolve(__dirname, '..', '..', 'templates', 'hook-packs');
const PLUGIN_TS = path.join(PACK_DIR, 'opencode', 'plugin.ts');
const PARSE_INPUT = path.join(PACK_DIR, 'shared', 'lib', 'parse-input.sh');

let workDir;
let pluginPath;
const artifactRoot = process.env.CAWS_TEST_ARTIFACT_DIR;
if (artifactRoot && !path.isAbsolute(artifactRoot))
  throw new Error('Artifact root must be absolute');

function transpilePlugin() {
  let source = ts.transpileModule(fs.readFileSync(PLUGIN_TS, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  }).outputText;
  const from = process.env.OPENCODE_PLUGIN_MUTATE_FROM;
  if (from) {
    if (!source.includes(from)) throw new Error(`mutation FROM not found in plugin: ${from}`);
    const at = source.indexOf(from);
    source =
      source.slice(0, at) +
      (process.env.OPENCODE_PLUGIN_MUTATE_TO || '') +
      source.slice(at + from.length);
  }
  return source;
}

beforeAll(() => {
  if (artifactRoot) fs.mkdirSync(artifactRoot, { recursive: true });
  workDir = fs.mkdtempSync(path.join(artifactRoot || os.tmpdir(), 'caws-opencode-cwd-'));
  pluginPath = path.join(workDir, 'plugin.cjs');
  fs.writeFileSync(pluginPath, transpilePlugin());
});

afterAll(() => {
  if (!artifactRoot) fs.rmSync(workDir, { recursive: true, force: true });
});

/** A project whose dispatchers record the stdin payload they receive. */
function makeProject(name) {
  const project = path.join(workDir, name);
  const dispatchDir = path.join(project, '.caws', 'hooks', 'dispatch');
  fs.mkdirSync(dispatchDir, { recursive: true });
  fs.mkdirSync(path.join(project, 'packages', 'app'), { recursive: true });
  for (const event of ['pre_tool_use', 'post_tool_use', 'session_start', 'stop', 'pre_compact']) {
    const script = path.join(dispatchDir, `${event}.sh`);
    fs.writeFileSync(
      script,
      `#!/bin/bash
record="$(mktemp "$(dirname "$0")/${event}.call.XXXXXX")"
cat > "$record.payload.json"
cp "$record.payload.json" "$(dirname "$0")/${event}.payload.json"
printf '%s\\0' "$0" "$PWD" "$CAWS_PROJECT_DIR" "$CAWS_AGENT_SURFACE" "$@" > "$record.invocation.bin"
printf '%s\\n' "$record" >> "$(dirname "$0")/${event}.calls"
if [[ -f "$(dirname "$0")/${event}.stdout" ]]; then cat "$(dirname "$0")/${event}.stdout"; fi
exit 0
`
    );
    fs.chmodSync(script, 0o755);
  }
  return project;
}

function recordedPayload(project, event) {
  const file = path.join(project, '.caws', 'hooks', 'dispatch', `${event}.payload.json`);
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

/** Fresh-module helper; isolation controls deliberately share one module below. */
function loadPlugin(ctx) {
  jest.resetModules();
  return require(pluginPath).CawsPlugin(ctx);
}

/** HOOK_CWD as the shared guards' parser reads it from a payload. */
function hookCwdFor(payload) {
  const res = spawnSync(
    'bash',
    ['-c', `source "${PARSE_INPUT}" && parse_hook_input && printf '%s' "$HOOK_CWD"`],
    { input: JSON.stringify(payload), encoding: 'utf8' }
  );
  expect(res.status).toBe(0);
  return res.stdout;
}

function dispatchRecords(project, event) {
  const calls = path.join(project, '.caws/hooks/dispatch', `${event}.calls`);
  if (!fs.existsSync(calls)) return [];
  return fs
    .readFileSync(calls, 'utf8')
    .trim()
    .split('\n')
    .map((record) => {
      const [script, cwd, projectDir, surface, ...argv] = fs
        .readFileSync(`${record}.invocation.bin`, 'utf8')
        .split('\0')
        .slice(0, -1);
      return {
        script,
        cwd,
        projectDir,
        surface,
        argv,
        payload: JSON.parse(fs.readFileSync(`${record}.payload.json`, 'utf8')),
      };
    });
}
function expectLifecycleRecords(project, event, sessions) {
  expect(dispatchRecords(project, event)).toEqual(
    sessions.map((session_id) => ({
      script: path.join(project, '.caws/hooks/dispatch', `${event}.sh`),
      cwd: project,
      projectDir: project,
      surface: 'opencode',
      argv: [],
      payload: { session_id },
    }))
  );
}
const lifecycleEvents = [
  ['session.created', 'session_start', (sessionID) => ({ info: { id: sessionID } })],
  ['session.idle', 'stop', (sessionID) => ({ sessionID })],
  ['session.compacted', 'pre_compact', (sessionID) => ({ sessionID })],
];
describe('OpenCode lifecycle identity and instance isolation', () => {
  test.each(lifecycleEvents)(
    '%s dispatches its declared own identity after another session',
    async (type, dispatcher, props) => {
      const project = makeProject(`own-${dispatcher}`);
      const hooks = await loadPlugin({ directory: project, worktree: project });
      await hooks['tool.execute.before'](
        { tool: 'read', sessionID: 'prior-session' },
        { args: {} }
      );
      await hooks.event({ event: { type, properties: props('own-session') } });
      expectLifecycleRecords(project, dispatcher, ['own-session']);
    }
  );
  test.each(lifecycleEvents)(
    '%s never inherits a prior identity when its own identity is unusable',
    async (type, dispatcher) => {
      const project = makeProject(`missing-${dispatcher}`);
      const hooks = await loadPlugin({ directory: project, worktree: project });
      await hooks['tool.execute.before'](
        { tool: 'read', sessionID: 'prior-session' },
        { args: {} }
      );
      const invalid = [
        undefined,
        null,
        {},
        { sessionID: '' },
        { sessionID: 'unknown' },
        { sessionID: 7 },
        { sessionID: 'one', sessionId: 'another' },
      ];
      if (type === 'session.created') invalid.push({ sessionID: 'one', info: { id: 'another' } });
      else invalid.push({ id: 'unrelated-event-id' });
      for (const properties of invalid) {
        await hooks.event({ event: { type, properties } });
        expectLifecycleRecords(project, dispatcher, []);
      }
    }
  );
  test.each(lifecycleEvents)(
    '%s retains unambiguous explicit session aliases',
    async (type, dispatcher) => {
      const project = makeProject(`alias-${dispatcher}`);
      const hooks = await loadPlugin({ directory: project, worktree: project });
      await hooks.event({ event: { type, properties: { sessionId: 'legacy-session' } } });
      await hooks.event({ event: { type, properties: { session: { id: 'nested-session' } } } });
      expectLifecycleRecords(project, dispatcher, ['legacy-session', 'nested-session']);
    }
  );
  test('two idle sessions interleave without borrowing the last tool or lifecycle identity', async () => {
    const project = makeProject('idle-interleaving');
    const hooks = await loadPlugin({ directory: project, worktree: project });
    await hooks['tool.execute.before']({ tool: 'read', sessionID: 'session-a' }, { args: {} });
    await hooks['tool.execute.before']({ tool: 'read', sessionID: 'session-b' }, { args: {} });
    await hooks.event({ event: { type: 'session.idle', properties: { sessionID: 'session-a' } } });
    await hooks.event({ event: { type: 'session.idle', properties: {} } });
    await hooks.event({ event: { type: 'session.idle', properties: { sessionID: 'session-b' } } });
    expectLifecycleRecords(project, 'stop', ['session-a', 'session-b']);
  });
  test('instances sharing one loaded module keep project routing and pending context separate', async () => {
    const first = makeProject('instance-first');
    const second = makeProject('instance-second');
    jest.resetModules();
    const { CawsPlugin } = require(pluginPath);
    const a = await CawsPlugin({ directory: first, worktree: first });
    const b = await CawsPlugin({ directory: second, worktree: second });
    fs.writeFileSync(
      path.join(first, '.caws/hooks/dispatch/pre_tool_use.stdout'),
      JSON.stringify({
        hookSpecificOutput: { additionalContext: 'first-project-context' },
      })
    );
    await a['tool.execute.before']({ tool: 'read', sessionID: 'first-session' }, { args: {} });
    await b['tool.execute.before']({ tool: 'read', sessionID: 'second-session' }, { args: {} });
    const bSystem = { system: [] };
    await b['experimental.chat.system.transform']({}, bSystem);
    expect(bSystem.system).toEqual([]);
    const aSystem = { system: [] };
    await a['experimental.chat.system.transform']({}, aSystem);
    expect(aSystem.system).toEqual([
      'CAWS context (peer notice / message / advisory):\nfirst-project-context',
    ]);
    await Promise.all([
      a.event({ event: { type: 'session.idle', properties: { sessionID: 'first-session' } } }),
      b.event({ event: { type: 'session.idle', properties: { sessionID: 'second-session' } } }),
    ]);
    expectLifecycleRecords(first, 'stop', ['first-session']);
    expectLifecycleRecords(second, 'stop', ['second-session']);
    expect(
      dispatchRecords(first, 'pre_tool_use').map((record) => record.payload.session_id)
    ).toEqual(['first-session']);
    expect(
      dispatchRecords(second, 'pre_tool_use').map((record) => record.payload.session_id)
    ).toEqual(['second-session']);
  });
  test('ordinary single-session lifecycle preserves dispatcher names and advisory behavior', async () => {
    const project = makeProject('ordinary-lifecycle');
    const hooks = await loadPlugin({ directory: project, worktree: project });
    for (const [type, dispatcher, props] of lifecycleEvents) {
      await hooks.event({ event: { type, properties: props('ordinary-session') } });
      expectLifecycleRecords(project, dispatcher, ['ordinary-session']);
    }
  });
});

describe('opencode plugin payload cwd', () => {
  test('a Bash tool call reaches the pre dispatcher with cwd set to the session directory, not the git root', async () => {
    const project = makeProject('pre-dir');
    const sessionDir = path.join(project, 'packages', 'app');
    const hooks = await loadPlugin({ directory: sessionDir, worktree: project });
    await hooks['tool.execute.before'](
      { tool: 'bash', sessionID: 'ses_1' },
      { args: { command: 'echo x > a.txt' } }
    );
    const payload = recordedPayload(project, 'pre_tool_use');
    expect(payload.tool_name).toBe('Bash');
    expect(payload.cwd).toBe(sessionDir);
    expect(hookCwdFor(payload)).toBe(sessionDir);
  });

  test('the post dispatcher payload carries the same cwd', async () => {
    const project = makeProject('post-dir');
    const sessionDir = path.join(project, 'packages', 'app');
    const hooks = await loadPlugin({ directory: sessionDir, worktree: project });
    await hooks['tool.execute.after'](
      { tool: 'bash', sessionID: 'ses_1' },
      { args: { command: 'echo x > a.txt' } }
    );
    expect(recordedPayload(project, 'post_tool_use').cwd).toBe(sessionDir);
  });

  test('a Write tool call carries the session directory as cwd', async () => {
    const project = makeProject('write-dir');
    const hooks = await loadPlugin({ directory: project, worktree: project });
    await hooks['tool.execute.before'](
      { tool: 'write', sessionID: 'ses_1' },
      { args: { filePath: 'a.txt', content: 'x' } }
    );
    const payload = recordedPayload(project, 'pre_tool_use');
    expect(payload.tool_name).toBe('Write');
    expect(payload.cwd).toBe(project);
  });

  test('a relative bash workdir argument resolves against the session directory', async () => {
    const project = makeProject('workdir-rel');
    const hooks = await loadPlugin({ directory: project, worktree: project });
    await hooks['tool.execute.before'](
      { tool: 'bash', sessionID: 'ses_1' },
      { args: { command: 'echo x > a.txt', workdir: 'packages/app' } }
    );
    expect(recordedPayload(project, 'pre_tool_use').cwd).toBe(
      path.join(project, 'packages', 'app')
    );
  });

  test('an absolute bash workdir argument is used as given', async () => {
    const project = makeProject('workdir-abs');
    const elsewhere = path.join(workDir, 'elsewhere');
    const hooks = await loadPlugin({ directory: project, worktree: project });
    await hooks['tool.execute.before'](
      { tool: 'bash', sessionID: 'ses_1' },
      { args: { command: 'echo x > a.txt', workdir: elsewhere } }
    );
    expect(recordedPayload(project, 'pre_tool_use').cwd).toBe(elsewhere);
  });

  test('with no session directory the payload has no cwd key, and the git root is not substituted', async () => {
    const project = makeProject('no-dir');
    const hooks = await loadPlugin({ worktree: project });
    await hooks['tool.execute.before'](
      { tool: 'bash', sessionID: 'ses_1' },
      { args: { command: 'echo x > a.txt' } }
    );
    const payload = recordedPayload(project, 'pre_tool_use');
    expect(Object.prototype.hasOwnProperty.call(payload, 'cwd')).toBe(false);
    expect(hookCwdFor(payload)).toBe('');
  });
});
