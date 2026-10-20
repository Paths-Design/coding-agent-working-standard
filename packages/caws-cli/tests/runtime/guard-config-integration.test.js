const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const cp = require('node:child_process');
const crypto = require('node:crypto');
const { AbortController } = globalThis;
const { installMachineRuntime } = require('../../dist/init/machine-adapters');
const { prepareRuntimeInvocation } = require('../../dist/runtime/engine');
const templates = path.resolve(__dirname, '../../templates/hook-packs');
const quote = (text) => "'" + text.replace(/'/g, "'\\''") + "'";
const prefix = { prefix: 'native/', reason: 'The project owns ordinary generated native sources' };
const guards = {
  'scope-guard.sh': { additional_allow_prefixes: [prefix] },
  'write-allowlist.sh': { additional_allow_prefixes: [prefix] },
  'god-object-check.sh': { thresholds: { loc: 100, delta: 10 } },
  'loc-delta-check.sh': { thresholds: { delta: 10 } },
};
function fixture() {
  const retained = process.env.CAWS_GUARD_CONFIG_ARTIFACT_ROOT;
  if (retained && !path.isAbsolute(retained)) throw new Error('Artifact root must be absolute');
  const parent = retained || os.tmpdir();
  fs.mkdirSync(parent, { recursive: true });
  const root = fs.realpathSync(fs.mkdtempSync(path.join(parent, 'guard-config-')));
  const repo = path.join(root, 'project');
  const home = path.join(root, 'machine');
  const bin = path.join(root, 'bin');
  const put = (file, value, mode) => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, typeof value === 'string' ? value : JSON.stringify(value), { mode });
  };
  fs.mkdirSync(repo);
  fs.mkdirSync(bin);
  const python = cp
    .execFileSync('/bin/bash', ['-c', 'command -v python3'], { encoding: 'utf8' })
    .trim();
  // Interpreter witnesses must not recursively source the selected BASH_ENV.
  put(
    path.join(bin, 'python3'),
    '#!/bin/bash -p\ncase "$1" in */guard-config.py) printf "called\\n" >> "$CONFIG_PARSER_WITNESS"; exit 97;; esac\nexec ' +
      quote(python) +
      ' "$@"\n',
    0o755
  );
  // Scope authority is a controlled refusing boundary; this fixture tests config transport.
  put(
    path.join(bin, 'caws'),
    '#!/bin/bash -p\nif [[ "$1 $2" == "scope check" ]]; then exit 1; fi\nif [[ "$1 $2" == "scope show" ]]; then printf \'%s\' \'{"decision":"reject","rule":"scope.reject.root_not_allowed","path":"native/core.rs","mode":"authoritative","boundSpecId":"TEST-001","bindingState":"bound"}\'; fi\n',
    0o755
  );
  const environment = {
    PATH: bin + ':' + process.env.PATH,
    HOME: root,
    CAWS_HOME: home,
    CODEX_THREAD_ID: 'same-session',
    CAWS_TRAP_KILL: '0',
    CAWS_HOOK_ADVISORY_DEDUP: '0',
    CONFIG_PARSER_WITNESS: path.join(root, 'config-parser-calls'),
    CONSUMER_ROOT: root,
  };
  expect(cp.spawnSync('git', ['init', '-q'], { cwd: repo, env: environment }).status).toBe(0);
  put(path.join(repo, '.caws/policy.yaml'), 'version: 1\n');
  fs.mkdirSync(path.join(repo, '.caws/specs'));
  put(
    path.join(repo, 'native/core.rs'),
    Array.from({ length: 150 }, (_, i) => 'const value' + i + '=1;').join('\n') + '\n'
  );
  const installed = installMachineRuntime({ home, templatesRoot: templates });
  const runtime = path.join(home, 'lib/runtimes', installed.digest);
  const defaults = JSON.parse(fs.readFileSync(path.join(runtime, 'system-policy.json')));
  const wrapper = path.join(repo, '.caws/hooks/consumer.sh');
  put(
    wrapper,
    `#!/bin/bash
set -u
pack="$CAWS_SHARED_LIB_DIR/.."
input=$(cat)
for name in scope-guard god-object-check loc-delta-check; do
  printf '%s' "$input" | bash "$pack/$name.sh" > "$CONSUMER_ROOT/$name.stdout" 2> "$CONSUMER_ROOT/$name.stderr"
  printf '%s' "$?" > "$CONSUMER_ROOT/$name.status"
done
bash -c 'source "$1/lib/write-allowlist.sh"; caws_is_write_allowlisted "$2" "$CAWS_PROJECT_DIR"' _ "$pack" "$CAWS_PROJECT_DIR/native/core.rs"
printf '%s' "$?" > "$CONSUMER_ROOT/write-allowlist.status"
printf '%s' '{"hookSpecificOutput":{"hookEventName":"PreToolUse","additionalContext":"four consumers completed"}}'
`,
    0o755
  );
  put(path.join(home, 'surfaces/codex/settings.json'), { version: 1, enabled: true });
  const key = crypto.createHash('sha256').update(repo).digest('hex');
  put(path.join(home, 'state/projects', key + '.json'), {
    version: 1,
    root: repo,
    surfaces: {
      codex: {
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
        handlers: { 'block-dangerous.sh': '.caws/hooks/consumer.sh' },
        libraries: {},
      },
    },
  });
  let counter = 0;
  const policy = (value) => {
    const file = path.join(repo, '.caws/hooks/hook-policy.json');
    if (value === null) fs.rmSync(file, { force: true });
    else put(file, value);
  };
  const prepare = async (extra = {}) => {
    const payload = {
      cwd: repo,
      session_id: 'same-session',
      tool_name: 'Edit',
      tool_input: {
        file_path: path.join(repo, 'native/core.rs'),
        old_string: 'old\n',
        new_string: Array.from({ length: 22 }, (_, i) => 'new' + i).join('\n') + '\n',
      },
    };
    const request = {
      schema: 'caws.runtime.request.v1',
      id: 'config-' + ++counter,
      runtimeDigest: installed.digest,
      surface: 'codex',
      event: 'pre_tool_use',
      configuration: 'system',
      caller: { processId: process.pid, cwd: repo, environment: { ...environment, ...extra } },
      deadlineEpochMs: Date.now() + 15000,
      inputJson: JSON.stringify(payload),
      payload,
    };
    put(path.join(root, request.id + '.request.json'), request);
    const invocation = await prepareRuntimeInvocation(request, new AbortController().signal);
    return { invocation, request };
  };
  const run = async (prepared) => {
    const { invocation, request } = prepared || (await prepare());
    const completion = await invocation.dispatch();
    await invocation.acknowledgeHandoff(true);
    const read = (name) => fs.readFileSync(path.join(root, name), 'utf8');
    const result = {
      exitCode: completion.nativeResult.exitCode,
      output: Buffer.from(completion.nativeResult.stdout).toString(),
      stderr: Buffer.from(completion.nativeResult.stderr).toString(),
      scope: read('scope-guard.stdout'),
      scopeStatus: read('scope-guard.status'),
      allowlist: read('write-allowlist.status'),
      god: read('god-object-check.stdout'),
      delta: read('loc-delta-check.stdout'),
    };
    put(path.join(root, request.id + '.result.json'), result);
    expect(result.exitCode).toBe(0);
    expect(result.output).toContain('four consumers completed');
    return result;
  };
  return {
    root,
    repo,
    runtime,
    environment,
    put,
    policy,
    prepare,
    run,
    projectSettings: path.join(home, 'state/projects', key + '.json'),
    close() {
      if (!retained) fs.rmSync(root, { recursive: true, force: true });
    },
  };
}

