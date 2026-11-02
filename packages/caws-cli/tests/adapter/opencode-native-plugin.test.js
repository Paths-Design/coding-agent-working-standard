'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const ts = require('typescript');
const {
  renderOpenCodeNativePlugin,
  OPENCODE_NATIVE_PLUGIN_MEMBER,
} = require('../../dist/init/opencode-native-plugin');
const { installMachineRuntime } = require('../../dist/init/machine-adapters');
const { sha } = require('../../dist/init/machine-runtime-state');
const template = fs.readFileSync(
  path.resolve(__dirname, '../../templates/hook-packs/opencode/plugin.ts')
);
const artifactRoot = process.env.CAWS_TEST_ARTIFACT_DIR;
if (artifactRoot && !path.isAbsolute(artifactRoot))
  throw new Error('Artifact root must be absolute');
let root, home, project;
beforeEach(() => {
  if (artifactRoot) fs.mkdirSync(artifactRoot, { recursive: true });
  root = fs.realpathSync(
    fs.mkdtempSync(path.join(artifactRoot || os.tmpdir(), 'caws-opencode-native-plugin-'))
  );
  home = path.join(root, 'machine home');
  project = path.join(root, 'project');
  fs.mkdirSync(path.join(home, 'bin'), { recursive: true });
  fs.mkdirSync(path.join(project, '.caws/hooks/dispatch'), { recursive: true });
});
afterEach(() => {
  if (artifactRoot)
    fs.writeFileSync(
      path.join(root, 'fixture.json'),
      JSON.stringify(
        {
          home,
          project,
          scope: 'synthetic producer/inventory controls; no native admission or harness proof',
        },
        null,
        2
      ) + '\n'
    );
  else fs.rmSync(root, { recursive: true, force: true });
});
function executable(file, body) {
  fs.writeFileSync(file, '#!/bin/bash\n' + body + '\n', { mode: 0o755 });
}
async function plugin(source) {
  const file = path.join(root, 'fixture-plugin.cjs');
  fs.writeFileSync(
    file,
    ts.transpileModule(source.toString('utf8'), {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
    }).outputText
  );
  jest.resetModules();
  return require(file).CawsPlugin({ directory: project, worktree: project });
}
function nativeFixture(exitCode = 0) {
  executable(
    path.join(home, 'bin/caws-hook-native'),
    'cat > "$(dirname "$0")/input.json"\n' +
      'printf "%s\\0" "$@" > "$(dirname "$0")/argv.bin"\n' +
      'printf "%s\\0" "$PWD" "$CAWS_HOME" "$CAWS_PROJECT_DIR" > "$(dirname "$0")/context.bin"\n' +
      'printf "%s\\n" "$#" >> "$(dirname "$0")/calls"\n' +
      'exit ' +
      exitCode
  );
}
test('runtime inventory retains exact rendered producer without opting a harness in', () => {
  const installed = installMachineRuntime({ home });
  const runtime = path.join(home, 'lib/runtimes', installed.digest);
  const bytes = fs.readFileSync(path.join(runtime, OPENCODE_NATIVE_PLUGIN_MEMBER));
  expect(bytes).toEqual(renderOpenCodeNativePlugin(template, home));
  const manifest = JSON.parse(fs.readFileSync(path.join(runtime, 'manifest.json'), 'utf8'));
  expect(manifest[OPENCODE_NATIVE_PLUGIN_MEMBER]).toBe(sha(bytes));
  expect(fs.existsSync(path.join(home, 'surfaces/opencode/settings.json'))).toBe(false);
  expect(fs.existsSync(path.join(project, '.opencode/plugins/caws.ts'))).toBe(false);
});
test.each(['relative', '', '/bad\0home'])('renderer refuses invalid machine home %p', (value) => {
  expect(() => renderOpenCodeNativePlugin(template, value)).toThrow('absolute machine home');
});
test('renderer refuses missing or ambiguous binding marker', () => {
  expect(() => renderOpenCodeNativePlugin(Buffer.from('not the template'), home)).toThrow('marker');
  expect(() => renderOpenCodeNativePlugin(Buffer.concat([template, template]), home)).toThrow(
    'marker'
  );
});
test.each([0, 2])(
  'rendered producer invokes stable Stop once with exact context at exit%d and never replays shell',
  async (exitCode) => {
    nativeFixture(exitCode);
    executable(
      path.join(project, '.caws/hooks/dispatch/stop.sh'),
      'touch "$(dirname "$0")/legacy-stop"'
    );
    const hooks = await plugin(renderOpenCodeNativePlugin(template, home));
    await hooks.event({
      event: { type: 'session.idle', properties: { sessionID: 'native-session' } },
    });
    expect(JSON.parse(fs.readFileSync(path.join(home, 'bin/input.json'), 'utf8'))).toEqual({
      session_id: 'native-session',
    });
    expect(
      fs.readFileSync(path.join(home, 'bin/argv.bin'), 'utf8').split('\0').slice(0, -1)
    ).toEqual(['opencode', 'stop', '--system']);
    expect(fs.readFileSync(path.join(home, 'bin/calls'), 'utf8')).toBe('3\n');
    expect(
      fs.readFileSync(path.join(home, 'bin/context.bin'), 'utf8').split('\0').slice(0, -1)
    ).toEqual([project, home, project]);
    expect(fs.existsSync(path.join(project, '.caws/hooks/dispatch/legacy-stop'))).toBe(false);
  }
);
test('missing native entry never replays legacy Stop', async () => {
  executable(
    path.join(project, '.caws/hooks/dispatch/stop.sh'),
    'touch "$(dirname "$0")/legacy-stop"'
  );
  const hooks = await plugin(renderOpenCodeNativePlugin(template, home));
  await hooks.event({
    event: { type: 'session.idle', properties: { sessionID: 'native-session' } },
  });
  expect(fs.existsSync(path.join(project, '.caws/hooks/dispatch/legacy-stop'))).toBe(false);
});
test('ordinary template keeps legacy Stop and rendered producer keeps other lifecycle dispatch', async () => {
  nativeFixture();
  for (const name of ['stop', 'session_start'])
    executable(
      path.join(project, '.caws/hooks/dispatch', name + '.sh'),
      'cat > "$(dirname "$0")/' + name + '.json"'
    );
  const legacy = await plugin(template);
  await legacy.event({
    event: { type: 'session.idle', properties: { sessionID: 'legacy-session' } },
  });
  expect(
    JSON.parse(fs.readFileSync(path.join(project, '.caws/hooks/dispatch/stop.json'), 'utf8'))
  ).toEqual({ session_id: 'legacy-session' });
  expect(fs.existsSync(path.join(home, 'bin/input.json'))).toBe(false);
  const native = await plugin(renderOpenCodeNativePlugin(template, home));
  await native.event({
    event: { type: 'session.created', properties: { info: { id: 'created-session' } } },
  });
  expect(
    JSON.parse(
      fs.readFileSync(path.join(project, '.caws/hooks/dispatch/session_start.json'), 'utf8')
    )
  ).toEqual({ session_id: 'created-session' });
});

