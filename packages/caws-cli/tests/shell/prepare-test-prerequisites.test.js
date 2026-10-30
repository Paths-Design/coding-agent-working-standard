'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { main } = require('../../scripts/prepare-test-prerequisites');
const receipt = require('../../scripts/lib/native-test-prerequisite-receipt.cjs');
const toolchain = receipt.toolchainObservation(
  'rustc 1.90.0 (fixture)\nrelease: 1.90.0\nhost: fixture\n',
  'cargo 1.90.0 (fixture)\n'
);

let root;
let packageRoot;
let target;
let calls;
let errors;
let output;
const ok = { status: 0, signal: null };

beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'caws-test-preparation-')));
  packageRoot = path.join(root, 'packages/caws-cli');
  target = path.join(root, 'packages/caws-native/target');
  fs.mkdirSync(packageRoot, { recursive: true });
  for (const [relative, text] of Object.entries({
    'rust-toolchain.toml': '[toolchain]\nchannel = "1.90.0"\n',
    'packages/caws-native/Cargo.toml': '[package]\nname="caws-native"\n',
    'packages/caws-cli/src/runtime/service-client.ts': '// client fixture',
    'packages/caws-cli/src/runtime/service-protocol.ts': '// protocol fixture',
    'packages/caws-native/Cargo.lock': 'version = 4\n',
    'packages/caws-native/build.rs': 'fn main() {}\n',
    'packages/caws-native/src/lib.rs': '// lib fixture\n',
    'packages/caws-native/tests/input.txt': 'test fixture',
    'packages/caws-native/examples/input.c': '// example fixture',
    'packages/caws-cli/templates/hook-packs/shared/input.sh': '# template fixture',
  })) {
    const file = path.join(root, relative);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, text);
  }

  calls = [];
  errors = [];
  output = [];
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

function emit(relative) {
  const file = path.join(target, relative);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, 'compiled fixture output');
}
function helpers() {
  emit('qualification-tools/scripts/committed-turn-files.js');
  emit('qualification-tools/scripts/render-qualification-harness.js');
}
function coreArtifact() {
  const file = path.join(target, 'debug/deps/caws_native-fixture');
  emit('debug/deps/caws_native-fixture');
  fs.chmodSync(file, 0o755);
  return {
    status: 0,
    signal: null,
    stdout:
      JSON.stringify({
        reason: 'compiler-artifact',
        target: {
          name: 'caws_native',
          kind: ['lib'],
          src_path: path.join(root, 'packages/caws-native/src/lib.rs'),
        },
        profile: { test: true },
        features: [],
        executable: file,
      }) + '\n',
  };
}
function invoke(steps, extra = {}) {
  return main({
    packageRoot,
    observeToolchain: () => toolchain,
    ...extra,
    err: (message) => errors.push(message),
    out: (message) => output.push(message),
    run: (command, args, options) => {
      calls.push({ command, args, options });
      const step = steps.shift();
      if (!step) throw new Error('Unexpected compiler invocation');
      return step();
    },
  });
}

test('prepares both helper entrypoints before an explicit offline feature-off host build', () => {
  expect(
    invoke([
      () => {
        helpers();
        return ok;
      },
      () => {
        emit('debug/caws-native');
        return ok;
      },
      () => coreArtifact(),
    ])
  ).toBe(0);
  expect(calls).toHaveLength(3);
  expect(calls[0].command).toBe(process.execPath);
  expect(calls[0].args).toEqual([
    require.resolve('typescript/bin/tsc'),
    '-p',
    path.join(packageRoot, 'tsconfig.qualification-tests.json'),
  ]);
  expect(calls[1].command).toBe('cargo');
  expect(calls[1].args).toEqual([
    'build',
    '--locked',
    '--offline',
    '--no-default-features',
    '--bin',
    'caws-native',
    '--jobs',
    '1',
    '--manifest-path',
    path.join(root, 'packages/caws-native/Cargo.toml'),
    '--target-dir',
    target,
  ]);
  expect(calls[1].options).toMatchObject({
    cwd: packageRoot,
    shell: false,
    stdio: 'inherit',
    env: { RUSTUP_TOOLCHAIN: '1.90.0' },
  });
  expect(calls[2].args).toEqual([
    'test',
    '--no-run',
    '--lib',
    '--locked',
    '--offline',
    '--no-default-features',
    '--jobs',
    '1',
    '--manifest-path',
    path.join(root, 'packages/caws-native/Cargo.toml'),
    '--target-dir',
    target,
    '--message-format=json',
  ]);
  expect(calls[2].options.stdio).toEqual(['ignore', 'pipe', 'inherit']);
  expect(receipt.readReceipt(packageRoot).coreTest.path).toBe(
    path.join(target, 'debug/deps/caws_native-fixture')
  );
  expect(output.join('')).toContain(path.join(target, 'debug/caws-native'));
  expect(errors).toEqual([]);
});

