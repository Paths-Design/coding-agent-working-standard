'use strict';
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { installMachineRuntime } = require('../../dist/init/machine-adapters');
let root, home, templates;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'caws-system-runtime-'));
  home = path.join(root, 'machine');
  templates = path.join(root, 'templates');
  fs.cpSync(path.resolve(__dirname, '../../templates/hook-packs'), templates, { recursive: true });
  fs.mkdirSync(path.join(home, 'surfaces/codex'), { recursive: true });
  fs.writeFileSync(
    path.join(home, 'surfaces/codex/settings.json'),
    JSON.stringify({ version: 1, enabled: true })
  );
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));
function repo(name) {
  const p = path.join(root, name);
  fs.mkdirSync(path.join(p, '.caws/specs'), { recursive: true });
  fs.writeFileSync(path.join(p, '.caws/policy.yaml'), 'version: 1\n');
  expect(spawnSync('git', ['init', '-q', '-b', 'main'], { cwd: p }).status).toBe(0);
  return p;
}
function invoke(
  p,
  event = 'pre_tool_use',
  extra = {},
  toolInput = { file_path: 'x.ts' },
  payload = {}
) {
  return spawnSync('python3', [path.join(home, 'bin/caws-hook'), 'codex', event, '--system'], {
    cwd: p,
    encoding: 'utf8',
    env: { ...process.env, CAWS_HOME: home, CAWS_PROJECT_DIR: '', ...extra },
    input: JSON.stringify({
      cwd: p,
      session_id: 'system-test',
      tool_name: 'Write',
      tool_input: toolInput,
      ...payload,
    }),
  });
}
function configure(p, surface) {
  const key = crypto.createHash('sha256').update(fs.realpathSync(p)).digest('hex');
  fs.mkdirSync(path.join(home, 'state/projects'), { recursive: true });
  fs.writeFileSync(
    path.join(home, 'state/projects', `${key}.json`),
    JSON.stringify({ version: 1, root: fs.realpathSync(p), surfaces: { codex: surface } })
  );
}
function stock(version) {
  // Distinct fixture bodies test distribution through the real process chain.
  fs.writeFileSync(
    path.join(templates, 'shared/cwd-guard.sh'),
    `#!/bin/bash\nprintf '{"decision":"block","reason":"guard-${version}"}\\n'\nexit 2\n`
  );
  fs.writeFileSync(
    path.join(templates, 'shared/session-log.sh'),
    '#!/bin/bash\npython3 "$(dirname "${BASH_SOURCE[0]}")/session_log_renderer.py"\n'
  );
  fs.writeFileSync(
    path.join(templates, 'shared/session_log_renderer.py'),
    `print('{"systemMessage":"renderer-${version}"}')\n`
  );
  for (const event of ['pre_tool_use', 'stop']) {
    const file = path.join(templates, 'shared/dispatch', `${event}.sh`);
    const handler = event === 'pre_tool_use' ? 'cwd-guard.sh' : 'session-log.sh';
    fs.writeFileSync(
      file,
      fs
        .readFileSync(file, 'utf8')
        .replace(/^HANDLERS=\([\s\S]*?^\)/m, `HANDLERS=(\n  ${handler}\n)`)
    );
  }
}
test('one machine update changes stock guards AND renderers in two existing projects without project files', () => {
  const a = repo('a'),
    b = repo('b');
  stock('one');
  const first = installMachineRuntime({ home, templatesRoot: templates });
  for (const p of [a, b]) {
    expect(invoke(p).status).toBe(2);
    expect(JSON.parse(invoke(p).stdout).reason).toBe('guard-one');
    expect(JSON.parse(invoke(p, 'stop').stdout)).toEqual({ systemMessage: 'renderer-one' });
    expect(fs.existsSync(path.join(p, '.caws/hooks'))).toBe(false);
    expect(fs.existsSync(path.join(p, '.codex'))).toBe(false);
  }
  stock('two');
  const second = installMachineRuntime({ home, templatesRoot: templates });
  expect(second.digest).not.toBe(first.digest);
  for (const p of [a, b]) {
    const guard = invoke(p);
    expect(guard.status).toBe(2);
    expect(JSON.parse(guard.stdout).reason).toBe('guard-two');
    expect(guard.stderr).toContain(second.digest);
    expect(JSON.parse(invoke(p, 'stop').stdout)).toEqual({ systemMessage: 'renderer-two' });
    expect(fs.readFileSync(path.join(p, '.caws/policy.yaml'), 'utf8')).toBe('version: 1\n');
    expect(fs.existsSync(path.join(p, '.caws/hooks'))).toBe(false);
    expect(fs.existsSync(path.join(p, '.codex'))).toBe(false);
  }
});
test('explicit extensions run in order while stock guard updates remain inherited', () => {
  const p = repo('extensions');
  fs.writeFileSync(path.join(p, 'custom.sh'), '#!/bin/bash\necho extension-ran >&2\n', {
    mode: 0o755,
  });
  configure(p, {
    disabled: {},
    extensions: { pre_tool_use: [{ handler: 'custom.sh', before: 'cwd-guard.sh' }] },
    handlers: { 'custom.sh': 'custom.sh' },
    libraries: {},
  });
  stock('extension');
  installMachineRuntime({ home, templatesRoot: templates });
  const result = invoke(p);
  expect(result.status).toBe(2);
  expect(result.stderr).toContain('extension-ran');
  expect(JSON.parse(result.stdout).reason).toBe('guard-extension');
});
test('malformed project settings fail closed instead of falling back to stock defaults', () => {
  const p = repo('malformed');
  configure(p, { disabled: {}, extensions: {}, handlers: {}, libraries: {}, unknown: true });
  stock('never');
  installMachineRuntime({ home, templatesRoot: templates });
  const result = invoke(p);
  expect(result.status).toBe(2);
  expect(result.stderr).toContain('Malformed system project surface');
  expect(result.stdout).not.toContain('guard-never');
});

