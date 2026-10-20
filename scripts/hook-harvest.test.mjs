// @ts-check
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { category, codepointOrder, compare, declarations, filesystemName, inventory, isOptionToken, literalWords, normalizeStamp, resolveRoot, sha256, snapshot } from './hook-harvest.mjs';

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
  for (const repo of [consumer, caws]) {
    mkdirSync(repo);
    execFileSync('git', ['-c', 'init.templateDir=', 'init', '--quiet', repo]);
    execFileSync('git', ['-C', repo, 'config', 'core.hooksPath', '/dev/null']);
    execFileSync('git', ['-C', repo, 'config', 'core.fsmonitor', 'false']);
  }
  const left = path.join(consumer, '.caws/hooks'), right = path.join(caws, 'packages/caws-cli/templates/hook-packs/shared');
  put(path.join(left, 'guard.sh'), 'touch MUST-NOT-EXIST\n'); put(path.join(right, 'guard.sh'), 'touch MUST-NOT-EXIST\n');
  put(path.join(left, 'dispatch/pre.sh'), 'HANDLERS=(\nguard.sh#comment\n)\n'); put(path.join(right, 'dispatch/pre.sh'), 'HANDLERS=(\nguard.sh#comment\n)\n');
  for (const [repo, rel] of [[consumer, '.caws/hooks'], [caws, 'packages']]) {
    execFileSync('git', ['-C', repo ?? '', 'add', rel ?? '']);
    execFileSync('git', ['-C', repo ?? '', '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '--quiet', '-m', 'fixture']);
  }
  const binary = path.join(base, 'bin'); mkdirSync(binary); symlinkSync(process.execPath, path.join(binary, 'node')); symlinkSync(execFileSync('which', ['git'], { encoding: 'utf8' }).trim(), path.join(binary, 'git'));
  const script = fileURLToPath(new URL('./hook-harvest.mjs', import.meta.url)), link = path.join(base, 'harvest-link.mjs'); symlinkSync(script, link);
  const reports = [];
  for (const [label, entry] of [['direct', script], ['symlink', link]]) {
    const child = spawnSync(entry ?? '', ['--consumer-root', consumer, '--caws-root', caws], { cwd: base, env: { ...process.env, PATH: binary }, encoding: 'utf8' });
    put(path.join(base, `${label}-stdout.json`), child.stdout ?? ''); put(path.join(base, `${label}-stderr.log`), child.stderr ?? '');
    put(path.join(base, `${label}-command.json`), JSON.stringify({ executable: entry, argv: ['--consumer-root', consumer, '--caws-root', caws], status: child.status, signal: child.signal, error: child.error?.message, PATH: binary }, null, 2));
    assert.equal(child.status, 0, child.stderr); assert.equal(child.stderr, '');
    const report = JSON.parse(child.stdout); reports.push(report);
    assert.equal(report.files.find((/** @type {{path:string}} */ row) => row.path === 'guard.sh').consumer_tracked, true);
    assert.equal(report.files.find((/** @type {{path:string}} */ row) => row.path === 'guard.sh').consumer_sha256, sha256(Buffer.from('touch MUST-NOT-EXIST\n')));
    assert.deepEqual(report.dispatchers.consumer['dispatch/pre.sh'].declared, [{ entry: 'guard.sh', line: 2 }]);
    assert.deepEqual(report.counts, { identical: 2 });
    assert.equal(inventory(base).files.has('MUST-NOT-EXIST'), false);
  }
  assert.deepEqual(reports[0], reports[1]);
  assert.equal(readFileSync(path.join(left, 'guard.sh'), 'utf8'), 'touch MUST-NOT-EXIST\n');
  symlinkSync(consumer, path.join(base, '-my repo'));
  const space = spawnSync(process.execPath, [script, '--consumer-root', '-my repo', '--caws-root', caws], { cwd: base, encoding: 'utf8', env: { ...process.env, PATH: binary } });
  assert.equal(space.status, 0, space.stderr); assert.deepEqual(JSON.parse(space.stdout), reports[0]);
  put(path.join(base, 'dash-space-stdout.json'), space.stdout); put(path.join(base, 'dash-space-stderr.log'), space.stderr);
  const optionLookalike = spawnSync(process.execPath, [script, '--consumer-root', '-h repo', '--caws-root', caws], { cwd: base, encoding: 'utf8' });
  assert.equal(optionLookalike.status, 2); assert.match(optionLookalike.stderr, /expected a path after/);
  // This CLI has no positional operands: retained argparse reference refuses even a final separator.
  const separator = spawnSync(process.execPath, [script, '--consumer-root', consumer, '--caws-root', caws, '--'], { encoding: 'utf8' });
  assert.equal(separator.status, 2); assert.match(separator.stderr, /unrecognized or ambiguous argument: --/);
  const missing = spawnSync(process.execPath, [script], { encoding: 'utf8' }); assert.equal(missing.status, 2); assert.match(missing.stderr, /consumer-root is required/);
});
