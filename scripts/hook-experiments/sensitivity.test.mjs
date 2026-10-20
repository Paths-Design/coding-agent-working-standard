import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm, access, symlink, readlink } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { CASES, execute, parseArguments, runSensitivity, verdict } from './sensitivity.mjs';

/** @typedef {{name: string, relative: string, original: string, mutation: string, test: string, assertion: string}} SensitivityCase */

// Synthetic Node consumers exercise runner custody, not production hook semantics.
// Disposable *.py filenames preserve the runner's path contract; their contents are JavaScript.
/** @type {SensitivityCase[]} */
const EXPECTED = [
  { name: 'handler-attribution', relative: 'shared/session_log_renderer.py', original: '"status": hook_handler_status(row, stdout),', mutation: '"status": "block" if row.get("adapter_exit_code") == 2 else row.get("status"),', test: 'fidelity:test_mixed_handler_decisions_keep_per_handler_attribution', assertion: "self.assertEqual({name:item['status'] for name,item in contexts.items()}," },
  { name: 'codex-default', relative: 'codex/hooks/lib/parse-input.sh', original: '_caws_write_session_envelope codex', mutation: '_caws_write_session_envelope claude-code', test: 'test_surface_compatibility_helpers_preserve_defaults_without_bootstrap_flags', assertion: "self.assertEqual(json.loads(artifact.read_text())['platform'], expected)" },
  { name: 'renderer-lock', relative: 'shared/session_log_renderer.py', original: 'fcntl.flock(lock, fcntl.LOCK_EX)', mutation: 'pass  # sensitivity mutant: no writer serialization', test: 'fidelity:test_concurrent_renderers_lock_before_reading_and_leave_one_current_generation', assertion: 'second renderer read inputs while first held the lock' },
  { name: 'source-digest', relative: 'runtime/caws-hook.py', original: "source_sha256=source['sha256']", mutation: "source_sha256='0' * 64", test: 'test_description_is_read_only_and_matches_executed_override', assertion: "self.assertEqual(record['source_sha256'], selected['handlers'][0]['sha256'])" },
  { name: 'denial-priority', relative: 'shared/lib/run-handlers.sh', original: "block|deny) printf '3\\n' ;;", mutation: "block) printf '3\\n' ;;", test: 'test_all_surface_runners_preserve_refusals_and_record_raw_exit', assertion: 'self.assertEqual(denied.returncode, 2, denied.stderr)' },
  { name: 'cache-symlink', relative: 'shared/lib/session-cache.sh', original: 'os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW', mutation: 'os.O_RDONLY | os.O_DIRECTORY', test: 'test_recording_failure_cannot_turn_a_refusal_into_admission', assertion: 'self.assertEqual(list(outside.iterdir()), [])' },
];

/** @param {string} file */
async function exists(file) {
  try { await access(file); return true; } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return false;
    throw error;
  }
}

/** @param {import('node:test').TestContext} t
 * @param {string} [mode]
 */
