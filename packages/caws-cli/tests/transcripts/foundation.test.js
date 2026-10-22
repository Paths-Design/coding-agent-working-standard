'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const packageRoot = path.resolve(__dirname, '../..');

function runChecked(args, label) {
  const result = spawnSync(process.execPath, args, {
    cwd: packageRoot,
    shell: false,
    encoding: 'utf8',
    timeout: 30_000,
    killSignal: 'SIGKILL',
  });
  if (result.error || result.signal || result.status !== 0) {
    throw new Error(
      `${label} failed: status=${result.status}, signal=${result.signal}\n` +
        `${result.error ? result.error.stack : ''}\n` +
        `stdout:\n${result.stdout || ''}\nstderr:\n${result.stderr || ''}`
    );
  }
  return result.stdout;
}

test('compiles and runs the transcript foundation tests', () => {
  const output = fs.mkdtempSync(path.join(os.tmpdir(), 'caws-transcripts-'));
  let failure;
  try {
    const compiler = require.resolve('typescript/bin/tsc', { paths: [packageRoot] });
    runChecked(
      [
        compiler,
        '-p',
        path.join(__dirname, 'tsconfig.json'),
        '--outDir',
        output,
        '--noEmitOnError',
      ],
      'Transcript test compilation'
    );
    const stdout = runChecked(
      [path.join(__dirname, 'run.cjs'), path.join(output, 'tests/transcripts')],
      'Transcript foundation tests'
    );
    expect(stdout).toMatch(/^# tests [1-9]\d*$/m);
    expect(stdout).toMatch(/^# pass [1-9]\d*$/m);
  } catch (error) {
    failure = error;
  } finally {
    try {
      fs.rmSync(output, { recursive: true, force: true });
    } catch (error) {
      failure = failure
        ? new AggregateError([failure, error], 'Transcript tests and cleanup failed')
        : error;
    }
  }
  if (failure) throw failure;
}, 70_000);
