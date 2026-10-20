const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const cp = require('node:child_process');
const crypto = require('node:crypto');
const { AbortController } = globalThis;
const { installMachineRuntime } = require('../../dist/init/machine-adapters');
const { prepareRuntimeInvocation } = require('../../dist/runtime/engine');
const {
  loadGuardConfigurationEnvironment,
  parseNonGovernedZones,
} = require('../../dist/runtime/guard-config');
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
  // A retained directory inside .caws changes canonical-root discovery. Execute
  // in an ordinary temporary repository, then retain its exact bytes separately.
  const parent = os.tmpdir();
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
    '#!/bin/bash -p\ncase "$1" in */guard-config.py) printf "called\\n" >> "$CONFIG_PARSER_WITNESS"; [[ "${CONFIG_PARSER_MODE:-deny}" == execute ]] || exit 97;; esac\nexec ' +
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
env | grep '^CAWS_GUARD_' | sort > "$CONSUMER_ROOT/guard-config.env"
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
  const makeRequest = (extra = {}) => {
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
    return request;
  };
  const prepare = async (extra = {}) => {
    const request = makeRequest(extra);
    const invocation = await prepareRuntimeInvocation(request, new AbortController().signal);
    return { invocation, request };
  };
  const capture = (request, nativeResult) => {
    const read = (name) => fs.readFileSync(path.join(root, name), 'utf8');
    const result = {
      exitCode: nativeResult.exitCode,
      output: Buffer.from(nativeResult.stdout).toString(),
      stderr: Buffer.from(nativeResult.stderr).toString(),
      assignments: read('guard-config.env'),
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
  const run = async (prepared) => {
    const { invocation, request } = prepared || (await prepare());
    let completion;
    try {
      completion = await invocation.dispatch();
    } catch (error) {
      put(path.join(root, request.id + '.failure.json'), {
        message: String(error),
        stdout: Buffer.from(error.stdout || []).toString('base64'),
        stderr: Buffer.from(error.stderr || []).toString('base64'),
      });
      throw error;
    }
    await invocation.acknowledgeHandoff(true);
    return capture(request, completion.nativeResult);
  };
  const native = (extra = {}) => {
    const executable = process.env.CAWS_GUARD_CONFIG_NATIVE_BIN;
    expect(path.isAbsolute(executable || '')).toBe(true);
    const request = makeRequest(extra);
    const args = [
      'invoke',
      '--engine',
      path.resolve(__dirname, '../../dist/runtime/engine-entry.js'),
      '--node',
      process.execPath,
      '--surface',
      'codex',
      '--event',
      'pre_tool_use',
      '--runtime-digest',
      installed.digest,
      '--timeout-ms',
      '15000',
      '--configuration',
      'system',
    ];
    const result = cp.spawnSync(executable, args, {
      cwd: repo,
      env: { ...environment, ...extra },
      input: Buffer.from(request.inputJson + '\n'),
      timeout: 20000,
      maxBuffer: 4 * 1024 * 1024,
    });
    put(path.join(root, request.id + '.native.json'), {
      executable,
      args,
      sha256: crypto.createHash('sha256').update(fs.readFileSync(executable)).digest('hex'),
      code: result.status,
      signal: result.signal,
      error: result.error ? String(result.error) : null,
    });
    fs.writeFileSync(path.join(root, request.id + '.stdout.bin'), result.stdout || Buffer.alloc(0));
    fs.writeFileSync(path.join(root, request.id + '.stderr.bin'), result.stderr || Buffer.alloc(0));
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(0);
    return capture(request, {
      exitCode: result.status,
      stdout: result.stdout,
      stderr: result.stderr,
    });
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
    native,
    projectSettings: path.join(home, 'state/projects', key + '.json'),
    close() {
      if (retained) {
        fs.mkdirSync(retained, { recursive: true });
        const destination = path.join(retained, path.basename(root));
        put(path.join(root, 'fixture-root.json'), {
          executedRoot: root,
          retainedRoot: destination,
        });
        fs.cpSync(root, destination, { recursive: true });
      }
      fs.rmSync(root, { recursive: true, force: true });
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

const nativeTest = process.env.CAWS_GUARD_CONFIG_NATIVE_BIN ? test : test.skip;
nativeTest(
  'supplied native client reaches typed preload and all four real shell consumers',
  () => {
    const f = fixture();
    try {
      f.policy(null);
      shipped(f.native());
      f.policy(document());
      configured(f.native());
      expect(fs.existsSync(f.environment.CONFIG_PARSER_WITNESS)).toBe(false);
    } finally {
      f.close();
    }
  },
  45000
);

test('parallel projects with repeated session identity cannot share configuration assignments', async () => {
  const left = fixture(),
    right = fixture();
  try {
    left.policy(document());
    const other = { ...prefix, prefix: 'other/' };
    right.policy(
      document({
        'scope-guard.sh': { additional_allow_prefixes: [other] },
        'write-allowlist.sh': { additional_allow_prefixes: [other] },
        'god-object-check.sh': { thresholds: { loc: 1000, delta: 1000 } },
        'loc-delta-check.sh': { thresholds: { delta: 1000 } },
      })
    );
    const [a, b] = await Promise.all([left.run(), right.run()]);
    configured(a);
    shipped(b);
  } finally {
    left.close();
    right.close();
  }
}, 45000);

test('public threshold overrides retain precedence over typed config', async () => {
  const f = fixture();
  try {
    f.policy(document());
    const result = await f.run(
      await f.prepare({ CAWS_GOD_OBJECT_LOC: '1000', CAWS_LOC_DELTA_WARN_THRESHOLD: '1000' })
    );
    expect(result.scope).toBe('');
    expect(result.allowlist).toBe('0');
    expect(result.god).toBe('');
    expect(result.delta).toBe('');
  } finally {
    f.close();
  }
}, 45000);

test('selected Bash startup retains its parser path and public threshold settings', async () => {
  const f = fixture();
  try {
    f.policy(document());
    const startup = path.join(f.root, 'startup.sh');
    f.put(
      startup,
      'printf "startup\\n" >> "$CONSUMER_ROOT/startup-calls"\nexport CAWS_GOD_OBJECT_LOC=100 CAWS_GOD_OBJECT_DELTA=10 CAWS_LOC_DELTA_WARN_THRESHOLD=10\n'
    );
    const result = await f.run(await f.prepare({ BASH_ENV: startup }));
    expect(result.scope).toContain('TEST-001');
    expect(result.allowlist).toBe('1');
    expect(result.god).toContain('threshold: 100');
    expect(result.delta).toContain('threshold: 10');
    expect(fs.readFileSync(path.join(f.root, 'startup-calls'), 'utf8')).toContain('startup\n');
    expect(fs.readFileSync(f.environment.CONFIG_PARSER_WITNESS, 'utf8')).toBe('called\n');
  } finally {
    f.close();
  }
}, 45000);

test('inherited source sentinel cannot turn caller assignments into a trusted preload', async () => {
  const f = fixture();
  try {
    f.policy(document());
    shipped(
      await f.run(
        await f.prepare({
          _CAWS_GUARD_CONFIG_SH_SOURCED: '1',
          CAWS_GUARD_CONFIG_STATUS: 'ok',
          CAWS_GUARD_ZONE_COUNT: '1',
          CAWS_GUARD_ZONE_0: '/',
        })
      )
    );
    expect(fs.existsSync(f.environment.CONFIG_PARSER_WITNESS)).toBe(false);
  } finally {
    f.close();
  }
}, 45000);

test('strict filesystem text reads preserve legacy unavailable states and universal newlines', () => {
  const f = fixture();
  try {
    const yaml = path.join(f.repo, '.caws/policy.yaml');
    const policy = path.join(f.repo, '.caws/hooks/hook-policy.json');
    f.policy(document());
    fs.writeFileSync(yaml, Buffer.from([0xff]));
    expect(loadGuardConfigurationEnvironment(f.repo)).toEqual({
      CAWS_GUARD_ZONE_COUNT: '0',
      CAWS_GUARD_CONFIG_STATUS: 'unavailable',
    });
    fs.writeFileSync(yaml, 'non_governed_zones:\n  - native/**\n');
    fs.writeFileSync(policy, Buffer.from([0xff]));
    expect(loadGuardConfigurationEnvironment(f.repo)).toEqual({
      CAWS_GUARD_ZONE_COUNT: '1',
      CAWS_GUARD_ZONE_0: 'native/',
      CAWS_GUARD_CONFIG_STATUS: 'unavailable',
    });
    fs.writeFileSync(policy, '{}');
    for (const separator of ['\r\n', '\r']) {
      fs.writeFileSync(yaml, ['non_governed_zones:', '  - native/**', ''].join(separator));
      expect(loadGuardConfigurationEnvironment(f.repo)).toEqual({
        CAWS_GUARD_ZONE_COUNT: '1',
        CAWS_GUARD_ZONE_0: 'native/',
        CAWS_GUARD_CONFIG_STATUS: 'ok',
      });
    }
    fs.writeFileSync(yaml, 'version: 1\n');
    fs.writeFileSync(policy, Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('{}')]));
    expect(loadGuardConfigurationEnvironment(f.repo)).toEqual({
      CAWS_GUARD_ZONE_COUNT: '0',
      CAWS_GUARD_CONFIG_STATUS: 'invalid',
    });
  } finally {
    f.close();
  }
});

test('malformed UTF8 after preparation cannot introduce replacement-character prefix authority', async () => {
  const f = fixture();
  try {
    f.policy(document());
    const prepared = await f.prepare();
    const raw = Buffer.from(
      JSON.stringify(document()).replace(prefix.reason, prefix.reason + 'PLACEHOLDER')
    );
    const marker = Buffer.from('PLACEHOLDER'),
      at = raw.indexOf(marker);
    expect(at).toBeGreaterThan(-1);
    fs.writeFileSync(
      path.join(f.repo, '.caws/hooks/hook-policy.json'),
      Buffer.concat([raw.subarray(0, at), Buffer.from([0xff]), raw.subarray(at + marker.length)])
    );
    shipped(await f.run(prepared));
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

test.each(['na\0tive/', 'na\u0085tive/', 'na\ud800tive/'])(
  'non-native prefix transport %j retains the selected parser',
  async (unsafe) => {
    const f = fixture();
    try {
      f.policy(
        document({
          'scope-guard.sh': { additional_allow_prefixes: [{ ...prefix, prefix: unsafe }] },
        })
      );
      shipped(await f.run());
      expect(fs.readFileSync(f.environment.CONFIG_PARSER_WITNESS, 'utf8')).toBe('called\n');
    } finally {
      f.close();
    }
  },
  45000
);

test.each(['100.0', '1e2', '100.000000000000001'])(
  'threshold token %s cannot acquire integer authority by rounding',
  async (token) => {
    const f = fixture();
    try {
      f.policy(JSON.stringify(document()).replace('"loc":100', '"loc":' + token));
      shipped(await f.run());
      expect(fs.existsSync(f.environment.CONFIG_PARSER_WITNESS)).toBe(false);
    } finally {
      f.close();
    }
  },
  45000
);

test('Python whitespace cannot supply the missing character of an authorization reason', async () => {
  const f = fixture();
  try {
    f.policy(
      document({
        'scope-guard.sh': {
          additional_allow_prefixes: [{ ...prefix, reason: '\u001c12345678901' }],
        },
      })
    );
    shipped(await f.run());
    expect(fs.existsSync(f.environment.CONFIG_PARSER_WITNESS)).toBe(false);
  } finally {
    f.close();
  }
}, 45000);

test.each(['\u2028', '\u2029'])(
  'Unicode separator %j cannot shorten a scope zone or terminate its header',
  (separator) => {
    expect(parseNonGovernedZones('non_governed_zones:\n  - native/' + separator + '\n')).toEqual([
      'native/' + separator + '/',
    ]);
    expect(parseNonGovernedZones('non_governed_zones:' + separator + '\n  - native/\n')).toEqual(
      []
    );
    expect(parseNonGovernedZones('non_governed_zones:\n  - native/*' + separator + '\n')).toEqual([
      'native/*' + separator + '/',
    ]);
  }
);

test('source indexing limits retain the selected parser rather than asserting invalid policy', async () => {
  const f = fixture();
  try {
    const raw = JSON.stringify(document()).replace(
      /}$/,
      ',"metadata":' + '['.repeat(130) + '0' + ']'.repeat(130) + '}'
    );
    f.policy(raw);
    shipped(await f.run());
    expect(fs.readFileSync(f.environment.CONFIG_PARSER_WITNESS, 'utf8')).toBe('called\n');
  } finally {
    f.close();
  }
}, 45000);

test.each(['native\0/', 'native\u0085/', 'native\ud800/'])(
  'fallback %j executes the real Python parser and retains its shell transport',
  async (unsafe) => {
    const f = fixture();
    try {
      f.policy(
        document({
          'scope-guard.sh': { additional_allow_prefixes: [{ ...prefix, prefix: unsafe }] },
        })
      );
      const result = await f.run(await f.prepare({ CONFIG_PARSER_MODE: 'execute' }));
      if (unsafe.includes('\0')) {
        expect(result.scope).toBe('');
        expect(result.allowlist).toBe('1');
        expect(result.god).toBe('');
        expect(result.delta).toBe('');
      } else shipped(result);
      expect(fs.readFileSync(f.environment.CONFIG_PARSER_WITNESS, 'utf8')).toBe('called\n');
    } finally {
      f.close();
    }
  },
  45000
);