test('an explicitly adopted project cannot become ungoverned by losing its policy', () => {
  const p = repo('missing-governance');
  configure(p, { disabled: {}, extensions: {}, handlers: {}, libraries: {} });
  stock('not-admitted');
  installMachineRuntime({ home, templatesRoot: templates });
  fs.unlinkSync(path.join(p, '.caws/policy.yaml'));
  const result = invoke(p);
  expect(result.status).toBe(2);
  expect(result.stderr).toContain('governance');
  expect(result.stdout).not.toContain('guard-not-admitted');
});

test('the machine ownership oracle evaluates YAML claims without depending on project node_modules', () => {
  const p = repo('oracle');
  const lane = path.join(p, '.caws/worktrees/foreign');
  fs.mkdirSync(lane, { recursive: true });
  fs.writeFileSync(
    path.join(p, '.caws/worktrees.json'),
    JSON.stringify({
      worktrees: [{ name: 'foreign', path: lane, spec_id: 'FOREIGN', baseBranch: 'main' }],
    })
  );
  fs.writeFileSync(
    path.join(p, '.caws/specs/FOREIGN.yaml'),
    'id: FOREIGN\nlifecycle_state: active\nscope:\n  in: ["src/**"]\n'
  );
  const installed = installMachineRuntime({ home });
  const oracle = path.join(home, 'lib/runtimes', installed.digest, 'lib/worktree-claim-oracle.cjs');
  const check = (target) =>
    spawnSync(process.execPath, [oracle], {
      cwd: p,
      encoding: 'utf8',
      env: {
        ...process.env,
        NODE_PATH: '',
        CAWS_ORACLE_PROJECT_DIR: p,
        CAWS_ORACLE_CURRENT_BRANCH: 'main',
        CAWS_ORACLE_REL_PATH: target,
        CAWS_ORACLE_SESSION_ID: 'unbound',
      },
    });
  expect(check('src/claimed.ts').stdout).toContain('block_claimed:foreign:src/**');
  expect(check('unclaimed/file.ts').stdout).toContain('pass:');
  expect(fs.existsSync(path.join(p, 'node_modules'))).toBe(false);
});

