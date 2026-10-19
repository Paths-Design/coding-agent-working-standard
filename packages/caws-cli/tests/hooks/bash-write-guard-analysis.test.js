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
test('read-only Git after opaque interpreter code does not require metadata ownership', () => {
  const result = guard("node <<'JS'\nconst fn = x => x;\nJS\ngit status --short");
  expect({ status: result.status, stderr: result.stderr }).toEqual({ status: 0, stderr: '' });
  const write = guard("node <<'JS'\nconst fn = x => x;\nJS\ngit add -- file");
  expect(write.status).toBe(2);
  expect(write.stderr).toContain('metadata-coordinate-unresolved');
});
test('source-selected Git pager code remains unresolved while ordinary data is admitted', () => {
  const marker = path.join(fx.sibling, 'pager-marker');
  refused('PAGER=' + quote('printf pager > ' + marker) + ' git log --oneline', 'git-environment');
  expect(guard('PAGER=cat git log --oneline').status).toBe(0);
  expect(guard('DATA=' + quote('printf pager > ' + marker) + ' git log --oneline').status).toBe(0);
  expect(fs.existsSync(marker)).toBe(false);
});
test('nested Git cannot borrow launcher coordinates after source rebinds an exported variable', () => {
  const inherited = { GIT_DIR: path.join(fx.project, '.git') };
  const rebound = guard(
    'GIT_DIR=' + quote(path.join(fx.sibling, '.git')) + "; bash -c 'git add -- file'",
    inherited
  );
  expect(rebound.status).toBe(2);
  expect(rebound.stderr).toContain('mutation-shell-environment');
  const unchanged = guard(
    'GIT_DIR=' + quote(inherited.GIT_DIR) + "; bash -c 'git add -- file'",
    inherited
  );
  expect({ status: unchanged.status, stderr: unchanged.stderr }).toEqual({ status: 0, stderr: '' });
});
test('an actual Node payload still blocks a foreign literal write', () => {
  refused(
    "node <<'NODE'\nrequire('fs').writeFileSync('" + fx.sibling + "/x.txt', 'x');\nNODE",
    fx.sibling
  );
  expect(fs.existsSync(path.join(fx.sibling, 'x.txt'))).toBe(false);
});
test.each([
  ['combined sed in-place options', (target) => 'sed -ni -e p ' + quote(target), 'sed-option'],
  ['uniq output operand', (target) => 'uniq /dev/null ' + quote(target), 'reader-output'],
  ['sort output option', (target) => 'sort -o ' + quote(target) + ' /dev/null', 'reader-option'],
])('%s cannot discard an unmodeled write role', (_label, command, reason) => {
  refused(command(path.join(fx.sibling, 'out')), reason);
  expect(fs.existsSync(path.join(fx.sibling, 'out'))).toBe(false);
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
  return {
    schema: 'caws.shell_mutation_view.v1',
    tokens,
    issues: [],
    interpreters: [],
    gitMetadata: [],
  };
}
function git(command, cwd = fx.project) {
  return execFileSync('git', command, {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' },
  }).trim();
}
function metadataWorktrees() {
  git([
    '-c',
    'user.name=Fixture',
    '-c',
    'user.email=fixture@example.invalid',
    'commit',
    '-q',
    '--allow-empty',
    '-m',
    'fixture',
  ]);
  const own = path.join(fx.project, '.caws/worktrees/own');
  fs.rmdirSync(fx.foreign);
  git(['worktree', 'add', '-q', '-b', 'fixture-foreign', fx.foreign]);
  git(['worktree', 'add', '-q', '-b', 'fixture-own', own]);
  const registry = JSON.parse(fs.readFileSync(path.join(fx.project, '.caws/worktrees.json')));
  registry.own = { name: 'own', path: own, owner: { session_id: 'consumer-fixture-session' } };
  fs.writeFileSync(path.join(fx.project, '.caws/worktrees.json'), JSON.stringify(registry));
  return { own, registry };
}
test.each(['add -- new-file', 'commit --allow-empty -m note'])(
  'Git metadata %s admits canonical and owned contexts but refuses foreign ownership',
  (operation) => {
    const { own } = metadataWorktrees();
    for (const cwd of [fx.project, own]) {
      const result = guard('git -C ' + quote(cwd) + ' ' + operation);
      expect({ status: result.status, stderr: result.stderr }).toEqual({ status: 0, stderr: '' });
    }
    const foreign = refused(
      'git -C ' + quote(fx.foreign) + ' ' + operation,
      "Git metadata for worktree 'foreign'"
    );
    expect(foreign.stderr).toContain('DIFFERENT session');
    refused('git -C ' + quote(fx.sibling) + ' ' + operation, 'DIFFERENT repository');
    // Submitted operations are never executed by preflight.
    expect(git(['log', '--format=%s'])).toBe('fixture');
    expect(git(['status', '--porcelain'], own)).toBe('');
  }
);
test('Git metadata uses the actual common directory and preserves stronger foreign facts', () => {
  const { own } = metadataWorktrees();
  const normal = guard('git -C ' + quote(fx.sibling) + ' status --short');
  expect(normal.status).toBe(0);
  const mixed = refused(
    'git -C ' + quote(fx.foreign) + ' add -- file; touch "$UNKNOWN"',
    'Git metadata'
  );
  expect(mixed.stderr).toContain('DIFFERENT session');
  const view = protocolView([]);
  view.gitMetadata.push({
    subcommand: 'add',
    directory: path.join(fx.project, '.git'),
    common: path.join(fx.sibling, '.git'),
    worktree: own,
    start: 0,
    end: 0,
  });
  const result = guard('fixture', protocolBackend(JSON.stringify(view)));
  expect(result.status).toBe(2);
  expect(result.stderr).toContain('DIFFERENT repository');
});
test.each(['pass:no-active-worktrees', 'git_metadata:pass:unclaimed', 'git_metadata:unknown:x'])(
  'old or incompatible metadata oracle cannot grant admission: %s',
  (response) => {
    fs.writeFileSync(
      path.join(fx.hooks, 'lib/worktree-claim-oracle.cjs'),
      'process.stdout.write(' + JSON.stringify(response + '\n') + ');'
    );
    refused('git add -- file', 'git-metadata-oracle-protocol');
  }
);
test('a protective metadata oracle result survives a later nonzero failure', () => {
  fs.writeFileSync(
    path.join(fx.hooks, 'lib/worktree-claim-oracle.cjs'),
    'process.stdout.write("git_metadata:block_foreign_worktree:foreign:other\\nlate failure\\n"); process.exitCode=1;'
  );
  refused('git add -- file', "Git metadata for worktree 'foreign'");
});
test.each(['unregistered', 'missing-owner', 'duplicate', 'missing-session', 'missing-registry'])(
  'Git metadata refuses uncertain ownership: %s',
  (kind) => {
    const { own, registry } = metadataWorktrees();
    if (kind === 'unregistered') delete registry.own;
    if (kind === 'missing-owner') delete registry.own.owner;
    if (kind === 'duplicate') registry.alias = { ...registry.own, name: 'alias' };
    fs.writeFileSync(path.join(fx.project, '.caws/worktrees.json'), JSON.stringify(registry));
    if (kind === 'missing-registry') fs.unlinkSync(path.join(fx.project, '.caws/worktrees.json'));
    const result = guard(
      'git -C ' + quote(own) + ' add -- file',
      kind === 'missing-session'
        ? {
            HOOK_SESSION_ID: '',
            CAWS_SESSION_ID: '',
            CODEX_THREAD_ID: '',
            CLAUDE_SESSION_ID: '',
            CLAUDE_CODE_SESSION_ID: '',
            QWEN_CODE_SESSION_ID: '',
            DSH_SESSION_ID: '',
            CURSOR_TRACE_ID: '',
            CAWS_CALLER_PID: '',
          }
        : {}
    );
    expect(result.status).toBe(2);
    expect(result.stderr).toContain('Git metadata ownership could not be established');
  }
);
test('Git metadata registry identity uses physical paths through an alias', () => {
  const { own, registry } = metadataWorktrees();
  const alias = path.join(fx.root, 'own-alias');
  fs.symlinkSync(own, alias);
  registry.own.path = alias;
  fs.writeFileSync(path.join(fx.project, '.caws/worktrees.json'), JSON.stringify(registry));
  expect(guard('git -C ' + quote(own) + ' add -- file').status).toBe(0);
});
test('an independent --work-tree cannot lend identity to foreign Git metadata', () => {
  const { own } = metadataWorktrees();
  const foreignDirectory = git(['-C', fx.foreign, 'rev-parse', '--absolute-git-dir']);
  const ownDirectory = git(['-C', own, 'rev-parse', '--absolute-git-dir']);
  for (const target of [fx.project, own]) {
    refused(
      'git --git-dir=' + quote(foreignDirectory) + ' --work-tree=' + quote(target) + ' add -- file',
      "Git metadata for worktree 'foreign'"
    );
  }
  // Distinct metadata with the same reported worktree cannot share an owner-cache entry.
  refused(
    'git add -- file; git --git-dir=' +
      quote(foreignDirectory) +
      ' --work-tree=' +
      quote(fx.project) +
      ' add -- file',
    "Git metadata for worktree 'foreign'"
  );
  const mismatch = guard(
    'git --git-dir=' + quote(ownDirectory) + ' --work-tree=' + quote(fx.project) + ' add -- file'
  );
  expect(mismatch.status).toBe(2);
  expect(mismatch.stderr).toContain('git-metadata-worktree-mismatch');
  expect(
    guard('git --git-dir=' + quote(ownDirectory) + ' --work-tree=' + quote(own) + ' add -- file')
      .status
  ).toBe(0);
});
test('a named mapping mutation invalidates subsequent Git metadata discovery', () => {
  const { own } = metadataWorktrees();
  const pointer = fs.readFileSync(path.join(own, '.git'), 'utf8');
  const result = guard(
    'cp ' +
      quote(path.join(fx.foreign, '.git')) +
      ' ' +
      quote(path.join(own, '.git')) +
      '; git -C ' +
      quote(own) +
      ' add -- file'
  );
  expect(result.status).toBe(2);
  expect(result.stderr).toContain('metadata-coordinate-unresolved');
  expect(fs.readFileSync(path.join(own, '.git'), 'utf8')).toBe(pointer);
});
test.each([';', ' true;'])(
  'a command-substitution mapping mutation invalidates subsequent metadata discovery: %s',
  (assignmentEnd) => {
    const { own } = metadataWorktrees();
    const pointer = fs.readFileSync(path.join(own, '.git'), 'utf8');
    const result = guard(
      'X=$(cp ' +
        quote(path.join(fx.foreign, '.git')) +
        ' ' +
        quote(path.join(own, '.git')) +
        ')' +
        assignmentEnd +
        ' git -C ' +
        quote(own) +
        ' add -- file'
    );
    expect(result.status).toBe(2);
    expect(result.stderr).toContain('metadata-coordinate-unresolved');
    expect(fs.readFileSync(path.join(own, '.git'), 'utf8')).toBe(pointer);
  }
);
test.each(['gitdir', 'commondir', 'forward', 'hardlink', 'symlink'])(
  'nonreciprocal or nonordinary metadata pointers hold: %s',
  (kind) => {
    const { own } = metadataWorktrees();
    const directory = git(['-C', own, 'rev-parse', '--absolute-git-dir']);
    if (kind === 'gitdir')
      fs.writeFileSync(path.join(directory, 'gitdir'), path.join(fx.foreign, '.git') + '\n');
    if (kind === 'commondir')
      fs.writeFileSync(path.join(directory, 'commondir'), fx.sibling + '/.git\n');
    if (kind === 'forward')
      fs.writeFileSync(path.join(own, '.git'), 'gitdir: ' + path.join(fx.project, '.git') + '\n');
    if (kind === 'hardlink')
      fs.linkSync(path.join(directory, 'gitdir'), path.join(fx.root, 'extra-link'));
    if (kind === 'symlink') {
      const stored = path.join(fx.root, 'stored-pointer');
      fs.renameSync(path.join(directory, 'gitdir'), stored);
      fs.symlinkSync(stored, path.join(directory, 'gitdir'));
    }
    const result = guard('git -C ' + quote(own) + ' add -- file');
    expect(result.status).toBe(2);
    if (kind === 'commondir') expect(result.stderr).toContain('DIFFERENT repository');
    else if (kind === 'forward') expect(result.stderr).toContain('git-metadata-worktree-mismatch');
    else expect(result.stderr).toMatch(/git-metadata-mapping|metadata-discovery-failure/);
  }
);
test.each(['directory', 'common'])(
  'external unmarked Git metadata %s needs an explicit ownership answer',
  (field) => {
    const outside = path.join(fx.root, 'external-metadata');
    fs.mkdirSync(outside);
    const view = protocolView([]);
    view.gitMetadata.push({
      subcommand: 'add',
      directory: path.join(fx.project, '.git'),
      common: path.join(fx.project, '.git'),
      worktree: fx.project,
      start: 0,
      end: 0,
      [field]: outside,
    });
    const result = guard('fixture', protocolBackend(JSON.stringify(view)));
    expect(result.status).toBe(2);
    expect(result.stderr).toContain('metadata-outside-project');
  }
);
test.each(['directory', 'common', 'worktree'])(
  'unrepresentable Git metadata %s is never split into a grant',
  (field) => {
    const view = protocolView([]);
    view.gitMetadata.push({
      subcommand: 'add',
      directory: path.join(fx.project, '.git'),
      common: path.join(fx.project, '.git'),
      worktree: fx.project,
      start: 0,
      end: 0,
      [field]: fx.project + '/line\nfield\t',
    });
    const result = guard('fixture', protocolBackend(JSON.stringify(view)));
    expect(result.status).toBe(2);
    expect(result.stderr).toContain('git_metadata_unrepresentable');
  }
);
test('metadata protocol requires the channel even for a read-only result', () => {
  const view = protocolView([]);
  expect(guard('fixture', protocolBackend(JSON.stringify(view))).status).toBe(0);
  delete view.gitMetadata;
  const result = guard('fixture', protocolBackend(JSON.stringify(view)));
  expect(result.status).toBe(2);
  expect(result.stderr).toContain('invalid or incomplete contract');
});
test('metadata discovery cannot borrow an unknown cwd or ignore index routing', () => {
  const unknown = guard('git add -- file', { HOOK_CWD: '' });
  expect(unknown.status).toBe(2);
  expect(unknown.stderr).toContain('metadata-coordinate-unresolved');
  refused(
    'GIT_INDEX_FILE=' + quote(path.join(fx.sibling, 'index')) + ' git add -- file',
    'metadata-coordinate-unresolved'
  );
});
test('missing ownership infrastructure in a governed project fails closed', () => {
  fs.unlinkSync(path.join(fx.hooks, 'lib/worktree-claim-oracle.cjs'));
  refused('git add -- file', 'Ownership infrastructure unavailable');
});
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