test('native Stop preserves own nested plugin directory instead of collapsing to governance root', async () => {
  nativeFixture();
  const nested = path.join(project, 'nested');
  fs.mkdirSync(nested);
  const file = path.join(root, 'nested-plugin.cjs');
  fs.writeFileSync(
    file,
    ts.transpileModule(renderOpenCodeNativePlugin(template, home).toString('utf8'), {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
    }).outputText
  );
  const hooks = await require(file).CawsPlugin({ directory: nested, worktree: project });
  await hooks.event({
    event: { type: 'session.idle', properties: { sessionID: 'nested-session' } },
  });
  expect(
    fs.readFileSync(path.join(home, 'bin/context.bin'), 'utf8').split('\0').slice(0, -1)
  ).toEqual([nested, home, project]);
  expect(JSON.parse(fs.readFileSync(path.join(home, 'bin/input.json'), 'utf8'))).toEqual({
    session_id: 'nested-session',
  });
});
test('native Stop with no own absolute plugin directory dispatches neither native nor legacy', async () => {
  nativeFixture();
  executable(
    path.join(project, '.caws/hooks/dispatch/stop.sh'),
    'touch "$(dirname "$0")/legacy-stop"'
  );
  const file = path.join(root, 'missing-directory-plugin.cjs');
  fs.writeFileSync(
    file,
    ts.transpileModule(renderOpenCodeNativePlugin(template, home).toString('utf8'), {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
    }).outputText
  );
  const hooks = await require(file).CawsPlugin({ worktree: project });
  await hooks.event({ event: { type: 'session.idle', properties: { sessionID: 'own-session' } } });
  expect(fs.existsSync(path.join(home, 'bin/calls'))).toBe(false);
  expect(fs.existsSync(path.join(project, '.caws/hooks/dispatch/legacy-stop'))).toBe(false);
});
