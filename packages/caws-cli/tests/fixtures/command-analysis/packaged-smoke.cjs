// Run explicitly after build. Installs the real tarball in an isolated prefix.
const fs = require('node:fs'),
  os = require('node:os'),
  path = require('node:path'),
  crypto = require('node:crypto');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const linkedRepository = require('./git-fixture.cjs');
const pkg = path.resolve(__dirname, '../../..');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'caws-analysis-package-'));
function run(program, args, options = {}) {
  const child = spawnSync(program, args, {
    encoding: 'utf8',
    shell: false,
    timeout: 300000,
    maxBuffer: 16 * 1024 * 1024,
    ...options,
  });
  if (child.error) throw child.error;
  return child;
}
try {
  const packed = run('npm', ['pack', '--ignore-scripts', '--json', '--pack-destination', root], {
    cwd: pkg,
  });
  assert.equal(packed.status, 0, packed.stderr);
  const metadata = JSON.parse(packed.stdout)[0];
  for (const file of [
    'dist/shell/analysis/load-parser.js',
    'dist/shell/analysis/analyze.js',
    'dist/shell/analysis/mutation-view.js',
    'templates/hook-packs/shared/lib/bash-mutation-analysis.sh',
    'docs/guides/command-analysis.md',
  ])
    assert(
      metadata.files.some((item) => item.path === file),
      `Missing ${file}`
    );
  const tarball = path.join(root, metadata.filename),
    prefix = path.join(root, 'installed');
  const tarballSha256 = crypto.createHash('sha256').update(fs.readFileSync(tarball)).digest('hex');
  console.log(JSON.stringify({ phase: 'packed', tarballSha256 }));
  const installed = run(
    'npm',
    ['install', '--ignore-scripts', '--no-audit', '--no-fund', '--prefix', prefix, tarball],
    { cwd: root }
  );
  assert.equal(installed.status, 0, installed.stderr);
  const installedPkg = path.join(prefix, 'node_modules/@paths.design/caws-cli');
  const packageJson = JSON.parse(fs.readFileSync(path.join(installedPkg, 'package.json'), 'utf8'));
  assert.equal(packageJson.dependencies.unbash, '6.0.0');
  const parser = JSON.parse(
    fs.readFileSync(path.join(prefix, 'node_modules/unbash/package.json'), 'utf8')
  );
  assert.equal(parser.version, '6.0.0');
  const own = path.join(root, 'project/.caws/worktrees/own'),
    foreign = path.join(root, 'project/.caws/worktrees/foreign');
  linkedRepository(path.join(root, 'project'), [own, foreign]);
  const home = path.join(root, 'home');
  fs.mkdirSync(home);
  function analyze(command) {
    const child = run(
      process.execPath,
      [
        path.join(installedPkg, 'dist/index.js'),
        'hooks',
        'analyze',
        '--json',
        '--worktree',
        own,
        '--cwd',
        own,
      ],
      {
        cwd: own,
        env: { ...process.env, HOME: home, CAWS_HOME: path.join(home, '.caws') },
        input: JSON.stringify({ command }),
      }
    );
    const result = JSON.parse(child.stdout);
    assert.equal(result.schema, 'caws.hooks_analyze.v1');
    return { status: child.status, ...result };
  }
  const benign = analyze("P='src/a b.ts'; sed -n '1,40p' \"$P\"");
  assert.equal(benign.status, 0);
  assert.equal(benign.decision, 'allow');
  const ownGit = analyze('git status');
  if (ownGit.decision !== 'allow') {
    const query = run(
      'git',
      [
        '--no-pager',
        '-C',
        own,
        'rev-parse',
        '--path-format=absolute',
        '--absolute-git-dir',
        '--git-common-dir',
        '--is-bare-repository',
        '--show-toplevel',
      ],
      {
        env: {
          ...Object.fromEntries(
            Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_'))
          ),
          HOME: home,
          CAWS_HOME: path.join(home, '.caws'),
          GIT_OPTIONAL_LOCKS: '0',
          GIT_TERMINAL_PROMPT: '0',
          GIT_PAGER: 'cat',
        },
      }
    );
    assert.equal(ownGit.decision, 'allow', JSON.stringify({ ownGit, query }));
  }
  const hostile = analyze(`git -C '${foreign}' status`);
  assert.equal(hostile.status, 1);
  assert.equal(hostile.decision, 'deny');
  assert(hostile.reasons.some((item) => item.code === 'foreign-git-target'));
  const marker = path.join(root, 'payload-executed');
  assert.equal(analyze(`printf '%s' '$(touch ${marker})'`).decision, 'allow');
  assert.equal(fs.existsSync(marker), false);
  const project = path.join(root, 'project');
  fs.writeFileSync(
    path.join(project, '.caws/worktrees.json'),
    JSON.stringify({
      own: {
        name: 'own',
        path: own,
        owner: { session_id: 'package-fixture' },
      },
      foreign: {
        name: 'foreign',
        spec_id: 'FOREIGN',
        path: foreign,
        owner: { session_id: 'other' },
      },
    })
  );
  function writeGuard(command) {
    return run(
      '/bin/bash',
      [path.join(installedPkg, 'templates/hook-packs/shared/bash-write-guard.sh')],
      {
        cwd: own,
        input: '',
        env: {
          ...process.env,
          HOME: home,
          CAWS_HOME: path.join(home, '.caws'),
          CAWS_PROJECT_DIR: project,
          CAWS_BIN: path.join(prefix, 'node_modules/.bin/caws'),
          CAWS_AGENT_SURFACE: 'codex',
          HOOK_TOOL_NAME: 'Bash',
          HOOK_COMMAND: command,
          HOOK_CWD: own,
          HOOK_SESSION_ID: 'package-fixture',
          HOOK_PERMISSION_MODE: 'bypassPermissions',
        },
      }
    );
  }
  const benignInterpreter = writeGuard(
    "node <<'JS'\nconst f = () => { console.log(1, 2); }; const obj = { a: 1, b: 2 }; f();\nJS"
  );
  assert.equal(benignInterpreter.status, 0, benignInterpreter.stderr);
  const benignThenRead = writeGuard("node <<'JS'\nconst fn = x => x;\nJS\ngit status --short");
  assert.equal(benignThenRead.status, 0, benignThenRead.stderr);
  const finiteForeign = writeGuard(`DEST='${foreign}/never-written'; touch "$DEST"`);
  assert.equal(finiteForeign.status, 2, JSON.stringify(finiteForeign));
  assert.match(finiteForeign.stderr, /worktree 'foreign'/);
  const nestedForeign = writeGuard(`bash <<'SH'\nprintf x > '${foreign}/nested-never-written'\nSH`);
  assert.equal(nestedForeign.status, 2, JSON.stringify(nestedForeign));
  const inertInterpreter = writeGuard(
    `node -e 'require("node:fs").writeFileSync("${marker}", "bad")'`
  );
  assert.equal(inertInterpreter.status, 0, inertInterpreter.stderr);
  assert.equal(fs.existsSync(marker), false);
  assert.equal(fs.existsSync(path.join(foreign, 'never-written')), false);
  assert.equal(fs.existsSync(path.join(foreign, 'nested-never-written')), false);
  const ownMetadata = writeGuard('git add -- package-never-written');
  assert.equal(ownMetadata.status, 0, ownMetadata.stderr);
  const foreignMetadata = writeGuard(`git -C '${foreign}' add -- package-never-written`);
  assert.equal(foreignMetadata.status, 2, foreignMetadata.stderr);
  assert.match(foreignMetadata.stderr, /Git metadata for worktree 'foreign'/);
  const directoryQuery = run('git', ['-C', foreign, 'rev-parse', '--absolute-git-dir']);
  assert.equal(directoryQuery.status, 0, directoryQuery.stderr);
  const routedMetadata = writeGuard(
    `git --git-dir='${directoryQuery.stdout.trim()}' --work-tree='${project}' add -- package-never-written`
  );
  assert.equal(routedMetadata.status, 2, routedMetadata.stderr);
  assert.match(routedMetadata.stderr, /Git metadata for worktree 'foreign'/);
  const pointer = fs.readFileSync(path.join(own, '.git'), 'utf8');
  const changedMapping = writeGuard(
    `cp '${foreign}/.git' '${own}/.git'; git add -- package-never-written`
  );
  assert.equal(changedMapping.status, 2, changedMapping.stderr);
  assert.match(changedMapping.stderr, /metadata-coordinate-unresolved/);
  assert.equal(fs.readFileSync(path.join(own, '.git'), 'utf8'), pointer);
  const producerMapping = writeGuard(
    `X=$(cp '${foreign}/.git' '${own}/.git') true; git add -- package-never-written`
  );
  assert.equal(producerMapping.status, 2, producerMapping.stderr);
  assert.match(producerMapping.stderr, /metadata-coordinate-unresolved/);
  assert.equal(fs.readFileSync(path.join(own, '.git'), 'utf8'), pointer);
  console.log(
    JSON.stringify({
      tarballSha256,
      parserVersion: parser.version,
      loaderShipped: true,
      consumerDocsShipped: true,
      installedBenign: benign.decision,
      installedHostile: hostile.decision,
      submittedSideEffectObserved: false,
      packagedWriteGuardBenign: benignInterpreter.status,
      packagedWriteGuardBenignThenRead: benignThenRead.status,
      packagedWriteGuardForeign: finiteForeign.status,
      packagedWriteGuardNestedForeign: nestedForeign.status,
      packagedWriteGuardOwnMetadata: ownMetadata.status,
      packagedWriteGuardForeignMetadata: foreignMetadata.status,
      packagedWriteGuardRoutedMetadata: routedMetadata.status,
      packagedWriteGuardChangedMapping: changedMapping.status,
      packagedWriteGuardProducerMapping: producerMapping.status,
    })
  );
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
