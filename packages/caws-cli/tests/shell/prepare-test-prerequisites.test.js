'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { main } = require('../../scripts/prepare-test-prerequisites');

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
function invoke(steps) {
  return main({
    packageRoot,
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
    ])
  ).toBe(0);
  expect(calls).toHaveLength(2);
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
    '2',
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
