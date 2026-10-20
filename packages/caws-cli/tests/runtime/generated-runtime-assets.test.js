const fs = require('node:fs');
const path = require('node:path');
const { scenario, temporaryRoot, invoke, succeeds, refuses, snapshot } =
  require('./runtime-asset-fixture')();
const packageRoot = path.resolve(__dirname, '../..');
const projection = 'templates/hook-packs/shared/advisory_truncate.cjs';
const sources = [
  'scripts/generate-runtime-assets.mjs',
  'src/runtime/advisory-truncate-entry.ts',
  'src/runtime/utf8.ts',
];
function fixture(copyProjection = false) {
  const root = temporaryRoot();
  for (const relative of sources) {
    const destination = path.join(root, relative);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.copyFileSync(path.join(packageRoot, relative), destination);
  }
  fs.mkdirSync(path.join(root, 'node_modules'));
  fs.symlinkSync(
    path.dirname(require.resolve('esbuild/package.json')),
    path.join(root, 'node_modules/esbuild'),
    'dir'
  );
  const output = path.join(root, projection);
  if (copyProjection) {
    fs.mkdirSync(path.dirname(output), { recursive: true });
    fs.copyFileSync(path.join(packageRoot, projection), output);
    fs.chmodSync(output, fs.statSync(path.join(packageRoot, projection)).mode & 0o777);
  }
  return {
    root,
    output,
    generate: (...args) => invoke(root, process.execPath, [path.join(root, sources[0]), ...args]),
  };
}
function detachedAsset(output) {
  const root = temporaryRoot();
  const asset = path.join(root, 'advisory_truncate.cjs');
  fs.copyFileSync(output, asset);
  return { root, run: (args, input) => invoke(root, process.execPath, [asset, ...args], input) };
}
scenario('shipped projection check preserves bytes mode and modification time', () => {
  const f = fixture(true),
    before = snapshot(f.output);
  succeeds(f.generate('--check'));
  expect(snapshot(f.output)).toEqual(before);
});
scenario('missing projection check refuses without creating file or parent', () => {
  const f = fixture();
  refuses(f.generate('--check'));
  expect(fs.existsSync(path.join(f.root, 'templates'))).toBe(false);
});
scenario('package build checks freshness before downstream source generation', () => {
  const f = fixture();
  const metadata = JSON.parse(fs.readFileSync(path.join(packageRoot, 'package.json'), 'utf8'));
  fs.writeFileSync(
    path.join(f.root, 'package.json'),
    JSON.stringify({ scripts: { build: metadata.scripts.build } })
  );
  const marker = path.join(f.root, 'downstream-generator-called');
  fs.writeFileSync(
    path.join(f.root, 'scripts/generate-surface-registry.mjs'),
    "import fs from 'node:fs'; fs.writeFileSync(" + JSON.stringify(marker) + ", 'called');\n"
  );
  const result = invoke(f.root, 'npm', ['run', 'build', '--ignore-scripts'], undefined, {
    env: { HOME: f.root, PATH: process.env.PATH },
  });
  refuses(result);
  expect(result.stderr.toString()).toContain('Runtime asset is missing or stale');
  expect(fs.existsSync(marker)).toBe(false);
  expect(fs.existsSync(path.join(f.root, 'templates'))).toBe(false);
});
scenario('stale projection check refuses without repair', () => {
  const f = fixture();
  succeeds(f.generate());
  fs.appendFileSync(f.output, '\n// stale projection\n');
  const before = snapshot(f.output);
  refuses(f.generate('--check'));
  expect(snapshot(f.output)).toEqual(before);
  succeeds(f.generate());
  expect(fs.readFileSync(f.output)).not.toEqual(before.bytes);
  succeeds(f.generate('--check'));
});
scenario(
  'algorithm mutation invalidates projection and changes detached regenerated output',
  () => {
    const f = fixture();
    succeeds(f.generate());
    const original = snapshot(f.output),
      input = Buffer.from('ABCD');
    const old = detachedAsset(f.output).run(['3'], input);
    succeeds(old);
    expect(old.stdout).toEqual(Buffer.from('ABC'));
    const source = path.join(f.root, 'src/runtime/utf8.ts'),
      text = fs.readFileSync(source, 'utf8');
    expect(text.split('if (valid) {')).toHaveLength(2);
    fs.writeFileSync(source, text.replace('if (valid) {', 'if (valid && first !== 0x41) {'));
    refuses(f.generate('--check'));
    expect(snapshot(f.output)).toEqual(original);
    succeeds(f.generate());
    succeeds(f.generate('--check'));
    const changed = detachedAsset(f.output).run(['3'], input);
    succeeds(changed);
    expect(changed.stdout).toEqual(Buffer.from('BC'));
  }
);
if (process.platform !== 'win32')
  scenario('check refuses nonexecutable projection without permission repair', () => {
    const f = fixture();
    succeeds(f.generate());
    fs.chmodSync(f.output, 0o644);
    const before = snapshot(f.output);
    refuses(f.generate('--check'));
    expect(snapshot(f.output)).toEqual(before);
    succeeds(f.generate());
    expect(fs.statSync(f.output).mode & 0o111).not.toBe(0);
    succeeds(f.generate('--check'));
  });
scenario('detached helper preserves binary output and the declared ASCII budget wire', () => {
  const f = fixture();
  succeeds(f.generate());
  const detached = detachedAsset(f.output);
  fs.rmSync(path.join(f.root, 'src'), { recursive: true, force: true });
  fs.rmSync(path.join(f.root, 'node_modules'), { recursive: true, force: true });
  expect(fs.readdirSync(detached.root)).toEqual(['advisory_truncate.cjs']);
  const opaque = Buffer.from([0xff, 0x00, 0xc0, 0xef, 0xbb, 0xbf]);
  for (const [args, input, expected] of [
    [['6'], opaque, opaque],
    [['9007199254740992'], opaque, opaque],
    [['18446744073709551616'], opaque, opaque],
    [['0003'], Buffer.from('abcdef'), Buffer.from('abc')],
    [['0'], Buffer.from('x'), Buffer.alloc(0)],
    [['00'], Buffer.alloc(0), Buffer.alloc(0)],
    [['7'], Buffer.from([0x41, 0xff, 0xc3, 0xa9, 0xf0, 0x9f, 0x92, 0xa9, 0x42]), Buffer.from('Aé')],
    [['11'], Buffer.from('\ufeff�é😀z'), Buffer.from('\ufeff�é')],
  ]) {
    const result = detached.run(args, input);
    succeeds(result);
    expect(result.stdout).toEqual(expected);
    expect(result.stderr).toEqual(Buffer.alloc(0));
  }
  for (const args of [
    [],
    ['1', '2'],
    ['-0'],
    ['+1'],
    [' 1'],
    ['1 '],
    ['1_000'],
    ['１'],
    ['1.0'],
    ['1e3'],
    [''],
    ['1\n'],
    ['1\r\n'],
    ['1\u2028'],
    ['1\u2029'],
  ]) {
    const result = detached.run(args, opaque);
    expect(result.status).toBe(3);
    expect(result.stdout).toEqual(Buffer.alloc(0));
  }
});
