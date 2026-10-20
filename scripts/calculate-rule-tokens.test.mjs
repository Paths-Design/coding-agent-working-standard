import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { extractContent, updatedContent, oneDecimal, readText } from './calculate-rule-tokens.mjs';

const cli = fileURLToPath(new URL('./calculate-rule-tokens.mjs', import.meta.url));
/** @param {import('node:test').TestContext} t */
function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'caws-rule-tokens-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return directory;
}
/** @param {string} directory @param {string[]} [args] @param {NodeJS.ProcessEnv} [env] */
function run(directory, args = [], env = process.env) {
  return spawnSync(process.execPath, [cli, '--rules-dir', directory, ...args], { encoding: 'utf8', env });
}
/** @param {string} name @param {number} count */
function row(name, count) { return `${name}${' '.repeat(Math.max(0, 50 - Array.from(name).length))} ${String(count).padStart(6)}`; }

test('extracts at the first delimiter after three Unicode characters and strips only Python whitespace', () => {
  assert.equal(extractContent('---\r\nignored---\u0085\u001c\u2003hello'), 'hello');
  assert.equal(extractContent('😀😀😀--- hello'), 'hello');
  assert.equal(extractContent('ab--- untouched'), 'ab--- untouched');
  assert.equal(extractContent('plain---\ufeffhello'), '\ufeffhello');
  assert.equal(extractContent('no delimiters'), 'no delimiters');
});

test('updates all numeric prefixes and retains suffixes, duplicates and Python whitespace', () => {
  const input = '---\nruleTokenCount:\u0085١٢ # keep\nruleTokenCount: 123abc\nalwaysApply: true\n---\nbody';
  assert.equal(updatedContent(input, 7), '---\nruleTokenCount: 7 # keep\nruleTokenCount: 7abc\nalwaysApply: true\n---\nbody');
  assert.equal(updatedContent('---\nruleTokenCount:\n123\n---x', 2), '---\nruleTokenCount: 2\n---x');
  assert.equal(updatedContent('---\nruleTokenCount: 𖫀\n---hello', 1), '---\nruleTokenCount: 1\n---hello');
  assert.equal(updatedContent('---\nruleTokenCount: 𑽐\n---hello', 1), '---\nruleTokenCount: 𑽐\nruleTokenCount: 1\n---hello');
});

test('inserts before each alwaysApply or appends, while malformed frontmatter refuses update', () => {
  assert.equal(updatedContent('---\nalwaysApply: false\nalwaysApply: true\n---x', 2), '---\nruleTokenCount: 2\nalwaysApply: false\nruleTokenCount: 2\nalwaysApply: true\n---x');
  assert.equal(updatedContent('---\ntitle: hi\n---x', 2), '---\ntitle: hi\nruleTokenCount: 2\n---x');
  assert.equal(updatedContent('---\n---', 0), '---\n\nruleTokenCount: 0\n---');
  assert.equal(updatedContent('plain---x', 1), null);
  assert.equal(updatedContent('---unfinished', 1), null);
  // Python MULTILINE anchors match LF, not JS line separators.
  assert.equal(updatedContent('---a\u2028ruleTokenCount: 3\n---x', 2), '---\na\u2028ruleTokenCount: 3\nruleTokenCount: 2\n---x');
});

test('formats the actual binary64 percentage with ties to even', () => {
  for (const [value, expected] of [[0, '0.0'], [6.25, '6.2'], [18.75, '18.8'], [100, '100.0'], [2.55, '2.5'], [2.65, '2.6']]) {
    assert.equal(oneDecimal(Number(value)), expected);
  }
});

test('strict text decoding preserves BOM and normalizes all conventional newlines', t => {
  const dir = fixture(t);
  const file = join(dir, 'input');
  writeFileSync(file, '\ufeffa\r\nb\rc\n');
  assert.equal(readText(file), '\ufeffa\nb\nc\n');
  writeFileSync(file, Buffer.from([0xff]));
  assert.throws(() => readText(file), /encoded data was not valid/);
});

test('real offline CLI counts known tokens, updates exact bytes and reports body alwaysApply', t => {
  const dir = fixture(t);
  writeFileSync(join(dir, 'a.mdc'), '---\r\ntitle: test\r\nalwaysApply: trueish\r\n---\r\nhello world');
  const result = run(dir, ['--update'], { ...process.env, PATH: '/nonexistent', HTTP_PROXY: 'http://127.0.0.1:1', HTTPS_PROXY: 'http://127.0.0.1:1' });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, '');
  assert.equal(result.stdout, `\n${'Rule File'.padEnd(50)} Tokens\n${'-'.repeat(58)}\n${row('a.mdc', 2)} tokens\n  ✅ Updated ruleTokenCount\n${'-'.repeat(58)}\n${row('Total tokens', 2)}\n${row('Always-applied tokens', 2)} (100.0%)\n\n✅ Updated 1 rule file(s)\n`);
  assert.equal(readFileSync(join(dir, 'a.mdc'), 'utf8'), '---\ntitle: test\nruleTokenCount: 2\nalwaysApply: trueish\n---\nhello world');
});

