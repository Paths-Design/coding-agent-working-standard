#!/usr/bin/env node
/** Matched sensitivity experiments. Python regression consumers remain an R21 obligation. */
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** @typedef {{name:string,relative:string,original:string,mutation:string,test:string,assertion:string}} SensitivityCase */
/** @type {readonly Readonly<SensitivityCase>[]} */
export const CASES = Object.freeze([
  { name: 'handler-attribution', relative: 'shared/session_log_renderer.py',
    original: '"status": hook_handler_status(row, stdout),',
    mutation: '"status": "block" if row.get("adapter_exit_code") == 2 else row.get("status"),',
    test: 'fidelity:test_mixed_handler_decisions_keep_per_handler_attribution',
    assertion: "self.assertEqual({name:item['status'] for name,item in contexts.items()}," },
  { name: 'codex-default', relative: 'codex/hooks/lib/parse-input.sh',
    original: '_caws_write_session_envelope codex', mutation: '_caws_write_session_envelope claude-code',
    test: 'test_surface_compatibility_helpers_preserve_defaults_without_bootstrap_flags',
    assertion: "self.assertEqual(json.loads(artifact.read_text())['platform'], expected)" },
  { name: 'renderer-lock', relative: 'shared/session_log_renderer.py',
    original: 'fcntl.flock(lock, fcntl.LOCK_EX)', mutation: 'pass  # sensitivity mutant: no writer serialization',
    test: 'fidelity:test_concurrent_renderers_lock_before_reading_and_leave_one_current_generation',
    assertion: 'second renderer read inputs while first held the lock' },
  { name: 'source-digest', relative: 'runtime/caws-hook.py',
    original: "source_sha256=source['sha256']", mutation: "source_sha256='0' * 64",
    test: 'test_description_is_read_only_and_matches_executed_override',
    assertion: "self.assertEqual(record['source_sha256'], selected['handlers'][0]['sha256'])" },
  { name: 'denial-priority', relative: 'shared/lib/run-handlers.sh',
    original: "block|deny) printf '3\\n' ;;", mutation: "block) printf '3\\n' ;;",
    test: 'test_all_surface_runners_preserve_refusals_and_record_raw_exit',
    assertion: 'self.assertEqual(denied.returncode, 2, denied.stderr)' },
  { name: 'cache-symlink', relative: 'shared/lib/session-cache.sh',
    original: 'os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW', mutation: 'os.O_RDONLY | os.O_DIRECTORY',
    test: 'test_recording_failure_cannot_turn_a_refusal_into_admission',
    assertion: 'self.assertEqual(list(outside.iterdir()), [])' },
].map(row => Object.freeze(row)));

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const IGNORED = new Set(['node_modules', '__pycache__', '.DS_Store', 'tmp', '.caws']);
// CPython 3.11 / Unicode 14 argparse digit syntax, independent of Node's Unicode version.
const DIGIT = '[0-9\u0660-\u0669\u06f0-\u06f9\u07c0-\u07c9\u0966-\u096f\u09e6-\u09ef\u0a66-\u0a6f\u0ae6-\u0aef\u0b66-\u0b6f\u0be6-\u0bef\u0c66-\u0c6f\u0ce6-\u0cef\u0d66-\u0d6f\u0de6-\u0def\u0e50-\u0e59\u0ed0-\u0ed9\u0f20-\u0f29\u1040-\u1049\u1090-\u1099\u17e0-\u17e9\u1810-\u1819\u1946-\u194f\u19d0-\u19d9\u1a80-\u1a89\u1a90-\u1a99\u1b50-\u1b59\u1bb0-\u1bb9\u1c40-\u1c49\u1c50-\u1c59\ua620-\ua629\ua8d0-\ua8d9\ua900-\ua909\ua9d0-\ua9d9\ua9f0-\ua9f9\uaa50-\uaa59\uabf0-\uabf9\uff10-\uff19\u{104a0}-\u{104a9}\u{10d30}-\u{10d39}\u{11066}-\u{1106f}\u{110f0}-\u{110f9}\u{11136}-\u{1113f}\u{111d0}-\u{111d9}\u{112f0}-\u{112f9}\u{11450}-\u{11459}\u{114d0}-\u{114d9}\u{11650}-\u{11659}\u{116c0}-\u{116c9}\u{11730}-\u{11739}\u{118e0}-\u{118e9}\u{11950}-\u{11959}\u{11c50}-\u{11c59}\u{11d50}-\u{11d59}\u{11da0}-\u{11da9}\u{16a60}-\u{16a69}\u{16ac0}-\u{16ac9}\u{16b50}-\u{16b59}\u{1d7ce}-\u{1d7ff}\u{1e140}-\u{1e149}\u{1e2f0}-\u{1e2f9}\u{1e950}-\u{1e959}\u{1fbf0}-\u{1fbf9}]';
const NEGATIVE_NUMBER = new RegExp(`^-(?:${DIGIT}+|${DIGIT}*\\.${DIGIT}+)\\n?(?![\\s\\S])`, 'u');
const LIMITS = [
  'Selected defects only; no exhaustive mutation-score claim.',
  'Assertion sensitivity does not establish correctness of its oracle.',
];
/** Python UTF-8 text reads retain BOM, reject invalid bytes and normalize newlines. @param {string} file */
function text(file) {
  return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true })
    .decode(readFileSync(file)).replace(/\r\n?/g, '\n');
}
/** @param {string} value */
const sha = value => createHash('sha256').update(value).digest('hex');
/** @param {string} file @param {unknown} value */
const json = (file, value) => writeFileSync(file, JSON.stringify(value, null, 2) + '\n');

