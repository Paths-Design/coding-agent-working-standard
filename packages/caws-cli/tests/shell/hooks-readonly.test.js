'use strict';

/**
 * `caws hooks list | validate | compile --check` (CAWS-HOOKS-READONLY-VERBS-01).
 *
 * Two deliberate choices about how this suite proves things:
 *
 *  - **Wiring is proven on the BUILT dist CLI, not by calling the handlers.**
 *    Handler-level tests bypass Commander entirely, and this repo has twice
 *    shipped defects that such tests stayed green over: a flag declared in
 *    metadata but never forwarded to its handler, and a parent option
 *    shadowing a leaf option so the leaf's value was silently discarded. Only
 *    spawning the real binary can catch that class.
 *
 *  - **`list` is exercised against a real launcher process**, a stub placed at
 *    `$CAWS_HOME/bin/caws-hook`. `machineHome()` already reads `CAWS_HOME`, so
 *    the production path runs unmodified — no test-only seam was added to the
 *    command to make it observable.
 */

const { execFileSync, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const CLI = path.resolve(__dirname, '..', '..', 'dist', 'index.js');
const TEMPLATES = path.resolve(__dirname, '..', '..', 'templates/hook-packs/shared');
const {
  systemCommand,
  machineCommand,
  MACHINE_EVENTS,
} = require('../../dist/init/native-hook-identification');

/** A throwaway git repo with a real dispatch tree copied from the templates. */
function makeRepo({ policy, chains = {}, events = ['pre_tool_use', 'stop'] } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'caws-hooks-'));
  const real = fs.realpathSync(dir);
  execFileSync('git', ['init', '-q'], {
    cwd: real,
    timeout: 5000,
    maxBuffer: 1024 * 1024,
  });
  const dispatch = path.join(real, '.caws', 'hooks', 'dispatch');
  fs.mkdirSync(dispatch, { recursive: true });
  for (const event of events) {
    fs.copyFileSync(
      path.join(TEMPLATES, 'dispatch', `${event}.sh`),
      path.join(dispatch, `${event}.sh`)
    );
  }
  for (const [event, content] of Object.entries(chains)) {
    fs.writeFileSync(path.join(dispatch, `${event}.chain`), content);
  }
  if (policy !== undefined) {
    fs.writeFileSync(
      path.join(real, '.caws', 'hooks', 'hook-policy.json'),
      typeof policy === 'string' ? policy : JSON.stringify(policy, null, 2)
    );
  }
  return real;
}

/**
 * A stub machine runtime whose launcher emits a canned selection document.
 * `handlers` entries are `[entry, tier|null]`.
 */
function makeMachineHome(handlers) {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'caws-home-')));
  fs.mkdirSync(path.join(home, 'bin'), { recursive: true });
  const document = {
    schema: 'caws.hook_selection.v1',
    handlers: handlers.map(([entry, tier]) => ({
      entry,
      path: `/stub/${entry}`,
      kind: 'stock',
      ...(tier === null ? {} : { tier }),
    })),
  };
  fs.writeFileSync(
    path.join(home, 'bin', 'caws-hook'),
    `import json,sys\nfrom pathlib import Path\nPath(${JSON.stringify(path.join(home, 'legacy-called'))}).write_text('called\\n')\nprint(json.dumps(${JSON.stringify(document)}))\n`
  );
  const user = path.join(home, 'user');
  for (const [surface, vendor, file] of [
    ['claude-code', '.claude', 'settings.json'],
    ['codex', '.codex', 'hooks.json'],
  ]) {
    fs.mkdirSync(path.join(home, 'surfaces', surface), { recursive: true });
    fs.writeFileSync(
      path.join(home, 'surfaces', surface, 'settings.json'),
      JSON.stringify({ version: 1, enabled: true })
    );
    fs.mkdirSync(path.join(user, vendor), { recursive: true });
    fs.writeFileSync(
      path.join(user, vendor, file),
      JSON.stringify({
        hooks: Object.fromEntries(
          Object.entries(MACHINE_EVENTS).map(([event, name]) => [
            name,
            [
              {
                matcher: '.*',
                hooks: [
                  { type: 'command', command: systemCommand(home, surface, event), timeout: 45 },
                ],
              },
            ],
          ])
        ),
      })
    );
  }
  return home;
}

function runCli(args, { cwd, env = {} } = {}) {
  const result = spawnSync(process.execPath, [CLI, ...args], {
    cwd,
    encoding: 'utf8',
    timeout: 30000,
    maxBuffer: 4 * 1024 * 1024,
    env: {
      ...process.env,
      ...(env.CAWS_HOME && fs.existsSync(path.join(env.CAWS_HOME, 'user'))
        ? { HOME: path.join(env.CAWS_HOME, 'user'), CODEX_HOME: '' }
        : {}),
      ...env,
    },
  });
  return { status: result.status, out: `${result.stdout}${result.stderr}` };
}

/** Recursive content hash of a directory — the read-only oracle. */
function treeHash(root) {
  const entries = [];
  const walk = (dir) => {
    for (const name of fs.readdirSync(dir).sort()) {
      const full = path.join(dir, name);
      const stat = fs.lstatSync(full);
      if (stat.isDirectory()) walk(full);
      else entries.push(`${path.relative(root, full)}:${fs.readFileSync(full).toString('base64')}`);
    }
  };
  walk(root);
  return require('node:crypto').createHash('sha256').update(entries.join('\n')).digest('hex');
}

describe('A5: the group is reachable through Commander on the built CLI', () => {
  test('caws hooks --help lists all three leaves', () => {
    const { status, out } = runCli(['hooks', '--help']);
    expect(status).toBe(0);
    for (const leaf of ['list', 'validate', 'compile']) expect(out).toContain(leaf);
  });

  test.each([
    ['list', ['--event', '--surface', '--json', '--data']],
    ['validate', ['--json', '--data']],
    ['compile', ['--check', '--event', '--json', '--data']],
  ])('caws hooks %s --help declares its flags', (leaf, flags) => {
    const { status, out } = runCli(['hooks', leaf, '--help']);
    expect(status).toBe(0);
    for (const flag of flags) expect(out).toContain(flag);
  });

  test('an undeclared flag is REJECTED, so the --help assertions are not vacuous', () => {
    // Control for the arms above: without it they would pass against a CLI
    // that accepted every flag and forwarded none.
    const { status } = runCli(['hooks', 'validate', '--not-a-real-flag']);
    expect(status).not.toBe(0);
  });

  test('compile does not ACCEPT a --surface it could not honor', () => {
    // A declared-but-unforwarded flag is the accept-and-discard defect this
    // suite exists for, and the first draft of this group shipped one:
    // `compile --surface` was declared in metadata and destructured in the
    // action, then never used. It cannot be honored — every project-wired
    // surface execs the same dispatcher, so there is one chain per event —
    // so the flag must not be accepted at all rather than silently ignored.
    const { status, out } = runCli(['hooks', 'compile', '--check', '--surface', 'opencode']);
    expect(status).not.toBe(0);
    expect(out).toMatch(/unknown option/i);
  });
});