async function fixture(t, mode = 'matched') {
  const retained = process.env.CAWS_SENSITIVITY_TEST_ARTIFACTS;
  if (retained) {
    assert.ok(path.isAbsolute(retained), 'retention root must be absolute');
    await mkdir(retained, { recursive: true });
  }
  const root = await mkdtemp(path.join(retained ?? tmpdir(), 'sensitivity test '));
  if (!retained) t.after(() => rm(root, { recursive: true, force: true }));
  const repo = path.join(root, 'fixture repo');
  const templates = path.join(repo, 'packages/caws-cli/templates/hook-packs');
  const tests = path.join(repo, 'packages/caws-cli/tests/hooks/pytest');
  await mkdir(tests, { recursive: true });
  /** @type {Map<string, string>} */
  const originals = new Map();
  for (const row of EXPECTED) {
    const file = path.join(templates, row.relative);
    originals.set(file, (originals.get(file) ?? '') + row.original + '\n');
  }
  for (const [file, contents] of originals) {
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, contents);
  }
  for (const name of ['node_modules', '__pycache__', 'tmp', '.caws']) {
    await mkdir(path.join(templates, name), { recursive: true });
    await writeFile(path.join(templates, name, 'excluded'), 'must not copy');
  }
  await writeFile(path.join(templates, '.DS_Store'), 'must not copy');
  await writeFile(path.join(repo, 'fixture-cases.json'), JSON.stringify(EXPECTED));
  await writeFile(path.join(repo, 'fixture-mode.json'), JSON.stringify(mode));
  const consumer = `const fs = require('node:fs');
const path = require('node:path');
async function main() {
  const repo = process.cwd();
  const argv = process.argv.slice(1);
  const rows = JSON.parse(fs.readFileSync(path.join(repo, 'fixture-cases.json'), 'utf8'));
  const row = rows.find(item => argv[1].endsWith(item.test.split(':').at(-1)));
  if (!row) throw new Error('unknown synthetic consumer case');
  const templates = process.env.CAWS_TEST_TEMPLATES_ROOT;
  const artifacts = process.env.CAWS_EXPERIMENT_ARTIFACTS;
  fs.mkdirSync(artifacts, { recursive: true });
  const source = fs.readFileSync(path.join(templates, row.relative), 'utf8');
  const source_lines = source.split(/\\r\\n|\\r|\\n/);
  if (source_lines.at(-1) === '') source_lines.pop();
  const mutant = source_lines.includes(row.mutation);
  const mode = JSON.parse(fs.readFileSync(path.join(repo, 'fixture-mode.json'), 'utf8'));
  fs.writeFileSync(path.join(artifacts, 'context.json'), JSON.stringify({
    cwd: repo, templates, artifacts, dont_write_bytecode: process.env.PYTHONDONTWRITEBYTECODE,
    argv, mutant, source_lines,
    excluded_present: ['node_modules', '__pycache__', 'tmp', '.caws', '.DS_Store']
      .filter(name => fs.existsSync(path.join(templates, name))),
  }));
  process.stdout.write(Buffer.concat([Buffer.from('raw stdout'), Buffer.from([0, 255, 10])]));
  if (mode === 'timeout') await new Promise(resolve => setTimeout(resolve, 30000));
  if (mode === 'control-failure' && !mutant) {
    process.stderr.write('AssertionError: broken control\\n'); process.exitCode = 1; return;
  }
  if (mutant) {
    if (mode === 'setup-failure') {
      process.stderr.write('ImportError: broken fixture setup\\n'); process.exitCode = 1; return;
    }
    const assertion = mode === 'wrong-assertion' ? 'a different assertion' : row.assertion;
    process.stderr.write('AssertionError: ' + assertion + '\\n'); process.exitCode = 1; return;
  }
  process.stderr.write(Buffer.concat([Buffer.from('raw stderr'), Buffer.from([0, 254, 10])]));
}
main().catch(error => { console.error(error); process.exitCode = 1; });
`;
  for (const name of ['test_machine_hook_selection.py', 'test_installed_session_fidelity.py']) {
    await writeFile(path.join(tests, name), consumer);
  }
  return { root, repo, templates, originals, output: path.join(root, 'retained output') };
}

// The runner's interpreter selector executes only our JavaScript fixture files.
const python = process.execPath;

test('six immutable cases preserve the original mutation and assertion contracts', () => {
  assert.deepEqual(CASES, EXPECTED);
  assert.equal(Object.isFrozen(CASES), true);
  for (const row of CASES) assert.equal(Object.isFrozen(row), true, row.name);
});