function configured(result) {
  expect(result.scope).toBe('');
  expect(result.scopeStatus).toBe('0');
  expect(result.allowlist).toBe('0');
  expect(result.god).toContain('god-object-check');
  expect(result.god).toContain('threshold: 100');
  expect(result.delta).toContain('threshold: 10');
}
function shipped(result) {
  expect(result.scope).toContain('not in the defined scope');
  expect(result.scope).toContain('TEST-001');
  expect(result.allowlist).toBe('1');
  expect(result.god).toBe('');
  expect(result.delta).toBe('');
}
const document = (value = guards) => ({ version: 1, surfaces: {}, guards: value });

test('compiled engine preloads all four real consumers without invoking their Python config parser', async () => {
  const f = fixture();
  const before = { ...process.env };
  try {
    f.policy(null);
    shipped(await f.run());
    f.policy(document());
    configured(await f.run());
    expect(fs.existsSync(f.environment.CONFIG_PARSER_WITNESS)).toBe(false);
    expect(process.env).toEqual(before);
  } finally {
    f.close();
  }
}, 45000);

test('dispatch reads fresh policy and rejects forged caller transport; invalid data retains shipped behavior', async () => {
  const f = fixture();
  try {
    f.policy(document());
    const first = await f.prepare({
      CAWS_GUARD_CONFIG_STATUS: 'ok',
      CAWS_GUARD_ZONE_COUNT: '1',
      CAWS_GUARD_ZONE_0: '/',
      CAWS_GUARD_PREFIX_COUNT_SCOPE_GUARD_SH: '1',
      CAWS_GUARD_PREFIX_SCOPE_GUARD_SH_0: 'native/',
    });
    f.policy(document({ ...guards, 'unknown-guard.sh': {} }));
    shipped(await f.run(first));
    await expect(f.prepare()).rejects.toThrow('not a configurable guard');
    f.policy(document());
    configured(await f.run());
    expect(fs.existsSync(f.environment.CONFIG_PARSER_WITNESS)).toBe(false);
  } finally {
    f.close();
  }
}, 45000);

