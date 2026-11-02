#!/usr/bin/env node
// Deterministic, offline derivation from the exact source bytes in sources.json.
// node tests/transcripts/unicode14/generate.mjs --ucd-dir <external downloads> [--check]
import { createHash } from 'node:crypto';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import assert from 'node:assert/strict';

const here = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const dirIndex = args.indexOf('--ucd-dir');
if (
  dirIndex < 0 ||
  !args[dirIndex + 1] ||
  args.some((a, i) => a !== '--check' && i !== dirIndex && i !== dirIndex + 1)
) {
  throw new Error('Usage: generate.mjs --ucd-dir <external pinned source directory> [--check]');
}
const check = args.includes('--check');
const inputDir = path.resolve(args[dirIndex + 1]);
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const sourceBytes = await readFile(path.join(here, 'sources.json'));
const sources = JSON.parse(sourceBytes.toString('utf8'));
const generatorSha256 = sha256(await readFile(fileURLToPath(import.meta.url)));
const input = new Map();
// Validate every fingerprint before computing or writing any output.
for (const source of sources.sources) {
  const bytes = await readFile(path.join(inputDir, source.file));
  assert.equal(sha256(bytes), source.sha256, `Source fingerprint: ${source.file}`);
  input.set(source.file, bytes.toString('utf8'));
}
const records = (file) =>
  input
    .get(file)
    .split(/\r?\n/)
    .map((line) => line.split('#')[0].trim())
    .filter(Boolean)
    .map((line) => line.split(';').map((field) => field.trim()));
const categories = new Array(0x110000).fill('Cn');
const names = new Map();
const cjkRanges = [];
const addName = (name, cp) => {
  assert.match(name, /^[\x20-\x7e]+$/);
  assert.equal(name, name.toUpperCase());
  assert.equal(names.has(name), false, `Duplicate name: ${name}`);
  names.set(name, cp);
};
let pending;
let previous = -1;
for (const row of records('UnicodeData.txt')) {
  assert.equal(row.length, 15);
  const cp = Number.parseInt(row[0], 16);
  assert.ok(cp > previous && cp <= 0x10ffff);
  previous = cp;
  const name = row[1];
  const category = row[2];
  assert.match(category, /^[A-Z][a-z]$/);
  if (name.endsWith(', First>')) {
    assert.equal(pending, undefined);
    pending = { cp, name: name.slice(0, -8), category };
  } else if (name.endsWith(', Last>')) {
    assert.ok(pending);
    assert.equal(name.slice(0, -7), pending.name);
    assert.equal(category, pending.category);
    categories.fill(category, pending.cp, cp + 1);
    if (name.startsWith('<CJK Ideograph')) cjkRanges.push([pending.cp, cp]);
    pending = undefined;
  } else {
    assert.equal(pending, undefined);
    categories[cp] = category;
    if (!name.startsWith('<')) addName(name, cp);
  }
}
assert.equal(pending, undefined);
// This is the precise CPython 3.11.13 algorithmic-name range contract.
assert.deepEqual(cjkRanges, [
  [0x3400, 0x4dbf],
  [0x4e00, 0x9fff],
  [0x20000, 0x2a6df],
  [0x2a700, 0x2b738],
  [0x2b740, 0x2b81d],
  [0x2b820, 0x2cea1],
  [0x2ceb0, 0x2ebe0],
  [0x30000, 0x3134a],
]);
const canonicalNameCount = names.size;
const aliasKinds = new Set(['correction', 'control', 'alternate', 'figment', 'abbreviation']);
const aliases = records('NameAliases.txt').map(([cp, name, kind]) => {
  assert.ok(aliasKinds.has(kind));
  const value = Number.parseInt(cp, 16);
  addName(name, value);
  return [name, value, kind];
});
const jamo = new Map(
  records('Jamo.txt').map(([cp, shortName]) => [Number.parseInt(cp, 16), shortName])
);
const jamoRange = (start, count) =>
  Array.from({ length: count }, (_, i) => {
    assert.ok(jamo.has(start + i));
    return jamo.get(start + i);
  });
