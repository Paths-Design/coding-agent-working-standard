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
  workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'caws-opencode-cwd-'));
  pluginPath = path.join(workDir, 'plugin.cjs');
  fs.writeFileSync(pluginPath, transpilePlugin());
});

afterAll(() => {
  fs.rmSync(workDir, { recursive: true, force: true });
});

/** A project whose dispatchers record the stdin payload they receive. */
function makeProject(name) {
  const project = path.join(workDir, name);
  const dispatchDir = path.join(project, '.caws', 'hooks', 'dispatch');
  fs.mkdirSync(dispatchDir, { recursive: true });
  fs.mkdirSync(path.join(project, 'packages', 'app'), { recursive: true });
  for (const event of ['pre_tool_use', 'post_tool_use']) {
    const script = path.join(dispatchDir, `${event}.sh`);
    fs.writeFileSync(
      script,
      `#!/bin/bash\ncat > "$(dirname "$0")/${event}.payload.json"\nexit 0\n`
    );
    fs.chmodSync(script, 0o755);
  }
  return project;
}

function recordedPayload(project, event) {
  const file = path.join(project, '.caws', 'hooks', 'dispatch', `${event}.payload.json`);
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

/** Load a fresh plugin instance (the module keeps per-process state). */
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