test('zero total is successful and only successful updates contribute to summary', t => {
  const dir = fixture(t);
  writeFileSync(join(dir, 'a.mdc'), '---\n---');
  const zero = run(dir, ['--update']);
  assert.equal(zero.status, 0, zero.stderr);
  assert.match(zero.stdout, /Always-applied tokens\s+0 \(0\.0%\)/);
  assert.match(zero.stdout, /Updated 1 rule file\(s\)\n$/);
  writeFileSync(join(dir, 'b.mdc'), '---');
  const partial = run(dir, ['--update']);
  assert.equal(partial.status, 0, partial.stderr);
  assert.match(partial.stdout, /Updated 1 rule file\(s\)\n$/);
  assert.match(partial.stdout, /has malformed frontmatter/);
  assert.equal(readFileSync(join(dir, 'b.mdc'), 'utf8'), '---');
});

test('executable entry point runs with only Node available on PATH', t => {
  const dir = fixture(t);
  const bin = join(dir, 'bin');
  mkdirSync(bin);
  symlinkSync(process.execPath, join(bin, 'node'));
  writeFileSync(join(dir, 'a.mdc'), 'hello world');
  const result = spawnSync(cli, ['--rules-dir', dir], { encoding: 'utf8', env: { ...process.env, PATH: bin } });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /a\.mdc\s+2 tokens/);
  assert.equal(result.stderr, '');
});

test('nonrecursive glob includes hidden rules, sorts by Unicode code points and uses character widths', t => {
  const dir = fixture(t);
  mkdirSync(join(dir, 'nested'));
  writeFileSync(join(dir, 'nested', 'hidden.mdc'), 'untouched');
  writeFileSync(join(dir, 'ignored.txt'), 'untouched');
  for (const name of ['😀.mdc', '\ue000.mdc', '.hidden.mdc']) writeFileSync(join(dir, name), 'hello');
  const result = run(dir);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(result.stdout.split('\n').filter(line => line.endsWith(' tokens')), ['.hidden.mdc', '\ue000.mdc', '😀.mdc'].map(name => `${row(name, 1)} tokens`));
  assert.equal(readFileSync(join(dir, 'nested', 'hidden.mdc'), 'utf8'), 'untouched');
});

test('explicit selection accepts nested, non-mdc, absolute and parent paths; directory check precedes rule check', t => {
  const dir = fixture(t);
  mkdirSync(join(dir, 'rules'));
  writeFileSync(join(dir, 'outside.txt'), 'hello world');
  for (const name of ['../outside.txt', resolve(dir, 'outside.txt')]) {
    const result = run(join(dir, 'rules'), ['--rule', name]);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /outside\.txt\s+2 tokens/);
  }
  const missing = run(join(dir, 'missing'), ['--rule', join(dir, 'outside.txt')]);
  assert.equal(missing.status, 1);
  assert.equal(missing.stdout, `Error: Rules directory not found: ${join(dir, 'missing')}\n`);
});

test('special-token spellings and invalid UTF-8 fail after preserving earlier updates', t => {
  const specialTokens = ['<|endoftext|>', '<|fim_prefix|>', '<|fim_middle|>', '<|fim_suffix|>', '<|endofprompt|>'];
  for (const bad of [...specialTokens.map(token => Buffer.from(`hello ${token} world`)), Buffer.from([0xff])]) {
    const dir = fixture(t);
    writeFileSync(join(dir, 'a.mdc'), '---\n---\nhello world');
    writeFileSync(join(dir, 'z.mdc'), bad);
    const result = run(dir, ['--update']);
    assert.equal(result.status, 1);
    assert.notEqual(result.stderr, '');
    assert.doesNotMatch(result.stdout, /Total tokens/);
    assert.equal(readFileSync(join(dir, 'a.mdc'), 'utf8'), '---\n\nruleTokenCount: 2\n---\nhello world');
    assert.deepEqual(readFileSync(join(dir, 'z.mdc')), bad);
  }
});

test('symlink updates retain existing follow-target behavior', t => {
  const dir = fixture(t);
  writeFileSync(join(dir, 'target'), '---\n---\nhello');
  symlinkSync('target', join(dir, 'a.mdc'));
  const result = run(dir, ['--update']);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(readFileSync(join(dir, 'target'), 'utf8'), '---\n\nruleTokenCount: 1\n---\nhello');
});

test('argument errors exit 2 and missing/no-match inputs exit 1 with concrete diagnostics', t => {
  const dir = fixture(t);
  for (const args of [['--unknown'], ['--rule'], ['--r'], ['--update=yes']]) {
    const result = run(dir, args);
    assert.equal(result.status, 2);
    assert.match(result.stderr, /Usage:.*\nError:/);
  }
  const empty = run(dir);
  assert.equal(empty.status, 1);
  assert.equal(empty.stdout, `No .mdc files found in ${dir}\n`);
  const missing = run(dir, ['--rule', 'missing']);
  assert.equal(missing.status, 1);
  assert.equal(missing.stdout, `Error: Rule file not found: ${join(dir, 'missing')}\n`);
});
