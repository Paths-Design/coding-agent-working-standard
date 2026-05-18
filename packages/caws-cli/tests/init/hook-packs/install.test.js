/**
 * Tests for INIT-HOOK-PACKS-001 — hook-pack install via `caws init
 * --agent-surface claude-code`.
 *
 * Coverage targets the slice acceptance criteria:
 *   A1  fresh install creates pack files with managed headers
 *   A2  re-run with same pack version is a no-op
 *   A3  re-run with bumped pack version updates managed files
 *   A4  unmanaged collision refuses
 *   A5  managed drift refuses without --adopt or --overwrite
 *   A6  no flag + no detection → skipped_ambiguous, warns
 *   A13 --agent-surface none is explicit and quiet
 *
 * Plus structural checks:
 *   - HookPackV1 manifest is valid against the types
 *   - Pack template directory exists with all manifest files
 *   - Registry resolves claude-code; cursor/windsurf → declared_not_implemented
 *   - Harness detection: single, ambiguous, none
 */

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const { runInitCommand } = require('../../../dist/shell');
const {
  resolveHookPack,
  isKnownSurface,
  IMPLEMENTED_SURFACES,
  KNOWN_SURFACES,
} = require('../../../dist/init/hook-packs/register');
const {
  CLAUDE_CODE_PACK,
} = require('../../../dist/init/hook-packs/manifest-claude-code');
const {
  detectAgentHarness,
} = require('../../../dist/init/harness-detect');
const {
  parseManagedHeader,
  inspectClaudeSettings,
  CANONICAL_SETTINGS_SNIPPET,
} = require('../../../dist/init/hook-install');

function mkBareGitRepo(prefix) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  execFileSync('git', ['init', '--quiet', root]);
  execFileSync('git', ['-C', root, 'config', 'user.email', 'test@test.com']);
  execFileSync('git', ['-C', root, 'config', 'user.name', 'Test']);
  execFileSync('git', [
    '-C', root, 'commit', '--quiet', '--allow-empty', '-m', 'init',
  ]);
  return root;
}

function rmrf(p) {
  if (fs.existsSync(p)) fs.rmSync(p, { recursive: true, force: true });
}

function capture(fn, opts = {}) {
  const out = [];
  const err = [];
  const code = fn({
    ...opts,
    out: (s) => out.push(s),
    err: (s) => err.push(s),
  });
  return { code, stdout: out.join('\n'), stderr: err.join('\n') };
}

// ============================================================
// Registry and surface validation
// ============================================================
describe('hook-pack registry', () => {
  it('claude-code resolves to the canonical pack', () => {
    const r = resolveHookPack('claude-code');
    expect(r.kind).toBe('pack');
    expect(r.pack.id).toBe('claude-code');
    expect(r.pack.targetSurface).toBe('claude-code');
    expect(r.pack.cawsMinMajor).toBe(11);
    expect(r.pack.activation).toBe('restart_required');
  });

  it('cursor and windsurf are declared but not implemented', () => {
    expect(resolveHookPack('cursor').kind).toBe('declared_not_implemented');
    expect(resolveHookPack('windsurf').kind).toBe('declared_not_implemented');
  });

  it('none is resolved as the explicit-skip path', () => {
    expect(resolveHookPack('none').kind).toBe('none');
  });

  it('KNOWN_SURFACES contains exactly the four expected values', () => {
    expect([...KNOWN_SURFACES].sort()).toEqual([
      'claude-code', 'cursor', 'none', 'windsurf',
    ]);
  });

  it('IMPLEMENTED_SURFACES is exactly claude-code in v11.1', () => {
    expect([...IMPLEMENTED_SURFACES]).toEqual(['claude-code']);
  });

  it('isKnownSurface accepts and rejects correctly', () => {
    expect(isKnownSurface('claude-code')).toBe(true);
    expect(isKnownSurface('none')).toBe(true);
    expect(isKnownSurface('zed')).toBe(false);
    expect(isKnownSurface('')).toBe(false);
  });
});

