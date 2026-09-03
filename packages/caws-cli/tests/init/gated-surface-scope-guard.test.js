'use strict';

/**
 * CAWS-GATED-SURFACE-SCOPE-GUARD-001 — the trust-gated surface scope guard.
 *
 * qwen-code (>=0.21.10 workspace-trust gate) and zcode (>=3.3.6 strips
 * project hooks unconditionally) may carry USER-scope CAWS wiring. When they
 * do, installing PROJECT-scope hook entries double-fires every dispatcher
 * (observed live 2026-08-13: doubled audit entries, ~4-minute SessionStart
 * hang). These tests pin:
 *   - the detection contract (markers, nesting, missing/unparseable = absent);
 *   - the suppression (merge + plan return skipped_dual_scope, nothing
 *     written, a LOUD stderr warning — never a silent skip);
 *   - the inertness (no user-scope wiring => byte-identical legacy behavior).
 *
 * The home dir is injected by stubbing os.homedir() — the same module
 * instance the built merge functions call — so the tests are hermetic and
 * immune to whatever the dev machine's real user scope happens to contain.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  detectUserScopeCawsWiring,
  mergeQwenSettings,
  mergeZcodeConfig,
  planQwenSettingsMerge,
  planZcodeConfigMerge,
} = require('../../dist/init/hook-install');

function makeTempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

/** Install a fake user-scope config and point os.homedir at its root. */
function withFakeHome(t) {
  const home = makeTempDir('gsg-home-');
  const realHomedir = os.homedir;
  os.homedir = () => home;
  return {
    home,
    restore() {
      os.homedir = realHomedir;
      fs.rmSync(home, { recursive: true, force: true });
    },
    writeUserScope(surface, body) {
      const rel =
        surface === 'qwen-code'
          ? path.join('.qwen', 'settings.json')
          : path.join('.zcode', 'cli', 'config.json');
      const abs = path.join(home, rel);
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, typeof body === 'string' ? body : JSON.stringify(body, null, 2));
      return abs;
    },
  };
}

/** Capture stderr during a call; returns [result, capturedText]. */
function captureStderr(fn) {
  const chunks = [];
  const realWrite = process.stderr.write;
  process.stderr.write = (chunk) => {
    chunks.push(typeof chunk === 'string' ? chunk : chunk.toString());
    return true;
  };
  try {
    const result = fn();
    return [result, chunks.join('')];
  } finally {
    process.stderr.write = realWrite;
  }
}

const QWEN_USER_SCOPE_WIRING = {
  hooks: {
    SessionStart: [
      {
        matcher: 'startup|resume',
        hooks: [
          {
            type: 'command',
            command:
              'REPO_ROOT="$(git rev-parse --show-toplevel 2>/dev/null || pwd -P)"; "$REPO_ROOT/.qwen/hooks/caws-qwen-hook.sh"',
          },
        ],
      },
    ],
  },
};

const ZCODE_USER_SCOPE_WIRING = {
  hooks: {
    enabled: true,
    events: {
      PreToolUse: [
        {
          hooks: [
            {
              type: 'command',
              command:
                '"${ZCODE_PROJECT_DIR}"/.zcode/hooks/caws-bridge.sh pre_tool_use',
            },
          ],
        },
      ],
    },
  },
};

describe('detection: user-scope CAWS wiring (A1/A2 precondition)', () => {
  test('qwen: wiring matched by the shim tail, at user scope', () => {
    const h = withFakeHome();
    try {
      h.writeUserScope('qwen-code', QWEN_USER_SCOPE_WIRING);
      const d = detectUserScopeCawsWiring('qwen-code', h.home);
      expect(d.present).toBe(true);
      expect(d.sourcePath).toBe(path.join(h.home, '.qwen', 'settings.json'));
    } finally {
      h.restore();
    }
  });

  test('zcode: wiring matched by the bridge tail, nested under hooks.events', () => {
    const h = withFakeHome();
    try {
      h.writeUserScope('zcode', ZCODE_USER_SCOPE_WIRING);
      expect(detectUserScopeCawsWiring('zcode', h.home).present).toBe(true);
    } finally {
      h.restore();
    }
  });

  test('a command dispatching into the shared .caws/hooks/ core counts too', () => {
    const h = withFakeHome();
    try {
      h.writeUserScope('qwen-code', {
        hooks: {
          Stop: [{ hooks: [{ type: 'command', command: 'bash "$ROOT/.caws/hooks/dispatch/stop.sh"' }] }],
        },
      });
      expect(detectUserScopeCawsWiring('qwen-code', h.home).present).toBe(true);
    } finally {
      h.restore();
    }
  });

  test('missing or unparseable user-scope config is absent, never an error', () => {
    const h = withFakeHome();
    try {
      expect(detectUserScopeCawsWiring('qwen-code', h.home).present).toBe(false);
      h.writeUserScope('qwen-code', '{ not json');
      expect(detectUserScopeCawsWiring('qwen-code', h.home).present).toBe(false);
    } finally {
      h.restore();
    }
  });

  test('unrelated user-scope hooks are NOT CAWS wiring', () => {
    const h = withFakeHome();
    try {
      h.writeUserScope('qwen-code', {
        hooks: { Stop: [{ hooks: [{ type: 'command', command: 'my-own-formatter.sh' }] }] },
      });
      expect(detectUserScopeCawsWiring('qwen-code', h.home).present).toBe(false);
    } finally {
      h.restore();
    }
  });
});

