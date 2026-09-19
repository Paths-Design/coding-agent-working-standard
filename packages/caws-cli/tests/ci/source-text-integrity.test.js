'use strict';

/**
 * Repo-wide source-text integrity gate — CAWS-SOURCE-NUL-BYTE-GREP-BLINDNESS-01.
 *
 * A single raw U+0000 byte anywhere in a source file makes grep treat the
 * WHOLE file as binary: it reports no matches and exits 1, which is
 * indistinguishable from "the pattern is not there". `file` reports the file
 * as `data`. The file still compiles and still behaves correctly, so nothing
 * else notices.
 *
 * That is a fail-open shape for every grep-based tool that reads source, and
 * in this repo the hook guards are grep-based. It was found by accident:
 * `grep -c summarizeActiveAgents src/kernel/worktree/leases.ts` exited 1
 * while the symbol occurred five times, because the file carried one raw NUL
 * inside the string literal of its own LEASE_PATH_NULL_BYTE check.
 *
 * Two rules this gate follows:
 *
 *   1. It reads BYTES. It never shells out to grep, because grep is the tool
 *      the defect defeats — a grep-based detector is blind to exactly the
 *      files it exists to find.
 *   2. Every NUL written in this file is the escape `\u0000`, never a raw
 *      byte. Writing a literal one here would trip the gate this file
 *      installs.
 */

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const { validateLeasePathMetadata, LEASE_RULES } = require('../../dist/kernel');

const REPO_ROOT = execFileSync('git', ['rev-parse', '--show-toplevel'], {
  cwd: __dirname,
  encoding: 'utf8',
}).trim();

/** Extensions whose contents are text by definition. */
const TEXT_EXTENSIONS = new Set([
  '.bash',
  '.bats',
  '.cfg',
  '.cjs',
  '.conf',
  '.css',
  '.html',
  '.ini',
  '.js',
  '.json',
  '.jsonc',
  '.jsx',
  '.md',
  '.mdx',
  '.mjs',
  '.py',
  '.scss',
  '.sh',
  '.sql',
  '.toml',
  '.ts',
  '.tsx',
  '.txt',
  '.xml',
  '.yaml',
  '.yml',
  '.zsh',
]);

/** Text files that carry no extension. */
const TEXT_BASENAMES = new Set([
  '.editorconfig',
  '.eslintignore',
  '.gitattributes',
  '.gitignore',
  '.npmignore',
  '.npmrc',
  '.nvmrc',
  '.prettierignore',
  'CODEOWNERS',
  'LICENSE',
  'Makefile',
]);

