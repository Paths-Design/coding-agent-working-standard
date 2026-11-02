#!/usr/bin/env node
// Count Cursor rule tokens with the bundled, pinned GPT-4 cl100k_base encoding.
// Usage: node scripts/calculate-rule-tokens.mjs [--update] [--rule FILE]
import { readFileSync, writeFileSync, existsSync, readdirSync, statSync, realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import { isAbsolute, basename, sep, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Tiktoken } from 'tiktoken/lite';

const require = createRequire(import.meta.url);
/** @type {{bpe_ranks: string, special_tokens: Record<string, number>, pat_str: string}} */
const vocabulary = require('tiktoken/encoders/cl100k_base.json');
// Python str.strip/lstrip and re \s include these characters; JS trim includes a
// BOM instead, and omits U+0085 and U+001C–001F.
const whitespace = '[\\t-\\r\\x1c-\\x20\\x85\\xa0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000]';
const leadingWhitespace = new RegExp(`^${whitespace}+`, 'u');
const trailingWhitespace = new RegExp(`${whitespace}+$`, 'u');
// Metadata digit syntax follows the qualified Python 3.11 / Unicode 14 reference.
// An explicit class prevents Node Unicode upgrades from rewriting additional fields.
const decimalDigits = "[" + [
  String.raw`\u{30}-\u{39}\u{660}-\u{669}\u{6f0}-\u{6f9}\u{7c0}-\u{7c9}\u{966}-\u{96f}\u{9e6}-\u{9ef}`,
  String.raw`\u{a66}-\u{a6f}\u{ae6}-\u{aef}\u{b66}-\u{b6f}\u{be6}-\u{bef}\u{c66}-\u{c6f}\u{ce6}-\u{cef}`,
  String.raw`\u{d66}-\u{d6f}\u{de6}-\u{def}\u{e50}-\u{e59}\u{ed0}-\u{ed9}\u{f20}-\u{f29}\u{1040}-\u{1049}`,
  String.raw`\u{1090}-\u{1099}\u{17e0}-\u{17e9}\u{1810}-\u{1819}\u{1946}-\u{194f}\u{19d0}-\u{19d9}\u{1a80}-\u{1a89}`,
  String.raw`\u{1a90}-\u{1a99}\u{1b50}-\u{1b59}\u{1bb0}-\u{1bb9}\u{1c40}-\u{1c49}\u{1c50}-\u{1c59}\u{a620}-\u{a629}`,
  String.raw`\u{a8d0}-\u{a8d9}\u{a900}-\u{a909}\u{a9d0}-\u{a9d9}\u{a9f0}-\u{a9f9}\u{aa50}-\u{aa59}\u{abf0}-\u{abf9}`,
  String.raw`\u{ff10}-\u{ff19}\u{104a0}-\u{104a9}\u{10d30}-\u{10d39}\u{11066}-\u{1106f}\u{110f0}-\u{110f9}\u{11136}-\u{1113f}`,
  String.raw`\u{111d0}-\u{111d9}\u{112f0}-\u{112f9}\u{11450}-\u{11459}\u{114d0}-\u{114d9}\u{11650}-\u{11659}\u{116c0}-\u{116c9}`,
  String.raw`\u{11730}-\u{11739}\u{118e0}-\u{118e9}\u{11950}-\u{11959}\u{11c50}-\u{11c59}\u{11d50}-\u{11d59}\u{11da0}-\u{11da9}`,
  String.raw`\u{16a60}-\u{16a69}\u{16ac0}-\u{16ac9}\u{16b50}-\u{16b59}\u{1d7ce}-\u{1d7ff}\u{1e140}-\u{1e149}\u{1e2f0}-\u{1e2f9}`,
  String.raw`\u{1e950}-\u{1e959}\u{1fbf0}-\u{1fbf9}`,
].join('') + "]";
const tokenField = new RegExp(`(^|\\n)ruleTokenCount:${whitespace}*${decimalDigits}+`, 'gu');
const alwaysApplied = new RegExp(`(^|\\n)alwaysApply:${whitespace}*true`, 'u');

/** @param {string} text */
function strip(text) { return text.replace(leadingWhitespace, '').replace(trailingWhitespace, ''); }

/** Read like Python's UTF-8 text mode: strict decoding, BOM retained, universal newlines.
 * @param {string} file
 */
export function readText(file) {
  return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true })
    .decode(readFileSync(file)).replace(/\r\n?/g, '\n');
}

