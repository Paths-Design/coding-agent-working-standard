const fs = require('node:fs');
const path = require('node:path');
const { parseGuardConfiguration } = require('../../dist/runtime/guard-config');
const { scenario, temporaryRoot, invoke, succeeds } = require('./runtime-asset-fixture')();
const cli = path.resolve(__dirname, '../..');
const { installMachineRuntime } = require('../../dist/init/machine-adapters');

scenario('installed shell retains shipped defaults when Node or the helper is unavailable', () => {
  const root = temporaryRoot();
  const lib = path.join(root, 'lib');
  const tools = path.join(root, 'tools');
  fs.mkdirSync(lib);
  fs.mkdirSync(tools);
  for (const name of ['guard-config.sh', 'guard-config.cjs'])
    fs.copyFileSync(path.join(cli, 'templates/hook-packs/shared/lib', name), path.join(lib, name));
  fs.symlinkSync('/usr/bin/dirname', path.join(tools, 'dirname'));
  const run = () =>
    invoke(
      root,
      '/bin/bash',
      [
        '-p',
        '-c',
        'source "$1"; caws_guard_config_load "$2"; printf "%s|%s|%s" "$CAWS_GUARD_CONFIG_STATUS" "$CAWS_GUARD_ZONE_COUNT" "$(caws_guard_threshold god-object-check.sh loc 2000)"',
        '_',
        path.join(lib, 'guard-config.sh'),
        root,
      ],
      undefined,
      { env: { HOME: root, PATH: tools } }
    );
  const noNode = run();
  succeeds(noNode);
  expect(noNode.stdout.toString()).toBe('unavailable|0|2000');
  fs.symlinkSync(process.execPath, path.join(tools, 'node'));
  fs.renameSync(path.join(lib, 'guard-config.cjs'), path.join(lib, 'guard-config.unavailable'));
  const noHelper = run();
  succeeds(noHelper);
  expect(noHelper.stdout.toString()).toBe('unavailable|0|2000');
  fs.writeFileSync(path.join(lib, 'guard-config.cjs'), 'process.exit(7);\n');
  const failedHelper = run();
  succeeds(failedHelper);
  expect(failedHelper.stdout.toString()).toBe('unavailable|0|2000');
});

scenario(
  'packed templates install a stock loader that runs without Python or package-source fallback',
  () => {
    const root = temporaryRoot();
    const packed = path.join(root, 'packed');
    const unpacked = path.join(root, 'unpacked');
    fs.mkdirSync(packed);
    fs.mkdirSync(unpacked);
    const pack = invoke(
      root,
      'npm',
      ['pack', '--ignore-scripts', '--json', '--pack-destination', packed],
      undefined,
      { cwd: cli, env: { HOME: root, PATH: process.env.PATH }, timeoutMs: 30000 }
    );
    succeeds(pack);
    const metadata = JSON.parse(pack.stdout.toString())[0];
    succeeds(
      invoke(root, '/usr/bin/tar', ['-xzf', path.join(packed, metadata.filename), '-C', unpacked])
    );
    const templates = path.join(unpacked, 'package/templates/hook-packs');
    expect(fs.existsSync(path.join(templates, 'shared/lib/guard-config.py'))).toBe(false);
    const home = path.join(root, 'machine');
    const installed = installMachineRuntime({ home, templatesRoot: templates });
    const lib = path.join(home, 'lib/runtimes', installed.digest, 'lib');
    expect(fs.existsSync(path.join(lib, 'guard-config.py'))).toBe(false);
    expect(fs.statSync(path.join(lib, 'guard-config.cjs')).mode & 0o111).toBe(0);
    fs.renameSync(templates, templates + '-unavailable');
    const project = path.join(root, 'project');
    fs.mkdirSync(path.join(project, '.caws/hooks'), { recursive: true });
    fs.writeFileSync(
      path.join(project, '.caws/hooks/hook-policy.json'),
      '{"guards":' + threshold('2500') + '}'
    );
    const tools = path.join(root, 'tools');
    fs.mkdirSync(tools);
    fs.symlinkSync(process.execPath, path.join(tools, 'node'));
    fs.symlinkSync('/usr/bin/dirname', path.join(tools, 'dirname'));
    const result = invoke(
      root,
      '/bin/bash',
      [
        '-p',
        '-c',
        'source "$1"; caws_guard_config_load "$2"; printf "%s|%s" "$CAWS_GUARD_CONFIG_STATUS" "$(caws_guard_threshold god-object-check.sh loc 2000)"',
        '_',
        path.join(lib, 'guard-config.sh'),
        project,
      ],
      undefined,
      { env: { HOME: root, PATH: tools } }
    );
    succeeds(result);
    expect(result.stdout.toString()).toBe('ok|2500');
  }
);

