// @ts-check
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { assertGitConfig, assertGitVersion, assertNoGitlinks, category, codepointOrder, compare, declarations, filesystemName, gitEnvironment, inventory, isOptionToken, literalWords, normalizeStamp, resolveRoot, sha256, snapshot } from './hook-harvest.mjs';

/** @param {import('node:test').TestContext} t */
function fixture(t) {
  const retained = process.env.CAWS_HARVEST_TEST_ARTIFACTS;
  if (retained) mkdirSync(retained, { recursive: true });
  const root = mkdtempSync(path.join(retained ?? tmpdir(), 'caws-harvest-'));
  if (!retained) t.after(() => rmSync(root, { recursive: true, force: true }));
  else t.diagnostic(`retained fixture: ${root}`);
  return root;
}
/** @param {string} file @param {string | Buffer} value */
function put(file, value) { mkdirSync(path.dirname(file), { recursive: true }); writeFileSync(file, value); }

/** Fixture repositories never inherit host Git configuration or Git environment overrides. */
function fixtureEnvironment() {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')));
  return { ...env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' };
}

test('Git environment disables trace destinations, preserves allowed configuration and rejects present overrides', () => {
  const original = { PATH: '/fixture/bin', HOME: '/fixture/home', ordinary: 'retained', GIT_CONFIG_GLOBAL: '/fixture/global', GIT_CONFIG_SYSTEM: '', GIT_CONFIG_NOSYSTEM: '1', GIT_TRACE: '/fixture/trace', GIT_TRACE_PACKET: '', GIT_TRACE2: '/fixture/trace2', GIT_TRACE2_EVENT: '/fixture/events', GIT_TRACE2_PERF: '/fixture/perf', GIT_TRACE_FUTURE_DESTINATION: '/fixture/future' };
  const before = { ...original }, result = gitEnvironment(original);
  assert.deepEqual(result, { PATH: '/fixture/bin', HOME: '/fixture/home', ordinary: 'retained', GIT_CONFIG_GLOBAL: '/fixture/global', GIT_CONFIG_SYSTEM: '', GIT_CONFIG_NOSYSTEM: '1', GIT_TRACE2: '0', GIT_TRACE2_EVENT: '0', GIT_TRACE2_PERF: '0' });
  assert.notEqual(result, original); assert.deepEqual(original, before);
  for (const key of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_OBJECT_DIRECTORY', 'GIT_ALTERNATE_OBJECT_DIRECTORIES', 'GIT_CONFIG_COUNT', 'GIT_CONFIG_PARAMETERS', 'GIT_OPTIONAL_LOCKS', 'GIT_EXEC_PATH', 'GIT_SSH_COMMAND', 'GIT_FUTURE_OVERRIDE']) {
    for (const value of ['', '/fixture/value']) {
      const input = { ordinary: 'retained', [key]: value };
      assert.throws(() => gitEnvironment(input), Error, `${key}=${JSON.stringify(value)}`);
      assert.deepEqual(input, { ordinary: 'retained', [key]: value });
    }
  }
});

test('Git version admission enforces the 2.45 floor and refuses unparseable output', () => {
  for (const output of ['git version 2.45.0\n', 'git version 2.54.0 (Apple Git-157)\n', 'git version 3.0.0\n']) assert.doesNotThrow(() => assertGitVersion(output), output);
  for (const output of ['git version 2.44.99\n', 'git version 1.99.99\n', '', '2.50.1\n', 'git version surprise\n']) assert.throws(() => assertGitVersion(output), Error, JSON.stringify(output));
});

test('Git config accepts unrelated valueless, multiline and numeric or dotted sections without changing bytes', () => {
  const raw = Buffer.from('ordinary.flag\0ordinary.value\none\n\rtwo\0filter.fixture.smudge\ncat\0filter.fixture.clean\n\0filter.fixture.process\n\0' + '123.flag\nnumeric\0-section.flag\nhyphen\0a.b.flag\ndotted\0');
  const before = Buffer.from(raw);
  assert.doesNotThrow(() => assertGitConfig(raw)); assert.deepEqual(raw, before);
  assert.doesNotThrow(() => assertGitConfig(Buffer.alloc(0)));
});

test('Git config refuses executable or valueless clean/process values including unused drivers', () => {
  for (const raw of ['filter.unused.clean\ncat\0', 'filter.unused.process\nowned-program\n--argument\rvalue\0', 'filter.unused.clean\0', 'filter.unused.process\0', 'ordinary.value\nsafe\nvalue\0filter.unused.clean\ncat\0']) assert.throws(() => assertGitConfig(Buffer.from(raw)), Error, JSON.stringify(raw));
});

test('Git config uses the last exact driver value without merging case-sensitive names', () => {
  assert.doesNotThrow(() => assertGitConfig(Buffer.from('filter.fixture.clean\ncat\0filter.fixture.clean\n\0filter.fixture.process\0filter.fixture.process\n\0')));
  for (const raw of ['filter.fixture.clean\n\0filter.fixture.clean\ncat\0', 'filter.fixture.process\n\0filter.fixture.process\0', 'filter.case.clean\ncat\0filter.Case.clean\n\0', 'filter.case.process\ncat\0filter.Case.process\n\0']) assert.throws(() => assertGitConfig(Buffer.from(raw)), Error, JSON.stringify(raw));
});

test('Git config refuses malformed NUL framing and keys', () => {
  for (const raw of ['ordinary.key\nvalue', '\0', '\nvalue\0', 'ordinary.1variable\nvalue\0', 'ordinary.key\nvalue\0\0']) assert.throws(() => assertGitConfig(Buffer.from(raw)), Error, JSON.stringify(raw));
});

test('whole-index admission accepts file/conflict stages with raw filename bytes', () => {
  const object = 'a'.repeat(40), rawName = Buffer.from([255, 9, 10, 13, 120]);
  const raw = Buffer.concat([Buffer.from(`100644 ${object} 0\tordinary file\0`), Buffer.from(`100755 ${object} 1\tconflict\0`), Buffer.from(`100644 ${object} 2\tconflict\0`), Buffer.from(`120000 ${'b'.repeat(64)} 3\t`), rawName, Buffer.from([0])]);
  const before = Buffer.from(raw);
  assert.doesNotThrow(() => assertNoGitlinks(raw)); assert.deepEqual(raw, before);
  assert.doesNotThrow(() => assertNoGitlinks(Buffer.alloc(0)));
});

test('whole-index admission refuses every gitlink stage including excluded or unrelated paths', () => {
  const ordinary = `100644 ${'a'.repeat(40)} 0\t.caws/hooks/guard.sh\0`;
  for (const stage of [0, 1, 2, 3]) for (const name of ['unrelated/module', '.caws/hooks/state/module']) assert.throws(() => assertNoGitlinks(Buffer.from(`${ordinary}160000 ${'b'.repeat(40)} ${stage}\t${name}\0`)), Error, `${stage}: ${name}`);
});

test('whole-index admission refuses malformed headers, object IDs and record framing', () => {
  const object = 'a'.repeat(40);
  for (const raw of [`100644 ${object} 0\tunterminated`, `100644 ${object} 0 filename\0`, `999999 ${object} 0\tfilename\0`, `100644 ${'z'.repeat(40)} 0\tfilename\0`, `100644 abc 0\tfilename\0`, `100644 ${object} 4\tfilename\0`, `100644 ${object} 0\t\0`, '\0', `100644 ${object} 0\tfilename\0\0`]) assert.throws(() => assertNoGitlinks(Buffer.from(raw)), Error, JSON.stringify(raw));
});

test('comparison retains empty files, all statuses, lengths, raw hashes and category precedence', () => {
  const left = new Map(Object.entries({ same: Buffer.from('x'), stamp: Buffer.from('# hook_pack_version: 67\nexit 2\n'), body: Buffer.from('# hook_pack_version: 67\nexit 0\n'), empty: Buffer.alloc(0), added: Buffer.from('new'), prose: Buffer.from('version 67') }));
  const right = new Map(Object.entries({ same: Buffer.from('x'), stamp: Buffer.from('# hook_pack_version: 1\nexit 2\n'), body: Buffer.from('# hook_pack_version: 1\nexit 2\n'), empty: Buffer.alloc(0), removed: Buffer.from('old'), prose: Buffer.from('version 1') }));
  const rows = compare(left, right), byName = Object.fromEntries(rows.map(row => [row.path, row]));
  assert.deepEqual(Object.fromEntries(rows.map(row => [row.path, row.status])), { added: 'consumer-only', body: 'different', empty: 'identical', prose: 'different', removed: 'caws-only', same: 'identical', stamp: 'version-stamp-only' });
  assert.equal(byName.empty?.consumer_bytes, 0);
  assert.equal(byName.empty?.consumer_sha256, 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
  assert.equal(byName.added?.caws_bytes, null);
  assert.notEqual(byName.stamp?.consumer_sha256, byName.stamp?.caws_sha256);
  assert.deepEqual(['tests/a', 'package.json', 'package-lock.json', 'adapter-surface-policies/x', 'guard.sh'].map(category), ['test-or-fixture', 'dependency-metadata', 'dependency-metadata', 'project-surface-policy', 'hook-source-or-support']);
});

test('stamp normalization never decodes arbitrary bytes or broadens the managed line', () => {
  assert.deepEqual(normalizeStamp(Buffer.from([255, 0, 13, 10])), Buffer.from([255, 0, 13, 10]));
  for (const line of [' # hook_pack_version: 12', '# hook_pack_version: 12 ', '# hook_pack_version: 12\r', '# hook_pack_version: ١٢', '# hook_pack_version: 12 suffix']) assert.equal(normalizeStamp(Buffer.from(line)).toString(), line);
  assert.equal(normalizeStamp(Buffer.from('# hook_pack_version: 12')).toString(), '# hook_pack_version: <stamp>');
  assert.equal(normalizeStamp(Buffer.from('# hook_pack_version: 12\n')).toString(), '# hook_pack_version: <stamp>\n');
});

test('literal words preserve Python shlex comments, escapes, empty quotes and concatenation', () => {
  assert.deepEqual(literalWords('good.sh#ignored'), ['good.sh']);
  assert.deepEqual(literalWords('audit.sh\\ tool-use au"dit".sh'), ['audit.sh tool-use', 'audit.sh']);
  assert.deepEqual(literalWords('"" \'\' "a\\$b" "a\\\"b" \'a\\b\''), ['', '', 'a\\$b', 'a"b', 'a\\b']);
  assert.deepEqual(literalWords('a.sh\u00a0b.sh'), ['a.sh\u00a0b.sh']);
  assert.equal(literalWords('"bad'), null); assert.equal(literalWords('bad\\'), null);
});

test('declarations preserve live/comment separation, duplicate unresolved lines and per-line recovery', () => {
  const input = Buffer.from('HANDLERS=(\nfirst.sh second.sh\n"audit.sh tool-use"\n# "audit.sh stop"\n# test-run-guard.sh refuses raw pytest\n"$A" "$B"\n"bad\nnext.sh\n# "bad\ngood.sh#ignored\na.sh argument\n) # comment\nlate.sh\n)\n');
  assert.deepEqual(declarations(input), {
    declared: [{ entry: 'first.sh', line: 2 }, { entry: 'second.sh', line: 2 }, { entry: 'audit.sh tool-use', line: 3 }, { entry: 'next.sh', line: 8 }, { entry: 'good.sh', line: 10 }, { entry: 'a.sh', line: 11 }, { entry: 'late.sh', line: 13 }],
    commented: [{ entry: 'audit.sh stop', line: 4 }], unresolved_lines: [6, 6, 7, 11, 12],
  });
});

test('Unicode separators, strip semantics, BOM and invalid UTF8 preserve report line coordinates', () => {
  const separators = ['\u0085', '\u2028', '\u2029', '\v', '\f', '\u001c', '\u001d', '\u001e'];
  const input = `\u001f_ALL_HANDLERS=(\u001f\n${separators.map((separator, index) => `x${index}.sh${separator}`).join('')}last.sh\n)`;
  assert.deepEqual(declarations(Buffer.from(input)).declared, [...separators.map((_, i) => ({ entry: `x${i}.sh`, line: i + 2 })), { entry: 'last.sh', line: 10 }]);
  assert.deepEqual(declarations(Buffer.from('\ufeffHANDLERS=(\na.sh\n)')).declared, []);
  const malformed = Buffer.concat([Buffer.from('HANDLERS=(\na'), Buffer.from([255]), Buffer.from('.sh\n)')]);
  assert.deepEqual(declarations(malformed), { declared: [], commented: [], unresolved_lines: [2] });
  assert.deepEqual(declarations(Buffer.from('HANDLERS=(\na.sh\u00a0b.sh\n)')).unresolved_lines, [2]);
  assert.deepEqual(declarations(Buffer.from('HANDLERS=(inline.sh)\na.sh\n)')).declared, []);
});

test('inventory excludes every cache basename, generated suffix, link kind and nested subtree', t => {
  const base = fixture(t), root = path.join(base, 'hooks'), outside = path.join(base, 'outside');
  mkdirSync(root); put(path.join(root, 'custom.sh'), 'exit 2\n'); put(path.join(outside, 'payload'), 'excluded-payload');
  for (const name of ['node_modules', '__pycache__', '.pytest_cache', '.pristine', 'state', 'logs']) put(path.join(root, name, 'payload'), 'excluded');
  put(path.join(root, 'nested/logs/payload'), 'excluded');
  for (const name of ['.DS_Store', 'a.pyc', 'a.log']) put(path.join(root, name), 'excluded');
  symlinkSync(outside, path.join(root, 'linked-dir')); symlinkSync(path.join(outside, 'payload'), path.join(root, 'linked-file')); symlinkSync('missing', path.join(root, 'dangling')); symlinkSync(root, path.join(root, 'cycle'));
  put(path.join(root, '\ue000.sh'), Buffer.from([255])); put(path.join(root, '𐀀.sh'), Buffer.alloc(0));
  /** @type {string[]} */ const payloadReads = [];
  const result = inventory(root, { readFile: file => { payloadReads.push(file.toString()); return readFileSync(file); } });
  assert.deepEqual([...result.files.keys()], ['custom.sh', '\ue000.sh', '𐀀.sh']);
  assert.deepEqual(payloadReads, ['custom.sh', '\ue000.sh', '𐀀.sh'].map(name => path.join(root, name)));
  assert.equal(result.files.get('\ue000.sh')?.[0], 255);
  assert.deepEqual(result.excluded.map(row => row.path), ['.DS_Store', '.pristine', '.pytest_cache', '__pycache__', 'a.log', 'a.pyc', 'cycle', 'dangling', 'linked-dir', 'linked-file', 'logs', 'nested/logs', 'node_modules', 'state']);
  assert.equal(result.excluded.find(row => row.path === 'linked-dir')?.reason, 'dependency/cache/state or symlink subtree');
  assert.equal(result.excluded.find(row => row.path === 'dangling')?.reason, 'symlink or generated file');
  assert.equal(readFileSync(path.join(outside, 'payload'), 'utf8'), 'excluded-payload');
  put(path.join(base, 'payload-read-observation.json'), JSON.stringify({ payloadReads, excluded: result.excluded, outsidePayload: path.join(outside, 'payload'), outsidePayloadReadByInventory: payloadReads.includes(path.join(outside, 'payload')) }, null, 2));
});

test('code point ordering distinguishes BMP and astral paths', () => assert.deepEqual(['𐀀', '\ue000', 'a'].sort(codepointOrder), ['a', '\ue000', '𐀀']));

test('option recognition precedes the ASCII-space value exception', () => {
  for (const value of ['-my repo', '--unknown repo', '-', '-1', '-١', 'plain']) assert.equal(isOptionToken(value), false, value);
  for (const value of ['-h repo', '--consumer-root=some repo', '--consumer=some repo', '--', '-unknown', '-h']) assert.equal(isOptionToken(value), true, value);
});

test('filesystem decoding preserves invalid bytes and reports the host filename boundary', t => {
  const root = fixture(t);
  const raw = Buffer.concat([Buffer.from(`${root}/`), Buffer.from([255]), Buffer.from('.sh')]);
  assert.equal(filesystemName(Buffer.from([255, 46, 115, 104])), '\udcff.sh');
  assert.equal(filesystemName(Buffer.from('\ufffd.sh')), '\ufffd.sh');
  assert.equal(filesystemName(Buffer.from([0xed, 0xa0, 0x80, 0xf0, 0x9f, 0x98, 0x80])), '\udced\udca0\udc80😀');
  let rawCreated = false;
  try { writeFileSync(raw, 'raw-invalid-name'); rawCreated = true; } catch (error) {
    assert.equal(error && typeof error === 'object' && 'code' in error ? error.code : undefined, 'EILSEQ');
    t.diagnostic('Host refused invalid UTF8 filename with EILSEQ: decoder checked; end-to-end invalid-name traversal requires a filesystem that admits it.');
  }
  put(path.join(root, '\ufffd.sh'), 'valid-replacement-name');
  const files = inventory(root).files;
  assert.equal(files.size, rawCreated ? 2 : 1);
  if (rawCreated) assert.equal(files.get('\udcff.sh')?.toString(), 'raw-invalid-name');
  assert.equal(files.get('\ufffd.sh')?.toString(), 'valid-replacement-name');
  put(path.join(root, 'filename-capability.json'), JSON.stringify({ rawCreated, requiredAdditionalCheck: rawCreated ? null : 'Actual two-name traversal on an invalid-UTF8-capable filesystem', rawHex: raw.toString('hex') }, null, 2));
});

test('path resolution interprets dotdot after symlink resolution and preserves missing tails', t => {
  const base = fixture(t); mkdirSync(path.join(base, 'real/inner'), { recursive: true }); symlinkSync(path.join(base, 'real/inner'), path.join(base, 'alias'));
  assert.equal(resolveRoot(`${base}/alias/../consumer`), `${base}/real/consumer`);
  assert.equal(resolveRoot(`${base}/alias/missing/../leaf`), `${base}/real/inner/leaf`);
});

test('inventory rechecks a queued directory link before descending after sibling reads', t => {
  const base = fixture(t), root = path.join(base, 'hooks'), outside = path.join(base, 'outside');
  put(path.join(root, 'queued/inside.sh'), 'inside'); put(path.join(root, 'trigger.sh'), 'trigger'); put(path.join(outside, 'outside.sh'), 'outside');
  const observed = inventory(root, { readFile: file => {
    const bytes = readFileSync(file);
    if (file.toString().endsWith('/trigger.sh')) { renameSync(path.join(root, 'queued'), path.join(base, 'old-queued')); symlinkSync(outside, path.join(root, 'queued')); }
    return bytes;
  } });
  assert.deepEqual([...observed.files.keys()], ['trigger.sh']);
  assert.equal(readFileSync(path.join(outside, 'outside.sh'), 'utf8'), 'outside');
});

for (const changed of ['bytes', 'membership', 'excluded', 'head', 'status', 'stable']) {
  test(`snapshot independently checks ${changed}`, () => {
    let inventories = 0, heads = 0, statuses = 0;
    const result = () => snapshot('/repo', '/repo/hooks', {
      inventory: () => {
        const second = inventories++ > 0;
        const files = new Map([['guard.sh', Buffer.from(second && changed === 'bytes' ? 'exit 0' : 'exit 2')]]);
        if (second && changed === 'membership') files.set('new.sh', Buffer.alloc(0));
        return { files, excluded: second && changed === 'excluded' ? [{ path: 'link', reason: 'symlink or generated file' }] : [] };
      },
      git: (_repo, ...args) => args[0] === 'rev-parse' ? ((heads++ > 0 && changed === 'head') ? 'new\n' : 'old\n') : ((statuses++ > 0 && changed === 'status') ? ' M guard.sh\n' : ''),
    });
    if (changed === 'stable') assert.equal(result().metadata.head, 'old');
    else assert.throws(result, /source changed during inventory/);
  });
}

test('actual Node-only direct/symlink CLI reports semantic bytes, tracking and no CAWS hook execution', t => {
  const base = fixture(t), consumer = path.join(base, 'consumer'), caws = path.join(base, 'caws');
  const gitEnv = fixtureEnvironment();
  for (const repo of [consumer, caws]) {
    mkdirSync(repo);
    execFileSync('git', ['-c', 'init.templateDir=', 'init', '--quiet', repo], { env: gitEnv, timeout: 10_000 });
    execFileSync('git', ['-C', repo, 'config', 'core.hooksPath', '/dev/null'], { env: gitEnv, timeout: 10_000 });
    execFileSync('git', ['-C', repo, 'config', 'core.fsmonitor', 'false'], { env: gitEnv, timeout: 10_000 });
  }
  const left = path.join(consumer, '.caws/hooks'), right = path.join(caws, 'packages/caws-cli/templates/hook-packs/shared');
  put(path.join(left, 'guard.sh'), 'touch MUST-NOT-EXIST\n'); put(path.join(right, 'guard.sh'), 'touch MUST-NOT-EXIST\n');
  put(path.join(left, 'dispatch/pre.sh'), 'HANDLERS=(\nguard.sh#comment\n)\n'); put(path.join(right, 'dispatch/pre.sh'), 'HANDLERS=(\nguard.sh#comment\n)\n');
  for (const [repo, rel] of [[consumer, '.caws/hooks'], [caws, 'packages']]) {
    execFileSync('git', ['-C', repo ?? '', 'add', rel ?? ''], { env: gitEnv, timeout: 10_000 });
    execFileSync('git', ['-C', repo ?? '', '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '--quiet', '-m', 'fixture'], { env: gitEnv, timeout: 10_000 });
  }
  const binary = path.join(base, 'bin'); mkdirSync(binary); symlinkSync(process.execPath, path.join(binary, 'node')); symlinkSync(execFileSync('which', ['git'], { encoding: 'utf8', env: gitEnv, timeout: 10_000 }).trim(), path.join(binary, 'git'));
  const script = fileURLToPath(new URL('./hook-harvest.mjs', import.meta.url)), link = path.join(base, 'harvest-link.mjs'); symlinkSync(script, link);
  const reports = [];
  for (const [label, entry] of [['direct', script], ['symlink', link]]) {
    const child = spawnSync(entry ?? '', ['--consumer-root', consumer, '--caws-root', caws], { cwd: base, env: { ...gitEnv, PATH: binary }, encoding: 'utf8', timeout: 10_000 });
    put(path.join(base, `${label}-stdout.json`), child.stdout ?? ''); put(path.join(base, `${label}-stderr.log`), child.stderr ?? '');
    put(path.join(base, `${label}-command.json`), JSON.stringify({ executable: entry, argv: ['--consumer-root', consumer, '--caws-root', caws], status: child.status, signal: child.signal, error: child.error?.message, PATH: binary }, null, 2));
    assert.equal(child.status, 0, child.stderr); assert.equal(child.stderr, '');
    const report = JSON.parse(child.stdout); reports.push(report);
    assert.deepEqual(report.limits, [
      'Byte differences do not establish missing capabilities or edit authorship.',
      'Declarations do not establish effective native registration or execution.',
      'No hooks executed and no payload text copied.',
      'Excluded subtrees are not recursively inventoried.',
      'Sequential stable reads are not a cross-repository atomic snapshot.',
      'Git admission requires Git 2.45 or later, stable configuration and index inputs, no executable clean/process filters and no indexed submodules.',
      'Inventory exclusions do not prohibit Git status from reading excluded tracked files.',
    ]);
    assert.equal(report.files.find((/** @type {{path:string}} */ row) => row.path === 'guard.sh').consumer_tracked, true);
    assert.equal(report.files.find((/** @type {{path:string}} */ row) => row.path === 'guard.sh').consumer_sha256, sha256(Buffer.from('touch MUST-NOT-EXIST\n')));
    assert.deepEqual(report.dispatchers.consumer['dispatch/pre.sh'].declared, [{ entry: 'guard.sh', line: 2 }]);
    assert.deepEqual(report.counts, { identical: 2 });
    assert.equal(inventory(base).files.has('MUST-NOT-EXIST'), false);
  }
  assert.deepEqual(reports[0], reports[1]);
  assert.equal(readFileSync(path.join(left, 'guard.sh'), 'utf8'), 'touch MUST-NOT-EXIST\n');
  symlinkSync(consumer, path.join(base, '-my repo'));
  const space = spawnSync(process.execPath, [script, '--consumer-root', '-my repo', '--caws-root', caws], { cwd: base, encoding: 'utf8', env: { ...gitEnv, PATH: binary }, timeout: 10_000 });
  assert.equal(space.status, 0, space.stderr); assert.deepEqual(JSON.parse(space.stdout), reports[0]);
  put(path.join(base, 'dash-space-stdout.json'), space.stdout); put(path.join(base, 'dash-space-stderr.log'), space.stderr);
  const optionLookalike = spawnSync(process.execPath, [script, '--consumer-root', '-h repo', '--caws-root', caws], { cwd: base, encoding: 'utf8', env: gitEnv, timeout: 10_000 });
  assert.equal(optionLookalike.status, 2); assert.match(optionLookalike.stderr, /expected a path after/);
  // This CLI has no positional operands: retained argparse reference refuses even a final separator.
  const separator = spawnSync(process.execPath, [script, '--consumer-root', consumer, '--caws-root', caws, '--'], { encoding: 'utf8', env: gitEnv, timeout: 10_000 });
  assert.equal(separator.status, 2); assert.match(separator.stderr, /unrecognized or ambiguous argument: --/);
  const missing = spawnSync(process.execPath, [script], { encoding: 'utf8', env: gitEnv, timeout: 10_000 }); assert.equal(missing.status, 2); assert.match(missing.stderr, /consumer-root is required/);
});

/** Retain commands before assertions so failed controls remain inspectable.
 * @param {string} base @param {Record<string,unknown>[]} commands
 * @param {string} executable @param {string[]} argv */
function fixtureCommand(base, commands, executable, argv) {
  const env = fixtureEnvironment();
  const child = spawnSync(executable, argv, { cwd: base, env, encoding: 'utf8', timeout: 10_000 });
  commands.push({ executable, argv: [...argv], cwd: base, timeout_ms: 10_000, git_environment: Object.fromEntries(Object.entries(env).filter(([key]) => key.startsWith('GIT_'))), status: child.status, signal: child.signal, error: child.error?.message ?? null, stdout: child.stdout ?? '', stderr: child.stderr ?? '' });
  put(path.join(base, 'commands.json'), JSON.stringify(commands, null, 2));
  return child;
}
/** @param {string} base @param {Record<string,unknown>[]} commands @param {string} repo @param {string[]} argv */
function fixtureGit(base, commands, repo, argv) {
  return fixtureCommand(base, commands, 'git', ['--no-pager', '--no-optional-locks', '-C', repo, ...argv]);
}
/** @param {string} base @param {Record<string,unknown>[]} commands */
function privateRepositories(base, commands) {
  const consumer = path.join(base, 'consumer'), caws = path.join(base, 'caws');
  const left = path.join(consumer, '.caws/hooks'), right = path.join(caws, 'packages/caws-cli/templates/hook-packs/shared');
  for (const [repo, hooks] of [[consumer, left], [caws, right]]) {
    mkdirSync(repo, { recursive: true });
    for (const argv of [['-c', 'init.templateDir=', 'init', '--quiet', '.'], ['config', 'core.hooksPath', '/dev/null'], ['config', 'core.fsmonitor', 'false'], ['config', 'user.name', 'Fixture'], ['config', 'user.email', 'fixture@example.invalid']]) {
      const result = fixtureGit(base, commands, repo, argv); assert.equal(result.status, 0, result.stderr);
    }
    put(path.join(hooks, 'guard.sh'), 'canonical\n');
    for (const argv of [['add', '--', '.'], ['commit', '--quiet', '-m', 'fixture']]) {
      const result = fixtureGit(base, commands, repo, argv); assert.equal(result.status, 0, result.stderr);
    }
  }
  return { consumer, caws, left, right };
}
/** @param {string} file */
function optionalText(file) { return existsSync(file) ? readFileSync(file, 'utf8') : null; }
/** @param {string} repo @param {string} hooks */
function repositoryIdentity(repo, hooks) {
  const files = inventory(hooks);
  return { root: repo, hooks_root: hooks, source: [...files.files].map(([name, bytes]) => ({ path: name, bytes: bytes.length, sha256: sha256(bytes) })), excluded: files.excluded, index_sha256: sha256(readFileSync(path.join(repo, '.git/index'))), config_sha256: sha256(readFileSync(path.join(repo, '.git/config'))), head_sha256: sha256(readFileSync(path.join(repo, '.git/HEAD'))), head_log_sha256: sha256(readFileSync(path.join(repo, '.git/logs/HEAD'))), attributes: optionalText(path.join(repo, '.gitattributes')) };
}
/** @param {string} value */
function shellWord(value) { return `'${value.replaceAll("'", "'\\''")}'`; }

test('real Git fsmonitor executes despite hooksPath null while harvest suppresses it without changing inputs', t => {
  const base = fixture(t);
  /** @type {Record<string,unknown>[]} */ const commands = [];
  const { consumer, caws, left, right } = privateRepositories(base, commands);
  const marker = path.join(base, 'fsmonitor.marker'), monitor = path.join(base, 'owned-fsmonitor.sh');
  put(monitor, `#!/bin/sh\nprintf 'called\\n' >> ${shellWord(marker)}\nprintf 'fixture-token\\000'\n`);
  chmodSync(monitor, 0o755);
  for (const argv of [['config', 'core.fsmonitor', monitor], ['config', 'core.fsmonitorHookVersion', '2']]) {
    const result = fixtureGit(base, commands, consumer, argv); assert.equal(result.status, 0, result.stderr);
  }
  const beforePositive = { marker: optionalText(marker), consumer: repositoryIdentity(consumer, left), caws: repositoryIdentity(caws, right) };
  const positive = fixtureGit(base, commands, consumer, ['status', '--porcelain=v1', '--untracked-files=no']);
  const positiveMarker = optionalText(marker); rmSync(marker, { force: true });
  const beforeHarvest = { marker: optionalText(marker), consumer: repositoryIdentity(consumer, left), caws: repositoryIdentity(caws, right) };
  const script = fileURLToPath(new URL('./hook-harvest.mjs', import.meta.url));
  const harvested = fixtureCommand(base, commands, process.execPath, [script, '--consumer-root', consumer, '--caws-root', caws]);
  const afterHarvest = { marker: optionalText(marker), consumer: repositoryIdentity(consumer, left), caws: repositoryIdentity(caws, right) };
  put(path.join(base, 'fsmonitor-observation.json'), JSON.stringify({ script, script_sha256: sha256(readFileSync(script)), monitor, monitor_sha256: sha256(readFileSync(monitor)), marker, beforePositive, positiveMarker, beforeHarvest, afterHarvest, commands }, null, 2));
  assert.equal(beforePositive.marker, null); assert.equal(positive.status, 0, positive.stderr); assert.equal(positive.stdout, '');
  assert.equal(typeof positiveMarker, 'string'); assert.match(positiveMarker ?? '', /^(?:called\n)+$/);
  assert.equal(harvested.status, 0, harvested.stderr); assert.equal(harvested.stderr, '');
  assert.deepEqual(JSON.parse(harvested.stdout).counts, { identical: 1 }); assert.equal(JSON.parse(harvested.stdout).consumer.status, '');
  assert.deepEqual(afterHarvest, beforeHarvest);
});

test('real clean filter canonicalizes a changed tracked hook and harvest refuses before executing it', t => {
  const base = fixture(t);
  /** @type {Record<string,unknown>[]} */ const commands = [];
  const { consumer, caws, left, right } = privateRepositories(base, commands);
  const marker = path.join(base, 'clean.marker'), cleaner = path.join(base, 'owned-clean.mjs');
  put(path.join(consumer, '.gitattributes'), '.caws/hooks/guard.sh filter=owned\n');
  for (const argv of [['add', '--', '.gitattributes'], ['commit', '--quiet', '-m', 'fixture attributes']]) {
    const result = fixtureGit(base, commands, consumer, argv); assert.equal(result.status, 0, result.stderr);
  }
  put(cleaner, `import { appendFileSync, readFileSync } from 'node:fs';\nreadFileSync(0);\nappendFileSync(${JSON.stringify(marker)}, 'clean-called\\n');\nprocess.stdout.write('canonical\\n');\n`);
  for (const argv of [['config', 'filter.owned.clean', `${shellWord(process.execPath)} ${shellWord(cleaner)}`], ['config', 'filter.owned.required', 'true']]) {
    const result = fixtureGit(base, commands, consumer, argv); assert.equal(result.status, 0, result.stderr);
  }
  // A size mismatch can report modified without conversion. Same-size bytes and
  // an explicitly changed mtime force the content comparison that runs the filter.
  const changed = 'different\n', changedFile = path.join(left, 'guard.sh'); put(changedFile, changed);
  const changedStat = statSync(changedFile);
  utimesSync(changedFile, changedStat.atime, new Date(changedStat.mtimeMs + 2000));
  const beforePositive = { marker: optionalText(marker), consumer: repositoryIdentity(consumer, left), caws: repositoryIdentity(caws, right) };
  const positive = fixtureGit(base, commands, consumer, ['status', '--porcelain=v1', '--untracked-files=no']);
  const positiveMarker = optionalText(marker); rmSync(marker, { force: true });
  const beforeHarvest = { marker: optionalText(marker), consumer: repositoryIdentity(consumer, left), caws: repositoryIdentity(caws, right) };
  const script = fileURLToPath(new URL('./hook-harvest.mjs', import.meta.url));
  const harvested = fixtureCommand(base, commands, process.execPath, [script, '--consumer-root', consumer, '--caws-root', caws]);
  const afterHarvest = { marker: optionalText(marker), consumer: repositoryIdentity(consumer, left), caws: repositoryIdentity(caws, right) };
  put(path.join(base, 'clean-filter-observation.json'), JSON.stringify({ script, script_sha256: sha256(readFileSync(script)), cleaner, cleaner_sha256: sha256(readFileSync(cleaner)), marker, canonical_bytes: 'canonical\n', changed_bytes: changed, changed_mtime_ms: statSync(changedFile).mtimeMs, beforePositive, positiveMarker, beforeHarvest, afterHarvest, commands }, null, 2));
  assert.equal(beforePositive.marker, null); assert.equal(positive.status, 0, positive.stderr); assert.equal(positive.stdout, '');
  assert.equal(typeof positiveMarker, 'string'); assert.match(positiveMarker ?? '', /^(?:clean-called\n)+$/);
  assert.equal(Buffer.byteLength(changed), Buffer.byteLength('canonical\n')); assert.notEqual(changed, 'canonical\n'); assert.equal(readFileSync(changedFile, 'utf8'), changed);
  assert.equal(harvested.status, 1, harvested.stderr); assert.equal(harvested.stdout, ''); assert.match(harvested.stderr, /filters/);
  assert.deepEqual(afterHarvest, beforeHarvest);
});
