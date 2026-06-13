/**
 * Behavior tests for the pack-bundled duplicate-export-check.sh hook
 * (QG-HOOKS-EXTRACT-001 A3/A5/A8).
 *
 * Advisory-only (always exit 0). On Write of a new JS/TS file, flags an
 * exported symbol whose exact name already exists as an export elsewhere in
 * the enclosing package src tree. Generic names (main/init/setup/run/handle/
 * render/index/default) are allowlisted. Matching is exact, not heuristic.
 * v1 fires on Write only (not Edit).
 *
 * Each test builds a self-contained package tree under a temp dir so the
 * bounded lookup has a deterministic search root. The hook does NOT import
 * or execute an external quality package (A9).
 */

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const PACK_DIR = path.resolve(
  __dirname,
  '..',
  '..',
  '..',
  'templates',
  'hook-packs',
  'claude-code'
);
const HOOK = path.join(PACK_DIR, 'duplicate-export-check.sh');

/**
 * Build a package tree: packages/<pkg>/src/existing.ts with the given
 * export. Returns the repo root (cwd to run from) and the package path.
 */
function buildPackage(existingExportLine) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'caws-dup-'));
  const srcDir = path.join(root, 'packages', 'demo', 'src');
  fs.mkdirSync(srcDir, { recursive: true });
  fs.writeFileSync(path.join(srcDir, 'existing.ts'), existingExportLine + '\n');
  return { root, srcDir };
}

function runHook(payload, cwd) {
  const result = spawnSync('bash', [HOOK], {
    input: JSON.stringify(payload),
    encoding: 'utf8',
    cwd,
    env: { ...process.env },
  });
  return {
    code: result.status === null ? -1 : result.status,
    stdout: result.stdout || '',
    stderr: result.stderr || '',
  };
}

describe('duplicate-export-check.sh', () => {
  it('A3: flags a new file whose export collides with an existing one', () => {
    const { root } = buildPackage('export function computeTotal() { return 0; }');
    try {
      const r = runHook(
        {
          tool_name: 'Write',
          tool_input: {
            file_path: 'packages/demo/src/new.ts',
            content: 'export function computeTotal() { return 1; }',
          },
          session_id: 'dup-pos',
          cwd: root,
        },
        root
      );
      expect(r.code).toBe(0);
      expect(r.stdout).toMatch(/Duplicate-export advisory/);
      expect(r.stdout).toMatch(/computeTotal/);
      expect(r.stdout).toMatch(/existing\.ts/);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('A3 negative: a unique export name produces no output', () => {
    const { root } = buildPackage('export function computeTotal() { return 0; }');
    try {
      const r = runHook(
        {
          tool_name: 'Write',
          tool_input: {
            file_path: 'packages/demo/src/new.ts',
            content: 'export function brandNewUniqueSymbol() { return 1; }',
          },
          session_id: 'dup-neg',
          cwd: root,
        },
        root
      );
      expect(r.code).toBe(0);
      expect(r.stdout.trim()).toBe('');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('A3: allowlisted generic names (init) do not warn', () => {
    const { root } = buildPackage('export function init() { return 0; }');
    try {
      const r = runHook(
        {
          tool_name: 'Write',
          tool_input: {
            file_path: 'packages/demo/src/new.ts',
            content: 'export function init() { return 1; }',
          },
          session_id: 'dup-allow',
          cwd: root,
        },
        root
      );
      expect(r.code).toBe(0);
      expect(r.stdout.trim()).toBe('');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('A3: fires on Write only — an Edit does not trigger (v1 limitation)', () => {
    const { root } = buildPackage('export function computeTotal() { return 0; }');
    try {
      const r = runHook(
        {
          tool_name: 'Edit',
          tool_input: {
            file_path: 'packages/demo/src/new.ts',
            content: 'export function computeTotal() { return 1; }',
          },
          session_id: 'dup-edit',
          cwd: root,
        },
        root
      );
      expect(r.code).toBe(0);
      expect(r.stdout.trim()).toBe('');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('A5: a new file under dist/ is skipped (no output)', () => {
    const { root } = buildPackage('export function computeTotal() { return 0; }');
    try {
      const r = runHook(
        {
          tool_name: 'Write',
          tool_input: {
            file_path: 'packages/demo/dist/new.js',
            content: 'export function computeTotal() { return 1; }',
          },
          session_id: 'dup-dist',
          cwd: root,
        },
        root
      );
      expect(r.code).toBe(0);
      expect(r.stdout.trim()).toBe('');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