test('a kill requires a green control and the exact decision-bearing assertion', () => {
  const row = EXPECTED[0];
  assert.equal(verdict(row, { exit_code: 0 }, { exit_code: 1 }, `AssertionError: ${row.assertion}`), true);
  /** @type {[number | null, number | null, string][]} */
  const rejected = [
    [1, 1, `AssertionError: ${row.assertion}`],
    [null, 1, `AssertionError: ${row.assertion}`],
    [0, 0, `AssertionError: ${row.assertion}`],
    [0, null, `AssertionError: ${row.assertion}`],
    [0, 2, `AssertionError: ${row.assertion}`],
    [0, 1, 'AssertionError: unrelated setup assertion'],
    [0, 1, row.assertion],
  ];
  for (const [control, outcome, stderr] of rejected) {
    assert.equal(verdict(row, { exit_code: control }, { exit_code: outcome }, stderr), false);
  }
});

test('all six matched controls retain bytes and custody while mutant copies are cleaned', async (t) => {
  const f = await fixture(t);
  const result = await runSensitivity({ repo: f.repo, output: f.output, python });
  assert.equal(result.exitCode, 0);
  assert.deepEqual(result.summary.cases.map(row => [row.name, row.killed]), EXPECTED.map(row => [row.name, true]));
  assert.deepEqual(JSON.parse(await readFile(path.join(f.output, 'summary.json'), 'utf8')), result.summary);
  for (const row of result.summary.cases) {
    assert.equal(row.control.exit_code, 0);
    assert.equal(row.mutant.exit_code, 1);
    assert.deepEqual(await readFile(path.join(f.output, row.name, 'control/stdout')), Buffer.from('raw stdout\0\xff\n', 'latin1'));
    assert.deepEqual(await readFile(path.join(f.output, row.name, 'control/stderr')), Buffer.from('raw stderr\0\xfe\n', 'latin1'));
    /** @type {[string, typeof row.control][]} */
    const executions = [['control', row.control], ['mutant', row.mutant]];
    for (const [label, report] of executions) {
      assert.deepEqual(JSON.parse(await readFile(path.join(f.output, row.name, label, 'command.json'), 'utf8')), report);
      const context = JSON.parse(await readFile(path.join(report.artifacts, 'context.json'), 'utf8'));
      assert.equal(context.cwd, f.repo);
      assert.equal(context.artifacts, report.artifacts);
      assert.equal(context.dont_write_bytecode, '1');
      assert.equal(context.mutant, label === 'mutant');
      assert.equal(context.argv[1], report.argv[2]);
      assert.equal(context.argv[2], '-v');
      if (label === 'mutant') {
        assert.deepEqual(context.excluded_present, []);
        assert.equal(await exists(context.templates), false, 'temporary mutant copy must be removed');
      } else assert.equal(context.templates, f.templates);
    }
  }
  const overlap = EXPECTED.find(row => row.name === 'cache-symlink');
  assert.ok(overlap);
  assert.equal(overlap.original.includes(overlap.mutation), true, 'control contains the mutation text as a proper substring');
  assert.notEqual(overlap.original, overlap.mutation);
  const control = JSON.parse(await readFile(path.join(f.output, overlap.name, 'control/artifacts/context.json'), 'utf8'));
  const mutant = JSON.parse(await readFile(path.join(f.output, overlap.name, 'mutant/artifacts/context.json'), 'utf8'));
  assert.deepEqual(control.source_lines, [overlap.original]);
  assert.deepEqual(mutant.source_lines, [overlap.mutation]);
  assert.equal(control.mutant, false);
  assert.equal(mutant.mutant, true);
  for (const [file, contents] of f.originals) assert.equal(await readFile(file, 'utf8'), contents);
});

for (const mode of ['wrong-assertion', 'control-failure', 'setup-failure']) {
  test(`${mode} cannot be reported as a killed mutation`, async (t) => {
    const f = await fixture(t, mode);
    const result = await runSensitivity({ repo: f.repo, output: f.output, cases: ['source-digest'], python });
    assert.equal(result.exitCode, 1);
    assert.deepEqual(result.summary.cases.map(row => [row.name, row.killed]), [['source-digest', false]]);
    const row = result.summary.cases[0];
    assert.equal(row.control.exit_code, mode === 'control-failure' ? 1 : 0);
    assert.equal(row.mutant.exit_code, 1);
    assert.equal(await exists(path.join(f.output, 'handler-attribution')), false);
  });
}