describe('effective native and legacy inspection routes', () => {
  function registered(entry = 'native') {
    const repo = makeRepo();
    const home = makeMachineHome([['legacy-selected.sh', 'stock']]);
    const user = path.join(home, 'user');
    const config = path.join(user, '.codex/hooks.json');
    const trace = path.join(home, 'native-called');
    const quote = (s) => "'" + s.replace(/'/g, "'\\''") + "'";
    const native = path.join(home, 'bin/caws-hook-native');
    const document = {
      schema: 'caws.hook_selection.v1',
      handlers: [
        { entry: 'native-selected.sh', path: '/native/selected.sh', kind: 'stock', tier: 'stock' },
      ],
    };
    fs.writeFileSync(
      native,
      '#!/bin/sh\nprintf "%s\\n" "$*" > ' +
        quote(trace) +
        '\nprintf "%s\\n" "$PWD" > ' +
        quote(path.join(home, 'native-cwd')) +
        '\nprintf "%s\\n" "$CAWS_PROJECT_DIR" > ' +
        quote(path.join(home, 'native-project')) +
        '\nprintf "%s\\n" ' +
        quote(JSON.stringify(document)) +
        '\n',
      { mode: 0o755 }
    );
    const registration = {
      hooks: {
        PreToolUse: [
          {
            matcher: '.*',
            hooks: [
              { type: 'command', command: systemCommand(home, 'codex', 'pre_tool_use', entry) },
            ],
          },
        ],
      },
    };
    fs.writeFileSync(config, JSON.stringify(registration));
    const tools = path.join(home, 'empty-path');
    fs.mkdirSync(tools);
    const list = (extra = {}) =>
      runCli(['hooks', 'list', '--event', 'pre_tool_use', '--surface', 'codex', '--json'], {
        cwd: repo,
        env: { CAWS_HOME: home, CAWS_GIT_BINARY: '/usr/bin/git', ...extra },
      });
    const result = (extra = {}) => {
      const child = list(extra);
      expect(child.status).toBe(0);
      return JSON.parse(child.out).events[0];
    };
    return { repo, home, user, config, trace, native, registration, tools, list, result };
  }

  test('observed native registration runs its launcher with Python absent and retains caller context', () => {
    const f = registered();
    const nested = path.join(f.repo, 'nested');
    fs.mkdirSync(nested);
    const beforeRepo = treeHash(f.repo),
      beforeUser = treeHash(f.user);
    const child = runCli(
      ['hooks', 'list', '--event', 'pre_tool_use', '--surface', 'codex', '--json'],
      {
        cwd: nested,
        env: {
          HOME: f.user,
          CAWS_HOME: f.home,
          CAWS_PROJECT_DIR: nested,
          CAWS_GIT_BINARY: '/usr/bin/git',
          PATH: f.tools,
        },
      }
    );
    expect(child.status).toBe(0);
    expect(JSON.parse(child.out).events[0].handlers).toEqual([
      { entry: 'native-selected.sh', path: '/native/selected.sh', kind: 'stock', tier: 'stock' },
    ]);
    expect(fs.readFileSync(f.trace, 'utf8')).toBe('codex pre_tool_use --system --describe\n');
    expect(fs.readFileSync(path.join(f.home, 'native-cwd'), 'utf8')).toBe(nested + '\n');
    expect(fs.readFileSync(path.join(f.home, 'native-project'), 'utf8')).toBe(nested + '\n');
    expect(treeHash(f.repo)).toBe(beforeRepo);
    expect(treeHash(f.user)).toBe(beforeUser);
  });

  test('installed native launcher does not override observed legacy registration', () => {
    const f = registered('legacy');
    expect(f.result().handlers[0].entry).toBe('legacy-selected.sh');
    expect(fs.existsSync(f.trace)).toBe(false);
  });

  test.each(['empty', 'legacy', 'relative'])(
    'alternate %s CODEX_HOME cannot select stale HOME registration',
    (kind) => {
      const f = registered();
      const alternate = path.join(f.home, 'alternate-codex');
      fs.mkdirSync(alternate);
      if (kind === 'legacy')
        fs.writeFileSync(
          path.join(alternate, 'hooks.json'),
          JSON.stringify({
            hooks: {
              PreToolUse: [
                {
                  hooks: [
                    {
                      type: 'command',
                      command: systemCommand(f.home, 'codex', 'pre_tool_use', 'legacy'),
                    },
                  ],
                },
              ],
            },
          })
        );
      const row = f.result({ CODEX_HOME: kind === 'relative' ? 'alternate-codex' : alternate });
      expect(row.unavailable).toContain('Alternate CODEX_HOME');
      expect(row.handlers).toBeUndefined();
      expect(fs.existsSync(f.trace)).toBe(false);
      expect(fs.existsSync(path.join(f.home, 'legacy-called'))).toBe(false);
    }
  );

  test('explicit default CODEX_HOME preserves supported registration', () => {
    const f = registered();
    const row = f.result({ CODEX_HOME: path.join(f.home, 'user/.codex'), PATH: f.tools });
    expect(row.handlers[0].entry).toBe('native-selected.sh');
    expect(fs.readFileSync(f.trace, 'utf8')).toBe('codex pre_tool_use --system --describe\n');
  });

  test.each(['disabled TOML', 'additive JSON', 'benign TOML'])(
    'nested caller %s is observed before launcher selection',
    (kind) => {
      const f = registered();
      const nested = path.join(f.repo, 'nested/deeper');
      const config = path.join(f.repo, 'nested/.codex');
      fs.mkdirSync(nested, { recursive: true });
      fs.mkdirSync(config);
      if (kind === 'additive JSON') {
        const doc = JSON.parse(JSON.stringify(f.registration));
        doc.hooks.PreToolUse[0].hooks[0].command = machineCommand(
          f.home,
          'codex',
          'pre_tool_use',
          'native'
        );
        fs.writeFileSync(path.join(config, 'hooks.json'), JSON.stringify(doc));
      } else {
        fs.writeFileSync(
          path.join(config, 'config.toml'),
          kind === 'disabled TOML' ? '[features]\nhooks=false\n' : 'model="fixture"\n'
        );
      }
      const result = runCli(
        ['hooks', 'list', '--event', 'pre_tool_use', '--surface', 'codex', '--json'],
        { cwd: nested, env: { CAWS_HOME: f.home, CAWS_GIT_BINARY: '/usr/bin/git', PATH: f.tools } }
      );
      expect(result.status).toBe(0);
      const row = JSON.parse(result.out).events[0];
      if (kind === 'benign TOML') {
        expect(row.handlers[0].entry).toBe('native-selected.sh');
        expect(fs.readFileSync(path.join(f.home, 'native-cwd'), 'utf8')).toBe(nested + '\n');
      } else {
        expect(typeof row.unavailable).toBe('string');
        expect(row.handlers).toBeUndefined();
        expect(fs.existsSync(f.trace)).toBe(false);
        expect(fs.existsSync(path.join(f.home, 'legacy-called'))).toBe(false);
      }
    }
  );

  test('nested linked-checkout configuration maps to the root-checkout counterpart', () => {
    const f = registered();
    const checkout = path.join(f.home, 'linked-checkout');
    const nested = path.join(checkout, 'nested');
    fs.mkdirSync(nested, { recursive: true });
    const mapped = path.join(f.repo, 'nested/.codex');
    fs.mkdirSync(mapped, { recursive: true });
    fs.writeFileSync(path.join(mapped, 'config.toml'), '[features]\nhooks=false\n');
    const { observeHookInspectionRoute } = require('../../dist/init/hook-inspection-route');
    expect(() =>
      observeHookInspectionRoute({
        home: f.home,
        surface: 'codex',
        event: 'pre_tool_use',
        canonical: f.repo,
        checkout,
        caller: { cwd: nested, environment: { HOME: path.join(f.home, 'user') } },
      })
    ).toThrow('TOML hooks/features/state require native-harness qualification');
    expect(fs.existsSync(f.trace)).toBe(false);
  });

  test('default Codex configuration produced by configure preserves route admission', () => {
    const { installMachineRuntime } = require('../../dist/init/machine-adapters');
    const { configureSystemRuntime } = require('../../dist/init/system-runtime');
    const { observeHookInspectionRoute } = require('../../dist/init/hook-inspection-route');
    const repo = makeRepo();
    const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'caws-generated-')));
    const user = path.join(home, 'user');
    fs.mkdirSync(user);
    installMachineRuntime({ home, templatesRoot: path.dirname(TEMPLATES) });
    const config = path.join(user, '.codex/hooks.json');
    const plan = configureSystemRuntime({
      home,
      userHome: user,
      surface: 'codex',
      entry: 'legacy',
      plan: true,
    });
    expect(plan.changes.map((change) => change.path)).toContain(config);
    const registration = plan.changes.find((change) => change.path === config);
    expect(JSON.parse(registration.after).hooks.PreToolUse[0].hooks).toEqual([
      { type: 'command', command: systemCommand(home, 'codex', 'pre_tool_use'), timeout: 45 },
    ]);
    for (const change of plan.changes) {
      fs.mkdirSync(path.dirname(change.path), { recursive: true });
      fs.writeFileSync(change.path, change.after);
    }
    const before = treeHash(home);
    expect(
      observeHookInspectionRoute({
        home,
        surface: 'codex',
        event: 'pre_tool_use',
        canonical: repo,
        checkout: repo,
        caller: { cwd: repo, environment: { HOME: user } },
      })
    ).toEqual({ entry: 'legacy', system: true });
    expect(treeHash(home)).toBe(before);
  });

  test('all retained Codex event names and supported string metadata remain inspectable', () => {
    const f = registered();
    for (const event of [
      'PreModelRequest',
      'PostModelRequest',
      'PermissionRequest',
      'PostToolUse',
      'PreCompact',
      'PostCompact',
      'SessionStart',
      'SessionEnd',
      'UserPromptSubmit',
      'SubagentStart',
      'SubagentStop',
      'Stop',
      'Interrupt',
    ])
      f.registration.hooks[event] = [];
    f.registration.description = 'Observed registration fixture';
    f.registration.hooks.PreToolUse[0].hooks[0].statusMessage = 'Checking CAWS guardrails';
    f.registration.hooks.PreToolUse[0].hooks[0].timeout = 45;
    fs.writeFileSync(f.config, JSON.stringify(f.registration));
    expect(f.result({ PATH: f.tools }).handlers[0].entry).toBe('native-selected.sh');
    expect(fs.readFileSync(f.trace, 'utf8')).toBe('codex pre_tool_use --system --describe\n');
  });

  test.each([1, Number.MAX_SAFE_INTEGER])(
    'exact supported Codex timeout %s preserves native route admission',
    (timeout) => {
      const f = registered();
      f.registration.hooks.PreToolUse[0].hooks[0].timeout = timeout;
      fs.writeFileSync(f.config, JSON.stringify(f.registration));
      expect(f.result({ PATH: f.tools }).handlers[0].entry).toBe('native-selected.sh');
      expect(fs.readFileSync(f.trace, 'utf8')).toBe('codex pre_tool_use --system --describe\n');
    }
  );

  test.each([
    [
      'unknown top-level flag',
      (doc) => {
        doc.disableAllHooks = false;
      },
    ],
    [
      'nonstring description',
      (doc) => {
        doc.description = 7;
      },
    ],
    [
      'null hooks',
      (doc) => {
        doc.hooks = null;
      },
    ],
    [
      'array hooks',
      (doc) => {
        doc.hooks = [];
      },
    ],
    [
      'unknown event',
      (doc) => {
        doc.hooks.UnknownEvent = [];
      },
    ],
    [
      'malformed other event',
      (doc) => {
        doc.hooks.Stop = {};
      },
    ],
    [
      'null other-event group',
      (doc) => {
        doc.hooks.Stop = [null];
      },
    ],
    [
      'nonstring other-event matcher',
      (doc) => {
        doc.hooks.Stop = [{ matcher: 7, hooks: [] }];
      },
    ],
    [
      'malformed other-event hooks',
      (doc) => {
        doc.hooks.Stop = [{ hooks: {} }];
      },
    ],
    [
      'null other-event handler',
      (doc) => {
        doc.hooks.Stop = [{ hooks: [null] }];
      },
    ],
    [
      'unsupported other-event handler',
      (doc) => {
        doc.hooks.Stop = [{ hooks: [{ type: 'prompt' }] }];
      },
    ],
    [
      'hidden additive group',
      (doc) => {
        doc.hooks.PreToolUse.push({ ...doc.hooks.PreToolUse[0], enabled: false });
      },
    ],
    [
      'hidden additive hook',
      (doc) => {
        const hooks = doc.hooks.PreToolUse[0].hooks;
        hooks.push({ ...hooks[0], enabled: false });
      },
    ],
    [
      'nonstring command',
      (doc) => {
        doc.hooks.PreToolUse[0].hooks[0].command = 7;
      },
    ],
    [
      'empty command',
      (doc) => {
        doc.hooks.PreToolUse[0].hooks[0].command = ' ';
      },
    ],
    [
      'fractional timeout',
      (doc) => {
        doc.hooks.PreToolUse[0].hooks[0].timeout = 1.5;
      },
    ],
    [
      'negative timeout',
      (doc) => {
        doc.hooks.PreToolUse[0].hooks[0].timeout = -1;
      },
    ],
    [
      'zero timeout',
      (doc) => {
        doc.hooks.PreToolUse[0].hooks[0].timeout = 0;
      },
    ],
    [
      'string timeout',
      (doc) => {
        doc.hooks.PreToolUse[0].hooks[0].timeout = '45';
      },
    ],
    [
      'precision-losing timeout',
      (doc) => {
        doc.hooks.PreToolUse[0].hooks[0].timeout = Number.MAX_SAFE_INTEGER + 1;
      },
    ],
    [
      'u64-overflowing timeout',
      (doc) => {
        doc.hooks.PreToolUse[0].hooks[0].timeout = 1e20;
      },
    ],
    [
      'nonstring statusMessage',
      (doc) => {
        doc.hooks.PreToolUse[0].hooks[0].statusMessage = 7;
      },
    ],
    [
      'unsupported async field',
      (doc) => {
        doc.hooks.PreToolUse[0].hooks[0].async = false;
      },
    ],
    [
      'malformed foreign command in another event',
      (doc, fixture) => {
        doc.hooks.Stop = [
          {
            hooks: [
              {
                type: 'command',
                command: 'touch ' + JSON.stringify(path.join(fixture.home, 'must-not-execute')),
                timeout: '45',
              },
            ],
          },
        ];
      },
    ],
  ])('whole-file Codex JSON %s is unavailable before either launcher runs', (_name, mutate) => {
    const f = registered();
    mutate(f.registration, f);
    fs.writeFileSync(f.config, JSON.stringify(f.registration));
    const row = f.result();
    expect(row.unavailable).toContain('Unsupported Codex JSON registration');
    expect(row.handlers).toBeUndefined();
    expect(fs.existsSync(f.trace)).toBe(false);
    expect(fs.existsSync(path.join(f.home, 'legacy-called'))).toBe(false);
    expect(fs.existsSync(path.join(f.home, 'must-not-execute'))).toBe(false);
  });

  test.each(['literal', 'escaped'])(
    'duplicate %s Codex JSON hooks key is unavailable before launcher selection',
    (mode) => {
      const f = registered();
      const hooks = JSON.stringify(f.registration.hooks);
      const secondKey = mode === 'literal' ? '"hooks"' : '"ho\\u006fks"';
      fs.writeFileSync(f.config, '{"hooks":' + hooks + ',' + secondKey + ':' + hooks + '}');
      const row = f.result();
      expect(row.unavailable).toContain('invalid Codex JSON registration');
      expect(row.handlers).toBeUndefined();
      expect(fs.existsSync(f.trace)).toBe(false);
      expect(fs.existsSync(path.join(f.home, 'legacy-called'))).toBe(false);
    }
  );

  test.each([
    [
      'UTF-8',
      (hooks) =>
        Buffer.concat([
          Buffer.from('{"description":"'),
          Buffer.from([0xff]),
          Buffer.from('","hooks":' + hooks + '}'),
        ]),
    ],
    ['depth', () => '{"extra":' + '['.repeat(17) + '0' + ']'.repeat(17) + '}'],
    ['nodes', () => '{"extra":[' + Array(100_001).fill('0').join(',') + ']}'],
    ['bytes', () => ' '.repeat(1024 * 1024 + 1)],
  ])('bounded Codex JSON rejects invalid %s without a launcher', (name, bytes) => {
    const f = registered();
    fs.writeFileSync(f.config, bytes(JSON.stringify(f.registration.hooks)));
    const row = f.result();
    expect(row.unavailable).toContain(
      name === 'bytes' ? 'Unsupported Codex JSON registration' : 'invalid Codex JSON registration'
    );
    expect(row.handlers).toBeUndefined();
    expect(fs.existsSync(f.trace)).toBe(false);
    expect(fs.existsSync(path.join(f.home, 'legacy-called'))).toBe(false);
  });

  test.each([
    'missing',
    'corrupt',
    'duplicate',
    'restricted',
    'wrong-home',
    'disabled',
    'exec-form',
    'opaque-command',
    'disabled-settings',
    'missing-settings',
  ])('unavailable %s registration never invokes either launcher', (mode) => {
    const f = registered();
    if (mode === 'missing') fs.unlinkSync(f.config);
    else if (mode === 'corrupt') fs.writeFileSync(f.config, '{');
    else {
      const group = f.registration.hooks.PreToolUse[0];
      if (mode === 'duplicate') f.registration.hooks.PreToolUse.push(group);
      if (mode === 'restricted') group.matcher = 'Bash';
      if (mode === 'wrong-home')
        group.hooks[0].command = systemCommand(
          path.join(f.home, 'other'),
          'codex',
          'pre_tool_use',
          'native'
        );
      if (mode === 'disabled') f.registration.disableAllHooks = true;
      if (mode === 'exec-form')
        group.hooks[0] = {
          type: 'command',
          command: f.native,
          args: ['codex', 'pre_tool_use', '--system'],
        };
      if (mode === 'opaque-command')
        group.hooks[0].command =
          f.native +
          ' $(touch ' +
          path.join(f.home, 'must-not-execute') +
          ') codex pre_tool_use --system';
      if (mode === 'disabled-settings')
        fs.writeFileSync(
          path.join(f.home, 'surfaces/codex/settings.json'),
          JSON.stringify({ version: 1, enabled: false })
        );
      if (mode === 'missing-settings')
        fs.unlinkSync(path.join(f.home, 'surfaces/codex/settings.json'));
      fs.writeFileSync(f.config, JSON.stringify(f.registration));
    }
    const row = f.result();
    expect(row.unavailable).toBeTruthy();
    expect(row.handlers).toBeUndefined();
    expect(fs.existsSync(f.trace)).toBe(false);
    expect(fs.existsSync(path.join(f.home, 'legacy-called'))).toBe(false);
    expect(fs.existsSync(path.join(f.home, 'must-not-execute'))).toBe(false);
  });

  test.each(['missing-entry', 'failed-entry', 'malformed-output', 'inactive-output'])(
    'native %s never falls back to an available legacy launcher',
    (mode) => {
      const f = registered();
      if (mode === 'missing-entry') fs.unlinkSync(f.native);
      if (mode === 'failed-entry')
        fs.writeFileSync(f.native, '#!/bin/sh\nprintf "native integrity failure\\n" >&2\nexit 2\n');
      if (mode === 'malformed-output') fs.writeFileSync(f.native, '#!/bin/sh\nprintf "{}\\n"\n');
      if (mode === 'inactive-output')
        fs.writeFileSync(
          f.native,
          '#!/bin/sh\nprintf \'{"schema":"caws.hook_selection.v1","status":"inactive","reason":"project governance absent","handlers":[]}\\n\'\n'
        );
      const row = f.result();
      expect(row.unavailable).toBeTruthy();
      expect(row.handlers).toBeUndefined();
      expect(JSON.stringify(row)).not.toContain('legacy-selected.sh');
      expect(fs.existsSync(path.join(f.home, 'legacy-called'))).toBe(false);
    }
  );

  test('canonical project registration selects project mode without a user producer', () => {
    const f = registered();
    fs.unlinkSync(f.config);
    fs.mkdirSync(path.join(f.repo, '.codex'));
    f.registration.hooks.PreToolUse[0].hooks[0].command = machineCommand(
      f.home,
      'codex',
      'pre_tool_use',
      'native'
    );
    fs.writeFileSync(path.join(f.repo, '.codex/hooks.json'), JSON.stringify(f.registration));
    expect(f.result({ PATH: f.tools }).handlers[0].entry).toBe('native-selected.sh');
    expect(fs.readFileSync(f.trace, 'utf8')).toBe('codex pre_tool_use --describe\n');
  });

  test.each([
    ['feature disabled', '[features]\nhooks=false\n'],
    ['feature enabled without qualification', 'features.hooks=true\n'],
    ['quoted feature', '["features"]\n"hooks"=false\n'],
    ['escaped feature', '["feat\\u0075res"]\n"ho\\u006fks"=false\n'],
    ['inline feature', 'features={hooks=false}\n'],
    ['hook state', '[hooks.state."file:hooks.json:pre_tool_use:0:0"]\nenabled=false\n'],
    [
      'hook trust',
      '[hooks.state."file:hooks.json:pre_tool_use:0:0"]\ntrusted_hash="sha256:other"\n',
    ],
    ['quoted hook table', '["hooks"."state"."opaque"]\nenabled=true\n'],
    ['opaque hook scalar', 'hooks=false\n'],
    ['profile hook state', '[profiles.fast.hooks.state.key]\nenabled=false\n'],
    ['profile features', '[profiles.fast.features]\nhooks=false\n'],
    ['malformed document', 'model="unterminated\n'],
    ['duplicate key', 'model="a"\nmodel="b"\n'],
    ['opaque profile map', 'profiles=2026-01-01\n'],
    ['oversized document', '#' + 'x'.repeat(1024 * 1024)],
    ['invalid UTF8', Buffer.from([0x23, 0xff, 0x0a])],
  ])('command-free TOML %s is unavailable without invoking a launcher', (name, bytes) => {
    const f = registered();
    fs.writeFileSync(path.join(f.user, '.codex/config.toml'), bytes);
    const row = f.result();
    expect(row.unavailable).toMatch(/TOML|UTF-8/i);
    expect(row.handlers).toBeUndefined();
    expect(fs.existsSync(f.trace)).toBe(false);
    expect(fs.existsSync(path.join(f.home, 'legacy-called'))).toBe(false);
  });

  test.each([
    ['empty', ''],
    ['comment-only', '# [hooks] and features.hooks=false are inert comments\n'],
    [
      'model and project',
      'model="test-model"\nmodel_reasoning_effort="high"\n[projects."/project/with.dots"]\ntrust_level="trusted"\n',
    ],
    ['exact bigint', 'model="test"\n[history]\nmax_bytes=9223372036854775807\n'],
    ['model profile', '[profiles.fast]\nmodel="test-model"\n'],
    [
      'hook words in strings',
      'model="hooks features"\n[projects."features.hooks"]\ntrust_level="trusted"\n',
    ],
  ])('benign %s TOML preserves the observed JSON route', (name, bytes) => {
    const f = registered();
    fs.writeFileSync(path.join(f.user, '.codex/config.toml'), bytes);
    expect(f.result({ PATH: f.tools }).handlers[0].entry).toBe('native-selected.sh');
    expect(fs.readFileSync(f.trace, 'utf8')).toBe('codex pre_tool_use --system --describe\n');
  });

  test('command-free canonical project TOML also cannot silently disable inspected hooks', () => {
    const f = registered();
    fs.mkdirSync(path.join(f.repo, '.codex'));
    fs.writeFileSync(path.join(f.repo, '.codex/config.toml'), '"features"={"hooks"=false}\n');
    expect(f.result().unavailable).toMatch(/TOML/);
    expect(fs.existsSync(f.trace)).toBe(false);
  });
});