// ============================================================
// Claude Code manifest shape
// ============================================================
describe('Claude Code pack manifest', () => {
  it('lists every required hook file with managed: true', () => {
    const ids = CLAUDE_CODE_PACK.installedFiles.map((f) => f.destPath);
    expect(ids).toContain('.claude/hooks/scope-guard.sh');
    expect(ids).toContain('.claude/hooks/worktree-guard.sh');
    expect(ids).toContain('.claude/hooks/worktree-write-guard.sh');
    expect(ids).toContain('.claude/hooks/block-dangerous.sh');
    expect(ids).toContain('.claude/hooks/classify_command.py');
    expect(ids).toContain('.claude/hooks/CLAUDE.md');
    expect(ids).toContain('.claude/hooks/dispatch/pre_tool_use.sh');
    expect(ids).toContain('.claude/hooks/lib/parse-input.sh');

    for (const f of CLAUDE_CODE_PACK.installedFiles) {
      expect(f.managed).toBe(true);
    }
  });

  it('cites the failure-lineage entries the pack covers', () => {
    // Lineage entries 1, 4, 6, 8, 11, 12, 13, 16, 17 — at minimum.
    const refs = new Set(CLAUDE_CODE_PACK.lineageRefs);
    [1, 4, 6, 8, 11, 12, 16, 17].forEach((n) => {
      expect(refs.has(n)).toBe(true);
    });
  });

  it('every sourcePath in the manifest exists in the pack template dir', () => {
    // Resolve the pack template root relative to the dist build.
    const packRoot = path.resolve(
      __dirname, '..', '..', '..', 'templates', 'hook-packs', 'claude-code'
    );
    for (const f of CLAUDE_CODE_PACK.installedFiles) {
      const src = path.join(packRoot, f.sourcePath);
      expect(fs.existsSync(src)).toBe(true);
    }
  });
});

// ============================================================
// Managed header parser
// ============================================================
describe('parseManagedHeader', () => {
  it('parses a v11 Claude Code header', () => {
    const content = `#!/bin/bash
# CAWS-MANAGED-HOOK
# hook_pack: claude-code
# hook_pack_version: 1
# caws_min_major: 11
# lineage_refs: 1,17
# do_not_edit_directly: ...
`;
    const h = parseManagedHeader(content);
    expect(h).not.toBeNull();
    expect(h.hookPack).toBe('claude-code');
    expect(h.hookPackVersion).toBe(1);
    expect(h.cawsMinMajor).toBe(11);
    expect(h.lineageRefs).toEqual([1, 17]);
  });

  it('returns null for files with no header', () => {
    expect(parseManagedHeader('#!/bin/bash\necho hi\n')).toBeNull();
    expect(parseManagedHeader('plain text\n')).toBeNull();
  });

  it('returns null when marker present but required fields are missing', () => {
    const content = `# CAWS-MANAGED-HOOK\n# hook_pack: claude-code\n`;
    // Missing hook_pack_version → invalid header.
    expect(parseManagedHeader(content)).toBeNull();
  });
});

// ============================================================
// Harness detection
// ============================================================
describe('detectAgentHarness', () => {
  let repo;
  afterEach(() => rmrf(repo));

  it('returns none for a fresh repo', () => {
    repo = mkBareGitRepo('caws-harness-none-');
    expect(detectAgentHarness(repo).kind).toBe('none');
  });

  it('returns single:claude-code when .claude/ exists', () => {
    repo = mkBareGitRepo('caws-harness-claude-');
    fs.mkdirSync(path.join(repo, '.claude'));
    const r = detectAgentHarness(repo);
    expect(r.kind).toBe('single');
    expect(r.surface).toBe('claude-code');
  });

  it('returns ambiguous when multiple harness dirs exist', () => {
    repo = mkBareGitRepo('caws-harness-ambig-');
    fs.mkdirSync(path.join(repo, '.claude'));
    fs.mkdirSync(path.join(repo, '.cursor'));
    const r = detectAgentHarness(repo);
    expect(r.kind).toBe('ambiguous');
    expect(r.candidates).toContain('claude-code');
    expect(r.candidates).toContain('cursor');
  });
});

