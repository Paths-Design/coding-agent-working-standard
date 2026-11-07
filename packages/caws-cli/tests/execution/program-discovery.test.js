const fs = require('node:fs');
const path = require('node:path');
const { spawnCoveredSync } = require('./child-coverage.cjs');
const { authorityFixture, cleanupAll, source, hash } = require('./authority-fixture');
const { encodeAuthorizerReply } = require('../../dist/execution/protocol');
const { encodeProgramDiscoveryReply } = require('../../dist/execution/program-discovery');
afterAll(cleanupAll);
function request(record) {
  const bytes = Buffer.from(JSON.stringify(record));
  return {
    protocol: 'caws.execution.authorizer.v1',
    phase: 'analyze',
    invocationId: record.invocationId,
    recordBase64: bytes.toString('base64'),
    executionDigest: hash(bytes),
    expectedAuthorityRevision: null,
    fence: null,
  };
}
function run(
  record,
  {
    entry = 'program-discovery-main.js',
    envelope = request(record),
    suffix = Buffer.alloc(0),
    timeout = 5000,
    lifecycleEnvironment = {},
  } = {}
) {
  const body = Buffer.from(JSON.stringify(envelope));
  const header = Buffer.alloc(4);
  header.writeUInt32BE(body.length);
  const child = spawnCoveredSync(
    process.execPath,
    [path.resolve(__dirname, '../../dist/execution', entry)],
    {
      input: Buffer.concat([header, body, suffix]),
      env: { PATH: '/usr/bin:/bin', LC_ALL: 'C', ...lifecycleEnvironment },
      timeout,
      maxBuffer: 1048576,
    }
  );
  return { child, envelope };
}
function observation(result) {
  expect(result.child.status).toBe(0);
  expect(result.child.stderr.toString()).toBe('');
  expect(result.child.stdout.readUInt32BE()).toBe(result.child.stdout.length - 4);
  const value = JSON.parse(result.child.stdout.subarray(4).toString());
  expect(value.invocationId).toBe(result.envelope.invocationId);
  expect(value.executionDigest).toBe(result.envelope.executionDigest);
  return value;
}
describe('private nonexecuting draft program discovery', () => {
  test('private startup hook authority reaches lifecycle discovery without executing the hook', () => {
    const f = authorityFixture();
    const { git } = require('../helpers/git-repo-factory');
    const hooksDirectory = path.join(f.root, '.git/hooks');
    git(f.root, ['config', 'core.hooksPath', hooksDirectory]);
    const target = path.join(hooksDirectory, 'pre-commit');
    const marker = path.join(f.root, 'must-not-run-hook');
    fs.writeFileSync(target, `#!/bin/sh\nprintf bad > '${marker}'\n`, { mode: 0o755 });
    const names = [
      'applypatch-msg',
      'pre-applypatch',
      'post-applypatch',
      'pre-commit',
      'pre-auto-gc',
      'pre-merge-commit',
      'prepare-commit-msg',
      'commit-msg',
      'post-commit',
      'post-checkout',
      'post-merge',
      'pre-push',
      'pre-rebase',
      'post-rewrite',
      'reference-transaction',
      'post-index-change',
      'push-to-checkout',
      'proc-receive',
      'update',
      'pre-receive',
      'post-receive',
      'post-update',
    ];
    const hooks = Object.fromEntries(names.map((name) => [name, null]));
    const stat = fs.lstatSync(target, { bigint: true });
    hooks['pre-commit'] = {
      path: target,
      sha256: hash(fs.readFileSync(target)),
      dev: stat.dev.toString(),
      ino: stat.ino.toString(),
      mode: stat.mode.toString(),
    };
    const home = path.join(f.root, 'runtime-home');
    fs.mkdirSync(path.join(home, '.codex'), { recursive: true });
    fs.mkdirSync(path.join(home, 'machine'));
    const policy = path.join(home, 'lifecycle-hooks.json');
    fs.writeFileSync(
      policy,
      JSON.stringify({
        schema: 'caws.execution.git-hook-policy.v2',
        roots: [f.root, f.lane].map((cwd) => ({
          cwd,
          hooksDirectory,
          hooks,
          formatters: { eslint: null, prettier: null },
          readOnlyPaths: [],
        })),
      })
    );
    const lifecycleEnvironment = {
      HOME: home,
      CODEX_HOME: path.join(home, '.codex'),
      CAWS_HOME: path.join(home, 'machine'),
      CAWS_EXECUTION_GIT_HOOK_POLICY: policy,
      CAWS_EXECUTION_GIT_HOOK_POLICY_SHA256: hash(fs.readFileSync(policy)),
    };
    const entry = path.resolve(__dirname, '../../dist/execution/lifecycle-main.js');
    source(f, `'${process.execPath}' '${entry}' git-status`);
    for (const [name, value] of Object.entries({
      CAWS_EXECUTION_PROJECT: f.root,
      CAWS_EXECUTION_CALLER: f.lane,
      CAWS_EXECUTION_SESSION: f.record.association.sessionId,
      CAWS_EXECUTION_THREAD: f.record.association.threadId,
      CAWS_EXECUTION_CALL: f.record.association.callId,
    }))
      f.record.execution.environment.push({ name, value });
    f.record.execution.environment.sort((a, b) =>
      Buffer.compare(Buffer.from(a.name), Buffer.from(b.name))
    );
    f.record.execution.environment.find((row) => row.name === 'PATH').value = [
      ...new Set(
        [path.dirname(process.execPath), '/usr/bin', '/bin'].map((dir) =>
          fs.realpathSync.native(dir)
        )
      ),
    ].join(':');
    const authority = require('../../dist/execution/lifecycle').readExecutionLifecycleAuthority(
      {
        ...f.record,
        execution: {
          ...f.record.execution,
          environment: [
            ...f.record.execution.environment,
            ...Object.entries(lifecycleEnvironment).map(([name, value]) => ({ name, value })),
          ],
        },
      },
      { operation: 'git-status' }
    );
    expect(authority.specId).toBe('EXEC-001');
    expect(observation(run(f.record)).status).toBe('unresolved');
    const admitted = observation(run(f.record, { lifecycleEnvironment }));
    expect({ status: admitted.status, reasonCodes: admitted.reasonCodes }).toEqual({
      status: 'observed',
      reasonCodes: [],
    });
    expect(admitted.execution).toEqual({
      kind: 'caws-lifecycle-v1',
      argv: [process.execPath, entry, 'git-status'],
    });
    expect(fs.existsSync(marker)).toBe(false);
    fs.writeFileSync(path.join(f.lane, 'src/owned.txt'), 'owned source\n');
    const message = 'fix: keep multiline data\n\n- Preserve printf text > protected.txt as data';
    const quotedMessage = `'${message.replace(/'/g, "'\\''")}'`;
    source(
      f,
      `'${process.execPath}' '${entry}' git-commit --message ${quotedMessage} -- src/owned.txt`
    );
    const commit = observation(run(f.record, { lifecycleEnvironment }));
    expect(commit.status).toBe('observed');
    expect(commit.execution).toEqual({
      kind: 'caws-lifecycle-v1',
      argv: [process.execPath, entry, 'git-commit', '--message', message, '--', 'src/owned.txt'],
    });
    expect(fs.existsSync(marker)).toBe(false);
    fs.writeFileSync(target, '#!/bin/sh\nexit 1\n');
    const changed = observation(run(f.record, { lifecycleEnvironment }));
    expect(changed.status).toBe('unresolved');
    expect(changed.reasonCodes).toEqual(['authority_changed']);
    expect(fs.existsSync(marker)).toBe(false);
  });
  test('Cargo captures the unchanged standalone project and exact advisory argv without executing it', () => {
    const f = authorityFixture();
    const { git } = require('../helpers/git-repo-factory');
    const lane = path.join(f.root, 'cargo-owned');
    git(f.root, ['worktree', 'move', f.lane, lane]);
    f.lane = lane;
    f.registry.owned.path = lane;
    fs.writeFileSync(f.registryPath, JSON.stringify(f.registry));
    f.record.association.callerAnchor = lane;
    f.record.execution.cwd = lane;
    const pkg = path.join(lane, 'rust-probe');
    fs.mkdirSync(path.join(pkg, 'src'), { recursive: true });
    fs.writeFileSync(
      path.join(pkg, 'Cargo.toml'),
      '[package]\nname="actual-probe"\nversion="0.1.0"\nedition="2024"\n'
    );
    fs.writeFileSync(
      path.join(pkg, 'Cargo.lock'),
      'version = 4\n[[package]]\nname="actual-probe"\nversion="0.1.0"\n'
    );
    fs.writeFileSync(path.join(pkg, 'src/main.rs'), 'fn main() { panic!("must not execute"); }\n');
    const files = ['Cargo.toml', 'Cargo.lock', 'src/main.rs'].map((name) => path.join(pkg, name));
    const before = files.map((name) => fs.readFileSync(name));
    source(f, 'cargo run --manifest-path rust-probe/Cargo.toml');
    const value = observation(run(f.record));
    expect(value.status).toBe('observed');
    expect(value.commands).toEqual([]);
    expect(value.execution).toEqual({
      kind: 'cargo-run-v1',
      argv: ['cargo', 'run', '--manifest-path', 'rust-probe/Cargo.toml'],
      cargoProject: require('../../dist/execution/cargo-project').snapshotCargoProject(
        lane,
        'rust-probe/Cargo.toml',
        Date.now() + 30000
      ),
    });
    expect(value.execution.cargoProject.packageName).toBe('actual-probe');
    expect(files.map((name) => fs.readFileSync(name))).toEqual(before);
    expect(fs.existsSync(path.join(pkg, 'target'))).toBe(false);
    for (const invalid of [
      'cargo run --manifest-path ../Cargo.toml',
      'cargo run --manifest-path .caws/Cargo.toml',
      'cargo run --manifest-path rust-probe/Cargo.toml --release',
      'cargo run --manifest-path "rust-probe/Cargo.toml"',
    ]) {
      source(f, invalid);
      expect(observation(run(f.record)).execution).toBeNull();
    }
  });
  test('lifecycle discovery resolves canonical merge before ordinary edit authority and keeps the complete pinned argv', () => {
    const f = authorityFixture();
    const { git } = require('../helpers/git-repo-factory');
    f.registry.owned.branch = 'owned';
    f.registry.owned.baseBranch = git(f.root, ['branch', '--show-current']);
    fs.writeFileSync(f.registryPath, JSON.stringify(f.registry));
    f.record.association.callerAnchor = f.root;
    f.record.execution.cwd = f.root;
    const argv = [
      fs.realpathSync.native(process.execPath),
      path.resolve(__dirname, '../../dist/execution/lifecycle-main.js'),
      'worktree-merge',
      '--worktree',
      'owned',
      '--spec',
      'EXEC-001',
    ];
    const quoted = argv.map((value) => "'" + value.replaceAll("'", "'\\''") + "'").join(' ');
    source(f, quoted);
    for (const [name, value] of Object.entries({
      CAWS_EXECUTION_PROJECT: f.root,
      CAWS_EXECUTION_CALLER: f.root,
      CAWS_EXECUTION_SESSION: f.record.association.sessionId,
      CAWS_EXECUTION_THREAD: f.record.association.threadId,
      CAWS_EXECUTION_CALL: f.record.association.callId,
    }))
      f.record.execution.environment.push({ name, value });
    f.record.execution.environment.sort((a, b) =>
      Buffer.compare(Buffer.from(a.name), Buffer.from(b.name))
    );
    f.record.execution.environment.find((entry) => entry.name === 'PATH').value = [
      ...new Set(
        [path.dirname(process.execPath), '/usr/bin', '/bin'].map((dir) =>
          fs.realpathSync.native(dir)
        )
      ),
    ].join(':');
    const before = fs.readFileSync(f.registryPath);
    const result = observation(run(f.record, { timeout: 30000 }));
    expect(result.status).toBe('observed');
    expect(result.execution).toEqual({ kind: 'caws-lifecycle-v1', argv });
    expect(result.commands).toEqual(
      [argv[0], argv[1], '/usr/bin/git'].sort((a, b) =>
        Buffer.compare(Buffer.from(a), Buffer.from(b))
      )
    );
    expect(fs.readFileSync(f.registryPath)).toEqual(before);
    expect(fs.existsSync(f.lane)).toBe(true);
    for (const changed of [
      quoted + '; true',
      quoted + ' > redirected',
      'CAWS_FAKE=1 ' + quoted,
      quoted + ' &',
      quoted.replace("'worktree-merge'", '"$OPERATION"'),
    ]) {
      source(f, changed);
      expect(observation(run(f.record, { timeout: 30000 })).execution).toBeNull();
    }
    expect(fs.existsSync(path.join(f.root, 'redirected'))).toBe(false);
  });
  test('observes only the exact npm test source without resolving npm from caller PATH', () => {
    const f = authorityFixture();
    fs.writeFileSync(
      path.join(f.lane, 'package.json'),
      JSON.stringify({ scripts: { test: 'node tests/run.js' } })
    );
    source(f, 'npm test');
    const exact = observation(run(f.record));
    expect(exact.status).toBe('observed');
    expect(exact.commands).toEqual([]);
    expect(exact.execution).toEqual({
      kind: 'npm-test-v1',
      argv: ['npm', 'test'],
      project: expect.objectContaining({ testScript: 'node tests/run.js', npmrc: null }),
    });
    expect(exact.reasonCodes).toEqual([]);
    for (const altered of [
      'npm test -- --watch',
      'npm run test',
      'npm test; true',
      'PATH=/tmp npm test',
    ]) {
      source(f, altered);
      const result = observation(run(f.record));
      expect(result.status).toBe('unresolved');
      expect(result.commands).toEqual([]);
    }
  });
  test('lowers only the literal dedicated consumer and retains quoted metadata as argv data', () => {
    const f = authorityFixture();
    const argv = [
      require('node:fs').realpathSync.native(process.execPath),
      path.resolve(__dirname, '../../dist/execution/writer-main.js'),
      'specs',
      'evidence',
      'EXEC-001',
      '--ac',
      'A1',
      '--status',
      'unchecked',
      '--evidence-ref',
      'node /tmp/read.js; $(touch /foreign)\n{braces}',
    ];
    const quoted = argv.map((value) => "'" + value.replaceAll("'", "'\\''") + "'").join(' ');
    source(f, quoted);
    for (const [name, value] of Object.entries({
      CAWS_EXECUTION_PROJECT: f.root,
      CAWS_EXECUTION_CALLER: f.lane,
      CAWS_EXECUTION_SESSION: f.record.association.sessionId,
      CAWS_EXECUTION_THREAD: f.record.association.threadId,
      CAWS_EXECUTION_CALL: f.record.association.callId,
    }))
      f.record.execution.environment.push({ name, value });
    f.record.execution.environment.sort((a, b) =>
      Buffer.compare(Buffer.from(a.name), Buffer.from(b.name))
    );
    const result = observation(run(f.record));
    expect(result.status).toBe('observed');
    expect(result.execution).toEqual({ kind: 'caws-evidence-v1', argv });
    expect(result.commands).toEqual(
      [argv[0], argv[1], '/usr/bin/git'].sort((a, b) =>
        Buffer.compare(Buffer.from(a), Buffer.from(b))
      )
    );
    expect(fs.readFileSync(f.specPath, 'utf8')).not.toContain('evidence_ref');
    source(f, quoted + '; printf bad > ../foreign-marker');
    const refused = observation(run(f.record));
    expect(refused.execution).toBeNull();
    expect(fs.existsSync(path.join(f.root, 'foreign-marker'))).toBe(false);
  });
  test('observes finite lexical utilities through assignments and command wrappers exactly once', () => {
    const f = authorityFixture();
    source(
      f,
      'reader=sed; file="notes\nfile.txt"; command -- "$reader" -n 1p -- "$file"; /bin/cat src/data; sed -n 2p src/data; printf done'
    );
    const result = observation(run(f.record));
    expect(result).toEqual({
      protocol: 'caws.execution.program-discovery.v1',
      invocationId: f.record.invocationId,
      executionDigest: request(f.record).executionDigest,
      status: 'observed',
      commands: ['/bin/cat', 'sed'],
      execution: null,
      reasonCodes: [],
    });
    expect(fs.readdirSync(path.join(f.lane, 'src'))).toEqual([]);
  });
  test('uses inherited data without exposing arguments, environment or stdin in the reply', () => {
    const f = authorityFixture();
    f.record.execution.environment.push(
      { name: 'READER', value: 'sed' },
      { name: 'SECRET', value: 'private-data-value' }
    );
    f.record.execution.environment.sort((a, b) =>
      Buffer.compare(Buffer.from(a.name), Buffer.from(b.name))
    );
    f.record.execution.stdinBase64 = Buffer.from('private-stdin-value').toString('base64');
    source(f, '"$READER" -n 1p src/data; printf "%s" "$SECRET"');
    const result = observation(run(f.record));
    expect(result.status).toBe('observed');
    expect(result.commands).toEqual(['sed']);
    expect(JSON.stringify(result)).not.toContain('private-data-value');
    expect(JSON.stringify(result)).not.toContain(f.record.execution.stdinBase64);
  });
  test('a pinned Node candidate can be resolved into a different final record which is still analyzed', () => {
    const f = authorityFixture();
    f.record.execution.environment.find((entry) => entry.name === 'PATH').value = [
      ...new Set(
        [path.dirname(process.execPath), '/usr/bin', '/bin'].map((dir) =>
          fs.realpathSync.native(dir)
        )
      ),
    ].join(':');
    const command = 'node -e \'console.log({kind:"data",values:[1,2]})\'';
    source(f, command);
    const draft = observation(run(f.record));
    expect(draft.status).toBe('observed');
    expect(draft.commands).toEqual(['node']);
    source(f, command, [process.execPath]);
    const final = observation(run(f.record, { entry: 'authorizer-main.js' }));
    expect(final.executionDigest).not.toBe(draft.executionDigest);
    expect(final.decision).toBe('allow');
    expect(final.reasonCodes).toEqual([]);
  });
  test('empty candidates and a completed metadata observation confer no write admission', () => {
    const f = authorityFixture();
    source(f, 'printf no > outside.txt');
    const draft = observation(run(f.record));
    expect(draft.status).toBe('observed');
    expect(draft.commands).toEqual([]);
    expect(() => encodeAuthorizerReply(draft)).toThrow('Invalid execution authorizer frame');
    const final = observation(run(f.record, { entry: 'authorizer-main.js' }));
    expect(final.decision).toBe('deny');
    expect(final.reasonCodes).toEqual(['scope_refused']);
    expect(fs.existsSync(path.join(f.lane, 'outside.txt'))).toBe(false);
  });
  test.each([
    ['unknown command value', '"$missing" arg', 'source_unresolved'],
    ['malformed source', 'if', 'source_unresolved'],
    ['unsupported environment change', 'PATH=/tmp; cat src/data', 'source_unresolved'],
    ['known executable sed', 'sed -n "1e touch sentinel" src/data', 'source_denied'],
    ['too many wrappers', `${'command '.repeat(9)}sed src/data`, 'unsupported_profile'],
  ])('holds %s with no partial candidate result', (_name, command, reason) => {
    const f = authorityFixture();
    source(f, command);
    const result = observation(run(f.record));
    expect(result.status).toBe('unresolved');
    expect(result.commands).toEqual([]);
    expect(result.reasonCodes).toEqual([reason]);
    expect(fs.existsSync(path.join(f.lane, 'sentinel'))).toBe(false);
  });
  test('holds foreign ownership, expired preparation and records which are not empty-manifest drafts', () => {
    const f = authorityFixture();
    source(f, 'printf ok');
    f.record.association.threadId = 'foreign';
    expect(observation(run(f.record)).reasonCodes).toEqual(['foreign_owner']);
    f.record.association.threadId = 'thread-owned';
    f.record.limits.preparationDeadlineUnixMs = Date.now() - 1;
    expect(observation(run(f.record)).reasonCodes).toEqual(['deadline_expired']);
    f.record.limits.preparationDeadlineUnixMs = Date.now() + 30000;
    source(f, 'sed src/data', ['/usr/bin/sed']);
    expect(observation(run(f.record)).reasonCodes).toEqual(['invalid_record']);
  });
  test('refuses final-validation purpose and trailing bytes instead of consuming a fence or printing admission', () => {
    const f = authorityFixture();
    source(f, 'printf ok');
    const final = {
      ...request(f.record),
      phase: 'final_validate',
      expectedAuthorityRevision: 'revision',
      fence: { dev: '1', ino: '2', nonce: 'nonce' },
    };
    expect(observation(run(f.record, { envelope: final })).reasonCodes).toEqual(['invalid_record']);
    const invalid = run(f.record, { suffix: Buffer.from('x') }).child;
    expect(invalid.status).toBe(2);
    expect(invalid.stdout.length).toBe(0);
    expect(invalid.stderr.toString()).toBe(
      'Execution program discovery input or infrastructure failure\n'
    );
  });
  test('bounds the private reply without returning an oversized or partial candidate set', () => {
    const reply = {
      protocol: 'caws.execution.program-discovery.v1',
      invocationId: 'id',
      executionDigest: '0'.repeat(64),
      status: 'observed',
      commands: ['a'.repeat(65536)],
      execution: null,
      reasonCodes: [],
    };
    const frame = encodeProgramDiscoveryReply(reply);
    expect(frame.readUInt32BE()).toBe(frame.length - 4);
    expect(frame.length).toBeLessThan(65540);
    expect(JSON.parse(frame.subarray(4).toString())).toEqual({
      ...reply,
      status: 'unresolved',
      commands: [],
      reasonCodes: ['source_unresolved'],
    });
  });
  test('holds excessive candidate count and byte length without returning a partial list', () => {
    const f = authorityFixture();
    source(f, Array.from({ length: 257 }, (_, index) => `program${index}`).join('; '));
    const many = observation(run(f.record));
    expect(many.status).toBe('unresolved');
    expect(many.commands).toEqual([]);
    expect(many.reasonCodes).toEqual(['source_unresolved']);
    f.record.execution.environment.push({ name: 'BIG_COMMAND', value: 'x'.repeat(4097) });
    f.record.execution.environment.sort((a, b) =>
      Buffer.compare(Buffer.from(a.name), Buffer.from(b.name))
    );
    source(f, '"$BIG_COMMAND"');
    const large = observation(run(f.record));
    expect(large.status).toBe('unresolved');
    expect(large.commands).toEqual([]);
    expect(large.reasonCodes).toEqual(['source_unresolved']);
  });
});