describe('A2: validate', () => {
  test('an ABSENT policy is valid, not an error', () => {
    const repo = makeRepo();
    const { status, out } = runCli(['hooks', 'validate'], { cwd: repo });
    expect(status).toBe(0);
    expect(out).toContain('absent');
  });

  test('a well-formed policy is accepted', () => {
    const repo = makeRepo({
      policy: { version: 1, surfaces: { default: { extensions: {} } }, guards: {} },
    });
    const { status, out } = runCli(['hooks', 'validate'], { cwd: repo });
    expect(status).toBe(0);
    expect(out).toContain('valid');
  });

  test('malformed JSON is REJECTED with exit 1 and nothing is applied', () => {
    const repo = makeRepo({ policy: '{ not json' });
    const { status, out } = runCli(['hooks', 'validate'], { cwd: repo });
    expect(status).toBe(1);
    expect(out).toContain('REJECTED');
    expect(out).toContain('Nothing was applied');
  });

  test('disabling a REPO_POLICY_FLOOR handler is REJECTED', () => {
    // The floor exists so a policy cannot remove the mechanism that makes the
    // policy reviewable. A policy that can authorize its own amendment is not
    // a policy.
    const repo = makeRepo({
      policy: {
        version: 1,
        surfaces: { default: { disabled: { pre_tool_use: ['protected-paths.sh'] } } },
        guards: {},
      },
    });
    const { status, out } = runCli(['hooks', 'validate'], { cwd: repo });
    expect(status).toBe(1);
    expect(out).toContain('protected-paths.sh');
  });

  test('a NON-floor handler may be disabled — the floor is narrow, not a blanket ban', () => {
    // Discrimination control for the arm above: without it, a validator that
    // rejected every `disabled` entry would look correct.
    const repo = makeRepo({
      policy: {
        version: 1,
        surfaces: { default: { disabled: { pre_tool_use: ['quiet-merge.sh'] } } },
        guards: {},
      },
    });
    expect(runCli(['hooks', 'validate'], { cwd: repo }).status).toBe(0);
  });

  test('a project-wired named surface is WARNED, not rejected', () => {
    // Every project-wired surface execs the same dispatcher, so only
    // surfaces.default can reach the compiled chain. The document is legal;
    // the expectation behind it is not, and silence would let it look
    // effective.
    const repo = makeRepo({
      policy: { version: 1, surfaces: { opencode: { extensions: {} } }, guards: {} },
    });
    const { status, out } = runCli(['hooks', 'validate'], { cwd: repo });
    expect(status).toBe(0);
    expect(out).toContain('warning');
    expect(out).toContain('surfaces.default');
  });

  test('--json carries the same verdict as the exit code', () => {
    const repo = makeRepo({ policy: '{ not json' });
    const { status, out } = runCli(['hooks', 'validate', '--json'], { cwd: repo });
    expect(status).toBe(1);
    const parsed = JSON.parse(out.trim());
    expect(parsed).toMatchObject({ schema: 'caws.hooks_validate.v1', valid: false, present: true });
    expect(typeof parsed.error).toBe('string');
  });
});

