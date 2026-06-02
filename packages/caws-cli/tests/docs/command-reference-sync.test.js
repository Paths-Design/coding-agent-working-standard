'use strict';

// CAWS-DOCS-COMMAND-REFERENCE-GEN-001 — drift gate for the generated command
// reference. docs/command-reference.md must always equal a fresh render of
// COMMAND_SURFACE_METADATA; a metadata change without regenerating the doc
// fails here (the CI sync gate).
//
// The generator is an ESM script the CJS suite can't import, so the test drives
// the real binary as a subprocess (same approach as the front-matter validator
// test). `--stdout` prints the fresh render; `--check` exits 1 when stale.

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..', '..');
const GENERATOR = path.join(
  REPO_ROOT,
  'packages',
  'caws-cli',
  'scripts',
  'generate-command-reference.mjs'
);
const DOC_PATH = path.join(REPO_ROOT, 'docs', 'command-reference.md');

function runGen(args) {
  return spawnSync('node', [GENERATOR, ...args], { encoding: 'utf8', timeout: 30000 });
}

describe('command-reference.md is in sync with COMMAND_SURFACE_METADATA', () => {
  it('A1: the committed doc byte-equals a fresh render (exit 0 via --check)', () => {
    const check = runGen(['--check']);
    if (check.status !== 0) {
      throw new Error(
        `docs/command-reference.md is STALE — regenerate with:\n` +
          `  node packages/caws-cli/scripts/generate-command-reference.mjs\n` +
          `stderr:\n${check.stderr}`
      );
    }
    expect(check.status).toBe(0);
  });

  it('A1: --stdout render is byte-identical to the committed file', () => {
    const fresh = runGen(['--stdout']);
    expect(fresh.status).toBe(0);
    const committed = fs.readFileSync(DOC_PATH, 'utf8');
    expect(fresh.stdout).toBe(committed);
  });

  it('A2: every metadata group appears, and the hidden `specs create --type` alias does NOT', () => {
    const committed = fs.readFileSync(DOC_PATH, 'utf8');
    // All 13 groups present as headings.
    for (const g of [
      'init', 'doctor', 'status', 'scope', 'claim', 'gates', 'evidence',
      'events', 'waiver', 'specs', 'worktree', 'agents', 'prepush',
    ]) {
      expect(committed).toContain(`## \`caws ${g}\``);
    }
    // specs create is documented with its required arg…
    expect(committed).toContain('caws specs create <id>');
    // …but the hidden v10 `--type` alias on specs create is omitted. (The
    // visible `evidence record --type` is a different, legitimate option, so we
    // assert specifically that no "Removed v10 alias" prose leaks in.)
    expect(committed).not.toMatch(/Removed v10 alias/);
  });

  it('A3: an enum-backed option renders its allowed values (specs create --mode)', () => {
    const committed = fs.readFileSync(DOC_PATH, 'utf8');
    expect(committed).toMatch(/--mode <mode>`.*feature \| refactor \| fix \| doc \| chore/);
  });

  it('A4: re-rendering twice is deterministic (no diff between two runs)', () => {
    const a = runGen(['--stdout']);
    const b = runGen(['--stdout']);
    expect(a.status).toBe(0);
    expect(b.status).toBe(0);
    expect(a.stdout).toBe(b.stdout);
  });

  it('the generated file carries the do-not-edit banner', () => {
    const committed = fs.readFileSync(DOC_PATH, 'utf8');
    expect(committed).toMatch(/GENERATED FILE — do not edit by hand/);
    expect(committed).toMatch(/generate-command-reference\.mjs/);
  });
});