test('explicit parser override executes despite forged inherited preload status', async () => {
  const f = fixture();
  try {
    f.policy(document());
    const parser = path.join(f.root, 'custom-parser.py');
    f.put(
      parser,
      "import os\nopen(os.path.join(os.environ['CONSUMER_ROOT'],'custom-parser-called'),'a').write('called\\n')\nprint('CAWS_GUARD_CONFIG_STATUS=absent')\nprint('CAWS_GUARD_ZONE_COUNT=0')\n"
    );
    shipped(
      await f.run(
        await f.prepare({
          CAWS_GUARD_CONFIG_PY: parser,
          CAWS_GUARD_CONFIG_STATUS: 'ok',
          CAWS_GUARD_ZONE_COUNT: '1',
          CAWS_GUARD_ZONE_0: '/',
        })
      )
    );
    expect(fs.readFileSync(path.join(f.root, 'custom-parser-called'), 'utf8')).toBe('called\n');
  } finally {
    f.close();
  }
}, 45000);

test('a selected custom loader retains its own execution and ignores forged caller preload', async () => {
  const f = fixture();
  try {
    f.policy(document());
    const loader = path.join(f.repo, '.caws/hooks/custom-config.sh');
    f.put(
      loader,
      `caws_guard_config_load() {
  printf 'called\\n' >> "$CONSUMER_ROOT/custom-loader-called"
  export CAWS_GUARD_CONFIG_STATUS=absent CAWS_GUARD_ZONE_COUNT=0
}
`
    );
    const settings = JSON.parse(fs.readFileSync(f.projectSettings));
    settings.surfaces.codex.libraries['guard-config.sh'] = '.caws/hooks/custom-config.sh';
    f.put(f.projectSettings, settings);
    shipped(
      await f.run(
        await f.prepare({
          CAWS_GUARD_CONFIG_STATUS: 'ok',
          CAWS_GUARD_ZONE_COUNT: '1',
          CAWS_GUARD_ZONE_0: '/',
        })
      )
    );
    expect(fs.readFileSync(path.join(f.root, 'custom-loader-called'), 'utf8')).toBe('called\n');
    expect(fs.existsSync(f.environment.CONFIG_PARSER_WITNESS)).toBe(false);
  } finally {
    f.close();
  }
}, 45000);

test('stock-source tampering after preparation cannot retain typed admission', async () => {
  const f = fixture();
  try {
    f.policy(document());
    const prepared = await f.prepare();
    fs.appendFileSync(
      path.join(f.runtime, 'lib/guard-config.py'),
      '\n# source changed after preparation\n'
    );
    shipped(await f.run(prepared));
    expect(fs.readFileSync(f.environment.CONFIG_PARSER_WITNESS, 'utf8')).toBe('called\n');
  } finally {
    f.close();
  }
}, 45000);