describe('A1: list resolves through the launcher', () => {
  test('rows carry the tier the launcher reported', () => {
    const repo = makeRepo();
    const home = makeMachineHome([
      ['block-dangerous.sh', 'stock'],
      ['rg-replace-guard.sh', 'repo-policy'],
      ['local-only.sh', 'machine-policy'],
    ]);
    const { status, out } = runCli(['hooks', 'list', '--event', 'pre_tool_use'], {
      cwd: repo,
      env: { CAWS_HOME: home },
    });
    expect(status).toBe(0);
    expect(out).toContain('rg-replace-guard.sh  (repo-policy)');
    expect(out).toContain('local-only.sh  (machine-policy)');
    // A floor handler is marked so a reader can see what may not be removed.
    expect(out).toContain('block-dangerous.sh  (stock) [floor]');
  });

  test('a launcher that omits tier renders "unknown" and names the remediation', () => {
    // The installed runtime under ~/.caws has its own lifecycle and routinely
    // predates the CLI. Rendering a missing field as `undefined` would be a
    // lie dressed as data; this pins the honest output AND the fix.
    const repo = makeRepo();
    const home = makeMachineHome([['block-dangerous.sh', null]]);
    const { status, out } = runCli(['hooks', 'list', '--event', 'pre_tool_use'], {
      cwd: repo,
      env: { CAWS_HOME: home },
    });
    expect(status).toBe(0);
    expect(out).toContain('(unknown)');
    expect(out).not.toContain('undefined');
    expect(out).toContain('caws init adapters install');
  });

  test('no machine runtime is reported as unavailable, and list still exits 0', () => {
    const repo = makeRepo();
    const empty = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'caws-empty-')));
    const { status, out } = runCli(['hooks', 'list', '--event', 'pre_tool_use'], {
      cwd: repo,
      env: { CAWS_HOME: empty },
    });
    expect(status).toBe(0);
    expect(out).toContain('unavailable');
  });

  test('--json emits the resolved chain as a parseable contract', () => {
    const repo = makeRepo();
    const home = makeMachineHome([['scope-guard.sh', 'repo-policy']]);
    const { status, out } = runCli(
      ['hooks', 'list', '--event', 'pre_tool_use', '--surface', 'codex', '--json'],
      { cwd: repo, env: { CAWS_HOME: home } }
    );
    expect(status).toBe(0);
    const parsed = JSON.parse(out.trim());
    expect(parsed.schema).toBe('caws.hooks_list.v1');
    // --surface reached the handler; a metadata-only flag would not change this.
    expect(parsed.surface).toBe('codex');
    expect(parsed.events[0].handlers[0]).toMatchObject({
      entry: 'scope-guard.sh',
      tier: 'repo-policy',
    });
  });
});

