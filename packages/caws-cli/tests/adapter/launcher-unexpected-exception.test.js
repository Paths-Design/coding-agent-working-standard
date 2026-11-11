'use strict';
// A hook process that ends with status 1 is read by a harness as a hook error,
// and the tool call then runs with no guard. These cases drive the shipped
// bootstrap and launcher with faults outside the exception types they used to
// list, and pin that an enforcing event is refused with the fault named.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');

const RUNTIME_TEMPLATES = path.join(__dirname, '../../templates/hook-packs/runtime');
const BOOTSTRAP = path.join(RUNTIME_TEMPLATES, 'bootstrap.py');
const LAUNCHER = path.join(RUNTIME_TEMPLATES, 'caws-hook.py');
const sha = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');

const roots = [];
afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

/** A machine home whose selected runtime holds exactly the given driver. */
function homeWithDriver(driverBytes) {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'caws-launcher-fault-')));
  roots.push(home);
  const manifest = Buffer.from(JSON.stringify({ 'launcher.py': sha(driverBytes) }));
  const digest = sha(manifest);
  const runtime = path.join(home, 'lib/runtimes', digest);
  fs.mkdirSync(runtime, { recursive: true });
  fs.mkdirSync(path.join(home, 'state'), { recursive: true });
  fs.writeFileSync(path.join(runtime, 'manifest.json'), manifest);
  fs.writeFileSync(path.join(runtime, 'launcher.py'), driverBytes);
  fs.writeFileSync(
    path.join(home, 'state/adapter-runtime.json'),
    JSON.stringify({ version: 1, digest })
  );
  return home;
}

function invoke(home, event, input = '{}', entry = BOOTSTRAP) {
  return spawnSync('python3', [entry, 'claude-code', event], {
    cwd: home,
    encoding: 'utf8',
    input,
    env: { PATH: process.env.PATH, HOME: home, CAWS_HOME: home },
  });
}

describe('bootstrap: a driver that fails with an unlisted exception', () => {
  test.each([
    ['raise RuntimeError("driver exploded")\n', 'unexpected RuntimeError: driver exploded'],
    ['import module_that_does_not_exist_anywhere\n', 'unexpected ModuleNotFoundError'],
    ['def broken(:\n', 'unexpected SyntaxError'],
    ['assert False\n', 'unexpected AssertionError'],
  ])('PreToolUse is refused and the fault is named: %j', (driver, named) => {
    const result = invoke(homeWithDriver(Buffer.from(driver)), 'pre_tool_use');
    expect(result.status).toBe(2);
    const decision = JSON.parse(result.stdout);
    expect(decision.decision).toBe('block');
    expect(decision.reason).toContain('CAWS machine adapter: ' + named);
    expect(result.stderr).toContain('[caws machine adapter] CAWS machine adapter: ' + named);
  });

  test('a non-enforcing event reports the fault on stderr and does not fail the harness', () => {
    const result = invoke(
      homeWithDriver(Buffer.from('raise RuntimeError("driver exploded")\n')),
      'post_tool_use'
    );
    expect(result.status).toBe(0);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('unexpected RuntimeError: driver exploded');
  });

  test('a listed exception keeps its message without the unexpected prefix', () => {
    const result = invoke(
      homeWithDriver(Buffer.from('raise ValueError("pointer is wrong")\n')),
      'pre_tool_use'
    );
    expect(result.status).toBe(2);
    expect(JSON.parse(result.stdout).reason).toBe('CAWS machine adapter: pointer is wrong');
  });

  test.each([
    [0, 'allowed'],
    [2, 'refused by a handler'],
    [7, 'odd status'],
  ])("a driver's own exit %i and output pass through unchanged", (status, text) => {
    const driver = `import sys\nsys.stdout.write(${JSON.stringify(text)})\nsys.exit(${status})\n`;
    const result = invoke(homeWithDriver(Buffer.from(driver)), 'pre_tool_use');
    expect(result.status).toBe(status);
    expect(result.stdout).toBe(text);
  });
});

describe('launcher: a fault raised by the shipped driver itself', () => {
  // A payload nested deeper than the interpreter's recursion limit makes the
  // JSON decoder raise RecursionError, which is not one of the listed types.
  const nested = '['.repeat(200000) + ']'.repeat(200000);
  // Through the bootstrap, the bootstrap's handler is the outer net. Run as the
  // entry itself, which the legacy layout does, only the driver's own handler
  // stands between the fault and status 1.
  const routes = [
    ['through the bootstrap', BOOTSTRAP],
    ['as the entry itself', LAUNCHER],
  ];

  test.each(routes)('PreToolUse is refused and the fault is named, %s', (_label, entry) => {
    const home = homeWithDriver(fs.readFileSync(LAUNCHER));
    const result = invoke(home, 'pre_tool_use', nested, entry);
    expect(result.status).toBe(2);
    const decision = JSON.parse(result.stdout);
    expect(decision.decision).toBe('block');
    expect(decision.reason).toContain('CAWS machine adapter: unexpected RecursionError');
  });

  test.each(routes)('PostToolUse reports it and exits 0, %s', (_label, entry) => {
    const home = homeWithDriver(fs.readFileSync(LAUNCHER));
    const result = invoke(home, 'post_tool_use', nested, entry);
    expect(result.status).toBe(0);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('unexpected RecursionError');
  });
});