scenario(
  'standalone transport refuses NUL zones before a shell can truncate them into a different grant',
  () => {
    const root = temporaryRoot();
    fs.mkdirSync(path.join(root, '.caws'), { recursive: true });
    fs.writeFileSync(
      path.join(root, '.caws/policy.yaml'),
      'non_governed_zones:\n  - native/\0hidden/\n'
    );
    const result = invoke(root, process.execPath, [
      path.join(cli, 'templates/hook-packs/shared/lib/guard-config.cjs'),
      root,
    ]);
    succeeds(result);
    expect(result.stdout.toString()).toBe(
      'CAWS_GUARD_ZONE_COUNT=0\nCAWS_GUARD_CONFIG_STATUS=invalid\n'
    );
  }
);
const deep = '['.repeat(140) + '0' + ']'.repeat(140);
const threshold = (raw) => '{"god-object-check.sh":{"thresholds":{"loc":' + raw + '}}}';

test.each([
  ['100', 'ok'],
  ['100.0', 'invalid'],
  ['1e2', 'invalid'],
  ['100.000000000000001', 'invalid'],
  ['true', 'invalid'],
])('deep unrelated metadata preserves the raw threshold %s verdict', (raw, status) => {
  const result = parseGuardConfiguration(
    ' \n{"metadata":' + deep + ',"guards":' + threshold(raw) + '}'
  );
  expect(result.status).toBe(status);
  expect(result.guards).toEqual(
    status === 'ok'
      ? { 'god-object-check.sh': { additional_allow_prefixes: [], thresholds: { loc: 100 } } }
      : {}
  );
});

test.each([
  ['{"guards":' + threshold('100.0') + ',"gu\\u0061rds":' + threshold('100') + '}', 'ok'],
  ['{"gu\\u0061rds":' + threshold('100') + ',"guards":' + threshold('100.0') + '}', 'invalid'],
  ['{"metadata":' + JSON.stringify('} ] " guards') + ',"guards":' + threshold('100') + '}', 'ok'],
  ['{"guards":{"god-object-check.sh":{"thresholds":{"loc":100.0,"loc":100}}}}', 'ok'],
  ['{"guards":{"god-object-check.sh":{"thresholds":{"loc":100,"loc":100.0}}}}', 'invalid'],
  [
    '{"guards":{"god-object-check.sh":{"thresholds":{"loc":100.0},"thresholds":{"loc":100}}}}',
    'ok',
  ],
  [
    '{"guards":{"god-object-check.sh":{"thresholds":{"loc":100.0}},"god-object-check.sh":{"thresholds":{"loc":100}}}}',
    'ok',
  ],
])('root and nested last-member semantics retain the authored token %#', (raw, status) => {
  expect(parseGuardConfiguration(raw).status).toBe(status);
});

scenario(
  'detached standalone loader emits exact assignments with no source or module fallback',
  () => {
    const root = temporaryRoot();
    const project = path.join(root, 'project');
    const helper = path.join(root, 'guard-config.cjs');
    fs.mkdirSync(path.join(project, '.caws/hooks'), { recursive: true });
    fs.copyFileSync(path.join(cli, 'templates/hook-packs/shared/lib/guard-config.cjs'), helper);
    fs.writeFileSync(
      path.join(project, '.caws/hooks/hook-policy.json'),
      '{"guards":' + threshold('100') + ',"metadata":' + deep + '}'
    );
    fs.writeFileSync(
      path.join(project, '.caws/policy.yaml'),
      'non_governed_zones:\n  - generated/**\n'
    );
    const result = invoke(root, process.execPath, [helper, project]);
    succeeds(result);
    expect(result.stderr).toEqual(Buffer.alloc(0));
    expect(result.stdout.toString()).toBe(
      'CAWS_GUARD_ZONE_COUNT=1\nCAWS_GUARD_ZONE_0=generated/\nCAWS_GUARD_CONFIG_STATUS=ok\nCAWS_GUARD_PREFIX_COUNT_GOD_OBJECT_CHECK_SH=0\nCAWS_GUARD_THRESHOLD_GOD_OBJECT_CHECK_SH_LOC=100\n'
    );
    expect(invoke(root, process.execPath, [helper]).status).toBe(3);
  }
);