describe('tier-2 guard configuration is visible in list (VISIBILITY-PARITY-01)', () => {
  /** A policy whose only content is the tier-2 block under test. */
  const withGuards = (guards) => ({ version: 1, surfaces: { default: {} }, guards });

  const NATIVE_REASON = 'The Rust core lives in native/; this repo has no src/ at all.';

  test('A1: the prefix AND the reason the parser demanded are both rendered', () => {
    // The whole point of the slice. `parseRepoHookPolicy` refuses a prefix
    // entry whose reason is shorter than 12 characters, and until now nothing
    // read that field back — a required field with no readers is theater, and
    // this is precisely the field the anti-abuse doctrine ("would this be
    // correct in a repo with a different layout?") relies on a reviewer
    // seeing. Asserting the reason TEXT, not merely that a guards section
    // exists, is what makes the requirement load-bearing.
    const repo = makeRepo({
      policy: withGuards({
        'scope-guard.sh': {
          additional_allow_prefixes: [{ prefix: 'native/', reason: NATIVE_REASON }],
        },
      }),
    });
    const { status, out } = runCli(['hooks', 'list', '--event', 'pre_tool_use'], { cwd: repo });
    expect(status).toBe(0);
    expect(out).toContain('scope-guard.sh');
    expect(out).toContain('allow-prefix native/');
    expect(out).toContain(NATIVE_REASON);
  });

  test('A1: a threshold renders its value AND that env still outranks it', () => {
    // Precedence is env > config > shipped default. A reader comparing this
    // number against observed behavior and finding a mismatch would otherwise
    // conclude the config was ignored, when an env var simply won — so the
    // rendering has to carry the precedence, not just the number.
    const repo = makeRepo({
      policy: withGuards({ 'god-object-check.sh': { thresholds: { loc: 2500 } } }),
    });
    const { status, out } = runCli(['hooks', 'list', '--event', 'pre_tool_use'], { cwd: repo });
    expect(status).toBe(0);
    expect(out).toContain('threshold loc = 2500');
    expect(out).toMatch(/env overrides/i);
  });

  test('A2: --json carries guards under its OWN key, not folded into the chain', () => {
    // A consumer must be able to tell "this guard was added or removed"
    // (tier 1, surface-scoped, changes the chain) from "this guard reads
    // extra data" (tier 2, top-level, changes no handler's presence). Folding
    // tier 2 into `declared` or into an event's handler list would erase that
    // distinction, so the separation is asserted, not just the presence.
    const repo = makeRepo({
      policy: withGuards({
        'scope-guard.sh': {
          additional_allow_prefixes: [{ prefix: 'native/', reason: NATIVE_REASON }],
        },
        'loc-delta-check.sh': { thresholds: { delta: 400 } },
      }),
    });
    const { status, out } = runCli(['hooks', 'list', '--event', 'pre_tool_use', '--json'], {
      cwd: repo,
    });
    expect(status).toBe(0);
    const parsed = JSON.parse(out.trim());
    expect(parsed.guards).toEqual([
      { guard: 'loc-delta-check.sh', prefixes: [], thresholds: [['delta', 400]] },
      {
        guard: 'scope-guard.sh',
        prefixes: [{ prefix: 'native/', reason: NATIVE_REASON }],
        thresholds: [],
      },
    ]);
    // Tier 2 is NOT surface-scoped and must not leak into the tier-1 view.
    expect(JSON.stringify(parsed.declared ?? {})).not.toContain('native/');
    expect(JSON.stringify(parsed.events)).not.toContain('native/');
  });

  test('A2: the JSON ordering is deterministic, so a diff of two runs is signal', () => {
    // These rows land in review diffs and in `--json` consumers. Object key
    // order in JSON is insertion order, so without an explicit sort the same
    // document could render two ways and produce a phantom diff.
    const repo = makeRepo({
      policy: withGuards({
        'write-allowlist.sh': {
          additional_allow_prefixes: [{ prefix: 'z/', reason: NATIVE_REASON }],
        },
        'god-object-check.sh': { thresholds: { loc: 2500, delta: 300 } },
      }),
    });
    const first = runCli(['hooks', 'list', '--json'], { cwd: repo });
    const second = runCli(['hooks', 'list', '--json'], { cwd: repo });
    expect(first.out).toBe(second.out);
    const parsed = JSON.parse(first.out.trim());
    expect(parsed.guards.map((row) => row.guard)).toEqual([
      'god-object-check.sh',
      'write-allowlist.sh',
    ]);
    expect(parsed.guards[0].thresholds).toEqual([
      ['delta', 300],
      ['loc', 2500],
    ]);
  });

  test('A4: opting out of tier 2 costs NO output — byte-identical to no guards key', () => {
    // The strong form of "says nothing about tier-2 config": rather than
    // asserting the absence of a marker string (which would pass against a
    // renderer that emitted a differently-worded empty section), render the
    // same repo with an empty `guards` object and with the key absent
    // entirely, and require the two to be byte-identical.
    const absent = makeRepo({ policy: { version: 1, surfaces: { default: {} } } });
    const empty = makeRepo({ policy: withGuards({}) });
    const a = runCli(['hooks', 'list', '--event', 'pre_tool_use'], { cwd: absent });
    const b = runCli(['hooks', 'list', '--event', 'pre_tool_use'], { cwd: empty });
    expect(a.status).toBe(0);
    expect(a.out).toBe(b.out);
    expect(a.out).not.toContain('guard configuration');
    expect(a.out).not.toContain('allow-prefix');
  });

  test('A4: a guard entry declaring nothing is not rendered as an empty heading', () => {
    // `guards: { 'scope-guard.sh': {} }` is a legal document that declares no
    // data. Rendering a bare guard name under the tier-2 heading would tell a
    // reader something is configured when nothing is.
    const repo = makeRepo({ policy: withGuards({ 'scope-guard.sh': {} }) });
    const { status, out } = runCli(['hooks', 'list', '--event', 'pre_tool_use'], { cwd: repo });
    expect(status).toBe(0);
    expect(out).not.toContain('guard configuration');
  });

  test('the section is not unconditional: it appears only when tier 2 has content', () => {
    // Discrimination control for every A4 arm above. Without it they would
    // all pass against a renderer that had stopped emitting the section at
    // all — including in the A1 case where it is required.
    const configured = makeRepo({
      policy: withGuards({
        'scope-guard.sh': {
          additional_allow_prefixes: [{ prefix: 'native/', reason: NATIVE_REASON }],
        },
      }),
    });
    expect(runCli(['hooks', 'list'], { cwd: configured }).out).toContain('guard configuration');
  });

  test('an INVALID policy renders no tier-2 section and list still exits 0', () => {
    // `list` is explanatory, never enforcing (invariant 3), so unlike
    // `validate` it must not fail on a bad document. The risk is the other
    // way: rendering tier-2 rows parsed out of a document the validator
    // rejected would show a reader configuration that no guard will ever
    // apply, since a malformed document applies ZERO entries.
    const repo = makeRepo({
      policy: '{ "version": 1, "guards": { "scope-guard.sh": { "thresholds": { "loc": 5 } } } }',
    });
    const { status, out } = runCli(['hooks', 'list', '--event', 'pre_tool_use'], { cwd: repo });
    expect(status).toBe(0);
    expect(out).not.toContain('guard configuration');
    expect(runCli(['hooks', 'list', '--json'], { cwd: repo }).out).toContain('"guards":null');
  });

  test('list with a guards block is still READ-ONLY', () => {
    // The tier-2 rendering reads a file the command must not touch.
    const repo = makeRepo({
      policy: withGuards({
        'scope-guard.sh': {
          additional_allow_prefixes: [{ prefix: 'native/', reason: NATIVE_REASON }],
        },
      }),
    });
    const before = treeHash(path.join(repo, '.caws'));
    expect(runCli(['hooks', 'list'], { cwd: repo }).status).toBe(0);
    expect(treeHash(path.join(repo, '.caws'))).toBe(before);
  });
});