/** The historical utility searches after the third Unicode character, even
 * without an opening delimiter. Preserve that contract rather than parse YAML.
 * @param {string} text
 */
function delimiter(text) {
  const start = Array.from(text).slice(0, 3).join('').length;
  return text.indexOf('---', start);
}

/** @param {string} text */
export function extractContent(text) {
  const end = delimiter(text);
  return end < 0 ? text : text.slice(end + 3).replace(leadingWhitespace, '');
}

/** @param {string} text @param {number} count @returns {string | null} */
export function updatedContent(text, count) {
  if (!text.startsWith('---')) return null;
  const end = delimiter(text);
  if (end < 0) return null;
  let frontmatter = strip(text.slice(3, end));
  tokenField.lastIndex = 0;
  if (tokenField.test(frontmatter)) {
    tokenField.lastIndex = 0;
    frontmatter = frontmatter.replace(tokenField, (_match, prefix) => `${prefix}ruleTokenCount: ${count}`);
  } else if (/(^|\n)alwaysApply:/.test(frontmatter)) {
    frontmatter = frontmatter.replace(/(^|\n)(alwaysApply:)/g, `$1ruleTokenCount: ${count}\n$2`);
  } else {
    frontmatter += `\nruleTokenCount: ${count}`;
  }
  return `---\n${frontmatter}\n---${text.slice(end + 3)}`;
}

/** Python's .1f rounds the exact binary64 value, ties to even. toFixed rounds
 * exact halves away from zero (6.25 would incorrectly report 6.3).
 * @param {number} value
 */
export function oneDecimal(value) {
  const view = new DataView(new ArrayBuffer(8));
  view.setFloat64(0, value);
  const bits = view.getBigUint64(0);
  const exponent = Number((bits >> 52n) & 0x7ffn);
  const mantissa = (bits & ((1n << 52n) - 1n)) | (exponent ? 1n << 52n : 0n);
  const power = (exponent || 1) - 1023 - 52;
  const numerator = mantissa * 10n * (power >= 0 ? 1n << BigInt(power) : 1n);
  const denominator = power < 0 ? 1n << BigInt(-power) : 1n;
  let rounded = numerator / denominator;
  const remainder = numerator % denominator;
  if (remainder * 2n > denominator || (remainder * 2n === denominator && rounded % 2n)) rounded++;
  return `${rounded / 10n}.${rounded % 10n}`;
}

/** Preserve pathlib's display (remove empty/dot components but retain '..').
 * @param {string} value
 */
function pathText(value) {
  const prefix = value.startsWith(sep + sep) && !value.startsWith(sep + sep + sep) ? sep + sep : value.startsWith(sep) ? sep : '';
  return prefix + value.split(sep).filter(part => part && part !== '.').join(sep) || '.';
}
/** @param {string} directory @param {string} file */
function childPath(directory, file) { return pathText(isAbsolute(file) ? file : `${directory}${directory.endsWith(sep) ? '' : sep}${file}`); }
/** @param {string} a @param {string} b */
function codepointOrder(a, b) {
  const x = Array.from(a, c => c.codePointAt(0) ?? 0);
  const y = Array.from(b, c => c.codePointAt(0) ?? 0);
  for (let i = 0; i < Math.min(x.length, y.length); i++) if (x[i] !== y[i]) return x[i] - y[i];
  return x.length - y.length;
}
/** @param {string} label @param {number} count */
function row(label, count) { return `${label}${' '.repeat(Math.max(0, 50 - Array.from(label).length))} ${String(count).padStart(6)}`; }