/** @typedef {{argv:string[],exit_code:number|null,stderr_path:string,artifacts:string,cwd:string,inconclusive?:string}} Attempt */
/** Attribute only complete selected-test failures in the supported CPython unittest format.
 * Text is not authenticated against a consumer forging a complete report.
 * @param {Readonly<SensitivityCase>} entry
 * @param {Pick<Attempt,'exit_code'|'inconclusive'>} control
 * @param {Pick<Attempt,'exit_code'|'inconclusive'|'argv'>} outcome @param {string} stderr
 */
export function verdict(entry, control, outcome, stderr) {
  if (control.exit_code !== 0 || outcome.exit_code !== 1 || control.inconclusive || outcome.inconclusive) return false;
  const file = outcome.argv[1];
  if (!file) return false;
  const method = entry.test.replace(/^fidelity:/, '');
  const klass = entry.test.startsWith('fidelity:') ? 'InstalledSessionFidelity' : 'MachineHookSelection';
  if (basename(file) !== (entry.test.startsWith('fidelity:') ? 'test_installed_session_fidelity.py' : 'test_machine_hook_selection.py')) return false;
  const report = stderr.replace(/\r\n?/g, '\n');
  const summary = /^-{70}\nRan 1 test in [^\n]+\n\nFAILED \(failures=([1-9][0-9]*)(?:, skipped=[0-9]+)?\)\n?(?![\s\S])/m.exec(report);
  if (!summary || /^(?:ERROR:|During handling of the above exception|The above exception was)/m.test(report)) return false;
  const headers = [...report.matchAll(/^={70}\nFAIL: ([^\n]+)\n-{70}\n/gm)];
  if (headers.length !== Number(summary[1])) return false;
  const identities = [`${method} (__main__.${klass}.${method})`, `${method} (__main__.${klass})`];
  const expectedSource = entry.name === 'renderer-lock'
    ? "self.assertTrue(blocked_before_read, 'second renderer read inputs while first held the lock')"
    : entry.assertion;
  for (let index = 0; index < headers.length; index++) {
    const header = headers[index];
    const label = header[1];
    if (!identities.some(identity => label === identity || (label.startsWith(identity + ' (') && label.endsWith(')')))) return false;
    const body = report.slice(header.index + header[0].length, headers[index + 1]?.index ?? summary.index).trimEnd();
    if (!body.startsWith('Traceback (most recent call last):\n')) return false;
    const lines = body.split('\n');
    let lastFrame = -1;
    for (let line = 1; line < lines.length; line++)
      if (/^  File "[^"\n]+", line [1-9][0-9]*, in [^\n]+$/.test(lines[line])) lastFrame = line;
    if (lastFrame < 0) return false;
    const frame = /^  File "([^"\n]+)", line [1-9][0-9]*, in ([^\n]+)$/.exec(lines[lastFrame]);
    if (!frame || frame[1] !== file || frame[2] !== method) return false;
    const source = lines[lastFrame + 1];
    if (!source?.startsWith('    ') || !source.trimStart().startsWith(expectedSource)) return false;
    const exception = lines.slice(lastFrame + 2).find(line => line.length && !/^[ \t]/.test(line));
    if (!exception || !/^AssertionError(?::|$)/.test(exception)) return false;
    if (entry.name === 'renderer-lock' && exception !== 'AssertionError: False is not true : ' + entry.assertion) return false;
  }
  return true;
}