describe('A3: compile --check', () => {
  test('a repo with no policy and no sidecar is FRESH, not stale', () => {
    // Compiling a sidecar that merely restates the dispatcher's own stock
    // array would add a file to keep in sync for no behavioral gain.
    const repo = makeRepo();
    const { status, out } = runCli(['hooks', 'compile', '--check'], { cwd: repo });
    expect(status).toBe(0);
    expect(out).toContain('current');
  });

  test('a policy with no compiled sidecar is STALE and names the event', () => {
    const repo = makeRepo({
      policy: {
        version: 1,
        surfaces: { default: { disabled: { pre_tool_use: ['quiet-merge.sh'] } } },
        guards: {},
      },
    });
    const { status, out } = runCli(['hooks', 'compile', '--check'], { cwd: repo });
    expect(status).toBe(1);
    expect(out).toContain('pre_tool_use');
    expect(out).toContain('no compiled chain on disk');
  });

  test('a sidecar compiled against an older pack is named as a pack lag', () => {
    const repo = makeRepo({
      policy: { version: 1, surfaces: { default: {} }, guards: {} },
      chains: {
        pre_tool_use:
          '# caws hook chain v1 surface=default event=pre_tool_use policy-sha256=x pack=1\n',
      },
    });
    const { status, out } = runCli(['hooks', 'compile', '--check'], { cwd: repo });
    expect(status).toBe(1);
    expect(out).toMatch(/pack 1, shipping \d+/);
  });

  test('an invalid policy fails the check rather than compiling against a partial document', () => {
    const repo = makeRepo({ policy: '{ not json' });
    const { status, out } = runCli(['hooks', 'compile', '--check'], { cwd: repo });
    expect(status).toBe(1);
    expect(out).toContain('invalid');
  });

  test('--json reports wrote:false', () => {
    const repo = makeRepo();
    const { status, out } = runCli(['hooks', 'compile', '--check', '--json'], { cwd: repo });
    expect(status).toBe(0);
    const parsed = JSON.parse(out.trim());
    expect(parsed).toMatchObject({ schema: 'caws.hooks_compile_check.v1', wrote: false, stale: 0 });
  });

  test('--check is what makes compile read-only: the bare form DOES write', () => {
    // The separability claim this whole suite rests on, asserted as a
    // difference rather than as two independent facts. One repo, one policy,
    // one flag as the only variable: `--check` must leave `.caws/` byte-
    // identical, and dropping it must not. Without the second half, every
    // read-only assertion here would also hold for a `compile` that had
    // silently stopped working.
    const policy = {
      version: 1,
      surfaces: {
        default: {
          disabled: {
            pre_tool_use: [
              { handler: 'cwd-guard.sh', reason: 'this repo has no tracked worktrees' },
            ],
          },
        },
      },
    };
    const checked = makeRepo({ policy });
    const beforeCheck = treeHash(path.join(checked, '.caws'));
    expect(runCli(['hooks', 'compile', '--check'], { cwd: checked }).status).toBe(1);
    expect(treeHash(path.join(checked, '.caws'))).toBe(beforeCheck);

    const compiled = makeRepo({ policy });
    const beforeCompile = treeHash(path.join(compiled, '.caws'));
    expect(runCli(['hooks', 'compile'], { cwd: compiled }).status).toBe(0);
    expect(treeHash(path.join(compiled, '.caws'))).not.toBe(beforeCompile);
  });
});