describe('suppression: merge + plan skip loudly, write nothing (A1/A2)', () => {
  test('qwen merge: skipped_dual_scope, no file written, loud stderr warning', () => {
    const h = withFakeHome();
    const repo = makeTempDir('gsg-repo-');
    try {
      h.writeUserScope('qwen-code', QWEN_USER_SCOPE_WIRING);
      const [result, stderr] = captureStderr(() => mergeQwenSettings(repo));
      expect(result.kind).toBe('skipped_dual_scope');
      expect(result.userScopePath).toBe(path.join(h.home, '.qwen', 'settings.json'));
      expect(fs.existsSync(path.join(repo, '.qwen', 'settings.json'))).toBe(false);
      // NEVER SILENT ON SKIP: the warning names the hazard and the single source.
      expect(stderr).toContain('user-scope CAWS wiring for qwen-code');
      expect(stderr).toContain('double');
      // Fires once per call, not per entry.
      expect(stderr.match(/Warning: user-scope/g)).toHaveLength(1);
    } finally {
      h.restore();
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });

  test('qwen merge with an EXISTING project settings file: file byte-identical, still skipped', () => {
    const h = withFakeHome();
    const repo = makeTempDir('gsg-repo-');
    try {
      h.writeUserScope('qwen-code', QWEN_USER_SCOPE_WIRING);
      const settingsPath = path.join(repo, '.qwen', 'settings.json');
      fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
      const before = JSON.stringify({ tools: { webSearch: true } }, null, 2) + '\n';
      fs.writeFileSync(settingsPath, before);
      const [result] = captureStderr(() => mergeQwenSettings(repo));
      expect(result.kind).toBe('skipped_dual_scope');
      expect(fs.readFileSync(settingsPath, 'utf8')).toBe(before);
    } finally {
      h.restore();
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });

  test('zcode merge: skipped_dual_scope, no config.json created', () => {
    const h = withFakeHome();
    const repo = makeTempDir('gsg-repo-');
    try {
      h.writeUserScope('zcode', ZCODE_USER_SCOPE_WIRING);
      const [result, stderr] = captureStderr(() => mergeZcodeConfig(repo));
      expect(result.kind).toBe('skipped_dual_scope');
      expect(fs.existsSync(path.join(repo, '.zcode', 'config.json'))).toBe(false);
      expect(stderr).toContain('user-scope CAWS wiring for zcode');
    } finally {
      h.restore();
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });

  test('plans report the skip the perform path would take (never a false promise)', () => {
    const h = withFakeHome();
    const repo = makeTempDir('gsg-repo-');
    try {
      h.writeUserScope('qwen-code', QWEN_USER_SCOPE_WIRING);
      h.writeUserScope('zcode', ZCODE_USER_SCOPE_WIRING);
      const [qp] = captureStderr(() => planQwenSettingsMerge(repo));
      expect(qp.kind).toBe('skipped_dual_scope');
      expect(qp.readOnly).toBe(true);
      const [zp] = captureStderr(() => planZcodeConfigMerge(repo));
      expect(zp.kind).toBe('skipped_dual_scope');
      expect(zp.readOnly).toBe(true);
    } finally {
      h.restore();
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });
});

describe('inertness: no user-scope wiring => legacy behavior (A3)', () => {
  test('qwen merge creates the canonical wiring exactly as before the guard', () => {
    const h = withFakeHome(); // empty home: no user-scope wiring
    const repo = makeTempDir('gsg-repo-');
    try {
      const [result, stderr] = captureStderr(() => mergeQwenSettings(repo));
      expect(result.kind).toBe('created');
      expect(stderr).toBe('');
      const settingsPath = path.join(repo, '.qwen', 'settings.json');
      const parsed = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
      expect(Object.keys(parsed.hooks).sort()).toEqual(
        ['PostToolUse', 'PreToolUse', 'SessionStart', 'Stop', 'PreCompact'].sort()
      );
    } finally {
      h.restore();
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });

  test('zcode merge creates the canonical config exactly as before the guard', () => {
    const h = withFakeHome();
    const repo = makeTempDir('gsg-repo-');
    try {
      const [result, stderr] = captureStderr(() => mergeZcodeConfig(repo));
      expect(result.kind).toBe('created');
      expect(stderr).toBe('');
      expect(fs.existsSync(path.join(repo, '.zcode', 'config.json'))).toBe(true);
    } finally {
      h.restore();
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });
});