/** Resolve symlinks before interpreting following '..', including missing output leaves.
 * The supported reference profile is POSIX pathlib.resolve(strict=False).
 * @param {string} value
 */
export function resolveOutput(value) {
  /** @type {(string|{link:string})[]} */
  const pending = (isAbsolute(value) ? value : `${process.cwd()}/${value}`).split('/');
  const active = new Set();
  let output = '/';
  while (pending.length) {
    const part = pending.shift();
    if (part && typeof part === 'object') { active.delete(part.link); continue; }
    if (!part || part === '.') continue;
    if (part === '..') { output = dirname(output); continue; }
    const candidate = join(output, part);
    let link = false;
    try { link = lstatSync(candidate).isSymbolicLink(); }
    catch (error) {
      if (!error || typeof error !== 'object' || !('code' in error) || !['ENOENT', 'ENOTDIR'].includes(String(error.code))) throw error;
    }
    if (!link) { output = candidate; continue; }
    if (active.has(candidate)) throw new Error('symlink resolution loop: ' + value);
    active.add(candidate);
    const target = readlinkSync(candidate);
    if (isAbsolute(target)) output = '/';
    pending.unshift(...target.split('/'), { link: candidate });
  }
  return output;
}

/** Capture a regression-test attempt; timeouts are inconclusive, never kills.
 * This preserves the reference's direct-child timeout boundary, not descendant containment.
 * @param {string} directory @param {string} templates @param {string} test
 * @param {{repo:string,python:string,timeoutMs?:number}} options
 * @returns {Promise<Attempt>}
 */
export async function execute(directory, templates, test, options) {
  const timeoutMs = options.timeoutMs ?? 180000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) throw new Error('Invalid test timeout');
  mkdirSync(dirname(directory), { recursive: true });
  mkdirSync(directory); // A retry cannot overwrite a prior attempt's custody.
  const fidelity = test.startsWith('fidelity:');
  const script = join(options.repo, 'packages/caws-cli/tests/hooks/pytest',
    fidelity ? 'test_installed_session_fidelity.py' : 'test_machine_hook_selection.py');
  const argv = [options.python, script,
    fidelity ? 'InstalledSessionFidelity.' + test.slice('fidelity:'.length) : 'MachineHookSelection.' + test, '-v'];
  const env = { ...process.env, CAWS_TEST_TEMPLATES_ROOT: templates,
    CAWS_EXPERIMENT_ARTIFACTS: join(directory, 'artifacts'), PYTHONDONTWRITEBYTECODE: '1' };
  /** @type {Attempt} */
  const report = { argv, cwd: options.repo, exit_code: null,
    stderr_path: join(directory, 'stderr'), artifacts: join(directory, 'artifacts') };
  // Publish argv before launch as well as after completion, including startup failures.
  json(join(directory, 'command.json'), report);
  /** @type {Buffer[]} */ const out = [];
  /** @type {Buffer[]} */ const err = [];
  await new Promise(resolveAttempt => {
    const child = spawn(argv[0], argv.slice(1), { cwd: options.repo, env, stdio: ['ignore', 'pipe', 'pipe'] });
    const timer = setTimeout(() => { report.inconclusive = 'timeout'; child.kill('SIGKILL'); }, timeoutMs);
    child.stdout.on('data', chunk => out.push(Buffer.from(chunk)));
    child.stderr.on('data', chunk => err.push(Buffer.from(chunk)));
    child.once('error', error => { report.inconclusive = 'spawn_error: ' + error.message; });
    child.once('close', code => {
      clearTimeout(timer);
      report.exit_code = report.inconclusive ? null : code;
      if (code === null && !report.inconclusive) report.inconclusive = 'signal_termination';
      resolveAttempt(undefined);
    });
  });
  writeFileSync(join(directory, 'stdout'), Buffer.concat(out));
  writeFileSync(join(directory, 'stderr'), Buffer.concat(err));
  json(join(directory, 'command.json'), report);
  return report;
}

