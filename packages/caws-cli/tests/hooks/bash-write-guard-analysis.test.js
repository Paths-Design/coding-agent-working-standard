'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');
const ROOT = path.resolve(__dirname, '../..');
const SHARED = path.join(ROOT, 'templates/hook-packs/shared');
const YAML_MODULES = path.dirname(
  path.dirname(require.resolve('js-yaml/package.json', { paths: [ROOT] }))
);
const quote = (value) => "'" + value.replace(/'/g, "'\\''") + "'";
let fx;
beforeEach(() => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'caws-analysis-consumer-'));
  const project = path.join(root, 'project');
  const sibling = path.join(root, 'sibling');
  const hooks = path.join(root, 'copied-hooks');
  fs.mkdirSync(path.join(project, '.caws/specs'), { recursive: true });
  fs.mkdirSync(path.join(project, 'src'));
  fs.mkdirSync(sibling);
  execFileSync('git', ['init', '-q'], { cwd: project });
  execFileSync('git', ['init', '-q'], { cwd: sibling });
  fs.cpSync(SHARED, hooks, { recursive: true });
  const foreign = path.join(project, '.caws/worktrees/foreign');
  fs.mkdirSync(foreign, { recursive: true });
  fs.writeFileSync(
    path.join(project, '.caws/worktrees.json'),
    JSON.stringify({
      foreign: {
        name: 'foreign',
        spec_id: 'CLAIM',
        path: foreign,
        owner: { session_id: 'foreign-fixture-session' },
        baseBranch: 'main',
      },
    })
  );
  fs.writeFileSync(
    path.join(project, '.caws/specs/CLAIM.yaml'),
    'id: CLAIM\nlifecycle_state: active\nscope:\n  in:\n    - src/claimed.txt\n  out: []\n'
  );
  const cli = path.join(root, 'caws');
  fs.writeFileSync(
    cli,
    '#!/bin/sh\nexec ' +
      quote(process.execPath) +
      ' ' +
      quote(path.join(ROOT, 'dist/index.js')) +
      ' "$@"\n',
    { mode: 0o755 }
  );
  fx = { root, project, sibling, hooks, foreign, cli };
});
afterEach(() => fs.rmSync(fx.root, { recursive: true, force: true }));
function guard(command, extra = {}) {
  return spawnSync('/bin/bash', [path.join(fx.hooks, 'bash-write-guard.sh')], {
    cwd: fx.project,
    encoding: 'utf8',
    input: '',
    timeout: 15000,
    env: {
      ...process.env,
      HOME: fx.root,
      NODE_PATH: YAML_MODULES,
      HOOK_TOOL_NAME: 'Bash',
      HOOK_COMMAND: command,
      HOOK_CWD: fx.project,
      HOOK_SESSION_ID: 'consumer-fixture-session',
      HOOK_PERMISSION_MODE: 'bypassPermissions',
      CAWS_PROJECT_DIR: fx.project,
      CAWS_HOOKS_DIR: fx.hooks,
      CAWS_AGENT_SURFACE: 'codex',
      CAWS_BIN: fx.cli,
      ...extra,
    },
  });
}
function refused(command, message) {
  const result = guard(command);
  expect(result.error).toBeUndefined();
  expect({ status: result.status, stdout: result.stdout, stderr: result.stderr }).toEqual(
    expect.objectContaining({ status: 2 })
  );
  expect(result.stderr).toContain(message);
  return result;
}
test('Node arrow/object data does not fabricate a shell target', () => {
  const result = guard(
    "node <<'NODE'\nconst f = () => { console.log(1, 2); }; const obj = { a: 1, b: 2 }; f();\nNODE"
  );
  expect(result.status).toBe(0);
  expect(result.stderr).not.toContain('ask_dynamic_unconfined');
  expect(fs.readdirSync(fx.sibling)).toEqual(['.git']);
});
test('an actual Node payload still blocks a foreign literal write', () => {
  refused(
    "node <<'NODE'\nrequire('fs').writeFileSync('" + fx.sibling + "/x.txt', 'x');\nNODE",
    fx.sibling
  );
  expect(fs.existsSync(path.join(fx.sibling, 'x.txt'))).toBe(false);
});
test('a shell-fed heredoc retains its real shell write', () => {
  refused("bash <<'SH'\necho x > " + fx.sibling + '/x.txt\nSH', fx.sibling);
});
test('unquoted interpreter heredoc expansions retain nested shell writes', () => {
  refused('node <<NODE\nconsole.log("$(echo x > ' + fx.sibling + '/x.txt)");\nNODE', fx.sibling);
});
test('finite variables reach the existing canonical claim oracle', () => {
  expect(require.resolve('js-yaml', { paths: [ROOT] })).toContain('js-yaml');
  refused('touch src/claimed.txt', 'foreign:src/claimed.txt');
  const result = refused('TARGET=src/claimed.txt; touch "$TARGET"', 'foreign:src/claimed.txt');
  expect(result.stderr).toContain('claimed by an active worktree');
  expect(result.stderr).not.toContain('SKIPPED');
});
test('finite variables retain foreign worktree payload isolation', () => {
  refused('TARGET=' + quote(path.join(fx.foreign, 'x.txt')) + '; touch "$TARGET"', 'foreign');
});
test('missing cwd never borrows the project directory, including an empty registry', () => {
  fs.writeFileSync(path.join(fx.project, '.caws/worktrees.json'), '{}');
  const result = guard('touch relative', { HOOK_CWD: '' });
  expect(result.status).toBe(2);
  expect(result.stderr).toContain(
    "operating cwd could not be resolved for the relative path 'relative'"
  );
  expect(guard('printf safe', { HOOK_CWD: '' }).status).toBe(0);
});
test('unknown cwd retains absolute foreign writes and nested relative uncertainty', () => {
  refused('touch ' + quote(path.join(fx.sibling, 'out')), fx.sibling);
  const absolute = guard('touch ' + quote(path.join(fx.sibling, 'out')), { HOOK_CWD: '' });
  expect(absolute.status).toBe(2);
  expect(absolute.stderr).toContain(fx.sibling);
  const relative = guard("bash -c 'cd /; touch relative'", { HOOK_CWD: '' });
  expect(relative.status).toBe(2);
  expect(relative.stderr).toContain('operating cwd could not be resolved');
});
test('interpreter write verbs without a literal target remain unresolved', () => {
  refused(
    "node <<'NODE'\nrequire('fs').writeFileSync(process.env.DEST, 'x');\nNODE",
    'interpreter_write_target_unresolved'
  );
});
test('text mentioning node and a write verb cannot create an interpreter invocation', () => {
  const result = guard(
    'printf %s ' + quote("node require('fs').writeFileSync('" + fx.sibling + "/x.txt','x')")
  );
  expect(result.status).toBe(0);
});
test.each([
  ['sh -c \'G=printf; G=rm :; "$G" /foreign/x\'', 'mutation-shell-dialect'],
  ["NODE_OPTIONS='--require /tmp/preload.cjs' node -e 'console.log(1)'", 'environment-change'],
])('unmodeled interpreter selection cannot be an empty allow: %s', (command, reason) => {
  refused(command, reason);
});
test('a real entry script is read from the invocation cwd', () => {
  fs.mkdirSync(path.join(fx.project, 'scripts'));
  fs.writeFileSync(
    path.join(fx.project, 'scripts/task.mjs'),
    "import { writeFileSync } from 'node:fs'; writeFileSync('" + fx.sibling + "/x.txt','x');\n"
  );
  refused('cd scripts; node task.mjs', fx.sibling);
});
test.each(['{}', '{"schema":"caws.shell_mutation_view.v1","tokens":[]}'])(
  'invalid CLI response refuses without lexical fallback: %s',
  (response) => {
    const broken = path.join(fx.root, 'broken-caws');
    fs.writeFileSync(broken, '#!/bin/sh\nprintf %s ' + quote(response) + '\n', { mode: 0o755 });
    const result = guard('echo safe', { CAWS_BIN: broken });
    expect(result.status).toBe(2);
    expect(result.stderr).toContain('invalid or incomplete contract');
  }
);
test('missing analyzer and bridge each fail closed', () => {
  let result = guard('echo safe', { CAWS_BIN: path.join(fx.root, 'absent') });
  expect(result.status).toBe(2);
  expect(result.stderr).toContain('no legacy fallback');
  fs.unlinkSync(path.join(fx.hooks, 'lib/bash-mutation-analysis.sh'));
  result = guard('echo safe');
  expect(result.status).toBe(2);
  expect(result.stderr).toContain('no legacy fallback');
});

