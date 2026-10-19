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
  assert.equal(analyze('git status').decision, 'allow');
  const hostile = analyze(`git -C '${foreign}' status`);
  assert.equal(hostile.status, 1);
  assert.equal(hostile.decision, 'deny');
  assert(hostile.reasons.some((item) => item.code === 'foreign-git-target'));
  const marker = path.join(root, 'payload-executed');
  assert.equal(analyze(`printf '%s' '$(touch ${marker})'`).decision, 'allow');
  assert.equal(fs.existsSync(marker), false);
  console.log(
    JSON.stringify({
      tarballSha256: crypto.createHash('sha256').update(fs.readFileSync(tarball)).digest('hex'),
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