test('the Codex renderer uses native content provenance to exclude injected user-role context', () => {
  const transcript = path.join(root, 'native-provenance.jsonl');
  const message = (content, kinds) => ({
    type: 'response_item',
    payload: {
      type: 'message',
      role: 'user',
      content: content.map((text) => ({ type: 'input_text', text })),
      internal_chat_message_metadata_passthrough: { content_item_kinds: kinds },
    },
  });
  fs.writeFileSync(
    transcript,
    [
      message(
        ['plugin catalog', 'project instructions', 'environment details'],
        ['plugins.recommendations', 'agents_md.instructions', 'environments.environment_context']
      ),
      message(['actual request', 'injected context'], ['user.text', 'agents_md.instructions']),
    ]
      .map(JSON.stringify)
      .join('\n')
  );
  const adapter = path.resolve(
    __dirname,
    '../../templates/hook-packs/codex/hooks/lib/session-transcript.py'
  );
  const result = spawnSync(
    'python3',
    [
      '-c',
      'import runpy,json,sys; print(json.dumps(runpy.run_path(sys.argv[1])["parse_transcript_events"](sys.argv[2])))',
      adapter,
      transcript,
    ],
    { encoding: 'utf8' }
  );
  expect(result.status).toBe(0);
  expect(JSON.parse(result.stdout)).toEqual([
    { ev: 'user_text', text: 'actual request', ts: null },
  ]);
});

test('global registration waits for legacy retirement without duplicating the local chain or breaking a cached local entry', () => {
  const p = repo('transition');
  fs.mkdirSync(path.join(p, '.caws/hooks'));
  fs.mkdirSync(path.join(p, '.codex'));
  fs.writeFileSync(
    path.join(p, '.caws/hooks/old.sh'),
    '#!/bin/bash\necho legacy-denial >&2\nexit 2\n',
    { mode: 0o755 }
  );
  fs.writeFileSync(
    path.join(p, '.caws/hooks/adapter-policy.json'),
    JSON.stringify({
      version: 1,
      surfaces: {
        codex: {
          events: { pre_tool_use: { hooks_dir: '.caws/hooks', handlers: ['old.sh'] } },
          libraries: {},
        },
      },
    })
  );
  fs.writeFileSync(
    path.join(p, '.codex/hooks.json'),
    JSON.stringify({
      hooks: {
        PreToolUse: [
          { hooks: [{ command: `python3 '${home}/bin/caws-hook' codex pre_tool_use` }] },
        ],
      },
    })
  );
  stock('after-migration');
  installMachineRuntime({ home, templatesRoot: templates });
  const local = () =>
    spawnSync('python3', [path.join(home, 'bin/caws-hook'), 'codex', 'pre_tool_use'], {
      cwd: p,
      encoding: 'utf8',
      env: { ...process.env, CAWS_HOME: home },
      input: JSON.stringify({ cwd: p, session_id: 'transition-test' }),
    });
  expect(invoke(p).status).toBe(0);
  expect(invoke(p).stdout).toBe('');
  expect(local().status).toBe(2);
  expect(local().stderr).toContain('legacy-denial');
  configure(p, { disabled: {}, extensions: {}, handlers: {}, libraries: {} });
  expect(invoke(p).stdout).toBe('');
  fs.writeFileSync(path.join(p, '.codex/hooks.json'), '{"hooks":{}}');
  expect(JSON.parse(invoke(p).stdout).reason).toBe('guard-after-migration');
  expect(JSON.parse(local().stdout).reason).toBe('guard-after-migration');
});
test('system registration remains quiet outside Git and outside CAWS projects', () => {
  installMachineRuntime({ home, templatesRoot: templates });
  expect(invoke(root).status).toBe(0);
  expect(invoke(root).stdout).toBe('');
  const p = path.join(root, 'plain');
  fs.mkdirSync(p);
  expect(spawnSync('git', ['init', '-q'], { cwd: p }).status).toBe(0);
  expect(invoke(p).status).toBe(0);
  expect(invoke(p).stdout).toBe('');
  fs.mkdirSync(path.join(p, '.caws/sessions'), { recursive: true });
  expect(invoke(p).status).toBe(0);
  expect(invoke(p).stdout).toBe('');
  fs.writeFileSync(path.join(p, '.caws/working-spec.yaml'), 'id: LEGACY\n');
  expect(invoke(p).status).toBe(0);
  expect(invoke(p, 'session_start').stderr).toContain('Legacy governance');
});

