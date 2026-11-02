/** Raw Codex parser + real shared guard/oracle. No command payload is executed,
 * no oracle is mocked, and no installed/global governance is borrowed.
 * Installed ingress HOOK_* scrubbing has separate launcher/consumer controls.
 */
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawnSync } = require('node:child_process');
const { createHash } = require('node:crypto');
const PACKS = path.resolve(__dirname, '../../templates/hook-packs');
const SHARED = path.join(PACKS, 'shared');
const CODEX_PARSER = path.join(PACKS, 'codex/hooks/lib/parse-input.sh');
const CLI = path.resolve(__dirname, '../../dist/index.js');
const sha = (b) => createHash('sha256').update(b).digest('hex');
let root, repo, actualCwd, home, owned, foreign, hooks;
function command(program, args, options = {}) {
  const result = spawnSync(program, args, { encoding: 'utf8', timeout: 30000, ...options });
  expect(result.error).toBeUndefined();
  expect(result.signal).toBeNull();
  return result;
}
function cleanEnvironment() {
  const env = { ...process.env };
  for (const key of Object.keys(env))
    if (/^(?:HOOK_|_HOOK_|_CAWS_|CAWS_|CODEX_|CLAUDE_|GIT_|NODE_OPTIONS$)/.test(key))
      delete env[key];
  return env;
}
beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'caws-codex-guard-context-')));
  repo = path.join(root, 'session-project');
  actualCwd = path.join(root, 'actual-process-cwd');
  home = path.join(root, 'home');
  owned = path.join(repo, '.caws/worktrees/owned');
  foreign = path.join(repo, '.caws/worktrees/foreign');
  hooks = path.join(repo, '.caws/hooks');
  for (const dir of [repo, actualCwd, home, owned, foreign, path.join(repo, '.caws/specs')])
    fs.mkdirSync(dir, { recursive: true });
  fs.cpSync(SHARED, hooks, { recursive: true });
  const vendorLib = path.join(repo, '.codex/hooks/lib');
  fs.mkdirSync(vendorLib, { recursive: true });
  fs.copyFileSync(path.join(PACKS, 'codex/hooks/lib/emit.sh'), path.join(vendorLib, 'emit.sh'));
  // The executed guard is byte-identical to the authoritative template.
  expect(sha(fs.readFileSync(path.join(hooks, 'bash-write-guard.sh')))).toBe(
    sha(fs.readFileSync(path.join(SHARED, 'bash-write-guard.sh')))
  );
  expect(
    command('git', ['-C', repo, 'init', '-q', '-b', 'main'], {
      env: {
        ...cleanEnvironment(),
        HOME: home,
        GIT_CONFIG_GLOBAL: '/dev/null',
        GIT_CONFIG_SYSTEM: '/dev/null',
      },
    }).status
  ).toBe(0);
  fs.writeFileSync(
    path.join(repo, '.caws/worktrees.json'),
    JSON.stringify({
      owned: {
        name: 'owned',
        spec_id: 'OWNED',
        path: owned,
        owner: { session_id: 'owner-session' },
        baseBranch: 'main',
      },
      foreign: {
        name: 'foreign',
        spec_id: 'FOREIGN',
        path: foreign,
        owner: { session_id: 'foreign-session' },
        baseBranch: 'main',
      },
    })
  );
  for (const [name, id, claim] of [
    ['owned', 'OWNED', 'src/owned'],
    ['foreign', 'FOREIGN', 'src/foreign'],
  ])
    fs.writeFileSync(
      path.join(repo, '.caws/specs', id + '.yaml'),
      `id: ${id}\nlifecycle_state: active\nworktree: ${name}\nscope:\n  in:\n    - ${claim}\n`
    );
});
afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});
function run(
  commandText,
  {
    host,
    input = {},
    inherited = {},
    surface = 'codex',
    event = 'PreToolUse',
    tool = 'Bash',
    replay = 'payload',
  } = {}
) {
  const payload = {
    tool_name: tool,
    tool_input: { command: commandText, ...input },
    session_id: 'owner-session',
    cwd: repo,
    hook_event_name: event,
  };
  if (host !== undefined) payload.execution_workdir = host;
  const parser = surface === 'codex' ? CODEX_PARSER : path.join(hooks, 'lib/parse-input.sh');
  const result = command(
    '/bin/bash',
    [
      '-c',
      // Dispatch children receive parsed exports AND the original payload.
      // Inline JSON is deliberately not exported by the real parser.
      'source "$1"; parse_hook_input || exit $?; printf "%s\\0" "${HOOK_EXECUTION_WORKDIR_STATUS:-}" "$HOOK_CWD" "${HOOK_SESSION_CWD:-}" "$CAWS_PROJECT_DIR" >&3; { case "$3" in missing) : ;; malformed) printf "not-json" ;; *) if [[ -n "${HOOK_PAYLOAD_FILE:-}" ]]; then cat "$HOOK_PAYLOAD_FILE"; else printf "%s" "$HOOK_INPUT_JSON"; fi ;; esac; } | /bin/bash "$2"',
      'guard-context',
      parser,
      path.join(hooks, 'bash-write-guard.sh'),
      replay,
    ],
    {
      cwd: actualCwd,
      input: JSON.stringify(payload),
      stdio: ['pipe', 'pipe', 'pipe', 'pipe'],
      env: {
        ...cleanEnvironment(),
        HOME: home,
        CAWS_HOME: path.join(home, '.caws'),
        CAWS_PROJECT_DIR: repo,
        CAWS_AGENT_SURFACE: surface,
        CAWS_BIN: CLI,
        CODEX_THREAD_ID: 'owner-session',
        CLAUDE_CODE_SESSION_ID: 'owner-session',
        CAWS_GUARD_NO_ASK: '0',
        GIT_CONFIG_GLOBAL: '/dev/null',
        GIT_CONFIG_SYSTEM: '/dev/null',
        NODE_PATH: path.resolve(__dirname, '../../../../node_modules'),
        ...inherited,
      },
    }
  );
  return { ...result, fields: String(result.output[3] || '').split('\0') };
}
function expectUnqualifiedCodex(result) {
  // A cwd observation is not the final shell/startup execution contract.
  // docs/guides/command-analysis.md defines this reduced-producer refusal.
  expect(result.status).toBe(2);
  expect(result.stdout).toBe('');
  expect(result.stderr).toContain('command mutation analyzer failed (execution-contract)');
  expect(result.stderr).not.toContain('owned by a DIFFERENT session');
  expect(result.stderr).not.toContain('claimed by an active worktree');
}
function expectUnavailable(result) {
  expectUnqualifiedCodex(result);
  expect(result.fields.slice(0, 4)).toEqual(['unavailable', repo, repo, repo]);
}
test.each(['touch src/owned/file.js', 'touch docs/note.md', 'rm src/owned/*.js', 'git clean -fd'])(
  'legacy command-only cwd=session is unavailable for %s despite a different real process cwd',
  (text) => {
    expect(actualCwd).not.toBe(repo);
    expectUnavailable(run(text));
    expect(fs.existsSync(path.join(repo, 'src/owned/file.js'))).toBe(false);
  }
);
test('validated host cwd does not qualify the reduced Codex execution contract', () => {
  const result = run('touch src/owned/file.js', { host: owned });
  expectUnqualifiedCodex(result);
  expect(result.fields.slice(0, 4)).toEqual(['resolved', owned, repo, repo]);
});
test('file-transported payload preserves the validated owner context', () => {
  const result = run('touch src/owned/file.js', {
    host: owned,
    inherited: { CAWS_HOOK_INLINE_PAYLOAD_MAX_BYTES: '0' },
  });
  expectUnqualifiedCodex(result);
  expect(result.fields.slice(0, 4)).toEqual(['resolved', owned, repo, repo]);
});
test.each(['missing', 'malformed'])(
  'parsed exports cannot replace %s original metadata',
  (replay) => {
    const result = run('touch src/owned/file.js', { host: owned, replay });
    expect(result.status).toBe(2);
    expect(result.stderr).toContain('original tool metadata is missing or malformed');
    expect(fs.existsSync(path.join(owned, 'src/owned/file.js'))).toBe(false);
  }
);
test('resolved foreign cwd does not qualify the reduced Codex execution contract', () => {
  const result = run('touch src/foreign/file.js', { host: foreign });
  expectUnqualifiedCodex(result);
  expect(result.fields.slice(0, 4)).toEqual(['resolved', foreign, repo, repo]);
});
test('inherited resolved status and command alias cannot turn session cwd into host context', () => {
  const result = run('touch src/owned/file.js', {
    input: { workdir: owned },
    inherited: {
      HOOK_EXECUTION_WORKDIR_STATUS: 'resolved',
      HOOK_EXECUTION_WORKDIR: owned,
      HOOK_CWD: owned,
    },
  });
  expectUnavailable(result);
});
test('payload lookalike status fields do not substitute for host execution_workdir', () => {
  expectUnavailable(
    run('touch src/owned/file.js', {
      input: {
        HOOK_EXECUTION_WORKDIR_STATUS: 'resolved',
        execution_workdir: owned,
        cwd: owned,
      },
    })
  );
});
test('absolute owner path does not qualify missing Codex execution context', () => {
  const result = run('touch ' + path.join(owned, 'src/owned/file.js'));
  expectUnqualifiedCodex(result);
  expect(result.fields[0]).toBe('unavailable');
});
test('absolute foreign path does not qualify missing Codex execution context', () => {
  const result = run('touch ' + path.join(foreign, 'src/foreign/file.js'));
  expectUnqualifiedCodex(result);
});
test('absolute canonical claimed path does not bypass the Codex execution contract', () => {
  const result = run('touch ' + path.join(repo, 'src/owned/file.js'));
  expectUnqualifiedCodex(result);
});
test('unclaimed absolute canonical target does not bypass the Codex execution contract', () => {
  const result = run('touch ' + path.join(repo, 'unclaimed.txt'));
  expectUnqualifiedCodex(result);
});
test.each(['owner', 'foreign', 'unclaimed'])(
  'supported Bash profile preserves the %s ownership decision',
  (kind) => {
    const target =
      kind === 'owner'
        ? path.join(owned, 'src/owned/file.js')
        : kind === 'foreign'
          ? path.join(foreign, 'src/foreign/file.js')
          : path.join(repo, 'unclaimed.txt');
    const result = run('touch ' + target, { surface: 'claude-code' });
    expect(result.status).toBe(kind === 'foreign' ? 2 : 0);
    if (kind === 'foreign') {
      expect(result.stderr).toContain("worktree 'foreign'");
      expect(result.stderr).toContain('owned by a DIFFERENT session');
    } else
      expect({ stdout: result.stdout, stderr: result.stderr }).toEqual({ stdout: '', stderr: '' });
    expect(fs.existsSync(target)).toBe(false);
  }
);
test('a non-Codex harness keeps its existing payload-cwd ownership decision', () => {
  const result = run('touch src/owned/file.js', { surface: 'claude-code' });
  expect(result.status).toBe(2);
  expect(result.stderr).toContain('owned:src/owned');
  expect(result.stderr).not.toContain('unavailable-native-context');
});
test('non-Bash Stop remains a clean self-filtered pass', () => {
  const result = run('', { event: 'Stop', tool: 'Stop' });
  expect(result.status).toBe(0);
  expect(result.stdout).toBe('');
});
