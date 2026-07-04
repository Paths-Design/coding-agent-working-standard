'use strict';

const path = require('path');
const { spawnSync } = require('child_process');

const { cleanupAll, makeTempRepo } = require('../helpers/git-repo-factory');

const CLI = path.resolve(__dirname, '..', '..', 'dist', 'index.js');
const SHA_A = '72321aabd9967a8dd4bba72d990936f750b9c96c';
const SHA_B = 'c7b4b42aeb1f8c563fc1d3e6e9479f6e41d64615';

afterAll(() => {
  cleanupAll();
});

function runCli(root, args) {
  return spawnSync(process.execPath, [CLI, ...args], {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, CAWS_QUIET: '1' },
  });
}

describe('caws prepush --ack bundle normalization', () => {
  test('accepts a shell-quoted repeated ack bundle before commander validation', () => {
    const root = makeTempRepo();

    const result = runCli(root, ['prepush', `--ack ${SHA_A} --ack ${SHA_B}`, '--help']);

    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');
    expect(result.stdout).toContain('Usage: caws prepush [options]');
    expect(result.stdout).toContain('--ack <sha>');
  });

  test('preserves ordinary repeated ack flag parsing', () => {
    const root = makeTempRepo();

    const result = runCli(root, ['prepush', '--ack', SHA_A, '--ack', SHA_B, '--help']);

    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');
    expect(result.stdout).toContain('Usage: caws prepush [options]');
    expect(result.stdout).toContain('Acknowledge an unexpected commit by SHA');
  });

  test('does not normalize ack bundles for other commands', () => {
    const root = makeTempRepo();

    const result = runCli(root, ['init', `--ack ${SHA_A} --ack ${SHA_B}`]);

    expect(result.status).toBe(1);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('unknown option');
    expect(result.stderr).toContain('--ack');
  });
});