test('linked worktrees select canonical machine settings while handlers receive the actual checkout', () => {
  const p = repo('canonical');
  expect(
    spawnSync(
      'git',
      [
        '-c',
        'user.name=Test',
        '-c',
        'user.email=test@example.test',
        'commit',
        '--allow-empty',
        '-qm',
        'fixture',
      ],
      { cwd: p }
    ).status
  ).toBe(0);
  const linked = path.join(root, 'linked');
  expect(spawnSync('git', ['worktree', 'add', '-qb', 'lane', linked], { cwd: p }).status).toBe(0);
  fs.writeFileSync(
    path.join(p, 'custom.sh'),
    '#!/bin/bash\nprintf "checkout=%s\\n" "$CAWS_PROJECT_DIR" >&2\n',
    { mode: 0o755 }
  );
  configure(p, {
    disabled: {},
    extensions: { pre_tool_use: [{ handler: 'custom.sh', before: 'cwd-guard.sh' }] },
    handlers: { 'custom.sh': 'custom.sh' },
    libraries: {},
  });
  stock('linked');
  installMachineRuntime({ home, templatesRoot: templates });
  const result = invoke(linked, 'pre_tool_use', {
    CAWS_PROJECT_DIR: p,
    GIT_DIR: path.join(p, '.git'),
  });
  expect(result.status).toBe(2);
  expect(result.stderr).toContain('checkout=' + fs.realpathSync(linked));
  expect(JSON.parse(result.stdout).reason).toBe('guard-linked');
  expect(fs.existsSync(path.join(linked, '.caws/hooks'))).toBe(false);
});

test('unmodified stock guards protect hook paths and the stock renderer records the session without local executables', () => {
  const p = repo('stock');
  installMachineRuntime({ home });
  const denial = invoke(p, 'pre_tool_use', {}, { file_path: '.caws/hooks/attempt.sh' });
  expect(denial.status).toBe(2);
  expect(denial.stderr).toContain('protected');
  const machineDenial = invoke(
    p,
    'pre_tool_use',
    {},
    { file_path: path.join(home, 'state/adapter-runtime.json') }
  );
  expect(machineDenial.status).toBe(2);
  expect(machineDenial.stderr).toMatch(/protected|DIFFERENT repository/);
  const transcript = path.join(root, 'rollout.jsonl');
  fs.writeFileSync(
    transcript,
    [
      { type: 'event_msg', payload: { type: 'user_message', message: 'Check the runtime' } },
      {
        type: 'response_item',
        payload: {
          type: 'message',
          role: 'user',
          content: [{ type: 'input_text', text: 'Check the runtime' }],
        },
      },
      {
        type: 'response_item',
        payload: {
          type: 'function_call',
          name: 'exec_command',
          call_id: 'call-1',
          arguments: JSON.stringify({ cmd: 'git status --short' }),
        },
      },
      {
        type: 'response_item',
        payload: {
          type: 'function_call_output',
          call_id: 'call-1',
          output: 'Process exited with code 0\nOutput:\n',
        },
      },
      {
        type: 'response_item',
        payload: {
          type: 'message',
          role: 'assistant',
          channel: 'final',
          content: [{ type: 'output_text', text: 'The checkout is clean.' }],
        },
      },
    ]
      .map((r) => JSON.stringify({ timestamp: '2026-09-07T00:00:00Z', ...r }))
      .join('\n')
  );
  const start = invoke(
    p,
    'session_start',
    { CAWS_BIN: path.resolve(__dirname, '../../dist/index.js') },
    {},
    { transcript_path: transcript }
  );
  expect(start.status).toBe(0);
  const sessionDir = path.join(p, '.caws/sessions/system-test');
  const turn = JSON.parse(fs.readFileSync(path.join(sessionDir, 'turn-001.json')));
  expect(JSON.stringify(turn)).toContain('Check the runtime');
  expect(turn.refs.commands[0].command).toBe('git status --short');
  expect(JSON.stringify(turn)).toContain('The checkout is clean.');
  expect(fs.existsSync(path.join(sessionDir, 'turn-002.json'))).toBe(false);
  expect(fs.existsSync(path.join(p, '.caws/hooks'))).toBe(false);
});

