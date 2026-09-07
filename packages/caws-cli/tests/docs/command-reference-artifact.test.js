'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

test('generation writes only package artifacts, rejects stale output and requires the local build', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'caws-reference-artifact-'));
  try {
    const pkg = path.join(root, 'packages/caws-cli');
    const script = path.join(pkg, 'scripts/generate-command-reference.mjs');
    const metadata = path.join(pkg, 'dist/shell/command-metadata.js');
    const source = path.join(root, 'docs/command-reference.md');
    const output = path.join(pkg, 'docs/command-reference.md');
    for (const file of [script, metadata, source]) fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.copyFileSync(path.resolve(__dirname, '../../scripts/generate-command-reference.mjs'), script);
    fs.writeFileSync(source, '# Authored task guidance\n');
    fs.writeFileSync(metadata, `exports.COMMAND_SURFACE_METADATA = ${JSON.stringify([{
      kind: 'group', name: 'init', description: 'Set up CAWS', subcommands: [{
        kind: 'group', name: 'adapters', description: 'Machine adapters', subcommands: [{
          kind: 'leaf', name: 'example', description: 'Fixture operation',
          arguments: [{ name: 'first', required: true }, { name: 'second', required: false }],
          options: [{ flag: '--plan', description: 'Preview changes' }],
        }],
      }],
    }])};`);
    const run = (...args) => spawnSync(process.execPath, [script, ...args], { cwd: root, encoding: 'utf8' });
    expect(run().status).toBe(0);
    expect(fs.readFileSync(output, 'utf8')).toContain('caws init adapters example <first> [second]');
    expect(run('--check').status).toBe(0);
    fs.appendFileSync(output, '\nSTALE CONTROL\n');
    expect(run('--check').status).toBe(1);
    expect(run().status).toBe(0);
    expect(run('--check').status).toBe(0);
    expect(fs.readFileSync(source, 'utf8')).toBe('# Authored task guidance\n');
    fs.unlinkSync(metadata);
    const missing = run();
    expect(missing.status).toBe(2);
    expect(missing.stderr).toContain('build this checkout');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