// ============================================================
// A1: fresh install creates pack files with managed headers
// ============================================================
describe('A1: fresh install', () => {
  let repo;
  afterEach(() => rmrf(repo));

  it('creates every manifest file with a managed header', () => {
    repo = mkBareGitRepo('caws-pack-fresh-');
    const r = capture(runInitCommand, {
      cwd: repo,
      agentSurface: 'claude-code',
    });
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/Created \(\d+\)/);
    expect(r.stdout).toMatch(/RESTART REQUIRED/);

    for (const f of CLAUDE_CODE_PACK.installedFiles) {
      const abs = path.join(repo, f.destPath);
      expect(fs.existsSync(abs)).toBe(true);
      const content = fs.readFileSync(abs, 'utf8');
      const header = parseManagedHeader(content);
      expect(header).not.toBeNull();
      expect(header.hookPack).toBe('claude-code');
      expect(header.hookPackVersion).toBe(CLAUDE_CODE_PACK.packVersion);
    }
  });

  it('settings.json wiring step reports absent and prints canonical snippet', () => {
    repo = mkBareGitRepo('caws-pack-wiring-');
    const r = capture(runInitCommand, {
      cwd: repo,
      agentSurface: 'claude-code',
    });
    expect(r.stdout).toMatch(/No \.claude\/settings\.json present/);
    // The full snippet appears verbatim, indented.
    expect(r.stdout).toContain('"PreToolUse"');
    expect(r.stdout).toContain('"PostToolUse"');
    expect(r.stdout).toContain('"SessionStart"');
    expect(r.stdout).toContain('"Stop"');
  });
});

// ============================================================
// A2: re-run with same pack version is a no-op
// ============================================================
describe('A2: idempotent re-install', () => {
  let repo;
  afterEach(() => rmrf(repo));

  it('second run reports all files Unchanged and produces no diff', () => {
    repo = mkBareGitRepo('caws-pack-idem-');
    capture(runInitCommand, { cwd: repo, agentSurface: 'claude-code' });

    // Capture mtimes BEFORE the second run.
    const before = {};
    for (const f of CLAUDE_CODE_PACK.installedFiles) {
      before[f.destPath] = fs.statSync(path.join(repo, f.destPath)).mtimeMs;
    }

    const r2 = capture(runInitCommand, {
      cwd: repo,
      agentSurface: 'claude-code',
    });
    expect(r2.code).toBe(0);
    expect(r2.stdout).toMatch(/Unchanged \(\d+\)/);
    expect(r2.stdout).not.toMatch(/Created \(/);
    expect(r2.stdout).not.toMatch(/Updated \(/);

    // mtimes should be unchanged since no rewrite happened.
    for (const f of CLAUDE_CODE_PACK.installedFiles) {
      const after = fs.statSync(path.join(repo, f.destPath)).mtimeMs;
      expect(after).toBe(before[f.destPath]);
    }
  });
});

// ============================================================
// A4: unmanaged collision refuses
// ============================================================
describe('A4: unmanaged collision', () => {
  let repo;
  afterEach(() => rmrf(repo));

  it('refuses to overwrite a user-authored file with no managed marker', () => {
    repo = mkBareGitRepo('caws-pack-collide-');
    const target = path.join(repo, '.claude/hooks/scope-guard.sh');
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, '#!/bin/bash\n# user content, no marker\n');
    const before = fs.readFileSync(target, 'utf8');

    const r = capture(runInitCommand, {
      cwd: repo,
      agentSurface: 'claude-code',
    });
    expect(r.code).toBe(1);
    expect(r.stdout).toMatch(/Refused \(\d+\)/);
    expect(r.stdout).toMatch(/scope-guard\.sh.*unmanaged_collision/);

    // File content is preserved untouched.
    expect(fs.readFileSync(target, 'utf8')).toBe(before);
  });

  it('--overwrite resolves the collision and installs the pack version', () => {
    repo = mkBareGitRepo('caws-pack-collide-overwrite-');
    const target = path.join(repo, '.claude/hooks/scope-guard.sh');
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, '#!/bin/bash\n# user content\n');

    const r = capture(runInitCommand, {
      cwd: repo,
      agentSurface: 'claude-code',
      overwrite: true,
    });
    expect(r.code).toBe(0);

    // Now has the managed marker.
    const header = parseManagedHeader(fs.readFileSync(target, 'utf8'));
    expect(header).not.toBeNull();
    expect(header.hookPack).toBe('claude-code');
  });

  it('--adopt leaves the file in place and exits clean', () => {
    repo = mkBareGitRepo('caws-pack-collide-adopt-');
    const target = path.join(repo, '.claude/hooks/scope-guard.sh');
    fs.mkdirSync(path.dirname(target), { recursive: true });
    const userContent = '#!/bin/bash\n# adopted, no marker\n';
    fs.writeFileSync(target, userContent);

    const r = capture(runInitCommand, {
      cwd: repo,
      agentSurface: 'claude-code',
      adopt: true,
    });
    expect(r.code).toBe(0);

    // Untouched — adopt does not install over the file.
    expect(fs.readFileSync(target, 'utf8')).toBe(userContent);
  });
});