test.each([
  [{ status: 23, signal: null }, 23],
  [{ status: null, signal: 'SIGTERM' }, 1],
  [{ status: null, error: new Error('compiler ENOENT') }, 1],
])(
  'helper failure prevents native spawning even with stale complete outputs: %j',
  (result, expected) => {
    helpers();
    emit('debug/caws-native');
    expect(invoke([() => result])).toBe(expected);
    expect(calls).toHaveLength(1);
    expect(output).toEqual([]);
    if (result.signal) expect(errors.join('')).toContain(result.signal);
    if (result.error) expect(errors.join('')).toContain(result.error.message);
  }
);

test('a missing helper is fatal even when the compiler reports zero', () => {
  expect(
    invoke([
      () => {
        emit('qualification-tools/scripts/committed-turn-files.js');
        return ok;
      },
    ])
  ).toBe(1);
  expect(calls).toHaveLength(1);
  expect(errors.join('')).toContain('render-qualification-harness.js');
});

test.each([
  [{ status: 19, signal: null }, 19],
  [{ status: null, signal: 'SIGKILL' }, 1],
  [{ status: null, error: new Error('cargo ENOENT') }, 1],
])('failed native compilation cannot adopt an old binary: %j', (result, expected) => {
  emit('debug/caws-native');
  expect(
    invoke([
      () => {
        helpers();
        return ok;
      },
      () => result,
    ])
  ).toBe(expected);
  expect(calls).toHaveLength(2);
  expect(output).toEqual([]);
  if (result.signal) expect(errors.join('')).toContain(result.signal);
  if (result.error) expect(errors.join('')).toContain(result.error.message);
});

test('a missing native binary fails after a nominally successful native build', () => {
  expect(
    invoke([
      () => {
        helpers();
        return ok;
      },
      () => ok,
    ])
  ).toBe(1);
  expect(errors.join('')).toContain('debug/caws-native');
  expect(output).toEqual([]);
});

test.each([false, true])(
  'shared target symlink is rejected before compilation (dangling=%s)',
  (dangling) => {
    const shared = path.join(root, 'foreign-target');
    if (!dangling) fs.mkdirSync(shared);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.symlinkSync(shared, target);
    expect(invoke([])).toBe(1);
    expect(calls).toEqual([]);
    expect(errors.join('')).toContain('unlink the target symlink');
    expect(fs.lstatSync(target).isSymbolicLink()).toBe(true);
  }
);

