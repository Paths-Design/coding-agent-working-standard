#!/usr/bin/env node
// Offline, fail-closed derivation from exact CPython 3.11.13 source bytes.
// node tests/transcripts/html311/generate.mjs --source-dir <external downloads> [--check]
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const index = args.indexOf('--source-dir');
if (
  index < 0 ||
  !args[index + 1] ||
  args.some((arg, i) => arg !== '--check' && i !== index && i !== index + 1)
) {
  throw new Error('Usage: generate.mjs --source-dir <external pinned source directory> [--check]');
}
const sourceDirectory = path.resolve(args[index + 1]);
const check = args.includes('--check');
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const sourceManifestBytes = await readFile(path.join(here, 'sources.json'));
const manifest = JSON.parse(sourceManifestBytes.toString('utf8'));
assert.equal(manifest.decimalDigitLimit, 4300);
const generatorSha256 = hash(await readFile(fileURLToPath(import.meta.url)));
const source = new Map();
// Fingerprints are checked together before parsing or touching output files.
for (const { file, sha256 } of manifest.sources) {
  const bytes = await readFile(path.join(sourceDirectory, file));
  assert.equal(hash(bytes), sha256, 'Source fingerprint: ' + file);
  source.set(file, bytes.toString('utf8'));
}
function block(file, name) {
  const text = source.get(file);
  const start = text.indexOf('\n' + name + ' = {\n');
  assert.ok(start >= 0, 'Missing dictionary/set: ' + name);
  const body = text.slice(start + name.length + 6);
  const end = body.indexOf('\n}');
  assert.ok(end >= 0, 'Unterminated dictionary/set: ' + name);
  return body
    .slice(0, end)
    .split('\n')
    .filter((line) => line.trim());
}
// Recognize only the string grammar present in these pinned data literals.
// No eval, Python interpreter, import, AST execution or unknown escape fallback.
function pythonString(token) {
  const quote = token[0];
  assert.ok(quote === "'" || quote === '"');
  assert.equal(token.at(-1), quote);
  let result = '';
  for (let i = 1; i < token.length - 1; i++) {
    const char = token[i];
    if (char !== '\\') {
      assert.notEqual(char, quote);
      assert.ok(char.charCodeAt(0) >= 0x20 && char.charCodeAt(0) <= 0x7e);
      result += char;
      continue;
    }
    const escape = token[++i];
    const widths = { x: 2, u: 4, U: 8 };
    if (Object.hasOwn(widths, escape)) {
      const width = widths[escape];
      const digits = token.slice(i + 1, i + 1 + width);
      assert.equal(digits.length, width);
      assert.match(digits, /^[0-9a-fA-F]+$/);
      const cp = Number.parseInt(digits, 16);
      assert.ok(cp <= 0x10ffff && !(cp >= 0xd800 && cp <= 0xdfff));
      result += String.fromCodePoint(cp);
      i += width;
    } else {
      const escapes = { '\\': '\\', "'": "'", '"': '"', n: '\n', r: '\r', t: '\t' };
      assert.ok(Object.hasOwn(escapes, escape), 'Unsupported Python string escape');
      result += escapes[escape];
    }
  }
  return result;
}
const literal = '(?:\'(?:\\\\.|[^\'\\\\])*\'|"(?:\\\\.|[^"\\\\])*")';
const namedRow = new RegExp("^    ('[A-Za-z0-9]+;?'): (" + literal + '),?$');
const entries = new Map();
for (const line of block('entities.py', 'html5')) {
  const match = namedRow.exec(line);
  assert.ok(match && match[0] === line, 'Unrecognized html5 dictionary row: ' + line);
  const name = pythonString(match[1]);
  const value = pythonString(match[2]);
  assert.equal(entries.has(name), false, 'Duplicate html5 name');
  assert.ok(value.length > 0);
  entries.set(name, value);
}
assert.equal(entries.size, 2231);
const correctionRow = new RegExp('^    (0x[0-9a-f]+): (' + literal + '),\\s*(?:#.*)?$');
const corrections = new Map();
for (const line of block('html-init.py', '_invalid_charrefs')) {
  const match = correctionRow.exec(line);
  assert.ok(match && match[0] === line, 'Unrecognized numeric correction row: ' + line);
  const cp = Number.parseInt(match[1], 16);
  assert.equal(corrections.has(cp), false);
  corrections.set(cp, pythonString(match[2]));
}
const invalid = new Set();
for (const line of block('html-init.py', '_invalid_codepoints')) {
  const data = line.split('#')[0].trim();
  if (!data) continue;
  assert.match(data, /^(?:0x[0-9a-f]+,?\s*)+$/);
  for (const token of data
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean)) {
    const cp = Number.parseInt(token, 16);
    assert.equal(invalid.has(cp), false);
    invalid.add(cp);
  }
}
const ranges = [];
for (const cp of [...invalid].sort((a, b) => a - b)) {
  const last = ranges.at(-1);
  if (last && last[1] === cp - 1) last[1] = cp;
  else ranges.push([cp, cp]);
}
const license = source.get('LICENSE.txt');
const notice =
  '/*!\n * Derived from pinned CPython 3.11.13 HTML data.\n * Changes: dictionary/set data converted to frozen TypeScript; see manifest.generated.ts.\n *\n' +
  license
    .trimEnd()
    .split('\n')
    .map((line) => (line ? ' * ' + line : ' *'))
    .join('\n') +
  '\n */\n';