test('CLI accepts argparse unique option prefixes and repeated case selection', () => {
  const parsed = parseArguments(['--out', '/tmp/qualification with spaces', '--ca', 'source-digest', '--case=renderer-lock']);
  assert.ok(parsed);
  assert.equal(parsed.output, '/tmp/qualification with spaces');
  assert.deepEqual(parsed.cases, ['source-digest', 'renderer-lock']);
  assert.equal(parseArguments(['--output=/tmp/result'])?.output, '/tmp/result');
  assert.equal(parseArguments(['--o', '-'])?.output, '-');
  assert.equal(parseArguments(['--output', '-12.5'])?.output, '-12.5');
  assert.equal(parseArguments(['--output', '-١٢.٥'])?.output, '-١٢.٥');
  assert.equal(parseArguments(['--output', '-1\n'])?.output, '-1\n');
  assert.equal(parseArguments(['--output='])?.output, '');
  assert.equal(parseArguments(['--output', '-unrecognized value'])?.output, '-unrecognized value');
  assert.equal(parseArguments(['--out=/tmp/result', '--py', '/tmp/python with spaces'])?.python, '/tmp/python with spaces');
});

test('CLI help accepts short and unique long prefixes without requiring output', () => {
  for (const option of ['-h', '-hh', '-hhh', '--help', '--he', '--h']) {
    assert.equal(parseArguments([option]), null, option);
  }
});

test('CLI known options take precedence over values beginning with a dash', () => {
  for (const option of ['--case', '--ca', '--help', '--he', '--output', '--out', '--python', '--py', '-h']) {
    assert.throws(() => parseArguments(['--output', option]), /argument|value|required|expected/i, option);
  }
  assert.equal(parseArguments(['--output=--help'])?.output, '--help');
});

test('CLI rejects unrecognized dash values without ASCII spaces and invalid case names', () => {
  for (const value of ['--unknown', '-unknown', '-unknown\tvalue', '-unknown\u00a0value', '-1\n\n', '-\u{11f50}']) {
    assert.throws(() => parseArguments(['--output', value]), /argument|value|required|expected|unrecognized/i, value);
  }
  assert.throws(() => parseArguments(['--output', '/tmp/result', '--case', 'unknown-case']), /case|choice|invalid/i);
  assert.throws(() => parseArguments(['--output', '/tmp/result', '--unknown']), /unrecognized|unknown|argument/i);
  assert.throws(() => parseArguments(['--output']), /argument|value|required|expected/i);
});

test('timeout retains partial raw output and a machine-readable inconclusive command', async (t) => {
  const f = await fixture(t, 'timeout');
  const directory = path.join(f.root, 'timeout execution');
  const result = await execute(directory, f.templates, EXPECTED[3].test, { repo: f.repo, python, timeoutMs: 500 });
  assert.equal(result.exit_code, null);
  assert.equal(result.inconclusive, 'timeout');
  assert.deepEqual(await readFile(path.join(directory, 'stdout')), Buffer.from('raw stdout\0\xff\n', 'latin1'));
  assert.deepEqual(JSON.parse(await readFile(path.join(directory, 'command.json'), 'utf8')), result);
  assert.equal(verdict(EXPECTED[3], { exit_code: 0 }, result, `AssertionError: ${EXPECTED[3].assertion}`), false);
});

test('spawn failure retains its command and cannot look like an assertion kill', async (t) => {
  const f = await fixture(t);
  const directory = path.join(f.root, 'failed spawn');
  const result = await execute(directory, f.templates, EXPECTED[3].test, { repo: f.repo, python: path.join(f.root, 'missing interpreter') });
  assert.equal(result.exit_code, null);
  assert.ok(result.inconclusive);
  assert.equal(result.argv[0], path.join(f.root, 'missing interpreter'));
  assert.deepEqual(JSON.parse(await readFile(path.join(directory, 'command.json'), 'utf8')), result);
  assert.equal(await exists(path.join(directory, 'stdout')), true);
  assert.equal(await exists(path.join(directory, 'stderr')), true);
  assert.equal(verdict(EXPECTED[3], { exit_code: 0 }, result, `AssertionError: ${EXPECTED[3].assertion}`), false);
});