test('ambient target overrides cannot redirect the ordinary test build', () => {
  const previous = { target: process.env.CARGO_TARGET_DIR, triple: process.env.CARGO_BUILD_TARGET };
  process.env.CARGO_TARGET_DIR = '/foreign/target';
  process.env.CARGO_BUILD_TARGET = 'foreign-target-triple';
  try {
    expect(
      invoke([
        () => {
          helpers();
          return ok;
        },
        () => {
          emit('debug/caws-native');
          return ok;
        },
        () => coreArtifact(),
      ])
    ).toBe(0);
    for (const call of calls) {
      expect(call.options.env.CARGO_TARGET_DIR).toBeUndefined();
      expect(call.options.env.CARGO_BUILD_TARGET).toBeUndefined();
    }
  } finally {
    for (const [name, value] of [
      ['CARGO_TARGET_DIR', previous.target],
      ['CARGO_BUILD_TARGET', previous.triple],
    ]) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
});

test.each([
  { status: 37, signal: null },
  { status: null, signal: 'SIGTERM' },
])('failed libtest compilation invalidates a previous receipt: %j', (result) => {
  helpers();
  const file = receipt.locations(packageRoot).receipt;
  fs.writeFileSync(file, 'old receipt');
  expect(
    invoke([
      () => {
        helpers();
        return ok;
      },
      () => {
        emit('debug/caws-native');
        return ok;
      },
      () => result,
    ])
  ).toBe(result.status || 1);
  expect(fs.existsSync(file)).toBe(false);
});
test('successful Cargo exit without the current libtest artifact cannot publish a receipt', () => {
  expect(
    invoke([
      () => {
        helpers();
        return ok;
      },
      () => {
        emit('debug/caws-native');
        return ok;
      },
      () => ({ status: 0, signal: null, stdout: '{"reason":"build-finished","success":true}\n' }),
    ])
  ).toBe(1);
  expect(fs.existsSync(receipt.locations(packageRoot).receipt)).toBe(false);
});
test('template substitution during compilation refuses publication', () => {
  expect(
    invoke([
      () => {
        helpers();
        return ok;
      },
      () => {
        emit('debug/caws-native');
        return ok;
      },
      () => {
        const result = coreArtifact();
        fs.appendFileSync(
          path.join(packageRoot, 'templates/hook-packs/shared/input.sh'),
          '\nchanged'
        );
        return result;
      },
    ])
  ).toBe(1);
  expect(errors.join('')).toContain('source inputs changed');
  expect(fs.existsSync(receipt.locations(packageRoot).receipt)).toBe(false);
});
test('changed actual toolchain observation refuses publication', () => {
  let observations = 0;
  expect(
    invoke(
      [
        () => {
          helpers();
          return ok;
        },
        () => {
          emit('debug/caws-native');
          return ok;
        },
        () => coreArtifact(),
      ],
      {
        observeToolchain: () => {
          observations++;
          return { ...toolchain, cargo: toolchain.cargo + (observations > 1 ? ' changed' : '') };
        },
      }
    )
  ).toBe(1);
  expect(errors.join('')).toContain('toolchain changed');
  expect(fs.existsSync(receipt.locations(packageRoot).receipt)).toBe(false);
});

test('a shared qualification output ancestor refuses before any compiler invocation', () => {
  fs.mkdirSync(target);
  const shared = path.join(root, 'foreign-tools');
  fs.mkdirSync(shared);
  const link = path.join(target, 'qualification-tools');
  fs.symlinkSync(shared, link);
  expect(invoke([])).toBe(1);
  expect(calls).toEqual([]);
  expect(errors.join('')).toContain('symlink');
  expect(fs.lstatSync(link).isSymbolicLink()).toBe(true);
});
test('the actual toolchain observation boundary refuses a failed rustc before compilers', () => {
  const seen = [];
  expect(
    main({
      packageRoot,
      err: (message) => errors.push(message),
      out: (message) => output.push(message),
      run: (command, args) => {
        seen.push([command, ...args]);
        return { status: 29, signal: null };
      },
    })
  ).toBe(1);
  expect(seen).toEqual([['rustc', '--version', '--verbose']]);
  expect(errors.join('')).toContain('rustc observation');
});
test('the actual toolchain observation boundary rejects a foreign Cargo version', () => {
  const seen = [];
  expect(
    main({
      packageRoot,
      err: (message) => errors.push(message),
      out: (message) => output.push(message),
      run: (command, args) => {
        seen.push([command, ...args]);
        return {
          status: 0,
          signal: null,
          stdout: command === 'rustc' ? toolchain.rustc : 'cargo 1.91.0 (foreign)',
        };
      },
    })
  ).toBe(1);
  expect(seen).toEqual([
    ['rustc', '--version', '--verbose'],
    ['cargo', '--version'],
  ]);
  expect(errors.join('')).toContain('pinned');
});
