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
  console.log(
    JSON.stringify({
      tarballSha256,
      parserVersion: parser.version,
      loaderShipped: true,
      consumerDocsShipped: true,
      installedBenign: benign.decision,
      installedHostile: hostile.decision,
      submittedSideEffectObserved: false,
    })
  );
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