// ============================================================
// A5: managed drift refuses without --adopt or --overwrite
// ============================================================
describe('A5: managed drift', () => {
  let repo;
  afterEach(() => rmrf(repo));

  it('a managed file with local edits refuses without explicit policy', () => {
    repo = mkBareGitRepo('caws-pack-drift-');
    // First, install cleanly.
    capture(runInitCommand, { cwd: repo, agentSurface: 'claude-code' });
    const target = path.join(repo, '.claude/hooks/scope-guard.sh');
    const original = fs.readFileSync(target, 'utf8');
    // Drift it by appending content (marker still present in the header).
    fs.appendFileSync(target, '\n# LOCAL EDIT\n');

    const r = capture(runInitCommand, {
      cwd: repo,
      agentSurface: 'claude-code',
    });
    expect(r.code).toBe(1);
    expect(r.stdout).toMatch(/Refused \(\d+\)/);
    expect(r.stdout).toMatch(/scope-guard\.sh.*managed_drift/);

    // File still has the local edit (drift preserved on refusal).
    expect(fs.readFileSync(target, 'utf8')).toMatch(/LOCAL EDIT/);

    // --overwrite reverts to canonical pack content.
    const r2 = capture(runInitCommand, {
      cwd: repo,
      agentSurface: 'claude-code',
      overwrite: true,
    });
    expect(r2.code).toBe(0);
    expect(fs.readFileSync(target, 'utf8')).toBe(original);
  });
});

// ============================================================
// A6 + A13: --agent-surface none + ambiguous skip
// ============================================================
describe('A6 / A13: explicit none and ambiguous skip', () => {
  let repo;
  afterEach(() => rmrf(repo));

  it('--agent-surface none installs canonical state but no hooks', () => {
    repo = mkBareGitRepo('caws-pack-none-');
    const r = capture(runInitCommand, {
      cwd: repo,
      agentSurface: 'none',
    });
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/Skipped — --agent-surface none/);
    expect(r.stdout).toMatch(/NOT agent-safe/);
    // No .claude/ created.
    expect(fs.existsSync(path.join(repo, '.claude'))).toBe(false);
  });

  it('no flag + no detection emits skipped_ambiguous + warning', () => {
    repo = mkBareGitRepo('caws-pack-detect-none-');
    const r = capture(runInitCommand, { cwd: repo });
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/no harness detected/);
    expect(r.stdout).toMatch(/--agent-surface claude-code/);
    expect(fs.existsSync(path.join(repo, '.claude'))).toBe(false);
  });

  it('no flag + claude-code detection auto-selects the pack', () => {
    repo = mkBareGitRepo('caws-pack-detect-claude-');
    fs.mkdirSync(path.join(repo, '.claude'));
    const r = capture(runInitCommand, { cwd: repo });
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(
      new RegExp(
        `Step: hook-pack install \\(claude-code v${CLAUDE_CODE_PACK.packVersion}\\)`
      )
    );
    expect(fs.existsSync(
      path.join(repo, '.claude/hooks/scope-guard.sh')
    )).toBe(true);
  });
});

