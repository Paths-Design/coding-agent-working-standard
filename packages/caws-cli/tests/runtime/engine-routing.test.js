const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const cp = require('node:child_process');
const crypto = require('node:crypto');
const { AbortController } = globalThis;
const { installMachineRuntime } = require('../../dist/init/machine-adapters');
const { validateSystemPolicy } = require('../../dist/init/system-project-policy');
const { prepareRuntimeInvocation } = require('../../dist/runtime/engine');
const templates = path.resolve(__dirname, '../../templates/hook-packs');
const quote = (text) => "'" + text.replace(/'/g, "'\\''") + "'";

test('a selected project override receives complete Codex normalization through compatibility dispatch', async () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'caws-engine-route-')));
  const repo = path.join(root, 'project');
  const home = path.join(root, 'machine');
  fs.mkdirSync(repo);
  const put = (file, value) => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, typeof value === 'string' ? value : JSON.stringify(value));
  };
  const environment = {
    PATH: '/usr/bin:/bin',
    HOME: root,
    CAWS_HOME: home,
    CODEX_THREAD_ID: 'routing-fixture',
    CAWS_TRAP_KILL: '0',
    CAWS_NATIVE_CONTAINMENT_FILE: '/caller/forged-capability',
    CONSUMED_FILE: path.join(root, 'consumed.json'),
  };
  try {
    const git = cp.spawnSync('/usr/bin/git', ['init', '-q'], { cwd: repo, env: environment });
    expect(git.status).toBe(0);
    put(path.join(repo, '.caws/policy.yaml'), 'version: 1\n');
    fs.mkdirSync(path.join(repo, '.caws/specs'));
    const script = path.join(repo, '.caws/hooks/guard.cjs');
    const override = path.join(repo, '.caws/hooks/guard.sh');
    put(
      script,
      "const fs=require('node:fs');const names=['HOOK_TOOL_NAME','HOOK_ORIGINAL_TOOL_NAME','HOOK_FILE_PATH','HOOK_FILE_PATHS','CAWS_NATIVE_CONTAINMENT_FILE'];const consumed=Object.fromEntries(names.map(name=>[name,process.env[name]??null]));fs.writeFileSync(process.env.CONSUMED_FILE,JSON.stringify(consumed));if(consumed.HOOK_ORIGINAL_TOOL_NAME==='Bash'&&consumed.HOOK_FILE_PATHS==='/owned/file'){process.stdout.write(JSON.stringify({decision:'block',reason:'normalized extension refusal'}));process.exitCode=2;}"
    );
    put(override, '#!/bin/bash\nexec ' + quote(process.execPath) + ' ' + quote(script) + '\n');
    fs.chmodSync(override, 0o755);
    const installed = installMachineRuntime({ home, templatesRoot: templates });
    const defaults = JSON.parse(
      fs.readFileSync(path.join(home, 'lib/runtimes', installed.digest, 'system-policy.json'))
    );
    const policy = {
      disabled: {
        pre_tool_use: [
          ...new Set(
            defaults.events.pre_tool_use
              .map((entry) => entry.split(' ')[0])
              .filter((name) => name !== 'block-dangerous.sh')
          ),
        ],
      },
      extensions: {},
      handlers: { 'block-dangerous.sh': '.caws/hooks/guard.sh' },
      libraries: {},
    };
    validateSystemPolicy(repo, policy, { files: [...installed.files], defaults: defaults.events });
    put(path.join(home, 'surfaces/codex/settings.json'), { version: 1, enabled: true });
    const projectDigest = crypto.createHash('sha256').update(repo).digest('hex');
    put(path.join(home, 'state/projects', projectDigest + '.json'), {
      version: 1,
      root: repo,
      surfaces: { codex: policy },
    });
    const payload = {
      cwd: repo,
      session_id: 'routing-fixture',
      tool_name: 'Bash',
      tool_input: { command: 'echo safe', file_path: '/owned/file' },
    };
    const request = {
      schema: 'caws.runtime.request.v1',
      id: 'routing-invocation',
      runtimeDigest: installed.digest,
      surface: 'codex',
      event: 'pre_tool_use',
      configuration: 'system',
      caller: { processId: process.pid, cwd: repo, environment },
      deadlineEpochMs: Date.now() + 15000,
      inputJson: JSON.stringify(payload),
      payload,
    };
    const invocation = await prepareRuntimeInvocation(request, new AbortController().signal);
    expect(invocation.active).toBe(true);
    const { nativeResult: result, containment } = await invocation.dispatch();
    expect(containment).toBeNull();
    expect(result.exitCode).toBe(2);
    expect(JSON.parse(Buffer.from(result.stdout).toString()).reason).toBe(
      'normalized extension refusal'
    );
    expect(JSON.parse(fs.readFileSync(environment.CONSUMED_FILE))).toEqual({
      HOOK_TOOL_NAME: 'Bash',
      HOOK_ORIGINAL_TOOL_NAME: 'Bash',
      HOOK_FILE_PATH: '/owned/file',
      HOOK_FILE_PATHS: '/owned/file',
      CAWS_NATIVE_CONTAINMENT_FILE: null,
    });
    await invocation.acknowledgeHandoff(true);
    const rows = fs
      .readFileSync(
        path.join(repo, '.caws/sessions/routing-fixture/hook-invocations/routing-invocation.jsonl'),
        'utf8'
      )
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    expect(rows.map((row) => row.stage)).toContain('compatibility_dispatch_completed');
    expect(rows.map((row) => row.stage)).not.toContain('handler_started');
    expect(rows.at(-1)).toMatchObject({ stage: 'adapter_finished', exit_code: 2 });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}, 20000);