test('system audit logs are machine-owned and do not dirty either project', () => {
  const a = repo('audit-a'),
    b = repo('audit-b');
  installMachineRuntime({ home, templatesRoot: templates });
  for (const p of [a, b]) {
    const result = invoke(p, 'session_start', {}, {}, { tool_name: '', source: 'startup' });
    expect(result.status).toBe(0);
    const key = crypto.createHash('sha256').update(fs.realpathSync(p)).digest('hex');
    const log = fs.readFileSync(
      path.join(home, 'state/projects', key, 'logs/codex/audit.log'),
      'utf8'
    );
    expect(log).toContain('session_start');
    expect(log).toContain(p);
    expect(fs.existsSync(path.join(p, '.codex/logs'))).toBe(false);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// Tier-2 guard configuration on the MACHINE-ROUTED plane
// (CAWS-HOOKS-GUARD-CONFIG-MACHINE-PLANE-E2E-01)
//
// tests/hooks/bats/guard-config-adopters.bats drives the PROJECT-WIRED
// dispatcher, which resolves libs by filesystem path. The machine plane does
// not: run-handlers.sh takes the `CAWS_MACHINE_RUNTIME == 1` branch and calls
// `caws_source_lib guard-config.sh`, whose resolution order is machine
// overrides -> $CAWS_HOME/surfaces/<s>/lib -> adapter lib dir -> shared lib
// dir. Nothing the project-wired arms prove says that chain finds the file.
//
// The stakes are asymmetric. A lib missing from the runtime install set does
// NOT degrade to the shipped table the way an absent project-local copy does:
// it takes down EVERY machine-routed tool call in every project on the machine.
// Two mechanisms produce that, and the arms below establish which one runs —
// the launcher's manifest check refuses first, by name (measured), ahead of the
// silent `caws_source_lib guard-config.sh || return 2` at run-handlers.sh:420.
// ─────────────────────────────────────────────────────────────────────────────

function writeGuardPolicy(p, guards) {
  fs.mkdirSync(path.join(p, '.caws/hooks'), { recursive: true });
  fs.writeFileSync(
    path.join(p, '.caws/hooks/hook-policy.json'),
    JSON.stringify({ version: 1, surfaces: {}, guards })
  );
}

// A probe standing in for a real adopter: it reaches the config through the
// same two accessors `scope-guard.sh` uses and reports what it saw on stderr.
//
// Its reachability is the oracle these arms need. `caws_source_lib
// guard-config.sh || return 2` aborts run_handlers BEFORE any handler body
// executes, so an abort is observable as the total ABSENCE of this marker --
// which an exit code cannot distinguish, because the stock chain legitimately
// exits 2 for its own reasons in a bare fixture repo.
function installProbeGuard() {
  fs.writeFileSync(
    path.join(templates, 'shared/cwd-guard.sh'),
    '#!/bin/bash\n' +
      // Sourced exactly the way the three real adopters do it --
      // `$SCRIPT_DIR/lib/guard-config.sh` (scope-guard.sh:79,
      // god-object-check.sh:47, loc-delta-check.sh:35) -- NOT via
      // CAWS_SHARED_LIB_DIR. The idiom is the thing under test: a guard and its
      // lib are siblings-with-a-lib-subdir in the project-wired pack, and this
      // asserts runtimeFiles() reproduces that same relative layout in the
      // machine snapshot. Probing with CAWS_SHARED_LIB_DIR would pass while
      // every real adopter silently found nothing.
      'SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"\n' +
      '[[ -f "$SCRIPT_DIR/lib/guard-config.sh" ]] && source "$SCRIPT_DIR/lib/guard-config.sh"\n' +
      'if declare -F caws_guard_prefixes >/dev/null 2>&1; then\n' +
      '  caws_guard_config_load "${CAWS_PROJECT_DIR:-.}" || true\n' +
      '  printf "SAW:%s:%s\\n" "${CAWS_GUARD_CONFIG_STATUS:-none}" ' +
      '"$(caws_guard_prefixes scope-guard.sh | tr "\\n" ",")" >&2\n' +
      'else\n' +
      '  printf "SAW:no-accessor:\\n" >&2\n' +
      'fi\n' +
      'exit 0\n'
  );
}
const seen = (r) => `${r.stdout || ''}${r.stderr || ''}`;

test('the runtime install set carries BOTH guard-config halves, so the machine chain cannot abort', () => {
  const result = installMachineRuntime({ home, templatesRoot: templates, plan: true });
  // Asserted as a pair on purpose: the accessor alone would source cleanly and
  // then report `unavailable` forever, because it resolves the parser as its
  // own sibling. Shipping one without the other is silent, not loud.
  expect(result.files).toContain('lib/guard-config.sh');
  expect(result.files).toContain('lib/guard-config.py');
});

test('both halves land on disk in the snapshot the launcher actually sources from', () => {
  const installed = installMachineRuntime({ home, templatesRoot: templates });
  const libDir = path.join(home, 'lib/runtimes', installed.digest, 'lib');
  expect(fs.existsSync(path.join(libDir, 'guard-config.sh'))).toBe(true);
  expect(fs.existsSync(path.join(libDir, 'guard-config.py'))).toBe(true);
});

test('the handler chain still runs to completion when the repo declares no policy', () => {
  // The regression lock: every project on the machine takes this path. The
  // claim is NOT about the final verdict (the stock chain owns that, and in a
  // bare fixture repo other guards legitimately block) -- it is that
  // run_handlers reached and ran a handler at all, which `|| return 2` would
  // have prevented.
  const p = repo('guard-config-none');
  installProbeGuard();
  installMachineRuntime({ home, templatesRoot: templates });
  configure(p, { disabled: {}, extensions: {}, handlers: {}, libraries: {} });
  const result = invoke(p, 'pre_tool_use', {}, { file_path: 'src/app.ts' });
  expect(seen(result)).toContain('SAW:');
  // `absent` and not `unavailable`: the parser was found and ran, and reported
  // a verified-absent document. `unavailable` here would mean the lib resolved
  // but its parser did not, which is the silent half of the same defect.
  expect(seen(result)).toContain('SAW:absent:');
  expect(seen(result)).not.toContain('SAW:no-accessor');
});

test('a runtime MISSING the accessor is refused by name, not degraded to the shipped table', () => {
  // The contrast that makes the two "the chain ran" arms non-vacuous: without
  // it, `toContain('SAW:')` could be passing for reasons unrelated to lib
  // resolution, and nothing would show the absence has any consequence.
  //
  // It also pins WHICH mechanism catches it, which is not the one the inner
  // code suggests. `run-handlers.sh:420` has `caws_source_lib guard-config.sh
  // || return 2` -- a silent abort with no diagnostic. That line never fires
  // here, because the launcher validates the snapshot against its manifest
  // first and refuses with the absolute path named. The loud failure is the
  // one that actually runs; `|| return 2` is the backstop behind it.
  //
  // Either way the behavior is total, not degrading: unlike an absent
  // project-local copy, this does not fall back to the shipped table, so the
  // manifest row is load-bearing rather than a nicety.
  const p = repo('guard-config-missing-lib');
  installProbeGuard();
  const installed = installMachineRuntime({ home, templatesRoot: templates });
  configure(p, { disabled: {}, extensions: {}, handlers: {}, libraries: {} });

  const healthy = invoke(p, 'pre_tool_use', {}, { file_path: 'src/app.ts' });
  expect(seen(healthy)).toContain('SAW:absent:');

  fs.rmSync(path.join(home, 'lib/runtimes', installed.digest, 'lib/guard-config.sh'));
  const broken = invoke(p, 'pre_tool_use', {}, { file_path: 'src/app.ts' });
  // Same repo, same envelope, same policy state; the only variable is the lib.
  expect(broken.status).toBe(2);
  expect(JSON.parse(broken.stdout).decision).toBe('block');
  // Named, so an operator can act on it. A bare exit 2 would be the silent
  // variant this assertion exists to exclude.
  expect(JSON.parse(broken.stdout).reason).toContain('guard-config.sh');
  expect(seen(broken)).not.toContain('SAW:');
});

test('an unparseable policy is refused by the LAUNCHER, before any handler runs', () => {
  // The two planes fail closed in different places, and this pins which.
  //
  // Project-wired: the chain is a baked HANDLERS array, so a bad document is
  // only ever a tier-2 concern -- the guard runs and gets zero entries
  // (guard-config-adopters.bats, "the threshold key is 'delta'").
  //
  // Machine-routed: the launcher must PARSE the document to build the chain at
  // all, because the tier-1 `surfaces` half decides which handlers exist. It
  // cannot defer that to a handler, so an unparseable document blocks the tool
  // call outright. That is strictly stronger than "apply zero entries", so the
  // tier-2 promise is preempted here, not violated.
  const p = repo('guard-config-invalid');
  installProbeGuard();
  installMachineRuntime({ home, templatesRoot: templates });
  configure(p, { disabled: {}, extensions: {}, handlers: {}, libraries: {} });
  fs.mkdirSync(path.join(p, '.caws/hooks'), { recursive: true });
  fs.writeFileSync(path.join(p, '.caws/hooks/hook-policy.json'), '{ this is not json');
  const result = invoke(p, 'pre_tool_use', {}, { file_path: 'src/app.ts' });

  expect(result.status).toBe(2);
  expect(JSON.parse(result.stdout).decision).toBe('block');
  // The refusal must NAME the file, or the operator cannot find what to fix.
  expect(JSON.parse(result.stdout).reason).toContain('.caws/hooks/hook-policy.json');
  // The block came from the launcher and not from some guard downstream: the
  // probe never ran. This is the load-bearing half -- without it the arm would
  // pass on any exit-2 for any reason.
  expect(seen(result)).not.toContain('SAW:');
});

test('the tier-2 document reaches a guard through bin/caws-hook, changing what it sees', () => {
  // The end-to-end claim, as a controlled pair: identical envelope, identical
  // fixture, the document as the only variable. A fixture guard reads the
  // config through the same accessors a real adopter uses and reports what it
  // saw, so this asserts the TRANSPORT (launcher -> run-handlers -> shared lib
  // -> accessor), which is the only part the project-wired arms cannot.
  const p = repo('guard-config-e2e');
  installProbeGuard();
  installMachineRuntime({ home, templatesRoot: templates });
  configure(p, { disabled: {}, extensions: {}, handlers: {}, libraries: {} });

  const before = invoke(p, 'pre_tool_use', {}, { file_path: 'native/core.rs' });
  writeGuardPolicy(p, {
    'scope-guard.sh': {
      additional_allow_prefixes: [
        { prefix: 'native/', reason: 'Rust core lives here; this repo has no src directory.' },
      ],
    },
  });
  const after = invoke(p, 'pre_tool_use', {}, { file_path: 'native/core.rs' });

  // Non-vacuity: the accessor must have been REACHABLE in both runs, so the
  // difference is the document and not a failure to source the lib at all.
  expect(seen(before)).not.toContain('SAW:no-accessor');
  expect(seen(after)).not.toContain('SAW:no-accessor');
  // Absent document -> `absent`, which is distinct from `invalid` and from
  // `unavailable`; the prefix list is empty.
  expect(seen(before)).toContain('SAW:absent:');
  // Present document -> parsed, and the declared prefix arrived intact.
  expect(seen(after)).toContain('SAW:ok:native/,');
});
