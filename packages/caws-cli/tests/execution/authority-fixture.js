const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { makeTempRepo, cleanupAll: cleanupRepos, git } = require('../helpers/git-repo-factory');
const { initProject } = require('../../dist/store/init-store');
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const image = (name) => {
  const physical = fs.realpathSync.native(name);
  return { path: physical, sha256: hash(fs.readFileSync(physical)) };
};
const renamedRoots = [];
let reportedHost = false;
function systemImageMetadata(file) {
  try {
    const physical = fs.realpathSync.native(file);
    const stat = fs.statSync(physical);
    const parent = fs.statSync(path.dirname(physical));
    return {
      logical: file,
      physical,
      basename: path.basename(physical),
      uid: stat.uid,
      mode: stat.mode & 0o777,
      regular: stat.isFile(),
      parent: { path: path.dirname(physical), uid: parent.uid, mode: parent.mode & 0o777 },
      sha256: stat.isFile() ? hash(fs.readFileSync(physical)) : null,
    };
  } catch (error) {
    return { logical: file, error: error.code ?? error.message };
  }
}
function reportExecutionHost(root) {
  if (reportedHost || process.env.CAWS_TEST_EXECUTION_HOST_CENSUS !== '1') return;
  reportedHost = true;
  // Match lifecycleChildEnvironment's Git environment without a home tuple.
  // The additional private-HOME probe separates global from system/local keys.
  const environment = {
    PATH: `${path.dirname(fs.realpathSync.native(process.execPath))}:/usr/bin:/bin`,
    LC_ALL: 'C',
    GIT_OPTIONAL_LOCKS: '0',
  };
  const configurations = [
    ['effective-default', environment, []],
    ['effective-private-home', { ...environment, HOME: root }, []],
    ['local', environment, ['--local']],
  ].map(([scope, env, flags]) => {
    const args = [
      'config',
      ...flags,
      '--null',
      '--list',
      '--no-includes',
      '--show-origin',
      '--show-scope',
      '--name-only',
    ];
    const result = spawnSync('/usr/bin/git', args, {
      cwd: root,
      env,
      encoding: 'utf8',
      timeout: 2000,
      maxBuffer: 65536,
    });
    const fields = (result.stdout ?? '').split('\0');
    if (fields.at(-1) === '') fields.pop();
    const records = [];
    if (fields.length % 3 === 0) {
      for (let index = 0; index < fields.length; index += 3) {
        const key = fields[index + 2];
        records.push({
          scope: fields[index],
          origin: fields[index + 1],
          ...(/^[a-z][a-z0-9_.-]{0,255}$/i.test(key)
            ? { key }
            : { keySha256: hash(Buffer.from(key)) }),
        });
      }
    }
    return {
      scope,
      args,
      status: result.status,
      signal: result.signal,
      error: result.error?.message ?? null,
      records,
      fieldCount: fields.length,
      unparsed: fields.length % 3 !== 0,
    };
  });
  process.stderr.write(
    'CAWS execution host census (initial fixture; no configuration values): ' +
      JSON.stringify({
        platform: process.platform,
        arch: process.arch,
        root,
        configurations,
        images: [
          '/usr/bin/git',
          '/bin/bash',
          '/bin/cat',
          '/usr/bin/grep',
          '/usr/bin/head',
          '/usr/bin/tail',
          '/usr/bin/wc',
          '/bin/ls',
          '/usr/bin/cut',
          '/usr/bin/tr',
          '/usr/bin/uniq',
        ].map(systemImageMetadata),
      }) +
      '\n'
  );
}
function cleanupAll() {
  cleanupRepos();
  for (const root of renamedRoots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
}
function authorityFixture({ canonicalLF = false } = {}) {
  let root = fs.realpathSync.native(makeTempRepo());
  if (canonicalLF) {
    const moved = root + '\n';
    fs.renameSync(root, moved);
    root = moved;
    renamedRoots.push(root);
  }
  const initialized = initProject(root);
  if (!initialized.ok) throw new Error('Fixture initialization failed');
  const caws = path.join(root, '.caws');
  const lane = path.join(root, 'owned\nlane');
  git(root, ['worktree', 'add', '-b', 'owned', lane]);
  fs.mkdirSync(path.join(lane, 'src'));
  fs.mkdirSync(path.join(lane, '.caws'));
  const spec = {
    id: 'EXEC-001',
    title: 'Owned fixture authority',
    mode: 'fix',
    lifecycle_state: 'active',
    worktree: 'owned',
    blast_radius: { modules: ['fixture'] },
    scope: { in: ['src/'], out: ['private/'] },
    invariants: ['Only the current owner may mutate admitted paths'],
    acceptance: [
      { id: 'A1', given: 'owned context', when: 'checked', then: 'authority is derived' },
    ],
    non_functional: {},
    contracts: [],
  };
  const specPath = path.join(caws, 'specs', 'EXEC-001.yaml');
  fs.writeFileSync(specPath, JSON.stringify(spec));
  const registry = {
    owned: {
      path: lane,
      specId: spec.id,
      owner: { session_id: 'thread-owned', platform: 'codex' },
    },
  };
  const registryPath = path.join(caws, 'worktrees.json');
  fs.writeFileSync(registryPath, JSON.stringify(registry));
  const shell = image('/bin/bash');
  const record = {
    schema: 'caws.execution.prepared.v1',
    invocationId: 'fixture-invocation',
    association: {
      kind: 'codex-mcp-v1',
      sessionId: 'lineage-foreign',
      threadId: 'thread-owned',
      callId: 'native-call',
      callerAnchor: lane,
      serverEnvironmentId: 'server-env',
    },
    projectRoot: root,
    execution: {
      executable: shell,
      argv: [shell.path, '--noprofile', '--norc', '-c', ''],
      cwd: lane,
      environment: [
        { name: 'LC_ALL', value: 'C' },
        {
          name: 'PATH',
          value: [
            ...new Set(['/usr/bin', '/bin'].map((name) => fs.realpathSync.native(name))),
          ].join(':'),
        },
      ],
      stdinBase64: '',
    },
    profile: { kind: 'bash-clean-v1', source: '', utilities: [] },
    sandbox: {
      stateBase64: 'e30=',
      stateSha256: hash(Buffer.from('{}')),
      launcher: image(process.execPath),
      environmentAnchor: root,
    },
    limits: {
      preparationDeadlineUnixMs: Date.now() + 30000,
      jobTimeoutMs: 60000,
      terminationGraceMs: 1000,
      maxOutputBytes: 1048576,
    },
  };
  reportExecutionHost(root);
  return { root, caws, lane, spec, specPath, registry, registryPath, record };
}
function source(fixture, command, utilities = []) {
  fixture.record.profile.source = command;
  fixture.record.execution.argv[4] = command;
  fixture.record.profile.utilities = utilities.map(image);
  return fixture.record;
}
module.exports = { authorityFixture, cleanupAll, source, hash, image, systemImageMetadata };