describe('A4: read-only is proven by observation, not by reading the code', () => {
  test.each([
    ['list', ['hooks', 'list']],
    ['validate', ['hooks', 'validate']],
    ['compile --check (fresh)', ['hooks', 'compile', '--check']],
  ])('%s leaves .caws/ byte-identical', (_label, args) => {
    const repo = makeRepo({
      policy: { version: 1, surfaces: { default: {} }, guards: {} },
    });
    const before = treeHash(path.join(repo, '.caws'));
    runCli(args, { cwd: repo });
    expect(treeHash(path.join(repo, '.caws'))).toBe(before);
  });

  test('compile --check leaves .caws/ untouched even when it reports STALE', () => {
    // The interesting case: the command has just decided a file is wrong and
    // must still not fix it.
    const repo = makeRepo({
      policy: {
        version: 1,
        surfaces: { default: { disabled: { pre_tool_use: ['quiet-merge.sh'] } } },
        guards: {},
      },
    });
    const before = treeHash(path.join(repo, '.caws'));
    expect(runCli(['hooks', 'compile', '--check'], { cwd: repo }).status).toBe(1);
    expect(treeHash(path.join(repo, '.caws'))).toBe(before);
  });

  test('the tree hash can actually observe a change', () => {
    // Discrimination control for every arm above: without it they would all
    // pass against a hash function that returned a constant.
    const repo = makeRepo();
    const before = treeHash(path.join(repo, '.caws'));
    fs.writeFileSync(path.join(repo, '.caws', 'hooks', 'dispatch', 'pre_tool_use.chain'), 'x\n');
    expect(treeHash(path.join(repo, '.caws'))).not.toBe(before);
  });
});