/** @param {{repo?:string,output:string,cases?:readonly string[],python?:string,timeoutMs?:number,onResult?:(row:unknown)=>void}} options */
export async function runSensitivity(options) {
  const repo = realpathSync(options.repo ?? REPO);
  const output = resolveOutput(options.output);
  const names = options.cases;
  if (names?.some(name => !CASES.some(entry => entry.name === name))) throw new Error('Unknown sensitivity case');
  mkdirSync(dirname(output), { recursive: true });
  mkdirSync(output); // Never overwrite previous evidence.
  const templates = join(repo, 'packages/caws-cli/templates/hook-packs');
  const execution = { repo, python: options.python ?? 'python3',
    ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }) };
  const results = [];
  for (const entry of CASES) {
    if (names?.length && !names.includes(entry.name)) continue;
    const base = join(output, entry.name);
    const control = await execute(join(base, 'control'), templates, entry.test, execution);
    const temporary = mkdtempSync(join(tmpdir(), 'caws-hook-mutant-'));
    let source, altered, outcome;
    try {
      const copied = join(temporary, 'templates');
      // shutil.copytree's default follows links; retain that reference behavior.
      cpSync(templates, copied, { recursive: true, dereference: true,
        filter: file => !IGNORED.has(basename(file)) });
      const target = join(copied, entry.relative);
      source = text(target);
      writeFileSync(join(base, 'source.original'), source);
      if (source.split(entry.original).length !== 2) throw new Error('mutation anchor is not unique: ' + entry.name);
      altered = source.replace(entry.original, entry.mutation);
      writeFileSync(join(base, 'source.mutant'), altered);
      writeFileSync(target, altered);
      outcome = await execute(join(base, 'mutant'), copied, entry.test, execution);
    } finally { rmSync(temporary, { recursive: true, force: true }); }
    const killed = verdict(entry, control, outcome, text(join(base, 'mutant/stderr')));
    const row = { name: entry.name, source: entry.relative, test: entry.test,
      original_sha256: sha(source), mutant_sha256: sha(altered), control, mutant: outcome, killed };
    results.push(row);
    options.onResult?.(row);
  }
  const summary = { schema: 'caws.hook_sensitivity.v1', cases: results, limits: [...LIMITS] };
  json(join(output, 'summary.json'), summary);
  return { summary, exitCode: results.every(row => row.killed) ? 0 : 1 };
}

/** @param {readonly string[]} args */
export function parseArguments(args) {
  let output, python = 'python3';
  const options = ['--output', '--case', '--python', '--help'];
  /** argparse recognizes options before its negative-number and space exceptions. @param {string} value */
  const isOption = value => {
    if (!value.startsWith('-') || value === '-') return false;
    const prefix = value.split('=', 1)[0];
    if (value.startsWith('-h') || (value.startsWith('--') && options.some(option => option.startsWith(prefix)))) return true;
    return !NEGATIVE_NUMBER.test(value) && !value.includes(' ');
  };
  const cases = [];
  for (let index = 0; index < args.length; index++) {
    const raw = args[index];
    if (/^-h+$/.test(raw ?? '')) return null;
    const match = /^(--[^=]+)(?:=(.*))?$/s.exec(raw ?? '');
    const choices = match ? options.filter(option => option.startsWith(match[1])) : [];
    if (!match || choices.length !== 1) throw new Error('Unrecognized or ambiguous argument: ' + raw);
    if (choices[0] === '--help') {
      if (match[2] !== undefined) throw new Error('Help does not accept a value');
      return null;
    }
    const value = match[2] ?? args[++index];
    if (value === undefined || (match[2] === undefined && isOption(value))) throw new Error('Missing option value');
    if (choices[0] === '--output') output = value;
    else if (choices[0] === '--python') python = value;
    else { if (!CASES.some(entry => entry.name === value)) throw new Error('Unknown sensitivity case: ' + value); cases.push(value); }
  }
  if (output === undefined) throw new Error('--output is required');
  return { output, python, cases };
}

// An import must not require a script path in argv (e.g. node -e with data operands).
function isMain() {
  try { return Boolean(process.argv[1]) && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url)); }
  catch { return false; }
}
if (isMain()) {
  let options;
  try {
    options = parseArguments(process.argv.slice(2));
  } catch (error) { console.error(String(error)); process.exitCode = 2; }
  if (options !== undefined) try {
    if (!options) console.log('Usage: sensitivity.mjs --output DIRECTORY [--case NAME] [--python EXECUTABLE]');
    else process.exitCode = (await runSensitivity({ ...options, onResult: row => console.log(JSON.stringify(row)) })).exitCode;
  } catch (error) { console.error(String(error)); process.exitCode = 1; }
}