const hangul = [jamoRange(0x1100, 19), jamoRange(0x1161, 21), ['', ...jamoRange(0x11a8, 27)]];
const namedSequences = records('NamedSequences.txt').map(([name, cps]) => {
  assert.equal(names.has(name), false, `Sequence collides with literal name: ${name}`);
  const codepoints = cps.split(/\s+/).map((cp) => Number.parseInt(cp, 16));
  assert.ok(codepoints.length > 1);
  return [name, codepoints];
});
const ranges = (predicate) => {
  const output = [];
  let start;
  for (let cp = 0; cp <= 0x110000; cp++) {
    const included = cp < 0x110000 && predicate(categories[cp], cp);
    if (included && start === undefined) start = cp;
    if (!included && start !== undefined) {
      output.push([start, cp - 1]);
      start = undefined;
    }
  }
  return output;
};
const printable = ranges((category, cp) => cp === 0x20 || !'CZ'.includes(category[0]));
const word = ranges((category, cp) => cp === 0x5f || 'LN'.includes(category[0]));
const decimal = ranges((category) => category === 'Nd');
const license = input.get('LICENSE.txt');
const notice =
  '/*!\n * Derived from Unicode 14.0.0 data; regenerate with tests/transcripts/unicode14/generate.mjs.\n * Exact inputs and generator identity: manifest.generated.ts.\n *\n' +
  license
    .trimEnd()
    .split('\n')
    .map((line) => (line ? ' * ' + line : ' *'))
    .join('\n') +
  '\n */\n';
const hex = (cp) => '0x' + cp.toString(16);
const rangeTs = (name, values) =>
  `export const ${name}: readonly (readonly [number, number])[] = Object.freeze([\n${values.map(([a, b]) => `  Object.freeze([${hex(a)}, ${hex(b)}] as const),`).join('\n')}\n]);\n`;
const tableText =
  notice +
  rangeTs('PRINTABLE_RANGES', printable) +
  rangeTs('WORD_RANGES', word) +
  rangeTs('DECIMAL_RANGES', decimal) +
  rangeTs('CJK_NAME_RANGES', cjkRanges) +
  `export const HANGUL_JAMO: readonly (readonly string[])[] = Object.freeze([\n${hangul.map((column) => `  Object.freeze(${JSON.stringify(column)}),`).join('\n')}\n]);\n`;
const sortedNames = [...names].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
const namesText =
  notice +
  'export const CHARACTER_NAMES: Readonly<Record<string, number>> = Object.freeze({\n' +
  sortedNames.map(([name, cp]) => `  ${JSON.stringify(name)}: ${hex(cp)},`).join('\n') +
  '\n});\n';
const fixturesText =
  notice +
  `export const NAME_ALIASES: readonly (readonly [string, number, string])[] = ${JSON.stringify(aliases, null, 2)};\n` +
  `export const NAMED_SEQUENCES: readonly (readonly [string, readonly number[]])[] = ${JSON.stringify(namedSequences, null, 2)};\n`;
const identityInputs = { ...sources, generatorSha256, sourceManifestSha256: sha256(sourceBytes) };
const profileId = `python-3.11.13;unicode-14.0.0;sha256:${sha256(JSON.stringify(identityInputs))}`;
const manifest = {
  ...identityInputs,
  profileId,
  counts: {
    canonicalNames: canonicalNameCount,
    aliases: aliases.length,
    namedSequences: namedSequences.length,
    printableCodepoints: printable.reduce((n, [a, b]) => n + b - a + 1, 0),
    wordCodepoints: word.reduce((n, [a, b]) => n + b - a + 1, 0),
    decimalCodepoints: decimal.reduce((n, [a, b]) => n + b - a + 1, 0),
  },
  outputSha256: {
    'tables.generated.ts': sha256(tableText),
    'names.generated.ts': sha256(namesText),
    'literal-fixtures.generated.ts': sha256(fixturesText),
  },
};
const manifestText =
  '/** Pinned profile provenance. Generated offline; no runtime file reads. */\n' +
  'function freeze<T>(value: T): T {\n' +
  "  if (value !== null && typeof value === 'object') {\n" +
  '    for (const member of Object.values(value)) freeze(member);\n' +
  '    Object.freeze(value);\n' +
  '  }\n' +
  '  return value;\n' +
  '}\n' +
  'export const UNICODE_PROFILE_MANIFEST = freeze(' +
  JSON.stringify(manifest, null, 2) +
  ' as const);\n';
const outputDir = path.resolve(here, '../../../src/transcripts/unicode14');
const outputs = [
  [path.join(outputDir, 'tables.generated.ts'), tableText],
  [path.join(outputDir, 'names.generated.ts'), namesText],
  [path.join(outputDir, 'manifest.generated.ts'), manifestText],
  [path.join(outputDir, 'LICENSE.txt'), license],
  [path.join(here, 'literal-fixtures.generated.ts'), fixturesText],
];
if (!check) await mkdir(outputDir, { recursive: true });
for (const [file, bytes] of outputs) {
  if (check) assert.equal(await readFile(file, 'utf8'), bytes, `Generated bytes differ: ${file}`);
  else await writeFile(file, bytes);
}
console.log(
  JSON.stringify(
    {
      mode: check ? 'check' : 'generate',
      profileId,
      generatorSha256,
      ...manifest.counts,
      outputSha256: manifest.outputSha256,
    },
    null,
    2
  )
);