function isTextCandidate(absPath, relPath) {
  if (TEXT_EXTENSIONS.has(path.extname(relPath).toLowerCase())) return true;
  if (TEXT_BASENAMES.has(path.basename(relPath))) return true;
  // Extensionless executables (hook scripts, husky entries) announce
  // themselves with a shebang.
  let fd;
  try {
    fd = fs.openSync(absPath, 'r');
    const head = Buffer.alloc(2);
    const read = fs.readSync(fd, head, 0, 2, 0);
    return read === 2 && head[0] === 0x23 && head[1] === 0x21; // "#!"
  } catch {
    return false;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

/**
 * The detector, isolated so it can be proven against a synthetic buffer
 * rather than only against whatever the repo happens to contain today.
 * Returns null when clean, or the location of the first NUL.
 */
function findNulByte(buffer) {
  const offset = buffer.indexOf(0x00);
  if (offset === -1) return null;
  const before = buffer.subarray(0, offset);
  let line = 1;
  for (const byte of before) if (byte === 0x0a) line += 1;
  return { offset, line };
}

function trackedTextFiles() {
  const raw = execFileSync('git', ['-C', REPO_ROOT, 'ls-files', '-z'], {
    encoding: 'buffer',
    maxBuffer: 64 * 1024 * 1024,
  });
  const out = [];
  for (const chunk of raw.toString('utf8').split('\u0000')) {
    if (chunk.length === 0) continue;
    const abs = path.join(REPO_ROOT, chunk);
    // A tracked path can be absent from a sparse checkout.
    if (!fs.existsSync(abs)) continue;
    if (!fs.statSync(abs).isFile()) continue;
    if (isTextCandidate(abs, chunk)) out.push(chunk);
  }
  return out;
}

describe('CAWS-SOURCE-NUL-BYTE-GREP-BLINDNESS-01: source text integrity', () => {
  let candidates;
  beforeAll(() => {
    candidates = trackedTextFiles();
  });

  // ── the detector can fail ──────────────────────────────────────────────
  test('the detector reports a NUL in a synthetic buffer, and none in a clean one', () => {
    // Positive control. Without this, the repo-wide assertion below keeps
    // passing after a refactor silently breaks the detector, and a gate that
    // cannot fail proves nothing.
    const dirty = Buffer.from('line one\nline \u0000 two\n', 'utf8');
    const found = findNulByte(dirty);
    expect(found).not.toBeNull();
    expect(found.line).toBe(2);
    expect(dirty[found.offset]).toBe(0x00);

    expect(findNulByte(Buffer.from('line one\nline two\n', 'utf8'))).toBeNull();
  });

  // ── the scan is not vacuous ────────────────────────────────────────────
  test('the scan actually covers the repository', () => {
    // An empty or tiny candidate list would make the gate below pass
    // trivially. Assert the scan reached a plausible corpus AND the specific
    // file whose regression started this, so a recurrence there is caught.
    expect(candidates.length).toBeGreaterThan(500);
    expect(candidates).toContain('packages/caws-cli/src/kernel/worktree/leases.ts');

    // Breadth: every major source language is represented, so a filter that
    // silently narrowed to one extension is caught. Asserting the extension
    // classes rather than named files keeps this from rotting on a rename.
    const extensions = new Set(candidates.map((c) => path.extname(c).toLowerCase()));
    for (const required of ['.ts', '.js', '.sh', '.py', '.md', '.json', '.yaml']) {
      expect(extensions).toContain(required);
    }
  });

  // ── the gate ───────────────────────────────────────────────────────────
  test('no tracked text file contains a raw NUL byte', () => {
    const violations = [];
    for (const rel of candidates) {
      const hit = findNulByte(fs.readFileSync(path.join(REPO_ROOT, rel)));
      if (hit !== null) violations.push(`${rel}:${hit.line} (byte offset ${hit.offset})`);
    }
    expect(violations).toEqual([]);
  });

  // ── the file that started it is greppable again ────────────────────────
  test('grep can read kernel leases.ts', () => {
    // Uses the real tool, because the claim is specifically about what grep
    // can see. Before the fix this exited 1 with no output while the symbol
    // occurred five times in the file.
    const rel = 'packages/caws-cli/src/kernel/worktree/leases.ts';
    const matches = execFileSync(
      'grep',
      ['-c', 'summarizeActiveAgents', path.join(REPO_ROOT, rel)],
      {
        encoding: 'utf8',
      }
    ).trim();
    expect(Number(matches)).toBeGreaterThan(0);
  });
});

describe('CAWS-SOURCE-NUL-BYTE-GREP-BLINDNESS-01: the escape preserved the guard', () => {
  // The edit replaced a raw U+0000 in a string literal with the escape
  // '\u0000'. Those denote the same one-character string, so the validator
  // must behave identically — but "it still compiles" is not that proof.
  // These assert the behavior directly.

  test('a claimed_path containing a NUL is still refused, with the same rule', () => {
    const r = validateLeasePathMetadata({ claimed_paths: ['src/ok.ts', 'src/ba\u0000d.ts'] });
    expect(r.ok).toBe(false);
    expect(r.errors.map((e) => e.rule)).toContain(LEASE_RULES.LEASE_PATH_NULL_BYTE);
    expect(r.errors.some((e) => e.message.includes('null byte'))).toBe(true);
  });

  test('a last_modified_path containing a NUL is still refused', () => {
    const r = validateLeasePathMetadata({ last_modified_paths: ['a\u0000b'] });
    expect(r.ok).toBe(false);
    expect(r.errors.map((e) => e.rule)).toContain(LEASE_RULES.LEASE_PATH_NULL_BYTE);
  });

  test('a NUL anywhere in the string is caught, not only at the start', () => {
    for (const bad of ['\u0000lead', 'mid\u0000dle', 'trail\u0000']) {
      const r = validateLeasePathMetadata({ claimed_paths: [bad] });
      expect(r.ok).toBe(false);
      expect(r.errors.map((e) => e.rule)).toContain(LEASE_RULES.LEASE_PATH_NULL_BYTE);
    }
  });

  test('ordinary paths are still admitted — the guard did not become a blanket refusal', () => {
    // The must-stay-admitted counterweight. A validator that refuses
    // everything would satisfy every test above.
    const r = validateLeasePathMetadata({
      claimed_paths: ['src/a.ts', 'packages/caws-cli/src/b.ts'],
      last_modified_paths: ['docs/c.md'],
    });
    expect(r.ok).toBe(true);
  });
});
