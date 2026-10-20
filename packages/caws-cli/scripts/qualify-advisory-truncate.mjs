#!/usr/bin/env node
// Retain original Python and generated Node byte observations before retirement.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';

const [baseline, candidate, python, artifacts] = process.argv.slice(2);
if (
  process.argv.length !== 6 ||
  [baseline, candidate, python, artifacts].some((value) => !value || !path.isAbsolute(value))
)
  throw new Error(
    'Usage: qualify-advisory-truncate <absolute-baseline.py> <absolute-candidate.cjs> <absolute-python> <new-absolute-artifact-root>'
  );
if (fs.existsSync(artifacts)) throw new Error('Artifact root must be new');
for (const file of [baseline, candidate, python])
  if (!fs.statSync(file).isFile()) throw new Error('Not a regular file: ' + file);
fs.mkdirSync(artifacts, { recursive: true, mode: 0o700 });
const sha = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const manifest = {
  baseline,
  candidate,
  python,
  node: process.execPath,
  nodeVersion: process.version,
  baselineSha256: sha(baseline),
  candidateSha256: sha(candidate),
  nonclaims: [
    'Only ASCII decimal budgets from the stock shell wire are compared; broader Python int() grammar is not qualified.',
    'Raw helper equivalence does not establish surrounding shell, installed package, harness delivery or whole-runtime parity.',
    'A timeout can terminate the directly spawned child; descendant settlement is not established.',
  ],
};
fs.writeFileSync(path.join(artifacts, 'manifest.json'), JSON.stringify(manifest, null, 2));
const inputs = [
  Buffer.from('Aé€😀Z'),
  Buffer.from('\ufeff�x'),
  Buffer.from([0x61, 0xff, 0xc0, 0xaf, 0x62, 0xe2, 0x82]),
  Buffer.from([0xed, 0xa0, 0x80, 0xf4, 0x90, 0x80, 0x80, 0x41, 0x42]),
  Buffer.from([0, 0x41, 0, 0xf0, 0x9f, 0x98, 0x80]),
  Buffer.alloc(0),
];
let sequence = 0;
const observations = [];
function run(directory, name, executable, args, input) {
  const result = spawnSync(executable, args, {
    input,
    timeout: 3000,
    maxBuffer: 1024 * 1024,
    env: { PATH: process.env.PATH },
  });
  fs.writeFileSync(path.join(directory, name + '.stdout.bin'), result.stdout ?? Buffer.alloc(0));
  fs.writeFileSync(path.join(directory, name + '.stderr.bin'), result.stderr ?? Buffer.alloc(0));
  const receipt = {
    command: [executable, ...args],
    pid: result.pid,
    exitCode: result.status,
    signal: result.signal,
    error: result.error ? String(result.error) : null,
  };
  fs.writeFileSync(path.join(directory, name + '.status.json'), JSON.stringify(receipt, null, 2));
  if (result.error || result.signal || result.status !== 0)
    throw new Error(
      'Stop: helper execution failed; inspect ' + directory + '/' + name + '.status.json'
    );
  return result.stdout;
}
try {
  for (const [index, input] of inputs.entries()) {
    const limits = Array.from({ length: input.length + 2 }, (_, i) => String(i));
    limits.push('0002', '9007199254740992', '18446744073709551616');
    for (const limit of limits) {
      const directory = path.join(artifacts, String(++sequence).padStart(4, '0'));
      fs.mkdirSync(directory);
      fs.writeFileSync(path.join(directory, 'stdin.bin'), input);
      fs.writeFileSync(
        path.join(directory, 'case.json'),
        JSON.stringify({ inputIndex: index, limit, inputHex: input.toString('hex') })
      );
      const expected = run(directory, 'python', python, [baseline, limit], input);
      const actual = run(directory, 'node', process.execPath, [candidate, limit], input);
      const observation = {
        directory,
        limit,
        inputIndex: index,
        equal: actual.equals(expected),
        pythonHex: expected.toString('hex'),
        nodeHex: actual.toString('hex'),
      };
      observations.push(observation);
      fs.writeFileSync(
        path.join(directory, 'comparison.json'),
        JSON.stringify(observation, null, 2)
      );
      if (!observation.equal) throw new Error('Stop: byte difference; inspect ' + directory);
    }
  }
  fs.writeFileSync(
    path.join(artifacts, 'summary.json'),
    JSON.stringify({ exitCode: 0, cases: observations.length, observations }, null, 2)
  );
  process.stdout.write(
    'Compared ' + observations.length + ' retained Python/Node byte cases: equal.\n'
  );
} catch (error) {
  fs.writeFileSync(
    path.join(artifacts, 'summary.json'),
    JSON.stringify(
      { exitCode: 1, cases: observations.length, error: String(error), observations },
      null,
      2
    )
  );
  process.stderr.write(String(error) + '\n');
  process.exitCode = 1;
}