function protocolBackend(response, exitCode = 0) {
  const cli = path.join(fx.root, 'protocol-caws');
  fs.writeFileSync(cli, '#!/bin/sh\nprintf %s ' + quote(response) + '\nexit ' + exitCode + '\n', {
    mode: 0o755,
  });
  return { CAWS_BIN: cli };
}
function protocolToken(value, kind = 'word') {
  return {
    value,
    kind,
    dynamic: false,
    resolution: '',
    prefix: '',
    prefixBasis: 'none',
    unrepresentable: /[\n\t]/.test(value),
    cwd: fs.realpathSync.native(fx.project),
    start: 0,
    end: 0,
  };
}
function protocolView(tokens) {
  return { schema: 'caws.shell_mutation_view.v1', tokens, issues: [], interpreters: [] };
}
test('NUL framing preserves an empty BSD sed suffix without inventing a target', () => {
  const view = protocolView(
    ['sed', '-i', '', 's/a/b/', path.join(fx.foreign, 'out')].map((value) => protocolToken(value))
  );
  const result = guard('fixture source', protocolBackend(JSON.stringify(view)));
  expect(result.status).toBe(2);
  expect(result.stderr).toContain("worktree 'foreign'");
  expect(result.stderr).not.toContain('invalid or incomplete contract');
});
test('NUL framing retains trailing newline bytes for unrepresentable-target refusal', () => {
  const view = protocolView([protocolToken('touch'), protocolToken('name\n')]);
  const result = guard('fixture source', protocolBackend(JSON.stringify(view)));
  expect(result.status).toBe(2);
  expect(result.stderr).toContain('newline or tab');
});
test('an empty filename is not projected to the execution directory', () => {
  const view = protocolView([protocolToken('touch'), protocolToken('')]);
  const result = guard('fixture source', protocolBackend(JSON.stringify(view)));
  expect(result.status).toBe(0);
  expect(result.stderr).toBe('');
});
test.each(['invalid-boolean', 'embedded-nul', 'multiple-documents', 'nonzero'])(
  'protocol boundary refuses %s',
  (kind) => {
    const token = protocolToken('touch');
    if (kind === 'invalid-boolean') token.dynamic = 'false';
    if (kind === 'embedded-nul') token.value = 'a\0b';
    const view = JSON.stringify(protocolView([token]));
    const response = kind === 'multiple-documents' ? view + '\n' + view : view;
    const result = guard('fixture source', protocolBackend(response, kind === 'nonzero' ? 1 : 0));
    expect(result.status).toBe(2);
    expect(result.stderr).toContain(
      kind === 'nonzero' ? 'analyzer failed' : 'invalid or incomplete contract'
    );
  }
);