test('duplicate execution refuses an existing evidence directory without overwriting its bytes', async (t) => {
  const f = await fixture(t);
  const directory = path.join(f.root, 'exclusive execution');
  const options = { repo: f.repo, python };
  const first = await execute(directory, f.templates, EXPECTED[3].test, options);
  assert.equal(first.exit_code, 0);
  const names = ['command.json', 'stdout', 'stderr'];
  const before = await Promise.all(names.map(name => readFile(path.join(directory, name))));
  await assert.rejects(
    execute(directory, f.templates, EXPECTED[3].test, options),
    { code: 'EEXIST' },
  );
  for (const [index, name] of names.entries()) {
    assert.deepEqual(await readFile(path.join(directory, name)), before[index], name);
  }
});

for (const count of [0, 2]) {
  test(`${count} mutation anchors refuses qualification and preserves source`, async (t) => {
    const f = await fixture(t);
    const row = EXPECTED[3];
    const source = path.join(f.templates, row.relative);
    const contents = `${row.original}\n`.repeat(count);
    await writeFile(source, contents);
    await assert.rejects(runSensitivity({ repo: f.repo, output: f.output, cases: [row.name], python }), /unique|anchor/i);
    assert.equal(await readFile(source, 'utf8'), contents);
    assert.equal(await exists(path.join(f.output, 'summary.json')), false, 'incomplete qualification cannot publish success');
  });
}

test('disposable copies dereference source symlinks and normalize CRLF without changing the target', async (t) => {
  const f = await fixture(t);
  const row = EXPECTED.find(item => item.name === 'source-digest');
  assert.ok(row);
  const source = path.join(f.templates, row.relative);
  const target = path.join(f.root, 'external source target.py');
  const originalBytes = Buffer.from(`# source fixture\r\n${row.original}\r\n`);
  const normalized = `# source fixture\n${row.original}\n`;
  const altered = `# source fixture\n${row.mutation}\n`;
  await writeFile(target, originalBytes);
  await rm(source);
  await symlink(target, source);
  const result = await runSensitivity({ repo: f.repo, output: f.output, cases: [row.name], python });
  assert.equal(result.exitCode, 0);
  assert.equal(result.summary.cases.length, 1);
  const outcome = result.summary.cases[0];
  assert.equal(outcome.killed, true);
  assert.equal(outcome.original_sha256, createHash('sha256').update(normalized).digest('hex'));
  assert.equal(outcome.mutant_sha256, createHash('sha256').update(altered).digest('hex'));
  assert.deepEqual(await readFile(path.join(f.output, row.name, 'source.original')), Buffer.from(normalized));
  assert.deepEqual(await readFile(path.join(f.output, row.name, 'source.mutant')), Buffer.from(altered));
  assert.deepEqual(await readFile(target), originalBytes, 'mutating the copied source must not write through to the external target');
  assert.deepEqual(await readFile(source), originalBytes);
  assert.equal(await readlink(source), target);
  const control = JSON.parse(await readFile(path.join(outcome.control.artifacts, 'context.json'), 'utf8'));
  const mutant = JSON.parse(await readFile(path.join(outcome.mutant.artifacts, 'context.json'), 'utf8'));
  assert.deepEqual(control.source_lines, ['# source fixture', row.original]);
  assert.deepEqual(mutant.source_lines, ['# source fixture', row.mutation]);
  assert.equal(control.mutant, false);
  assert.equal(mutant.mutant, true);
  assert.equal(await exists(mutant.templates), false);
});
