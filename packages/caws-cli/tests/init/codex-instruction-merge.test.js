'use strict';

/**
 * Codex instruction-reach contract (CAWS-CODEX-INSTRUCTION-REACH-002).
 *
 * Codex discovers at most one instruction file per directory, preferring a
 * non-empty AGENTS.override.md over AGENTS.md. A vendor-local
 * `.codex/AGENTS.md` therefore cannot carry repository-wide CAWS instructions.
 * These tests pin a bounded root-file merge that follows Codex's selection
 * order without taking ownership of the repository's surrounding guidance.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  CODEX_INSTRUCTION_BLOCK,
  CODEX_INSTRUCTION_BEGIN_MARKER,
  CODEX_INSTRUCTION_END_MARKER,
  mergeCodexProjectInstructions,
  planCodexProjectInstructions,
  installHookPack,
} = require('../../dist/init/hook-install');
const { CODEX_PACK } = require('../../dist/init/hook-packs/manifest-codex');
const { runInitCommand } = require('../../dist/shell/commands/init');
const { cleanupAll, makeTempRepo } = require('../helpers/git-repo-factory');

const CODEX_REFERENCE_REL = '.codex/CAWS.md';

afterAll(() => cleanupAll());

function makeDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'caws-codex-instructions-'));
}

function runInit(root, opts = {}) {
  const out = [];
  const err = [];
  const code = runInitCommand({
    cwd: root,
    out: (line) => out.push(line),
    err: (line) => err.push(line),
    ...opts,
  });
  return { code, out: out.join('\n'), err: err.join('\n') };
}

describe('Codex project instruction merge', () => {
  let root;

  beforeEach(() => {
    root = makeDir();
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  test('the always-on block is concise, self-contained, and points at the full reference', () => {
    expect(Buffer.byteLength(CODEX_INSTRUCTION_BLOCK, 'utf8')).toBeLessThan(4096);
    expect(CODEX_INSTRUCTION_BLOCK).toContain('## CAWS working contract');
    expect(CODEX_INSTRUCTION_BLOCK).toContain('caws scope check <path>');
    expect(CODEX_INSTRUCTION_BLOCK).toContain('caws gates run --spec <id>');
    expect(CODEX_INSTRUCTION_BLOCK).toContain(CODEX_REFERENCE_REL);
  });

  test('no root instruction file: plan is pure and apply creates AGENTS.md', () => {
    const planned = planCodexProjectInstructions(root);
    expect(planned).toEqual({
      kind: 'created',
      path: path.join(root, 'AGENTS.md'),
      target: 'AGENTS.md',
      readOnly: true,
    });
    expect(fs.existsSync(path.join(root, 'AGENTS.md'))).toBe(false);

    const applied = mergeCodexProjectInstructions(root);
    expect(applied).toEqual({
      kind: 'created',
      path: path.join(root, 'AGENTS.md'),
      target: 'AGENTS.md',
    });
    expect(fs.readFileSync(path.join(root, 'AGENTS.md'), 'utf8')).toBe(
      `${CODEX_INSTRUCTION_BLOCK}\n`
    );
  });

  test('existing AGENTS.md bytes survive after the prepended managed block', () => {
    const original = '# Existing project rules\r\n\r\nKeep this final byte.';
    fs.writeFileSync(path.join(root, 'AGENTS.md'), original);

    const applied = mergeCodexProjectInstructions(root);
    const merged = fs.readFileSync(path.join(root, 'AGENTS.md'), 'utf8');

    expect(applied.kind).toBe('merged');
    expect(applied.target).toBe('AGENTS.md');
    expect(merged.endsWith(original)).toBe(true);
    expect(merged.startsWith(CODEX_INSTRUCTION_BEGIN_MARKER)).toBe(true);
  });

  test('a non-empty AGENTS.override.md wins and AGENTS.md remains byte-identical', () => {
    const agents = '# Ordinary project rules\n';
    const override = '# Deliberate root override\n';
    fs.writeFileSync(path.join(root, 'AGENTS.md'), agents);
    fs.writeFileSync(path.join(root, 'AGENTS.override.md'), override);

    const applied = mergeCodexProjectInstructions(root);

    expect(applied.target).toBe('AGENTS.override.md');
    expect(fs.readFileSync(path.join(root, 'AGENTS.md'), 'utf8')).toBe(agents);
    expect(fs.readFileSync(path.join(root, 'AGENTS.override.md'), 'utf8').endsWith(override)).toBe(true);
  });

  test('a whitespace-only override is skipped, so AGENTS.md remains the active target', () => {
    fs.writeFileSync(path.join(root, 'AGENTS.override.md'), '  \n');
    fs.writeFileSync(path.join(root, 'AGENTS.md'), '# Active instructions\n');

    const applied = mergeCodexProjectInstructions(root);

    expect(applied.target).toBe('AGENTS.md');
    expect(fs.readFileSync(path.join(root, 'AGENTS.override.md'), 'utf8')).toBe('  \n');
  });

  test('an instruction-file symlink is refused without changing its target', () => {
    const target = path.join(root, 'outside.md');
    fs.writeFileSync(target, '# external bytes\n');
    fs.symlinkSync(target, path.join(root, 'AGENTS.md'));

    expect(mergeCodexProjectInstructions(root)).toMatchObject({
      kind: 'refused',
      reason: 'instruction_file_unreadable',
    });
    expect(fs.readFileSync(target, 'utf8')).toBe('# external bytes\n');
  });

  test('a second merge is a byte-identical unchanged result', () => {
    mergeCodexProjectInstructions(root);
    const before = fs.readFileSync(path.join(root, 'AGENTS.md'));

    const second = mergeCodexProjectInstructions(root);

    expect(second.kind).toBe('unchanged');
    expect(fs.readFileSync(path.join(root, 'AGENTS.md')).equals(before)).toBe(true);
  });

  test('a stale valid block is replaced while bytes outside it are preserved', () => {
    const before = '# Before\n\n';
    const after = '\n\n# After with no final newline';
    const stale = CODEX_INSTRUCTION_BLOCK.replace('(managed, v1)', '(managed, v0)');
    fs.writeFileSync(path.join(root, 'AGENTS.md'), `${before}${stale}${after}`);

    const applied = mergeCodexProjectInstructions(root);
    const updated = fs.readFileSync(path.join(root, 'AGENTS.md'), 'utf8');

    expect(applied.kind).toBe('updated');
    expect(updated).toBe(`${before}${CODEX_INSTRUCTION_BLOCK}${after}`);
  });

  test.each([
    ['missing end marker', `${CODEX_INSTRUCTION_BEGIN_MARKER}\n# user bytes\n`],
    ['corrupt lone marker', '<!-- >>> caws codex instructions ??? -->\n# user bytes\n'],
    ['duplicate blocks', `${CODEX_INSTRUCTION_BLOCK}\n\n${CODEX_INSTRUCTION_BLOCK}\n`],
    ['orphan end marker', `${CODEX_INSTRUCTION_END_MARKER}\n# user bytes\n`],
  ])('%s refuses in plan and apply without changing bytes', (_label, malformed) => {
    const target = path.join(root, 'AGENTS.md');
    fs.writeFileSync(target, malformed);

    const planned = planCodexProjectInstructions(root);
    const applied = mergeCodexProjectInstructions(root);

    expect(planned).toMatchObject({ kind: 'refused', readOnly: true });
    expect(applied.kind).toBe('refused');
    expect(fs.readFileSync(target, 'utf8')).toBe(malformed);
  });
});

describe('Codex pack and init integration', () => {
  test('fresh vendor install uses .codex/CAWS.md and never installs .codex/AGENTS.md', () => {
    const root = makeDir();
    try {
      const result = installHookPack(CODEX_PACK, { repoRoot: root });
      expect(result.actions.find((a) => a.destPath === CODEX_REFERENCE_REL).action).toBe('created');
      expect(fs.existsSync(path.join(root, CODEX_REFERENCE_REL))).toBe(true);
      expect(fs.existsSync(path.join(root, '.codex/AGENTS.md'))).toBe(false);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test('JSON plan reports the active root instruction target without writing it', () => {
    const root = makeTempRepo();
    const result = runInit(root, {
      plan: true,
      json: true,
      agentSurface: 'codex',
    });
    const payload = JSON.parse(result.out);

    expect(result.code).toBe(0);
    expect(payload.codex_instructions).toEqual({
      kind: 'created',
      path: path.join(fs.realpathSync(root), 'AGENTS.md'),
      target: 'AGENTS.md',
      readOnly: true,
    });
    expect(fs.existsSync(path.join(root, 'AGENTS.md'))).toBe(false);
  });

  test('malformed root markers make plan and apply visibly refuse with non-zero status', () => {
    const root = makeTempRepo();
    const target = path.join(root, 'AGENTS.md');
    const malformed = `${CODEX_INSTRUCTION_BEGIN_MARKER}\n# preserve me\n`;
    fs.writeFileSync(target, malformed);

    const plan = runInit(root, {
      plan: true,
      json: true,
      agentSurface: 'codex',
    });
    const payload = JSON.parse(plan.out);
    expect(plan.code).toBe(1);
    expect(payload.ok).toBe(false);
    expect(payload.codex_instructions).toMatchObject({
      kind: 'refused',
      reason: 'malformed_managed_block',
    });

    const apply = runInit(root, { agentSurface: 'codex' });
    expect(apply.code).toBe(1);
    expect(apply.out).toContain('REFUSED');
    expect(apply.out).toContain('malformed CAWS instruction markers');
    expect(fs.readFileSync(target, 'utf8')).toBe(malformed);
  });
});