const usage = 'Usage: node scripts/calculate-rule-tokens.mjs [--update] [--rule FILE] [--rules-dir DIRECTORY]';
/** @param {string[]} argv */
function parseArguments(argv) {
  const options = ['--update', '--rule', '--rules-dir', '--help'];
  const result = { update: false, rule: '', rulesDir: '.cursor/rules', help: false };
  for (let i = 0; i < argv.length; i++) {
    const argument = argv[i];
    if (argument === '--' && i === argv.length - 1) break;
    const equal = argument.indexOf('=');
    const name = equal < 0 ? argument : argument.slice(0, equal);
    const candidates = name === '-h' ? ['--help'] : options.includes(name) ? [name] : name.startsWith('--') ? options.filter(option => option.startsWith(name)) : [];
    if (candidates.length !== 1) throw new SyntaxError(`${candidates.length ? 'ambiguous option' : 'unrecognized argument'}: ${argument}`);
    const option = candidates[0];
    if (option === '--update' || option === '--help') {
      if (equal >= 0) throw new SyntaxError(`${option} does not take a value`);
      if (option === '--help') { result.help = true; return result; }
      result.update = true;
    } else {
      const value = equal < 0 ? argv[++i] : argument.slice(equal + 1);
      if (value === undefined || (equal < 0 && value.startsWith('-') && !/^-\d+$|^-\d*\.\d+$/.test(value))) throw new SyntaxError(`${option} requires a value`);
      if (option === '--rule') result.rule = value;
      else result.rulesDir = value;
    }
  }
  return result;
}

/** @param {string[]} argv @param {(text: string) => void} [print] @returns {number} */
export function main(argv, print = console.log) {
  let args;
  try { args = parseArguments(argv); }
  catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
    console.error(`${usage}\nError: ${error.message}`);
    return 2;
  }
  if (args.help) {
    print(`${usage}\n\nCalculate token counts for Cursor rules\n\n--update     Update ruleTokenCount in frontmatter\n--rule       Process only this specific rule file\n--rules-dir  Rules directory (default: .cursor/rules)`);
    return 0;
  }
  const directory = pathText(args.rulesDir);
  if (!existsSync(directory)) { print(`Error: Rules directory not found: ${directory}`); return 1; }
  let files;
  if (args.rule) {
    files = [childPath(directory, args.rule)];
    if (!existsSync(files[0])) { print(`Error: Rule file not found: ${files[0]}`); return 1; }
  } else {
    files = statSync(directory).isDirectory()
      ? readdirSync(directory).filter(name => name.endsWith('.mdc')).sort(codepointOrder).map(name => childPath(directory, name)) : [];
  }
  if (!files.length) { print(`No .mdc files found in ${directory}`); return 1; }
  print(`\n${'Rule File'.padEnd(50)} ${'Tokens'.padStart(6)}`);
  print('-'.repeat(58));
  let total = 0;
  let always = 0;
  let updated = 0;
  const encoder = new Tiktoken(vocabulary.bpe_ranks, vocabulary.special_tokens, vocabulary.pat_str);
  try {
    for (const file of files) {
      const count = encoder.encode(extractContent(readText(file))).length;
      print(`${row(basename(file), count)} tokens`);
      total += count;
      if (args.update) {
        const original = readText(file);
        const content = updatedContent(original, count);
        if (content === null) {
          print(`Warning: ${file} ${original.startsWith('---') ? 'has malformed frontmatter' : "doesn't have frontmatter"}`);
          print('  ⚠️  Could not update ruleTokenCount');
        } else {
          writeFileSync(file, content, 'utf8');
          updated++;
          print('  ✅ Updated ruleTokenCount');
        }
      }
      if (alwaysApplied.test(readText(file))) always += count;
    }
  } finally { encoder.free(); }
  print('-'.repeat(58));
  print(row('Total tokens', total));
  print(`${row('Always-applied tokens', always)} (${oneDecimal(total ? always / total * 100 : 0)}%)`);
  if (args.update) print(`\n✅ Updated ${updated} rule file(s)`);
  return 0;
}

function isEntrypoint() {
  if (!process.argv[1]) return false;
  const invoked = resolve(process.argv[1]);
  const current = fileURLToPath(import.meta.url);
  if (invoked === current) return true;
  // Node resolves an ESM entry's symlink by default, while argv retains it.
  // Importing from `node -e ... unrelated-argument` must remain harmless.
  try { return realpathSync(invoked) === realpathSync(current); }
  catch { return false; }
}

if (isEntrypoint()) {
  try { process.exitCode = main(process.argv.slice(2)); }
  catch (error) { console.error(error); process.exitCode = 1; }
}