// ============================================================
// Settings.json wiring inspection
// ============================================================
describe('inspectClaudeSettings', () => {
  let repo;
  afterEach(() => rmrf(repo));

  it('reports absent when .claude/settings.json does not exist', () => {
    repo = mkBareGitRepo('caws-wiring-absent-');
    expect(inspectClaudeSettings(repo).kind).toBe('absent');
  });

  it('reports wired when all four dispatch entries are present', () => {
    repo = mkBareGitRepo('caws-wiring-good-');
    fs.mkdirSync(path.join(repo, '.claude'), { recursive: true });
    fs.writeFileSync(
      path.join(repo, '.claude/settings.json'),
      CANONICAL_SETTINGS_SNIPPET
    );
    expect(inspectClaudeSettings(repo).kind).toBe('wired');
  });

  it('reports partial when one dispatch entry is missing', () => {
    repo = mkBareGitRepo('caws-wiring-partial-');
    fs.mkdirSync(path.join(repo, '.claude'), { recursive: true });
    const minus = JSON.parse(CANONICAL_SETTINGS_SNIPPET);
    delete minus.hooks.Stop;
    fs.writeFileSync(
      path.join(repo, '.claude/settings.json'),
      JSON.stringify(minus)
    );
    const r = inspectClaudeSettings(repo);
    expect(r.kind).toBe('partial');
    expect(r.missing).toContain('Stop');
  });

  it('reports invalid for unparseable settings.json', () => {
    repo = mkBareGitRepo('caws-wiring-invalid-');
    fs.mkdirSync(path.join(repo, '.claude'), { recursive: true });
    fs.writeFileSync(
      path.join(repo, '.claude/settings.json'),
      '{not valid json'
    );
    const r = inspectClaudeSettings(repo);
    expect(r.kind).toBe('invalid');
    expect(r.error).toBeTruthy();
  });

  it('preserves user settings.json — install does not modify it', () => {
    repo = mkBareGitRepo('caws-wiring-preserve-');
    fs.mkdirSync(path.join(repo, '.claude'), { recursive: true });
    const userSettings = {
      env: { CUSTOM: 'foo' },
      permissions: { allow: ['Read'] },
      hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [] }] },
    };
    const settingsPath = path.join(repo, '.claude/settings.json');
    fs.writeFileSync(settingsPath, JSON.stringify(userSettings, null, 2));
    const before = fs.readFileSync(settingsPath, 'utf8');

    const r = capture(runInitCommand, {
      cwd: repo,
      agentSurface: 'claude-code',
    });
    expect(r.code).toBe(0);

    // settings.json byte-identical after install.
    expect(fs.readFileSync(settingsPath, 'utf8')).toBe(before);
    // Output told the user what to add.
    expect(r.stdout).toMatch(/missing one or more canonical/);
    expect(r.stdout).toContain('"PostToolUse"');
  });
});

// ============================================================
// Unimplemented surfaces are rejected with a clear message
// ============================================================
describe('unimplemented surfaces', () => {
  let repo;
  afterEach(() => rmrf(repo));

  it('cursor surface returns exit 1 with declared-not-implemented diagnostic', () => {
    repo = mkBareGitRepo('caws-pack-cursor-');
    const r = capture(runInitCommand, {
      cwd: repo,
      agentSurface: 'cursor',
    });
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/declared but not yet implemented/);
  });

  it('unknown surface returns exit 2', () => {
    repo = mkBareGitRepo('caws-pack-unknown-');
    const r = capture(runInitCommand, {
      cwd: repo,
      agentSurface: 'zed',
    });
    expect(r.code).toBe(2);
    expect(r.stderr).toMatch(/unknown --agent-surface/);
  });
});
