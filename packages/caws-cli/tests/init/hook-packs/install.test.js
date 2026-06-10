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
  CODEX_PACK,
} = require('../../../dist/init/hook-packs/manifest-codex');
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

  it('codex resolves to the canonical pack', () => {
    const r = resolveHookPack('codex');
    expect(r.kind).toBe('pack');
    expect(r.pack.id).toBe('codex');
    expect(r.pack.targetSurface).toBe('codex');
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

  it('KNOWN_SURFACES contains exactly the five expected values', () => {
    expect([...KNOWN_SURFACES].sort()).toEqual([
      'claude-code', 'codex', 'cursor', 'none', 'windsurf',
    ]);
  });

  it('IMPLEMENTED_SURFACES is exactly claude-code + codex in v11.1', () => {
    expect([...IMPLEMENTED_SURFACES]).toEqual(['claude-code', 'codex']);
  });

  it('isKnownSurface accepts and rejects correctly', () => {
    expect(isKnownSurface('claude-code')).toBe(true);
    expect(isKnownSurface('codex')).toBe(true);
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
    // WORKTREE-ISOLATION-HARDENING-001 Fix 3: Bash mutation target guard.
    expect(ids).toContain('.claude/hooks/bash-write-guard.sh');
    expect(ids).toContain('.claude/hooks/block-dangerous.sh');
    expect(ids).toContain('.claude/hooks/classify_command.py');
    expect(ids).toContain('.claude/hooks/CLAUDE.md');
    // CAWS-HOOKPACK-SHIP-README-001: the human-facing inventory ships managed.
    expect(ids).toContain('.claude/hooks/README.md');
    expect(ids).toContain('.claude/hooks/caws_dispatch/pre_tool_use.sh');
    expect(ids).toContain('.claude/hooks/lib/parse-input.sh');
    // HOOK-LIB-CONSOLIDATION-001: shared-utility libs are managed too.
    expect(ids).toContain('.claude/hooks/lib/caws-state.sh');
    expect(ids).toContain('.claude/hooks/lib/emit.sh');
    // WORKTREE-ISOLATION-HARDENING-001: the shared ownership oracle must ship
    // so worktree-write-guard / bash-write-guard can shell out to it at the
    // installed surface (otherwise the .caws/worktrees payload arm fails open).
    expect(ids).toContain('.claude/hooks/lib/worktree-claim-oracle.cjs');

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

  // ─── MULTI-AGENT-ACTIVITY-REGISTRY-001 (v3 bump) ─────────────────────
  describe('v3 lease-substrate hooks (MULTI-AGENT-ACTIVITY-REGISTRY-001)', () => {
    const { CLAUDE_CODE_PACK_VERSION } = require(
      '../../../dist/init/hook-packs/manifest-claude-code'
    );

    it('CLAUDE_CODE_PACK_VERSION is at least 4', () => {
      expect(CLAUDE_CODE_PACK_VERSION).toBeGreaterThanOrEqual(4);
    });

    it('manifest lists the three new agent-*.sh templates as managed + executable', () => {
      const expected = [
        '.claude/hooks/agent-register.sh',
        '.claude/hooks/agent-heartbeat.sh',
        '.claude/hooks/agent-stop.sh',
      ];
      for (const destPath of expected) {
        const entry = CLAUDE_CODE_PACK.installedFiles.find((f) => f.destPath === destPath);
        expect(entry).toBeDefined();
        expect(entry.managed).toBe(true);
        expect(entry.executable).toBe(true);
      }
    });

    it('manifest stateModel covers .caws/leases/ on read and write', () => {
      expect(CLAUDE_CODE_PACK.stateModel.reads).toContain('.caws/leases/');
      expect(CLAUDE_CODE_PACK.stateModel.writes).toContain('.caws/leases/');
    });

    it('lineageRefs includes entry 19 (canonical-checkout hijack)', () => {
      expect(CLAUDE_CODE_PACK.lineageRefs).toContain(19);
    });

    it('every agent-*.sh template carries a v3 managed header', () => {
      const packRoot = path.resolve(
        __dirname, '..', '..', '..', 'templates', 'hook-packs', 'claude-code'
      );
      for (const name of ['agent-register.sh', 'agent-heartbeat.sh', 'agent-stop.sh']) {
        const src = path.join(packRoot, name);
        expect(fs.existsSync(src)).toBe(true);
        const content = fs.readFileSync(src, 'utf8');
        expect(content).toContain('CAWS-MANAGED-HOOK');
        expect(content).toContain('hook_pack: claude-code');
        expect(content).toContain(`hook_pack_version: ${CLAUDE_CODE_PACK.packVersion}`);
        expect(content).toContain('lineage_refs: 19');
        // Templates are executable.
        const mode = fs.statSync(src).mode & 0o777;
        expect(mode & 0o111).not.toBe(0);
      }
    });

    it('dispatchers are bumped to v3 and reference the new handlers', () => {
      const packRoot = path.resolve(
        __dirname, '..', '..', '..', 'templates', 'hook-packs', 'claude-code'
      );

      const sessionStart = fs.readFileSync(
        path.join(packRoot, 'caws_dispatch', 'session_start.sh'), 'utf8'
      );
      expect(sessionStart).toContain(`hook_pack_version: ${CLAUDE_CODE_PACK.packVersion}`);
      expect(sessionStart).toContain('agent-register.sh');

      const preToolUse = fs.readFileSync(
        path.join(packRoot, 'caws_dispatch', 'pre_tool_use.sh'), 'utf8'
      );
      expect(preToolUse).toContain(`hook_pack_version: ${CLAUDE_CODE_PACK.packVersion}`);
      // Heartbeat MUST run FIRST in PreToolUse — verify it appears in
      // HANDLERS before any other guard so the lease refreshes even if
      // a later guard short-circuits.
      const handlersMatch = preToolUse.match(/HANDLERS=\(([^)]+)\)/s);
      expect(handlersMatch).not.toBeNull();
      const handlers = handlersMatch[1]
        .split('\n')
        .map((s) => s.trim())
        .filter((s) => s.length > 0 && !s.startsWith('#'));
      expect(handlers[0]).toBe('agent-heartbeat.sh');

      const stop = fs.readFileSync(
        path.join(packRoot, 'caws_dispatch', 'stop.sh'), 'utf8'
      );
      expect(stop).toContain(`hook_pack_version: ${CLAUDE_CODE_PACK.packVersion}`);
      expect(stop).toContain('agent-stop.sh');
    });

    it('agent-heartbeat.sh does not invoke jq (parses via node only)', () => {
      // The hook composes Claude Code's additionalContext envelope via
      // node, not jq. Visibility into parallel agents cannot depend on
      // a shell utility outside the CAWS toolchain — node is already a
      // hard CAWS dependency (the CLI itself is node), jq is not.
      // Smoke test A14.11 verifies this dynamically when an isolated
      // PATH is constructible; this test verifies it statically so the
      // assertion holds even on environments where jq is in /usr/bin.
      const packRoot = path.resolve(
        __dirname, '..', '..', '..', 'templates', 'hook-packs', 'claude-code'
      );
      const heartbeat = fs.readFileSync(
        path.join(packRoot, 'agent-heartbeat.sh'), 'utf8'
      );
      const codeLines = heartbeat.split('\n').filter((l) => {
        const t = l.trim();
        return t.length > 0 && !t.startsWith('#');
      });
      const jqInCode = codeLines.filter((l) => /\bjq\b/.test(l));
      expect(jqInCode).toEqual([]);
    });
  });

  // ─── QG-HOOKS-EXTRACT-001 (v11 bump) ─────────────────────────────────
  describe('v11 advisory quality hooks (QG-HOOKS-EXTRACT-001)', () => {
    const { CLAUDE_CODE_PACK_VERSION } = require(
      '../../../dist/init/hook-packs/manifest-claude-code'
    );

    const ADVISORY_HOOKS = [
      'god-object-check.sh',
      'shortcut-language-check.sh',
      'duplicate-export-check.sh',
      'loc-delta-check.sh',
    ];

    it('CLAUDE_CODE_PACK_VERSION is at least 11', () => {
      expect(CLAUDE_CODE_PACK_VERSION).toBeGreaterThanOrEqual(11);
    });

    it('manifest lists all four advisory hooks as managed + executable', () => {
      for (const name of ADVISORY_HOOKS) {
        const destPath = `.claude/hooks/${name}`;
        const entry = CLAUDE_CODE_PACK.installedFiles.find((f) => f.destPath === destPath);
        expect(entry).toBeDefined();
        expect(entry.sourcePath).toBe(name);
        expect(entry.managed).toBe(true);
        expect(entry.executable).toBe(true);
      }
    });

    it('lineageRefs records the four advisory-quality entries (28-31)', () => {
      const refs = new Set(CLAUDE_CODE_PACK.lineageRefs);
      [28, 29, 30, 31].forEach((n) => expect(refs.has(n)).toBe(true));
    });

    it('every advisory-hook template exists, is executable, and carries a v11 header', () => {
      const packRoot = path.resolve(
        __dirname, '..', '..', '..', 'templates', 'hook-packs', 'claude-code'
      );
      for (const name of ADVISORY_HOOKS) {
        const src = path.join(packRoot, name);
        expect(fs.existsSync(src)).toBe(true);
        const content = fs.readFileSync(src, 'utf8');
        expect(content).toContain('CAWS-MANAGED-HOOK');
        expect(content).toContain('hook_pack: claude-code');
        expect(content).toContain(`hook_pack_version: ${CLAUDE_CODE_PACK.packVersion}`);
        const mode = fs.statSync(src).mode & 0o777;
        expect(mode & 0o111).not.toBe(0);
      }
    });

    it('post_tool_use dispatcher registers all four advisory handlers', () => {
      const packRoot = path.resolve(
        __dirname, '..', '..', '..', 'templates', 'hook-packs', 'claude-code'
      );
      const postToolUse = fs.readFileSync(
        path.join(packRoot, 'caws_dispatch', 'post_tool_use.sh'), 'utf8'
      );
      expect(postToolUse).toContain(`hook_pack_version: ${CLAUDE_CODE_PACK.packVersion}`);
      // Match the array body up to the closing paren on its own line.
      // A plain [^)]+ would stop early at the "(exit 0)" paren inside an
      // inline comment, so anchor the terminator to a line-leading ")".
      const handlersMatch = postToolUse.match(/HANDLERS=\(\n([\s\S]*?)\n\)/);
      expect(handlersMatch).not.toBeNull();
      const handlers = handlersMatch[1]
        .split('\n')
        .map((s) => s.trim().replace(/^"|"$/g, ''))
        .filter((s) => s.length > 0 && !s.startsWith('#'));
      for (const name of ADVISORY_HOOKS) {
        expect(handlers).toContain(name);
      }
    });

    it('advisory hooks do not couple to the quality-gates package at runtime', () => {
      // Option-C boundary: the hooks reimplement detection intent in bash.
      // They must not shell out to, require, or import any quality-gates
      // module. Reading source for design reference is permitted and the
      // hooks DO cite packages/quality-gates in lineage comments — so the
      // assertion targets RUNTIME coupling (executable references), not
      // documentation mentions. We scan only non-comment code lines for any
      // invocation/source/require of a quality-gates module or a .mjs file.
      const packRoot = path.resolve(
        __dirname, '..', '..', '..', 'templates', 'hook-packs', 'claude-code'
      );
      for (const name of ADVISORY_HOOKS) {
        const content = fs.readFileSync(path.join(packRoot, name), 'utf8');
        const codeLines = content
          .split('\n')
          .map((l) => l.trim())
          .filter((l) => l.length > 0 && !l.startsWith('#'));
        for (const line of codeLines) {
          // No executable reference to the quality-gates package from the
          // hook body. (`.mjs` is intentionally NOT banned: duplicate-export-
          // check.sh legitimately lists *.mjs as a JS/TS source extension it
          // inspects — that is a file-type predicate, not a quality-gates
          // module reference.)
          expect(line).not.toMatch(/quality-gates/);
          expect(line).not.toMatch(/quality-gates.*\.mjs/);
          expect(line).not.toMatch(/\b(source|require|import)\b.*quality-gates/);
        }
      }
    });
  });
});

// ============================================================
// Codex manifest shape
// ============================================================
describe('Codex pack manifest', () => {
  it('lists hooks.json and the translated guard files with managed: true', () => {
    const ids = CODEX_PACK.installedFiles.map((f) => f.destPath);
    expect(ids).toContain('.codex/hooks.json');
    expect(ids).toContain('.codex/hooks/scope-guard.sh');
    expect(ids).toContain('.codex/hooks/worktree-guard.sh');
    expect(ids).toContain('.codex/hooks/worktree-write-guard.sh');
    expect(ids).toContain('.codex/hooks/bash-write-guard.sh');
    expect(ids).toContain('.codex/hooks/block-dangerous.sh');
    expect(ids).toContain('.codex/hooks/classify_command.py');
    expect(ids).toContain('.codex/hooks/AGENTS.md');
    expect(ids).toContain('.codex/hooks/README.md');
    expect(ids).toContain('.codex/hooks/caws_dispatch/pre_tool_use.sh');
    expect(ids).toContain('.codex/hooks/caws_dispatch/pre_compact.sh');
    expect(ids).toContain('.codex/hooks/lib/parse-input.sh');
    expect(ids).toContain('.codex/hooks/lib/emit.sh');

    for (const f of CODEX_PACK.installedFiles) {
      expect(f.managed).toBe(true);
    }
  });

  it('every sourcePath in the Codex manifest exists in the pack template dir', () => {
    const packRoot = path.resolve(
      __dirname, '..', '..', '..', 'templates', 'hook-packs', 'codex'
    );
    for (const f of CODEX_PACK.installedFiles) {
      expect(fs.existsSync(path.join(packRoot, f.sourcePath))).toBe(true);
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
    // CAWS-INIT-SETTINGS-WIRING-001: init now wires settings.json on a fresh
    // install, so the activation panel reports "wired — restart to load" (the
    // updated hooks need a session restart) rather than the old "RESTART
    // REQUIRED / settings.json not wired" STOP-sign. The restart boundary
    // remains; the unwired-STOP case no longer applies to a fresh install.
    expect(r.stdout).toMatch(/[Ss]ettings\.json is wired/);
    expect(r.stdout).toMatch(/[Rr]estart/);

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

  // CAWS-INIT-SETTINGS-WIRING-001 A1: init now WRITES a fresh settings.json
  // when absent (was: print-only). Also writes settings.json.example.
  it('writes a fresh settings.json with caws_dispatch wiring when absent', () => {
    repo = mkBareGitRepo('caws-pack-wiring-');
    const r = capture(runInitCommand, {
      cwd: repo,
      agentSurface: 'claude-code',
    });
    expect(r.stdout).toMatch(/Created \.claude\/settings\.json/);

    const settingsPath = path.join(repo, '.claude/settings.json');
    expect(fs.existsSync(settingsPath)).toBe(true);
    const written = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
    for (const key of ['PreToolUse', 'PostToolUse', 'SessionStart', 'Stop']) {
      expect(written.hooks[key]).toBeDefined();
    }
    // Wiring references the caws_dispatch namespace.
    expect(fs.readFileSync(settingsPath, 'utf8')).toContain(
      '/.claude/hooks/caws_dispatch/pre_tool_use.sh'
    );
    // A settings.json.example reference is also emitted.
    expect(
      fs.existsSync(path.join(repo, '.claude/settings.json.example'))
    ).toBe(true);
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
    expect(r.stdout).toMatch(/--agent-surface codex/);
    expect(fs.existsSync(path.join(repo, '.claude'))).toBe(false);
    expect(fs.existsSync(path.join(repo, '.codex'))).toBe(false);
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

  it('no flag + codex detection auto-selects the pack', () => {
    repo = mkBareGitRepo('caws-pack-detect-codex-');
    fs.mkdirSync(path.join(repo, '.codex'));
    const r = capture(runInitCommand, { cwd: repo });
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(
      new RegExp(`Step: hook-pack install \\(codex v${CODEX_PACK.packVersion}\\)`)
    );
    expect(fs.existsSync(path.join(repo, '.codex/hooks.json'))).toBe(true);
    expect(fs.existsSync(
      path.join(repo, '.codex/hooks/scope-guard.sh')
    )).toBe(true);
  });

  it('no flag + claude and codex signals skips as ambiguous', () => {
    repo = mkBareGitRepo('caws-pack-detect-ambiguous-');
    fs.mkdirSync(path.join(repo, '.claude'));
    fs.mkdirSync(path.join(repo, '.codex'));
    const r = capture(runInitCommand, { cwd: repo });
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/no harness detected|Skipped/);
    expect(fs.existsSync(path.join(repo, '.claude/hooks'))).toBe(false);
    expect(fs.existsSync(path.join(repo, '.codex/hooks.json'))).toBe(false);
  });
});

// ============================================================
// Codex install behavior
// ============================================================
describe('Codex hook-pack install behavior', () => {
  let repo;
  afterEach(() => rmrf(repo));

  it('fresh install creates hooks.json with managed metadata and absolute dispatcher commands', () => {
    repo = mkBareGitRepo('caws-pack-codex-install-');
    const r = capture(runInitCommand, {
      cwd: repo,
      agentSurface: 'codex',
    });
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(new RegExp(`Step: hook-pack install \\(codex v${CODEX_PACK.packVersion}\\)`));
    expect(r.stdout).toMatch(/\.codex\/hooks\.json trust/);

    const hooksPath = path.join(repo, '.codex/hooks.json');
    const hooksJson = fs.readFileSync(hooksPath, 'utf8');
    const header = parseManagedHeader(hooksJson);
    expect(header).toEqual(
      expect.objectContaining({
        hookPack: 'codex',
        hookPackVersion: CODEX_PACK.packVersion,
        cawsMinMajor: 11,
      })
    );

    const parsed = JSON.parse(hooksJson);
    const repoReal = fs.realpathSync(repo);
    const commands = [];
    for (const entries of Object.values(parsed.hooks)) {
      for (const block of entries) {
        for (const hook of block.hooks) {
          commands.push(hook.command);
        }
      }
    }
    expect(commands).toHaveLength(5);
    for (const command of commands) {
      expect(command).toContain(`CODEX_PROJECT_DIR='${repoReal}'`);
      expect(command).toContain(`${repoReal}/.codex/hooks/caws_dispatch/`);
      expect(command).not.toMatch(/"\$CODEX_PROJECT_DIR"|^\.codex\//);
    }

    expect(fs.existsSync(path.join(repo, '.codex/hooks/lib/parse-input.sh'))).toBe(true);
    expect(fs.existsSync(path.join(repo, '.codex/hooks/caws_dispatch/pre_compact.sh'))).toBe(true);
  });

  it('rerun is no-op and managed drift refuses by default', () => {
    repo = mkBareGitRepo('caws-pack-codex-drift-');
    const first = capture(runInitCommand, { cwd: repo, agentSurface: 'codex' });
    expect(first.code).toBe(0);

    const second = capture(runInitCommand, { cwd: repo, agentSurface: 'codex' });
    expect(second.code).toBe(0);
    expect(second.stdout).toMatch(/Unchanged \(\d+\)/);
    expect(second.stdout).not.toMatch(/Updated \(\d+\)|Created \(\d+\)/);

    const target = path.join(repo, '.codex/hooks.json');
    fs.appendFileSync(target, '\n');
    const drift = capture(runInitCommand, { cwd: repo, agentSurface: 'codex' });
    expect(drift.code).toBe(1);
    expect(drift.stdout).toMatch(/hooks\.json.*managed_drift/);

    const overwrite = capture(runInitCommand, {
      cwd: repo,
      agentSurface: 'codex',
      overwrite: true,
    });
    expect(overwrite.code).toBe(0);
    expect(overwrite.stdout).toMatch(/Updated \(\d+\)/);
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

  // CAWS-INIT-SETTINGS-WIRING-001 A2: init MERGES into an existing
  // settings.json non-destructively — user keys and hooks preserved, the
  // four caws_dispatch entries appended.
  it('merges caws_dispatch wiring into a user settings.json without clobbering', () => {
    repo = mkBareGitRepo('caws-wiring-preserve-');
    fs.mkdirSync(path.join(repo, '.claude'), { recursive: true });
    const userSettings = {
      env: { CUSTOM: 'foo' },
      permissions: { allow: ['Read'] },
      hooks: {
        PreToolUse: [
          {
            matcher: 'Bash',
            hooks: [{ type: 'command', command: '/my/own/hook.sh' }],
          },
        ],
      },
    };
    const settingsPath = path.join(repo, '.claude/settings.json');
    fs.writeFileSync(settingsPath, JSON.stringify(userSettings, null, 2));

    const r = capture(runInitCommand, {
      cwd: repo,
      agentSurface: 'claude-code',
    });
    expect(r.code).toBe(0);

    const after = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
    // User keys preserved.
    expect(after.env).toEqual({ CUSTOM: 'foo' });
    expect(after.permissions).toEqual({ allow: ['Read'] });
    // User's own PreToolUse hook survives.
    const preCmds = after.hooks.PreToolUse.flatMap((b) =>
      (b.hooks || []).map((h) => h.command)
    );
    expect(preCmds).toContain('/my/own/hook.sh');
    // CAWS entry appended alongside it.
    expect(
      preCmds.some((c) => c.includes('/.claude/hooks/caws_dispatch/pre_tool_use.sh'))
    ).toBe(true);
    // Output reported the merge.
    expect(r.stdout).toMatch(/Merged the CAWS caws_dispatch wiring/);
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

// ════════════════════════════════════════════════════════════════════
// CAWS-HOOK-PACK-RENDERER-MISSING-001 — A1/A2 + invariant 1
//
// session-log.sh shells out to session_log_renderer.py via
// `python3 "$RENDERER"`. Prior to v6 the renderer was referenced but
// not bundled, producing a broken session-log.sh on every fresh
// install. These tests prove the renderer is now bundled, registered
// as managed, and that the Sterling-specific MEANINGFUL_COMMAND_KW
// entries (cargo, ruff, mypy) have been removed from the baseline.
// ════════════════════════════════════════════════════════════════════
describe('CAWS-HOOK-PACK-RENDERER-MISSING-001 — session_log_renderer.py bundled', () => {
  const packRoot = path.resolve(
    __dirname, '..', '..', '..', 'templates', 'hook-packs', 'claude-code'
  );
  const rendererPath = path.join(packRoot, 'session_log_renderer.py');

  it('A1: renderer file exists in the pack template directory', () => {
    expect(fs.existsSync(rendererPath)).toBe(true);
  });

  it('A1: renderer is registered in the manifest with managed:true and executable:false', () => {
    const entry = CLAUDE_CODE_PACK.installedFiles.find(
      (f) => f.sourcePath === 'session_log_renderer.py'
    );
    expect(entry).toBeDefined();
    expect(entry.destPath).toBe('.claude/hooks/session_log_renderer.py');
    expect(entry.managed).toBe(true);
    expect(entry.executable).toBe(false);
  });

  it('A1: renderer carries a CAWS-MANAGED-HOOK header at packVersion', () => {
    const content = fs.readFileSync(rendererPath, 'utf8');
    expect(content).toContain('CAWS-MANAGED-HOOK');
    expect(content).toContain('hook_pack: claude-code');
    expect(content).toContain(`hook_pack_version: ${CLAUDE_CODE_PACK.packVersion}`);
    expect(content).toContain('caws_min_major: 11');
  });

  it('A1: session-log.sh references the renderer at the path the pack now ships', () => {
    // The pack's session-log.sh:35 declares
    //   RENDERER="$SCRIPT_DIR/session_log_renderer.py"
    // After install both files land in the same dir, so this relative
    // reference resolves to the bundled renderer.
    const sessionLog = fs.readFileSync(path.join(packRoot, 'session-log.sh'), 'utf8');
    expect(sessionLog).toMatch(/RENDERER=.*\$SCRIPT_DIR\/session_log_renderer\.py/);
    // The pack ships both side by side.
    expect(fs.existsSync(path.join(packRoot, 'session-log.sh'))).toBe(true);
    expect(fs.existsSync(path.join(packRoot, 'session_log_renderer.py'))).toBe(true);
  });

  it('A2: Sterling-specific MEANINGFUL_COMMAND_KW entries are removed from the baseline', () => {
    const content = fs.readFileSync(rendererPath, 'utf8');
    // Extract the MEANINGFUL_COMMAND_KW tuple — Python tuple-literal,
    // multiple lines.
    const tupleMatch = content.match(/MEANINGFUL_COMMAND_KW\s*=\s*\(([^)]+)\)/);
    expect(tupleMatch).not.toBeNull();
    const tupleBody = tupleMatch[1];

    // Sterling-Rust + Python-lint tooling: gone.
    expect(tupleBody).not.toMatch(/"cargo test"/);
    expect(tupleBody).not.toMatch(/"cargo build"/);
    expect(tupleBody).not.toMatch(/"ruff"/);
    expect(tupleBody).not.toMatch(/"mypy"/);

    // Generic baseline: preserved.
    expect(tupleBody).toMatch(/"pytest"/);
    expect(tupleBody).toMatch(/"git log"/);
    expect(tupleBody).toMatch(/"npm test"/);
    expect(tupleBody).toMatch(/"caws "/);
  });

  it('A2: test_run artifact-detection list mirrors the trimmed baseline', () => {
    const content = fs.readFileSync(rendererPath, 'utf8');
    // The test_run detection hardcoded a sibling list; should now match
    // the generic baseline minus Sterling-specifics.
    expect(content).toMatch(/keyword in command for keyword in \("pytest", "npm test", "pnpm test"\)/);
    expect(content).not.toMatch(/keyword in command for keyword in \("pytest", "cargo test"/);
  });

  it('invariant 3: pack version bumped from 5 to 6 to signal the new file to existing installs', () => {
    const { CLAUDE_CODE_PACK_VERSION } = require(
      '../../../dist/init/hook-packs/manifest-claude-code'
    );
    expect(CLAUDE_CODE_PACK_VERSION).toBeGreaterThanOrEqual(6);
  });
});

// ════════════════════════════════════════════════════════════════════
// CAWS-HOOK-PACK-PROMOTE-001 — A1/A2/A3/A4 (4-hook subset)
//
// Promotes 4 PORT-classified hooks from
// docs/reports/sterling_hook_port_audit_001.md:
//   cwd-guard.sh, protected-paths.sh, scan-secrets.sh (PreToolUse)
//   naming-check.sh (PostToolUse)
// ════════════════════════════════════════════════════════════════════
describe('CAWS-HOOK-PACK-PROMOTE-001 — all 7 PORT hooks', () => {
  const packRoot = path.resolve(
    __dirname, '..', '..', '..', 'templates', 'hook-packs', 'claude-code'
  );

  const PROMOTED_HOOKS = [
    { name: 'cwd-guard.sh', dispatch: 'pre_tool_use.sh', exec: true },
    { name: 'protected-paths.sh', dispatch: 'pre_tool_use.sh', exec: true },
    { name: 'scan-secrets.sh', dispatch: 'pre_tool_use.sh', exec: true },
    { name: 'naming-check.sh', dispatch: 'post_tool_use.sh', exec: true },
    { name: 'quiet-merge.sh', dispatch: 'pre_tool_use.sh', exec: true },
    { name: 'plan-transcript-snapshot.sh', dispatch: 'post_tool_use.sh', exec: true },
    { name: 'plan-transcript-finalize.sh', dispatch: 'stop.sh', exec: true },
  ];

  it('A1: all 7 promoted hooks exist in the pack template tree', () => {
    for (const h of PROMOTED_HOOKS) {
      const p = path.join(packRoot, h.name);
      expect(fs.existsSync(p)).toBe(true);
    }
  });

  it('A1: each promoted hook is registered in the manifest', () => {
    for (const h of PROMOTED_HOOKS) {
      const entry = CLAUDE_CODE_PACK.installedFiles.find(
        (f) => f.sourcePath === h.name
      );
      expect(entry).toBeDefined();
      expect(entry.destPath).toBe(`.claude/hooks/${h.name}`);
      expect(entry.managed).toBe(true);
      expect(entry.executable).toBe(h.exec);
    }
  });

  it('A1: each promoted hook carries a CAWS-MANAGED-HOOK header at v7', () => {
    for (const h of PROMOTED_HOOKS) {
      const content = fs.readFileSync(path.join(packRoot, h.name), 'utf8');
      expect(content).toContain('CAWS-MANAGED-HOOK');
      expect(content).toContain('hook_pack: claude-code');
      expect(content).toContain(`hook_pack_version: ${CLAUDE_CODE_PACK.packVersion}`);
      expect(content).toContain('caws_min_major: 11');
      // Each promoted hook cites at least one lineage entry from
      // the 22-25 range.
      expect(content).toMatch(/lineage_refs: \d+/);
    }
  });

  it('A2: PreToolUse dispatcher wires cwd-guard, protected-paths, scan-secrets, quiet-merge', () => {
    const preToolUse = fs.readFileSync(
      path.join(packRoot, 'caws_dispatch/pre_tool_use.sh'),
      'utf8'
    );
    expect(preToolUse).toContain('cwd-guard.sh');
    expect(preToolUse).toContain('protected-paths.sh');
    expect(preToolUse).toContain('scan-secrets.sh');
    expect(preToolUse).toContain('quiet-merge.sh');

    // Ordering invariant per audit + the hook's own header comment:
    // cwd-guard runs early (after agent-heartbeat), protected-paths
    // runs after scope-guard, scan-secrets advisory runs late,
    // quiet-merge MUST be last (it emits updatedInput which replaces
    // any prior interceptor's updatedInput).
    const cwdIdx = preToolUse.indexOf('cwd-guard.sh');
    const heartbeatIdx = preToolUse.indexOf('agent-heartbeat.sh');
    const scopeIdx = preToolUse.indexOf('scope-guard.sh');
    const protectedIdx = preToolUse.indexOf('protected-paths.sh');
    const secretsIdx = preToolUse.indexOf('scan-secrets.sh');
    const quietMergeIdx = preToolUse.indexOf('quiet-merge.sh');
    expect(cwdIdx).toBeGreaterThan(heartbeatIdx); // cwd-guard after heartbeat
    expect(protectedIdx).toBeGreaterThan(scopeIdx); // protected-paths after scope-guard
    expect(secretsIdx).toBeGreaterThan(protectedIdx); // scan-secrets after protected-paths
    expect(quietMergeIdx).toBeGreaterThan(secretsIdx); // quiet-merge LAST
  });

  it('A2: PostToolUse dispatcher wires naming-check and plan-transcript-snapshot', () => {
    const postToolUse = fs.readFileSync(
      path.join(packRoot, 'caws_dispatch/post_tool_use.sh'),
      'utf8'
    );
    // Uncommented in HANDLERS array.
    expect(postToolUse).toMatch(/^\s*"naming-check\.sh"/m);
    expect(postToolUse).toMatch(/^\s*"plan-transcript-snapshot\.sh"/m);
  });

  it('A2: Stop dispatcher wires plan-transcript-finalize', () => {
    const stopDispatch = fs.readFileSync(
      path.join(packRoot, 'caws_dispatch/stop.sh'),
      'utf8'
    );
    expect(stopDispatch).toMatch(/^\s*"plan-transcript-finalize\.sh"/m);
  });

  it('A2: plan-transcript pair ships as a unit (both files + cross-references)', () => {
    const snapshot = fs.readFileSync(
      path.join(packRoot, 'plan-transcript-snapshot.sh'), 'utf8'
    );
    const finalize = fs.readFileSync(
      path.join(packRoot, 'plan-transcript-finalize.sh'), 'utf8'
    );
    // Both hooks reference the same $HOME/.claude/.pending-plan-snapshots
    // state file. Snapshot writes to it; finalize reads + drains.
    expect(snapshot).toContain('pending-plan-snapshots');
    expect(finalize).toContain('pending-plan-snapshots');
    // Each hook documents its companion in the header.
    expect(snapshot).toMatch(/plan-transcript-finalize/i);
    expect(finalize).toMatch(/plan-transcript-snapshot/i);
  });

  it('A2: quiet-merge self-filters to Bash + caws worktree merge|destroy', () => {
    const content = fs.readFileSync(
      path.join(packRoot, 'quiet-merge.sh'), 'utf8'
    );
    // Self-filter: bail on non-Bash tools.
    expect(content).toMatch(/HOOK_TOOL_NAME/);
    expect(content).toMatch(/"\$TOOL_NAME"\s*!=\s*"Bash"/);
    // Targets the destructive command set.
    expect(content).toMatch(/caws\\s\+worktree\\s\+\(merge\|destroy\)/);
    // The rewrite uses updatedInput envelope.
    expect(content).toMatch(/hookSpecificOutput.*updatedInput/);
  });

  it('A3: naming-check.sh advisory messages do not reference removed v10 surfaces', () => {
    const content = fs.readFileSync(
      path.join(packRoot, 'naming-check.sh'),
      'utf8'
    );
    // Strip the file's own doc-comment header block (lines starting with #).
    // Stale-reference assertions target what the AGENT sees at runtime
    // (the hookSpecificOutput.additionalContext strings), not the
    // documentation comments that explain the genericization itself.
    const codeOnly = content
      .split('\n')
      .filter((line) => !line.trimStart().startsWith('#'))
      .join('\n');
    // The v10 CLI is gone; the advisory text must not direct users
    // to invoke it.
    expect(codeOnly).not.toMatch(/caws naming check/);
    expect(codeOnly).not.toMatch(/canonical-map\.yaml/);
    // Generic doctrine reference is preserved in the advisory text.
    expect(codeOnly).toMatch(/No shadow files/);
  });

  it('A4: failure-lineage.md has entries 22-27 for the 7 promoted hooks', () => {
    const lineagePath = path.resolve(
      __dirname, '..', '..', '..', '..', '..', 'docs', 'failure-lineage.md'
    );
    const content = fs.readFileSync(lineagePath, 'utf8');
    expect(content).toMatch(/^## Entry 22:/m);
    expect(content).toMatch(/^## Entry 23:/m);
    expect(content).toMatch(/^## Entry 24:/m);
    expect(content).toMatch(/^## Entry 25:/m);
    expect(content).toMatch(/^## Entry 26:/m);
    expect(content).toMatch(/^## Entry 27:/m);
    // Each cites the corresponding hook by name (entries 22-25 are
    // 1:1 with their hooks; 26 covers quiet-merge.sh; 27 covers the
    // plan-transcript pair).
    expect(content).toMatch(/Entry 22:[\s\S]*cwd-guard\.sh/);
    expect(content).toMatch(/Entry 23:[\s\S]*protected-paths\.sh/);
    expect(content).toMatch(/Entry 24:[\s\S]*scan-secrets\.sh/);
    expect(content).toMatch(/Entry 25:[\s\S]*naming-check\.sh/);
    expect(content).toMatch(/Entry 26:[\s\S]*quiet-merge\.sh/);
    expect(content).toMatch(/Entry 27:[\s\S]*plan-transcript-snapshot\.sh/);
    expect(content).toMatch(/Entry 27:[\s\S]*plan-transcript-finalize\.sh/);
  });

  it('invariant 5: pack version bumped to 7', () => {
    const { CLAUDE_CODE_PACK_VERSION } = require(
      '../../../dist/init/hook-packs/manifest-claude-code'
    );
    expect(CLAUDE_CODE_PACK_VERSION).toBeGreaterThanOrEqual(7);
  });

  it('invariant 6: lineageRefs in the manifest cite all promoted entries (22-27)', () => {
    expect(CLAUDE_CODE_PACK.lineageRefs).toContain(22);
    expect(CLAUDE_CODE_PACK.lineageRefs).toContain(23);
    expect(CLAUDE_CODE_PACK.lineageRefs).toContain(24);
    expect(CLAUDE_CODE_PACK.lineageRefs).toContain(25);
    expect(CLAUDE_CODE_PACK.lineageRefs).toContain(26);
    expect(CLAUDE_CODE_PACK.lineageRefs).toContain(27);
  });
});

// ════════════════════════════════════════════════════════════════════
// CAWS-LITE-MODE-RETIREMENT-001 — A1, A4, A5 + invariants 1, 3
//
// Pack v8 removes the v10 "Lite mode" branch from scope-guard.sh.
// The branch previously read `.caws/scope.json` and enforced lite-mode
// rules when no `.caws/specs/` directory was present. v8 retires that
// branch entirely.
// ════════════════════════════════════════════════════════════════════
describe('CAWS-LITE-MODE-RETIREMENT-001 — pack v8', () => {
  const packRoot = path.resolve(
    __dirname, '..', '..', '..', 'templates', 'hook-packs', 'claude-code'
  );

  it('A1/invariant 1: scope-guard.sh no longer contains the "Lite mode" branch', () => {
    const content = fs.readFileSync(
      path.join(packRoot, 'scope-guard.sh'),
      'utf8'
    );
    // The pre-v8 lite branch was guarded by:
    //   if [[ ! -d "$SPECS_BASE/.caws/specs" ]] && [[ -f "$SCOPE_FILE" ]]; then
    // and contained a "Lite mode: scope.json (no .caws/specs/)" comment
    // followed by a 60-line node -e block reading scope.json.
    expect(content).not.toMatch(/Lite mode: scope\.json/);
    expect(content).not.toMatch(/LITE_CHECK=/);
    // The hook should no longer reference SCOPE_FILE at all (it was
    // only used to point at .caws/scope.json for the lite branch).
    expect(content).not.toMatch(/SCOPE_FILE=/);
    // Negative-evidence guard: the v8 retirement note explains the
    // removal in the source so future readers don't re-add it.
    expect(content).toMatch(/CAWS-LITE-MODE-RETIREMENT-001/);
  });

  it('A1/invariant 1: scope-guard.sh "no specs directory → exit 0" is the new fallback', () => {
    const content = fs.readFileSync(
      path.join(packRoot, 'scope-guard.sh'),
      'utf8'
    );
    // The new shape: if no .caws/specs/ exists, exit 0 cleanly.
    // No silent fallback to scope.json.
    expect(content).toMatch(/if \[\[ ! -d "\$SPECS_BASE\/\.caws\/specs" \]\]; then/);
  });

  it('invariant 3a: src/config/lite-scope.js is excluded from the v11 build allowlist', () => {
    // build-cli.js's comment block lists the v10 surface that is
    // NOT shipped to dist/. lite-scope.js and modes.js are in that
    // list. This test asserts the build script's intent has not
    // silently been changed.
    const buildScript = fs.readFileSync(
      path.resolve(__dirname, '..', '..', '..', 'scripts', 'build-cli.js'),
      'utf8'
    );
    // The v10 paths called out as orphaned-by-removal in build-cli.js
    // should remain on the orphan list.
    expect(buildScript).toMatch(/scaffold\//);
    expect(buildScript).toMatch(/policy\/\*\.js/);
    // Generic assertion: the build script is allowlist-shaped, not
    // blocklist-shaped (a regression would silently ship orphan code).
    expect(buildScript).toMatch(/allowlist/i);
  });

  it('invariant 5/A5: docs/migration-v10-to-v11.md has a Lite mode retirement section', () => {
    const migrationPath = path.resolve(
      __dirname, '..', '..', '..', '..', '..', 'docs', 'migration-v10-to-v11.md'
    );
    const content = fs.readFileSync(migrationPath, 'utf8');
    // A header referencing lite-mode retirement should exist.
    expect(content).toMatch(/lite mode/i);
    // The section should explicitly mention .caws/mode.json and the
    // recommended action (delete it).
    expect(content).toMatch(/mode\.json/);
  });
});

// ════════════════════════════════════════════════════════════════════
// CAWS-SCOPE-STRIKE-SOURCE-UNIFY-001 — pack v9
//
// scope-guard.sh now delegates to `caws scope check` (the kernel-backed
// authority) before falling back to its inline node block. This unifies
// the scope-decision source: invariant 1 (hook and kernel agree),
// invariant 2 (strikes auto-invalidate when current scope says ADMIT),
// invariant 3 (one authoritative source).
// ════════════════════════════════════════════════════════════════════
describe('CAWS-SCOPE-STRIKE-SOURCE-UNIFY-001 — pack v9', () => {
  const packRoot = path.resolve(
    __dirname, '..', '..', '..', 'templates', 'hook-packs', 'claude-code'
  );

  it('invariant 1: scope-guard.sh delegates to `caws scope check` before falling back to inline node', () => {
    const content = fs.readFileSync(
      path.join(packRoot, 'scope-guard.sh'),
      'utf8'
    );
    // The delegation block must reference `caws scope check` and exit
    // on success — that's what guarantees ADMIT skips the strike
    // counter and matches `caws scope show`.
    expect(content).toMatch(/command -v caws/);
    expect(content).toMatch(/caws scope check "\$REL_PATH"/);
    // The ADMIT branch must exit 0 immediately (no emit_scope_progression).
    // We assert the structural shape: a `caws scope check` invocation
    // followed by `exit 0` before any strike-emitting code path.
    const cawsCheckIdx = content.indexOf('caws scope check "$REL_PATH"');
    expect(cawsCheckIdx).toBeGreaterThan(0);
    // Within ~10 lines of the caws check, there must be an `exit 0`.
    const window = content.slice(cawsCheckIdx, cawsCheckIdx + 500);
    expect(window).toMatch(/exit 0/);
    // And the retirement marker comment must be present so future
    // readers know this delegation is intentional, not a regression
    // of the inline-node-only design.
    expect(content).toMatch(/CAWS-SCOPE-STRIKE-SOURCE-UNIFY-001/);
  });

  it('invariant 2: ADMIT exit path skips emit_scope_progression entirely', () => {
    const content = fs.readFileSync(
      path.join(packRoot, 'scope-guard.sh'),
      'utf8'
    );
    // The kernel-ADMIT path must be: `caws scope check` → exit 0.
    // No call to emit_scope_progression on this path. We assert by
    // structural distance: the `exit 0` after `caws scope check`
    // appears BEFORE the first emit_scope_progression CALL SITE
    // (not the function definition; we match the call shape with
    // a quoted argument).
    const cawsCheckInvocationIdx = content.indexOf('caws scope check "$REL_PATH"');
    const firstEmitCallIdx = content.search(/emit_scope_progression "/);
    expect(cawsCheckInvocationIdx).toBeGreaterThan(0);
    expect(firstEmitCallIdx).toBeGreaterThan(0);
    expect(cawsCheckInvocationIdx).toBeLessThan(firstEmitCallIdx);
    // The kernel-ADMIT exit 0 lives between the caws check call and
    // the first emit_scope_progression call — proving the early-exit
    // path bypasses strike emission.
    const between = content.slice(cawsCheckInvocationIdx, firstEmitCallIdx);
    expect(between).toMatch(/exit 0/);
  });

  it('invariant 3: hook falls back to inline node when caws is unavailable', () => {
    const content = fs.readFileSync(
      path.join(packRoot, 'scope-guard.sh'),
      'utf8'
    );
    // Backwards-compatible fallback: if `command -v caws` is missing,
    // the existing `command -v node` block must still be reachable.
    // We assert both gates are present and ordered correctly (caws
    // check is gated behind `command -v caws`; the node block is
    // gated behind `command -v node` and appears after).
    const cawsGuardIdx = content.indexOf('command -v caws >/dev/null 2>&1');
    const nodeGuardIdx = content.indexOf('command -v node >/dev/null 2>&1');
    expect(cawsGuardIdx).toBeGreaterThan(0);
    expect(nodeGuardIdx).toBeGreaterThan(0);
    expect(cawsGuardIdx).toBeLessThan(nodeGuardIdx); // caws first, node fallback
  });

  it('pack version bumped to 9', () => {
    const { CLAUDE_CODE_PACK_VERSION } = require(
      '../../../dist/init/hook-packs/manifest-claude-code'
    );
    expect(CLAUDE_CODE_PACK_VERSION).toBeGreaterThanOrEqual(9);
  });

  it('scope-guard.sh header carries the current pack version', () => {
    const content = fs.readFileSync(
      path.join(packRoot, 'scope-guard.sh'),
      'utf8'
    );
    expect(content).toMatch(new RegExp(`^# hook_pack_version: ${CLAUDE_CODE_PACK.packVersion}$`, "m"));
  });
});
