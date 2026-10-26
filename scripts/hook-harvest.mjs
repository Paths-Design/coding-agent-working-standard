#!/usr/bin/env node
// @ts-check
/** Read-only hook comparison. Reports are evidence, never execution or authority. */
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { lstatSync, readFileSync, readdirSync, readlinkSync, realpathSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** @typedef {{path:string, reason:string}} Excluded */
/** @typedef {{files:Map<string, Buffer>, excluded:Excluded[]}} Inventory */
const EXCLUDED_DIRS = new Set(['node_modules', '__pycache__', '.pytest_cache', '.pristine', 'state', 'logs']);
const PY_SPACE = '[\\u0009-\\u000d\\u001c-\\u0020\\u0085\\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000]';
const STRIP = new RegExp(`^${PY_SPACE}+|${PY_SPACE}+$`, 'gu');
const OPEN = new RegExp(`^${PY_SPACE}*(?:_ALL_)?HANDLERS=\\(${PY_SPACE}*$`, 'u');
// argparse's negative-number exception uses Unicode14 decimal digits in the retained Python3.11 profile.
const DIGIT = '[' + [
  '30-39','660-669','6f0-6f9','7c0-7c9','966-96f','9e6-9ef','a66-a6f','ae6-aef','b66-b6f','be6-bef','c66-c6f','ce6-cef','d66-d6f','de6-def','e50-e59','ed0-ed9','f20-f29','1040-1049','1090-1099','17e0-17e9','1810-1819','1946-194f','19d0-19d9','1a80-1a89','1a90-1a99','1b50-1b59','1bb0-1bb9','1c40-1c49','1c50-1c59','a620-a629','a8d0-a8d9','a900-a909','a9d0-a9d9','a9f0-a9f9','aa50-aa59','abf0-abf9','ff10-ff19','104a0-104a9','10d30-10d39','11066-1106f','110f0-110f9','11136-1113f','111d0-111d9','112f0-112f9','11450-11459','114d0-114d9','11650-11659','116c0-116c9','11730-11739','118e0-118e9','11950-11959','11c50-11c59','11d50-11d59','11da0-11da9','16a60-16a69','16ac0-16ac9','16b50-16b59','1d7ce-1d7ff','1e140-1e149','1e2f0-1e2f9','1e950-1e959','1fbf0-1fbf9',
].map(range => range.split('-').map(hex => `\\u{${hex}}`).join('-')).join('') + ']';
const NEGATIVE_NUMBER = new RegExp(`^-${DIGIT}+\\n?(?![\\s\\S])|^-${DIGIT}*\\.${DIGIT}+\\n?(?![\\s\\S])`, 'u');
const LONG_OPTIONS = ['--consumer-root', '--caws-root', '--help'];
/** Match argparse's recognition order before its negative-number and ASCII-space value exceptions. @param {string} value */
export function isOptionToken(value) {
  if (!value.startsWith('-') || value === '-') return false;
  const prefix = value.split('=', 1)[0] ?? '';
  if (value.startsWith('-h') || (value.startsWith('--') && LONG_OPTIONS.some(option => option.startsWith(prefix)))) return true;
  return !NEGATIVE_NUMBER.test(value) && !value.includes(' ');
}
/** @param {string} value */
const strip = value => value.replace(STRIP, '');
/** Python orders Unicode code points, rather than UTF-16 code units. @param {string} a @param {string} b */
export function codepointOrder(a, b) {
  const left = Array.from(a, c => c.codePointAt(0) ?? 0), right = Array.from(b, c => c.codePointAt(0) ?? 0);
  for (let i = 0; i < Math.min(left.length, right.length); i++) {
    if (left[i] !== right[i]) return (left[i] ?? 0) - (right[i] ?? 0);
  }
  return left.length - right.length;
}
/** @param {Buffer} bytes */
export const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
/** Only exact LF-separated ASCII managed stamp lines normalize. @param {Buffer} bytes */
export function normalizeStamp(bytes) {
  return Buffer.from(bytes.toString('latin1').split('\n').map(line => /^# hook_pack_version: [0-9]+(?![\s\S])/.test(line) ? '# hook_pack_version: <stamp>' : line).join('\n'), 'latin1');
}
/** POSIX Python shlex.split(comments=True), without expansion or shell execution. @param {string} raw */
export function literalWords(raw) {
  /** @type {string[]} */ const words = [];
  let word = '', active = false;
  /** @type {null | "'" | '"'} */ let quote = null;
  for (let i = 0; i < raw.length; i++) {
    const c = raw[i] ?? '';
    if (quote === "'") {
      if (c === "'") quote = null;
      else word += c;
    } else if (c === '\\') {
      const next = raw[++i];
      if (next === undefined) return null;
      if (quote === '"' && next !== '"' && next !== '\\') word += '\\';
      word += next; active = true;
    } else if (quote === '"') {
      if (c === '"') quote = null;
      else word += c;
    } else if (c === '#') break;
    else if (c === "'" || c === '"') { quote = c; active = true; }
    else if (/[ \t\r\n]/.test(c)) {
      if (active) words.push(word);
      word = ''; active = false;
    } else { word += c; active = true; }
  }
  if (quote !== null) return null;
  if (active) words.push(word);
  return words;
}
/** @param {Buffer} bytes */
export function declarations(bytes) {
  /** @type {{entry:string,line:number}[]} */ const declared = [];
  /** @type {{entry:string,line:number}[]} */ const commented = [];
  /** @type {number[]} */ const unresolved_lines = [];
  // Buffer replacement decoding retains BOM. Python splitlines includes these separators, but not U+001F.
  const lines = bytes.toString('utf8').split(/\r\n|[\n\r\v\f\u001c-\u001e\u0085\u2028\u2029]/u);
  let inside = false;
  for (const [index, line] of lines.entries()) {
    if (OPEN.test(line)) { inside = true; continue; }
    if (!inside) continue;
    let value = strip(line);
    if (value === ')') { inside = false; continue; }
    const isComment = value.startsWith('#');
    if (isComment) value = strip(value.slice(1));
    const words = literalWords(value);
    if (words === null) { if (!isComment) unresolved_lines.push(index + 1); continue; }
    if (!words.length || (isComment && words.length !== 1)) continue;
    for (const entry of words) {
      if (/^[A-Za-z0-9_./-]+\.sh(?: [A-Za-z0-9_./-]+)*$/.test(entry)) (isComment ? commented : declared).push({ entry, line: index + 1 });
      else if (!isComment) unresolved_lines.push(index + 1);
    }
  }
  return { declared, commented, unresolved_lines };
}
/** Python filesystem UTF-8/surrogateescape keeps invalid filename bytes distinct. @param {Buffer} bytes */
export function filesystemName(bytes) {
  let value = '';
  for (let i = 0; i < bytes.length;) {
    const first = bytes[i] ?? 0;
    if (first < 0x80) { value += String.fromCharCode(first); i++; continue; }
    const count = first >= 0xc2 && first <= 0xdf ? 2 : first >= 0xe0 && first <= 0xef ? 3 : first >= 0xf0 && first <= 0xf4 ? 4 : 0;
    const second = bytes[i + 1] ?? 0;
    let valid = count > 0 && i + count <= bytes.length;
    for (let j = 1; j < count; j++) if ((bytes[i + j] ?? 0) < 0x80 || (bytes[i + j] ?? 0) > 0xbf) valid = false;
    if ((first === 0xe0 && second < 0xa0) || (first === 0xed && second > 0x9f) || (first === 0xf0 && second < 0x90) || (first === 0xf4 && second > 0x8f)) valid = false;
    if (valid) { value += bytes.subarray(i, i + count).toString('utf8'); i += count; }
    else { value += String.fromCharCode(0xdc00 + first); i++; }
  }
  return value;
}
/** Match pathlib's missing/unresolvable entry predicates. @param {string | Buffer} file @param {boolean} link */
function safeStat(file, link) {
  try { return link ? lstatSync(file) : statSync(file); } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && ['ENOENT', 'ENOTDIR', 'EBADF', 'ELOOP'].includes(String(error.code))) return undefined;
    throw error;
  }
}
/** Sequential reads retain the original stability boundary; this is not a no-follow race primitive. @param {string} root @param {{readFile?:(file:Buffer)=>Buffer}} readers @returns {Inventory} */
export function inventory(root, readers = {}) {
  /** @type {Map<string,Buffer>} */ const files = new Map();
  /** @type {Excluded[]} */ const excluded = [];
  const read = readers.readFile ?? (file => readFileSync(file));
  /** @param {Buffer} current @param {string[]} parts */
  function walk(current, parts) {
    /** @type {Buffer[]} */ let names;
    try { names = readdirSync(current, { encoding: 'buffer' }); } catch { return; } // os.walk's default onerror ignores directory enumeration errors.
    const entries = names.map(raw => ({ name: filesystemName(raw), file: Buffer.concat([current, Buffer.from('/'), raw]) }));
    /** @type {typeof entries} */ const dirs = [];
    /** @type {typeof entries} */ const leaves = [];
    for (const entry of entries) {
      let isDirectory = false;
      try { isDirectory = statSync(entry.file).isDirectory(); } catch { /* dangling links remain leaves */ }
      (isDirectory ? dirs : leaves).push(entry);
    }
    dirs.sort((a, b) => codepointOrder(a.name, b.name)); leaves.sort((a, b) => codepointOrder(a.name, b.name));
    /** @type {typeof entries} */ const descend = [];
    for (const entry of dirs) {
      if (EXCLUDED_DIRS.has(entry.name) || safeStat(entry.file, true)?.isSymbolicLink()) excluded.push({ path: [...parts, entry.name].join('/'), reason: 'dependency/cache/state or symlink subtree' });
      else descend.push(entry);
    }
    for (const entry of leaves) {
      const relative = [...parts, entry.name].join('/');
      if (safeStat(entry.file, true)?.isSymbolicLink() || entry.name === '.DS_Store' || ['.pyc', '.log'].includes(path.extname(entry.name))) excluded.push({ path: relative, reason: 'symlink or generated file' });
      else if (safeStat(entry.file, false)?.isFile()) files.set(relative, read(entry.file));
    }
    // os.walk rechecks links immediately before descending, after yielding the sibling files.
    for (const entry of descend) if (!safeStat(entry.file, true)?.isSymbolicLink()) walk(entry.file, [...parts, entry.name]);
  }
  walk(Buffer.from(root), []);
  excluded.sort((a, b) => codepointOrder(a.path, b.path));
  return { files, excluded };
}
/** @param {string} name */
export function category(name) {
  if (name.startsWith('tests/')) return 'test-or-fixture';
  if (name === 'package.json' || name === 'package-lock.json') return 'dependency-metadata';
  if (name.startsWith('adapter-surface-policies/')) return 'project-surface-policy';
  return 'hook-source-or-support';
}
/** @param {Map<string,Buffer>} left @param {Map<string,Buffer>} right */
export function compare(left, right) {
  return [...new Set([...left.keys(), ...right.keys()])].sort(codepointOrder).map(name => {
    const a = left.get(name), b = right.get(name);
    const status = a === undefined ? 'caws-only' : b === undefined ? 'consumer-only' : a.equals(b) ? 'identical' : normalizeStamp(a).equals(normalizeStamp(b)) ? 'version-stamp-only' : 'different';
    return { path: name, category: category(name), status, consumer_bytes: a?.length ?? null, caws_bytes: b?.length ?? null, consumer_sha256: a === undefined ? null : sha256(a), caws_sha256: b === undefined ? null : sha256(b) };
  });
}
const ALLOWED_GIT_ENVIRONMENT = new Set(['GIT_CONFIG_GLOBAL', 'GIT_CONFIG_SYSTEM', 'GIT_CONFIG_NOSYSTEM']);
/** Remove trace destinations before Git initializes, and refuse inherited command/config overrides.
 * @param {{[key:string]:string|undefined}} environment */
export function gitEnvironment(environment = process.env) {
  const result = { ...environment };
  for (const key of Object.keys(result)) {
    if (key.startsWith('GIT_TRACE')) delete result[key];
    else if (key.startsWith('GIT_') && !ALLOWED_GIT_ENVIRONMENT.has(key)) throw new Error('Unsupported inherited Git environment variable');
  }
  result.GIT_TRACE2 = '0';
  result.GIT_TRACE2_EVENT = '0';
  result.GIT_TRACE2_PERF = '0';
  return result;
}
/** @param {string} output */
export function assertGitVersion(output) {
  const match = /^git version ([0-9]+)\.([0-9]+)(?:\.[0-9]+)?(?:[-.][0-9A-Za-z][0-9A-Za-z.+-]*| \([^\r\n]*\))?\r?\n?$/.exec(output);
  const major = Number(match?.[1]), minor = Number(match?.[2]);
  if (!match || !Number.isSafeInteger(major) || !Number.isSafeInteger(minor)) throw new Error('Cannot establish Git version');
  if (major < 2 || (major === 2 && minor < 45)) throw new Error('Git 2.45 or later is required');
}
/** Keep framing, configuration values and filenames as bytes.
 * @param {Buffer} raw @returns {Buffer[]} */
function nulRecords(raw) {
  if (!Buffer.isBuffer(raw) || (raw.length && raw[raw.length - 1] !== 0)) throw new Error('Malformed Git NUL output');
  /** @type {Buffer[]} */ const records = [];
  for (let start = 0; start < raw.length;) {
    const end = raw.indexOf(0, start);
    if (end === start) throw new Error('Malformed Git NUL output');
    records.push(raw.subarray(start, end));
    start = end + 1;
  }
  return records;
}
/** Inspect effective filter values, preserving case-sensitive subsection identities.
 * Values are not decoded, normalized or included in diagnostics.
 * @param {Buffer} raw */
export function assertGitConfig(raw) {
  /** @type {Map<string, Buffer|null>} */ const filters = new Map();
  for (const record of nulRecords(raw)) {
    const separator = record.indexOf(10);
    const key = record.subarray(0, separator < 0 ? record.length : separator).toString('latin1');
    const match = /^([A-Za-z0-9.-]+?)\.(?:([^\n]*)\.)?([A-Za-z][A-Za-z0-9-]*)$/.exec(key);
    if (!match) throw new Error('Malformed Git configuration output');
    const section = (match[1] ?? '').toLowerCase(), subsection = match[2], variable = (match[3] ?? '').toLowerCase();
    if (section === 'filter' && subsection !== undefined && (variable === 'clean' || variable === 'process')) {
      filters.set(`${subsection}.${variable}`, separator < 0 ? null : record.subarray(separator + 1));
    }
  }
  for (const value of filters.values()) {
    if (value === null || value.length !== 0) throw new Error('Executable Git clean/process filters are not admitted');
  }
}
/** Inspect the whole index; paths may contain arbitrary non-NUL bytes.
 * @param {Buffer} raw */
export function assertNoGitlinks(raw) {
  for (const record of nulRecords(raw)) {
    const separator = record.indexOf(9);
    if (separator < 0 || separator === record.length - 1) throw new Error('Malformed Git index output');
    const header = record.subarray(0, separator).toString('latin1');
    const match = /^(100644|100755|120000|160000) ([0-9a-f]{40}|[0-9a-f]{64}) ([0-3])$/.exec(header);
    if (!match) throw new Error('Malformed Git index output');
    if (match[1] === '160000') throw new Error('Indexed Git submodules are not admitted');
  }
}
/** @param {Buffer} raw */
const decodeGit = raw => new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(raw).replace(/\r\n|\r/g, '\n');
/** One policy prefix for every Git subprocess. The version probe omits the
 * newer no-lazy-fetch flag so an older installation can report its version.
 * @param {string} root @param {string[]} args
 * @param {{[key:string]:string|undefined}} environment @param {boolean} lazyFetchGuard */
function spawnGit(root, args, environment, lazyFetchGuard) {
  const prefix = ['--no-pager', '--no-optional-locks', ...(lazyFetchGuard ? ['--no-lazy-fetch'] : []), '-c', 'core.fsmonitor=false', '-c', 'core.hooksPath=/dev/null'];
  try {
    return execFileSync('git', [...prefix, '-C', root, ...args], {
      env: environment, maxBuffer: 1024 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch {
    // Git's own config errors can include configuration values.
    throw new Error('Git inspection failed');
  }
}
/** Recheck admission on each call rather than caching past environment checks.
 * @param {string} root @param {...string} args */
function gitBytes(root, ...args) {
  const environment = gitEnvironment();
  assertGitVersion(decodeGit(spawnGit(root, ['--version'], environment, false)));
  return spawnGit(root, args, environment, true);
}
/** Retain the original report decoder and universal-newline semantics.
 * @param {string} root @param {...string} args */
export const git = (root, ...args) => decodeGit(gitBytes(root, ...args));
/** Admission assumes stable configuration, attributes and index inputs.
 * @param {string} root */
function preflightGit(root) {
  assertGitConfig(gitBytes(root, 'config', '--null', '--list', '--includes'));
  assertNoGitlinks(gitBytes(root, 'ls-files', '--stage', '-z'));
}
/** @param {Inventory} a @param {Inventory} b */
function sameInventory(a, b) {
  return a.files.size === b.files.size && [...a.files].every(([key, bytes]) => b.files.get(key)?.equals(bytes)) && JSON.stringify(a.excluded) === JSON.stringify(b.excluded);
}
/** Injectable readers make each stability check independently falsifiable. @param {string} repo @param {string} hookRoot @param {{git?: typeof git, inventory?: typeof inventory}} readers */
export function snapshot(repo, hookRoot, readers = {}) {
  const runGit = readers.git ?? git, readInventory = readers.inventory ?? inventory;
  const head = strip(runGit(repo, 'rev-parse', 'HEAD'));
  const status = runGit(repo, 'status', '--porcelain', '--', hookRoot);
  const first = readInventory(hookRoot), again = readInventory(hookRoot);
  if (!sameInventory(first, again) || strip(runGit(repo, 'rev-parse', 'HEAD')) !== head || runGit(repo, 'status', '--porcelain', '--', hookRoot) !== status) throw new Error(`source changed during inventory: ${hookRoot}; retry when stable`);
  return { files: first.files, metadata: { root: repo, hooks_root: hookRoot, head, status, excluded: first.excluded } };
}
/** Resolve existing symlink ancestors while preserving missing descendants, like pathlib.resolve(strict=False). @param {string} value */
export function resolveRoot(value) {
  // Resolve each symlink before interpreting its subsequent '..'. path.resolve would select a different tree.
  /** @type {(string | {resolvedLink:string})[]} */
  const pending = (path.isAbsolute(value) ? value : `${process.cwd()}/${value}`).split('/');
  const activeLinks = new Set();
  let resolved = '/';
  while (pending.length) {
    const part = pending.shift();
    if (part && typeof part === 'object') { activeLinks.delete(part.resolvedLink); continue; }
    if (!part || part === '.') continue;
    if (part === '..') { resolved = path.dirname(resolved); continue; }
    const candidate = path.join(resolved, part);
    let link = false;
    try { link = lstatSync(candidate).isSymbolicLink(); } catch (error) {
      if (!error || typeof error !== 'object' || !('code' in error) || !['ENOENT', 'ENOTDIR'].includes(String(error.code))) throw error;
    }
    if (link) {
      if (activeLinks.has(candidate)) throw new Error(`symlink resolution loop: ${value}`);
      activeLinks.add(candidate);
      const target = readlinkSync(candidate);
      if (path.isAbsolute(target)) resolved = '/';
      pending.unshift(...target.split('/'), { resolvedLink: candidate });
    } else resolved = candidate;
  }
  return resolved;
}
class UsageError extends Error {}
/** @param {string} consumerRoot @param {string} cawsRoot */
export function harvest(consumerRoot, cawsRoot) {
  const consumer = resolveRoot(consumerRoot), caws = resolveRoot(cawsRoot);
  const leftRoot = path.join(consumer, '.caws/hooks'), rightRoot = path.join(caws, 'packages/caws-cli/templates/hook-packs/shared');
  for (const root of [leftRoot, rightRoot]) {
    let valid = false;
    try { valid = statSync(root).isDirectory() && !lstatSync(root).isSymbolicLink(); } catch { /* diagnostics below */ }
    if (!valid) throw new UsageError(`hook source must be a real directory: ${root}`);
  }
  // Admit both repositories before either snapshot can invoke status.
  preflightGit(consumer);
  preflightGit(caws);
  const left = snapshot(consumer, leftRoot), right = snapshot(caws, rightRoot);
  const tracked = new Set(git(consumer, 'ls-files', '-z', '--', '.caws/hooks').split('\0'));
  const rows = compare(left.files, right.files).map(row => ({ ...row, consumer_tracked: tracked.has(`.caws/hooks/${row.path}`) }));
  /** @type {Record<string,number>} */ const counts = {};
  for (const row of rows) counts[row.status] = (counts[row.status] ?? 0) + 1;
  /** @param {Map<string,Buffer>} files */
  const dispatchers = files => Object.fromEntries([...files].sort(([a], [b]) => codepointOrder(a, b)).filter(([name]) => name.startsWith('dispatch/') && name.endsWith('.sh')).map(([name, bytes]) => [name, declarations(bytes)]));
  return { schema: 'caws.consumer_hook_harvest.v1', limits: ['Byte differences do not establish missing capabilities or edit authorship.', 'Declarations do not establish effective native registration or execution.', 'No hooks executed and no payload text copied.', 'Excluded subtrees are not recursively inventoried.', 'Sequential stable reads are not a cross-repository atomic snapshot.', 'Git admission requires Git 2.45 or later, stable configuration and index inputs, no executable clean/process filters and no indexed submodules.', 'Inventory exclusions do not prohibit Git status from reading excluded tracked files.'], consumer: left.metadata, caws: right.metadata, counts, files: rows, dispatchers: { consumer: dispatchers(left.files), caws: dispatchers(right.files) } };
}
/** Sort report keys and preserve Python's ASCII JSON encoding. @param {unknown} value @returns {unknown} */
function sortKeys(value) {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value !== null && typeof value === 'object') return Object.fromEntries(Object.entries(value).sort(([a], [b]) => codepointOrder(a, b)).map(([key, item]) => [key, sortKeys(item)]));
  return value;
}
/** @typedef {{kind:'argument'|'separator',raw:string}|{kind:'option',raw:string,option:string|null,explicit:string|undefined,equals:boolean}} ArgumentToken */
/** Classify the complete sequence before actions; ambiguity is immediate and extras are deferred.
 * @param {string[]} args @returns {ArgumentToken[]} */
function classifyArguments(args) {
  let terminated = false;
  return args.map(raw => {
    if (terminated) return { kind: 'argument', raw };
    if (raw === '--') { terminated = true; return { kind: 'separator', raw }; }
    if (!isOptionToken(raw)) return { kind: 'argument', raw };
    const separator = raw.indexOf('=');
    const prefix = separator < 0 ? raw : raw.slice(0, separator);
    const explicit = separator < 0 ? undefined : raw.slice(separator + 1);
    if (prefix === '-h' || LONG_OPTIONS.includes(prefix)) return { kind: 'option', raw, option: prefix, explicit, equals: separator >= 0 };
    const choices = raw.startsWith('--') ? LONG_OPTIONS.filter(option => option.startsWith(prefix)) : [];
    if (choices.length > 1) throw new UsageError(`unrecognized or ambiguous argument: ${raw}`);
    if (choices.length === 1) return { kind: 'option', raw, option: choices[0] ?? null, explicit, equals: separator >= 0 };
    if (raw.startsWith('-h')) return { kind: 'option', raw, option: '-h', explicit: raw.slice(2), equals: false };
    return { kind: 'option', raw, option: null, explicit: undefined, equals: false };
  });
}
/** Consume actions in order, retaining argparse's required-before-extras check.
 * @param {string[]} args
 * @returns {{help:true}|{help:false,consumer:string,caws:string|undefined}} */
function parseArguments(args) {
  const tokens = classifyArguments(args);
  /** @type {string[]} */ const extras = [];
  /** @type {string|undefined} */ let consumer;
  /** @type {string|undefined} */ let caws;
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (!token) continue;
    if (token.kind !== 'option' || token.option === null) { extras.push(token.raw); continue; }
    if (token.option === '--help') {
      if (token.explicit !== undefined) throw new UsageError('ignored explicit argument for --help');
      return { help: true };
    }
    if (token.option === '-h') {
      // Validate the whole registered cluster before dispatching pending help.
      // An unknown suffix becomes an extra; '=' and prefix tails refuse first.
      let tail = token.explicit, equals = token.equals;
      while (tail !== undefined) {
        if (equals || tail === '' || tail.startsWith('-')) throw new UsageError('ignored explicit argument for -h');
        if (!tail.startsWith('h')) { extras.push(`-${tail}`); break; }
        tail = tail.slice(1);
        if (tail === '') tail = undefined;
        else if (tail.startsWith('=')) { equals = true; tail = tail.slice(1); }
        else equals = false;
      }
      return { help: true };
    }
    let value = token.explicit;
    if (value === undefined) {
      const next = tokens[i + 1];
      if (!next || next.kind !== 'argument') throw new UsageError(`expected a path after ${token.raw}`);
      value = next.raw; i++;
    }
    if (token.option === '--consumer-root') consumer = value;
    else caws = value;
  }
  if (consumer === undefined) throw new UsageError('--consumer-root is required');
  if (extras.length) throw new UsageError(`unrecognized or ambiguous argument: ${extras[0]}`);
  return { help: false, consumer, caws };
}
/** @param {string[]} args */
export function main(args = process.argv.slice(2)) {
  const parsed = parseArguments(args);
  if (parsed.help) {
    process.stdout.write('Usage: hook-harvest.mjs --consumer-root ROOT [--caws-root ROOT]\nRead-only hook inventory; no CAWS hook execution or authority decision.\n');
    return 0;
  }
  const consumer = parsed.consumer;
  const caws = parsed.caws ?? path.dirname(path.dirname(realpathSync(fileURLToPath(import.meta.url))));
  const output = JSON.stringify(sortKeys(harvest(consumer, caws)), null, 2).replace(/[\u007f-\uffff]/g, c => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`);
  process.stdout.write(`${output}\n`); return 0;
}
function isEntrypoint() {
  if (!process.argv[1]) return false;
  try { return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url)); } catch { return false; }
}
if (isEntrypoint()) {
  try { process.exitCode = main(); } catch (error) { process.stderr.write(`hook-harvest: ${error instanceof Error ? error.message : String(error)}\n`); process.exitCode = error instanceof UsageError ? 2 : 1; }
}