const sortedEntries = [...entries].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
const entitiesText =
  notice +
  'export const HTML5_ENTITIES: Readonly<Record<string, string>> = Object.freeze({\n' +
  sortedEntries
    .map(([name, value]) => '  ' + JSON.stringify(name) + ': ' + JSON.stringify(value) + ',')
    .join('\n') +
  '\n});\n';
const correctionText =
  notice +
  'export const NUMERIC_CORRECTIONS: Readonly<Record<number, string>> = Object.freeze({\n' +
  [...corrections]
    .map(([cp, value]) => '  0x' + cp.toString(16) + ': ' + JSON.stringify(value) + ',')
    .join('\n') +
  '\n});\n' +
  'export const INVALID_NUMERIC_RANGES: readonly (readonly [number, number])[] = Object.freeze([\n' +
  ranges
    .map(
      ([a, b]) => '  Object.freeze([0x' + a.toString(16) + ', 0x' + b.toString(16) + '] as const),'
    )
    .join('\n') +
  '\n]);\n';
const identity = { ...manifest, generatorSha256, sourceManifestSha256: hash(sourceManifestBytes) };
const profileId = 'python-html-3.11.13;decimal-limit-4300;sha256:' + hash(JSON.stringify(identity));
const provenance = {
  ...identity,
  profileId,
  counts: {
    namedReferences: entries.size,
    semicolonlessReferences: sortedEntries.filter(([name]) => !name.endsWith(';')).length,
    numericCorrections: corrections.size,
    invalidNumericCodepoints: invalid.size,
  },
  outputSha256: {
    'entities.generated.ts': hash(entitiesText),
    'numeric.generated.ts': hash(correctionText),
  },
};
const manifestText =
  "/** Pinned HTML interpretation provenance; generated offline. */\nfunction freeze<T>(value: T): T {\n  if (value !== null && typeof value === 'object') {\n    for (const member of Object.values(value)) freeze(member);\n    Object.freeze(value);\n  }\n  return value;\n}\nexport const PYTHON_HTML_MANIFEST = freeze(" +
  JSON.stringify(provenance, null, 2) +
  ' as const);\n';
const output = path.resolve(here, '../../../src/transcripts/html311');
const outputs = [
  ['entities.generated.ts', entitiesText],
  ['numeric.generated.ts', correctionText],
  ['manifest.generated.ts', manifestText],
  ['LICENSE.txt', license],
];
if (!check) await mkdir(output, { recursive: true });
for (const [file, bytes] of outputs) {
  if (check)
    assert.equal(
      await readFile(path.join(output, file), 'utf8'),
      bytes,
      'Generated bytes differ: ' + file
    );
  else await writeFile(path.join(output, file), bytes);
}
console.log(
  JSON.stringify(
    {
      mode: check ? 'check' : 'generate',
      profileId,
      generatorSha256,
      ...provenance.counts,
      outputSha256: provenance.outputSha256,
    },
    null,
    2
  )
);
