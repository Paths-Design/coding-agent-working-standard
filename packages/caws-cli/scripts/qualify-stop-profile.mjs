#!/usr/bin/env node
/** Fixed OpenCode component comparison, not native admission or ambient parity.
 * Inputs choose pinned tool/package/corpus paths; never executable recipes,
 * required cases, surfaces, oracle functions, or comparison semantics.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
const ownFile = fileURLToPath(import.meta.url);
// Frozen external reference oracle: changing its bytes requires owned source review.
export const REVIEWED_REFERENCE_ADAPTER_SHA256 =
  '074dcc4c9880758ea9bfc092612034bff7f78b7d07bed2b4331e02d5916171a9';
// Complete stock shared-tree inventory at the reviewed source candidate. Paths
// may relocate; changing oracle bytes requires source review and requalification.
export const REVIEWED_REFERENCE_SHARED_INVENTORY_SHA256 =
  '9976411f31abc0c6249433c79a45e6e556901ebcc9ae948218416fc9a92eaad8';
// Reviewed retained corpus identity; adding/replacing cases requires owned code review.
export const SQL_CORPUS_SHA256 = 'e9d9303ec7ce77dc15260aceadfa8392c7b2dbd5b3c70803354cedec6e097d19';
const sha = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');
const read = (file) => fs.readFileSync(file);
const save = (file, value) =>
  fs.writeFileSync(
    file,
    JSON.stringify(
      value,
      (_key, item) =>
        typeof item === 'bigint' ? { $type: 'bigint', decimal: item.toString() } : item,
      2
    ) + '\n',
    { flag: 'wx' }
  );
export const SQL_CASES = Object.freeze([
  'message-int4300',
  'message-int4301',
  'message-negative4300',
  'message-negative4301',
  'part-int4301',
  'message-string4301',
  'message-float4301',
]);
export const RENDER_CASES = Object.freeze([
  'plain',
  'integer4300',
  'integer4301',
  'negative4301',
  'string4301',
  'float4301',
  'html-literal4301',
  'html-decimal4301',
]);
export function exactKeys(value, keys) {
  assert(value && typeof value === 'object' && !Array.isArray(value));
  assert.deepEqual(
    Object.keys(value).sort(),
    [...keys].sort(),
    'unsupported or missing request fields'
  );
}
export function validateRequest(request) {
  exactKeys(request, [
    'schema',
    'outputRoot',
    'surface',
    'candidate',
    'reference',
    'corpus',
    ...(Object.hasOwn(request, 'nativePolicyImage') ? ['nativePolicyImage'] : []),
  ]);
  if (Object.hasOwn(request, 'nativePolicyImage')) validatePolicyImage(request.nativePolicyImage);
  assert.equal(request.schema, 'caws.qualify-stop-components.request.v1');
  assert.equal(request.surface, 'opencode');
  exactKeys(request.candidate, ['node', 'native', 'engine', 'distRoot', 'distFiles']);
  exactKeys(request.reference, [
    'python',
    'adapter',
    'sharedRoot',
    'sharedFiles',
    'pythonDependencies',
  ]);
  assert.equal(
    request.reference.adapter?.sha256,
    REVIEWED_REFERENCE_ADAPTER_SHA256,
    'unreviewed external reference adapter'
  );
  assert(
    request.reference.pythonDependencies &&
      Object.keys(request.reference.pythonDependencies).length > 0,
    'explicit Python dependency pins required'
  );
  for (const [file, digest] of Object.entries(request.reference.pythonDependencies)) {
    assert(path.isAbsolute(file));
    assert.match(digest, /^[a-f0-9]{64}$/);
  }
  exactKeys(request.corpus, ['cells']);
  assert.equal(request.corpus.cells?.sha256, SQL_CORPUS_SHA256, 'unreviewed SQL corpus');
  for (const pin of [
    request.candidate.node,
    request.candidate.native,
    request.candidate.engine,
    request.reference.python,
    request.reference.adapter,
    request.corpus.cells,
  ]) {
    exactKeys(pin, ['path', 'sha256']);
    assert(path.isAbsolute(pin.path));
    assert.match(pin.sha256, /^[a-f0-9]{64}$/);
  }
  for (const root of [request.outputRoot, request.candidate.distRoot, request.reference.sharedRoot])
    assert(path.isAbsolute(root));
  for (const pins of [request.candidate.distFiles, request.reference.sharedFiles]) {
    assert(pins && Object.keys(pins).length > 0);
    for (const [relative, digest] of Object.entries(pins)) {
      assert(!path.isAbsolute(relative) && !relative.split('/').includes('..'));
      assert.match(digest, /^[a-f0-9]{64}$/);
    }
  }
  const sharedInventory = Object.fromEntries(
    Object.entries(request.reference.sharedFiles).sort(([left], [right]) =>
      left < right ? -1 : left > right ? 1 : 0
    )
  );
  assert.equal(
    sha(Buffer.from(JSON.stringify(sharedInventory))),
    REVIEWED_REFERENCE_SHARED_INVENTORY_SHA256,
    'unreviewed stock reference inventory'
  );
  return request;
}
export const SEMANTIC_PROFILE_SCHEMA = 'caws.runtime.stop-semantic-profile.v1';
export const PROFILE_REMAINING_JOINS = Object.freeze([
  'native-calendar-original-environment',
  'bundled-engine-dispatch-equivalence',
  'native-selection-prefix-and-queued-peer-admission',
  'ordinary-publication-reopened-consumer-and-release',
  'ambient-legacy-startup-equivalence',
  'other-supported-surfaces',
]);
const cliDist = 'native-prefix/node_modules/@paths.design/caws-cli/dist/';
export const isImplementationMember = (relative) =>
  relative.startsWith('native-prefix/') ||
  relative.startsWith('native/') ||
  ['native-entry.json', 'native-build-provenance.json'].includes(relative);
function validatePolicyImage(image) {
  exactKeys(image, ['descriptor', 'root', 'files']);
  exactKeys(image.descriptor, ['path', 'sha256']);
  assert(path.isAbsolute(image.root) && path.isAbsolute(image.descriptor.path));
  assert.match(image.descriptor.sha256, /^[a-f0-9]{64}$/);
  assert(image.files && Object.keys(image.files).length > 0);
  for (const [relative, digest] of Object.entries(image.files)) {
    assert(
      relative &&
        !relative.includes('\\') &&
        !path.isAbsolute(relative) &&
        relative.split('/').every((part) => part && part !== '.' && part !== '..')
    );
    assert.match(digest, /^[a-f0-9]{64}$/);
  }
  assert(
    !Object.hasOwn(image.files, 'native-stop-profile.json'),
    'cannot repackage an existing profile'
  );
}
// This checks actual prepared v2 bytes against the complete selected image. It
// does not convert a historical component receipt or a caller boolean to policy.
function capturePolicyImage(request, require) {
  const image = request.nativePolicyImage;
  validatePolicyImage(image);
  pinFile(image.descriptor);
  const input = JSON.parse(read(image.descriptor.path));
  assert.equal(
    input.schema,
    'caws.runtime.native-image-input.v2',
    'profile emission requires reviewed v2 build image'
  );
  assert(!Object.hasOwn(input, 'stopProfile'), 'qualify pre-profile image only');
  const prepared = require('./init/native-runtime-entry.js').prepareNativeRuntimeEntryFromBuild(
    input
  );
  pinTree(image.root, image.files);
  return verifyPolicyImageBindings(request.candidate, prepared, image.files);
}
/** Pure data consistency only; production captures the v2 image before use. */
export function verifyPolicyImageBindings(candidate, prepared, imageFiles) {
  const actual = Object.fromEntries(
    Object.entries(imageFiles)
      .filter(([name]) => isImplementationMember(name))
      .sort()
  );
  const expected = Object.fromEntries(
    [...prepared.files]
      .filter(([name]) => isImplementationMember(name))
      .map(([name, bytes]) => [name, sha(bytes)])
      .sort()
  );
  assert.deepEqual(
    actual,
    expected,
    'prepared v2 implementation differs from selected complete image'
  );
  const entry = prepared.metadata;
  assert.equal(
    actual[entry.nativeExecutable],
    candidate.native.sha256,
    'native image not compared'
  );
  assert.equal(actual[entry.nodeExecutable], candidate.node.sha256, 'Node image not compared');
  assert.equal(actual[entry.engineEntry], candidate.engine.sha256, 'engine image not compared');
  const dist = Object.fromEntries(
    Object.entries(actual)
      .filter(([name]) => name.startsWith(cliDist))
      .map(([name, digest]) => [name.slice(cliDist.length), digest])
  );
  assert.deepEqual(dist, candidate.distFiles, 'complete compared dist differs from image');
  return actual;
}
// Data construction is private to a successful live comparison. The exported
// validation helpers used by hostile tests cannot mint an invocation receipt.
function semanticPolicy(receipt, componentReceiptSha256, implementation) {
  verifyCoverage(receipt.comparisons);
  for (const row of receipt.comparisons) {
    assert.match(row.referenceSha256, /^[a-f0-9]{64}$/);
    assert.equal(row.referenceSha256, row.candidateSha256);
  }
  return {
    schema: SEMANTIC_PROFILE_SCHEMA,
    surface: 'opencode',
    event: 'stop',
    scope: 'controlled-components',
    implementation,
    selectors: {
      sql: [4300, 0].map((integerMaxDigits) => ({
        id: `cpython-3.11.13-unicode14-int${integerMaxDigits}`,
        integerMaxDigits,
      })),
      renderer: [4300, 0].map((integerMaxDigits) => ({
        id: `cpython3.11-json/int-max-str-digits:${integerMaxDigits}`,
        integerMaxDigits,
      })),
    },
    sqliteIdentity: receipt.sqliteIdentity,
    environment: { tz: 'UTC0', tzdir: 'absent', integerMaxDigits: [4300, 0] },
    comparison: {
      receiptSha256: componentReceiptSha256,
      driverSha256: receipt.driverSha256,
      comparisons: receipt.comparisons,
    },
    provenance: {
      referenceMode: receipt.referenceMode,
      referenceAdapterSha256: REVIEWED_REFERENCE_ADAPTER_SHA256,
      referenceSharedInventorySha256: REVIEWED_REFERENCE_SHARED_INVENTORY_SHA256,
      corpusSha256: SQL_CORPUS_SHA256,
    },
    remainingJoins: [...PROFILE_REMAINING_JOINS],
  };
}
function pinFile(pin) {
  const before = fs.lstatSync(pin.path);
  assert(before.isFile() && !before.isSymbolicLink());
  assert.equal(fs.realpathSync(pin.path), pin.path, 'pins must use canonical physical paths');
  const bytes = read(pin.path),
    after = fs.lstatSync(pin.path);
  assert.equal(sha(bytes), pin.sha256, `input pin mismatch: ${pin.path}`);
  for (const key of ['dev', 'ino', 'size', 'mtimeMs', 'ctimeMs'])
    assert.equal(before[key], after[key]);
  return pin;
}
function pinTree(root, expected) {
  assert.equal(fs.realpathSync(root), root);
  const actual = {};
  function visit(directory, relative = '') {
    for (const name of fs.readdirSync(directory).sort()) {
      const rel = relative ? `${relative}/${name}` : name,
        file = path.join(root, rel),
        st = fs.lstatSync(file);
      assert(!st.isSymbolicLink(), `symlink input: ${file}`);
      if (st.isDirectory()) visit(file, rel);
      else {
        assert(st.isFile());
        actual[rel] = sha(read(file));
      }
    }
  }
  visit(root);
  assert.deepEqual(actual, expected, 'complete input inventory changed');
  return actual;
}
export function verifyCoverage(comparisons) {
  const expected = [4300, 0]
    .flatMap((limit) => [
      ...SQL_CASES.map((name) => `sql/${limit}/${name}`),
      ...RENDER_CASES.map((name) => `renderer/${limit}/${name}`),
    ])
    .sort();
  assert.deepEqual(
    comparisons.map((row) => row.id).sort(),
    expected,
    'missing, duplicate or extra fixed comparison'
  );
  for (const row of comparisons)
    assert.equal(row.result, 'equal', `comparison did not establish equality: ${row.id}`);
}
export function verifyFixedOutcome(category, name, limit, observation) {
  const refusal =
    limit === 4300 &&
    (category === 'sql'
      ? ['message-int4301', 'message-negative4301', 'part-int4301'].includes(name)
      : ['integer4301', 'negative4301', 'html-decimal4301'].includes(name));
  assert.equal(
    observation.kind,
    refusal ? 'integer_limit' : category === 'sql' ? 'projection' : 'artifacts',
    'fixed case produced the wrong semantic disposition'
  );
}
export function normalizeRendererFailure(prepared, name, limit, expectedByteOffset = 0n) {
  assert.equal(prepared.disposition, 'failed');
  assert.equal(limit, 4300, 'no numeric failure expected in unlimited profile');
  assert(
    ['integer4301', 'negative4301', 'html-decimal4301'].includes(name),
    'failure not expected for fixed case'
  );
  const htmlCase = name === 'html-decimal4301';
  const phase = htmlCase ? 'normalization' : 'numeric';
  assert.equal(prepared.failure.phase, phase, 'unexpected renderer failure stage');
  assert.equal(prepared.failure.cause.phase, phase, 'unexpected inner renderer failure stage');
  assert.equal(
    prepared.failure.cause.byteOffset,
    expectedByteOffset,
    'numeric failure occurred outside fixed row'
  );
  const message = htmlCase
    ? 'Exceeds the limit (4300 digits) for integer string conversion: value has 4301 digits; use sys.set_int_max_str_digits() to increase the limit'
    : 'Integer exceeds selected 4300-digit limit';
  assert.equal(prepared.failure.cause.message, message, 'unexpected renderer failure meaning');
  return {
    kind: 'integer_limit',
    stage: 'renderer',
    sourceStage: htmlCase ? 'html_decimal' : 'json_integer',
    limit: 4300,
    digits: 4301,
  };
}
export function verifyReferenceDependencies(identity, expected) {
  assert.equal(identity.implementation, 'cpython');
  assert(identity.version.startsWith('3.11.13 '));
  const observed = {};
  for (const module of Object.values(identity.modules)) {
    for (const pin of [module, module.cachedBytecode].filter(Boolean)) {
      assert.equal(expected[pin.path], pin.sha256, `unqualified Python dependency: ${pin.path}`);
      pinFile(pin);
      observed[pin.path] = pin.sha256;
    }
  }
  assert(Object.keys(observed).length > 0, 'empty reference dependency observation');
  return observed;
}
function verifyRequiredModuleClosure(require, root, pins) {
  const observed = {};
  for (const file of Object.keys(require.cache)) {
    assert(file.startsWith(root + path.sep), `candidate dependency escaped pinned dist: ${file}`);
    const relative = path.relative(root, file);
    assert.equal(pins[relative], sha(read(file)), `candidate dependency not pinned: ${file}`);
    observed[relative] = pins[relative];
  }
  return observed;
}
export async function qualify(requestFile) {
  const raw = read(requestFile),
    request = validateRequest(JSON.parse(raw));
  assert(
    !process.env.NODE_OPTIONS && !process.env.NODE_PATH && process.execArgv.length === 0,
    'qualifier requires plain pinned Node without preload options'
  );
  assert.equal(process.env.TZ, 'UTC0', 'controlled candidate timezone required');
  assert(!Object.hasOwn(process.env, 'TZDIR'), 'controlled candidate requires absent TZDIR');
  assert.equal(process.env.LC_ALL, 'C');
  assert.equal(process.env.LANG, 'C');
  assert.equal(
    fs.realpathSync(process.execPath),
    request.candidate.node.path,
    'execute with the pinned candidate Node'
  );
  for (const pin of [
    request.candidate.node,
    request.candidate.native,
    request.candidate.engine,
    request.reference.python,
    request.reference.adapter,
    request.corpus.cells,
  ])
    pinFile(pin);
  pinTree(request.candidate.distRoot, request.candidate.distFiles);
  pinTree(request.reference.sharedRoot, request.reference.sharedFiles);
  for (const [file, digest] of Object.entries(request.reference.pythonDependencies))
    pinFile({ path: file, sha256: digest });
  const adapterPin = request.reference.adapter;
  pinFile(adapterPin);
  const adapter = adapterPin.path;
  const driverPin = { path: ownFile, sha256: sha(read(ownFile)) };
  assert(!fs.existsSync(request.outputRoot));
  fs.mkdirSync(request.outputRoot, { mode: 0o700 });
  fs.mkdirSync(path.join(request.outputRoot, 'home'));
  fs.mkdirSync(path.join(request.outputRoot, 'tmp'));
  const environment = {
    HOME: path.join(request.outputRoot, 'home'),
    TMPDIR: path.join(request.outputRoot, 'tmp') + '/',
    PATH: '/usr/bin:/bin:/usr/sbin:/sbin',
    LC_ALL: 'C',
    LANG: 'C',
    TZ: 'UTC0',
    CAWS_AGENT_SURFACE: 'opencode',
    PYTHONDONTWRITEBYTECODE: '1',
  };
  const started = Date.now(),
    comparisons = [],
    executions = [],
    fixturePins = {},
    referenceDependencyPins = {};
  const checkReference = (reference) =>
    Object.assign(
      referenceDependencyPins,
      verifyReferenceDependencies(reference.identity, request.reference.pythonDependencies)
    );
  const run = (id, executable, argv) => {
    assert(Date.now() - started < 60000, 'qualification whole-run deadline');
    const result = spawnSync(executable, argv, {
      cwd: request.outputRoot,
      env: environment,
      encoding: null,
      timeout: Math.min(8000, 60000 - (Date.now() - started)),
      maxBuffer: 8 * 1024 * 1024,
    });
    const stdout = result.stdout ?? Buffer.alloc(0),
      stderr = result.stderr ?? Buffer.alloc(0);
    fs.writeFileSync(path.join(request.outputRoot, `${id}.stdout`), stdout, { flag: 'wx' });
    fs.writeFileSync(path.join(request.outputRoot, `${id}.stderr`), stderr, { flag: 'wx' });
    executions.push({
      id,
      executable,
      argv,
      exitCode: result.status,
      signal: result.signal,
      error: result.error?.message ?? null,
      stdoutSha256: sha(stdout),
      stderrSha256: sha(stderr),
    });
    save(path.join(request.outputRoot, `${id}.execution.json`), executions.at(-1));
    assert(!result.error && !result.signal && result.status === 0, `command failed: ${id}`);
    return JSON.parse(stdout.toString('utf8'));
  };
  try {
    const sqlite = run('native-sqlite-identity', request.candidate.native.path, [
      '--sqlite-build-identity',
    ]);
    exactKeys(sqlite, [
      'schema',
      'version',
      'sourceId',
      'threadSafe',
      'compileOptions',
      'compiledPrefixSha256',
    ]);
    assert.equal(sqlite.schema, 'caws.sqlite_build_identity.v1');
    const cells = JSON.parse(read(request.corpus.cells.path));
    assert.deepEqual(
      Object.keys(cells.fixtures).sort(),
      [...SQL_CASES].sort(),
      'wrong retained corpus'
    );
    for (const fixture of Object.values(cells.fixtures)) {
      pinFile({ path: fixture.database, sha256: fixture.database_sha256 });
      fixturePins[fixture.database] = fixture.database_sha256;
    }
    const require = createRequire(path.join(request.candidate.distRoot, 'index.js'));
    const implementation = request.nativePolicyImage
      ? capturePolicyImage(request, require)
      : undefined;
    const projection = require('./transcripts/store-projection.js');
    const { createDefaultTranscriptRegistry } = require('./transcripts/registry.js');
    const { prepareSessionArtifactsWithCalendar } = require('./transcripts/render-prepare.js');
    const calendar = require('./transcripts/renderer-calendar.js');
    const { jsonNumber } = require('./transcripts/lossless-json.js');
    const numeric = require('./transcripts/transcript-json-profile.js');
    const html = require('./transcripts/python-html.js');
    const limits = {
      json: {
        maxInputBytes: 100000,
        maxDecodedCodepoints: 100000,
        maxNodes: 10000,
        maxDepth: 100,
        maxStringCodepoints: 100000,
        maxNumberChars: 10000,
      },
      maxRows: 10,
      maxEvents: 10,
      maxCodepoints: 100000,
    };
    const context = {
      sessionId: 'qualification-sid',
      cwd: '/qualification/project',
      startedAt: '2023-11-14T22:13:20+00:00',
      model: 'unknown',
      branch: 'qualification',
      headSha: 'head',
      startSha: 'start',
      dirtyFiles: jsonNumber('2'),
    };
    const compare = (id, reference, candidate, referenceIdentity) => {
      save(path.join(request.outputRoot, id.replaceAll('/', '-') + '.comparison.json'), {
        id,
        reference,
        candidate,
        referenceIdentity,
      });
      assert.deepEqual(candidate, reference, `semantic mismatch: ${id}`);
      comparisons.push({
        id,
        result: 'equal',
        referenceSha256: sha(Buffer.from(JSON.stringify(reference))),
        candidateSha256: sha(Buffer.from(JSON.stringify(candidate))),
      });
    };
    for (const limit of [4300, 0]) {
      const profile =
        limit === 4300 ? 'cpython-3.11.13-unicode14-int4300' : 'cpython-3.11.13-unicode14-int0';
      const numericProfile = {
        id: `cpython3.11-json/int-max-str-digits:${limit}`,
        integerMaxDigits: limit,
      };
      for (const name of SQL_CASES) {
        const id = `sql/${limit}/${name}`,
          leaf = id.replaceAll('/', '-'),
          fixture = cells.fixtures[name];
        const input = {
          surface: 'opencode',
          sharedRoot: request.reference.sharedRoot,
          category: 'sql',
          case: name,
          integerMaxDigits: limit,
          database: fixture.database,
        };
        const inputFile = path.join(request.outputRoot, leaf + '.input.json');
        save(inputFile, input);
        const reference = run(leaf, request.reference.python.path, [
          '-B',
          '-S',
          '-X',
          `int_max_str_digits=${limit}`,
          adapter,
          inputFile,
        ]);
        checkReference(reference);
        assert.equal(reference.case, name);
        assert.equal(reference.category, 'sql');
        assert.equal(reference.integerMaxDigits, limit);
        const row = {
          ordinal: 1,
          cells: fixture.cells.map((cell) =>
            cell.storageClass === 'text' || cell.storageClass === 'blob'
              ? { storageClass: cell.storageClass, bytes: Buffer.from(cell.base64, 'base64') }
              : cell.storageClass === 'integer'
                ? { storageClass: 'integer', value: BigInt(cell.decimal) }
                : assert.fail('unqualified retained SQL storage class')
          ),
        };
        let actual;
        try {
          const value = await projection.reconstructStoreProjection(
            (async function* () {
              yield row;
            })(),
            'opencode',
            async (seconds) => {
              assert.equal(seconds, 1700000000n, 'corpus changed timestamp frontier');
              // Explicit supplied UTC dependency for this component corpus. Native
              // UTC acquisition/representation qualification remains a separate join.
              return {
                kind: 'utc_calendar',
                seconds,
                tmYear: 123,
                tmMon: 10,
                tmMday: 14,
                tmHour: 22,
                tmMin: 13,
                tmSec: 20,
              };
            },
            limits,
            profile
          );
          actual = {
            kind: 'projection',
            base64: Buffer.from(projection.encodeStoreProjectionEvents(value, 1000000)).toString(
              'base64'
            ),
          };
        } catch (error) {
          if (
            error?.name !== 'StoreJsonError' ||
            error.category !== 'integer_limit' ||
            error.code !== 'integer_digits'
          )
            throw error;
          save(path.join(request.outputRoot, leaf + '.candidate-failure.json'), {
            name: error.name,
            category: error.category,
            code: error.code,
            message: error.message,
            offset: error.offset,
            offsetUnit: error.offsetUnit,
          });
          actual = {
            kind: 'integer_limit',
            stage: 'sql',
            sourceStage: 'json_integer',
            limit: 4300,
            digits: 4301,
          };
          assert.equal(limit, 4300);
          assert(['message-int4301', 'message-negative4301', 'part-int4301'].includes(name));
        }
        verifyFixedOutcome('sql', name, limit, reference.observation);
        verifyFixedOutcome('sql', name, limit, actual);
        compare(id, reference.observation, actual, reference.identity);
      }
      for (const name of RENDER_CASES) {
        const id = `renderer/${limit}/${name}`,
          leaf = id.replaceAll('/', '-');
        const token =
          name === 'integer4300'
            ? '7'.repeat(4300)
            : name === 'integer4301'
              ? '7'.repeat(4301)
              : name === 'negative4301'
                ? '-' + '7'.repeat(4301)
                : name === 'string4301'
                  ? JSON.stringify('7'.repeat(4301))
                  : name === 'float4301'
                    ? '7'.repeat(4301) + '.0'
                    : null;
        const text =
          name === 'html-literal4301' ? '&#' + '7'.repeat(4301) + ';' : 'qualified-visible';
        const firstRow =
          JSON.stringify({
            type: 'user',
            timestamp: '2023-11-14T22:13:20+00:00',
            message: { content: [{ type: 'text', text }] },
          }).replace(/}$/, token === null ? '}' : `,"ignored":${token}}`) + '\n';
        // Stock unescapes user-shell activity, never an ordinary user's text.
        // Keep the literal case as a positive control against over-normalizing.
        const shellText = '<bash-input>&#' + '7'.repeat(4301) + ';</bash-input>';
        const transcript =
          firstRow +
          (name === 'html-decimal4301'
            ? JSON.stringify({
                type: 'user',
                timestamp: '2023-11-14T22:13:21+00:00',
                message: { content: [{ type: 'text', text: shellText }] },
              }) + '\n'
            : '');
        const transcriptPath = path.join(request.outputRoot, leaf + '.jsonl');
        fs.writeFileSync(transcriptPath, transcript, { flag: 'wx' });
        const input = {
          surface: 'opencode',
          sharedRoot: request.reference.sharedRoot,
          category: 'renderer',
          case: name,
          integerMaxDigits: limit,
          transcript: transcriptPath,
          artifactDirectory: path.join(request.outputRoot, leaf + '-reference-artifacts'),
          context,
        };
        const inputFile = path.join(request.outputRoot, leaf + '.input.json');
        save(inputFile, input);
        const reference = run(leaf, request.reference.python.path, [
          '-B',
          '-S',
          '-X',
          `int_max_str_digits=${limit}`,
          adapter,
          inputFile,
        ]);
        checkReference(reference);
        assert.equal(reference.case, name);
        assert.equal(reference.category, 'renderer');
        assert.equal(reference.integerMaxDigits, limit);
        const bytes = Buffer.from(transcript);
        if (limit === 4300 && ['integer4301', 'negative4301', 'html-decimal4301'].includes(name)) {
          let primitiveFailure;
          try {
            if (name === 'html-decimal4301') html.pythonHtmlUnescape(shellText, numericProfile);
            else numeric.parseTranscriptJson(transcript.trim(), numericProfile);
          } catch (error) {
            primitiveFailure = error;
          }
          const expectedType =
            name === 'html-decimal4301'
              ? html.PythonHtmlDecimalDigitLimitError
              : numeric.TranscriptJsonNumericConversionError;
          assert(
            primitiveFailure instanceof expectedType,
            'required typed numeric primitive refusal was absent or changed'
          );
          if (name === 'html-decimal4301') {
            assert.equal(primitiveFailure.code, 'PYTHON_HTML_DECIMAL_DIGIT_LIMIT');
            assert.equal(primitiveFailure.digits, 4301);
            assert.equal(primitiveFailure.limit, 4300);
          }
          save(path.join(request.outputRoot, leaf + '.primitive-failure.json'), {
            name: primitiveFailure.name,
            constructor: primitiveFailure.constructor.name,
            message: primitiveFailure.message,
            code: primitiveFailure.code,
            digits: primitiveFailure.digits,
            limit: primitiveFailure.limit,
            stack: primitiveFailure.stack,
          });
        }
        // The renderer validates these exact stock discovery paths even when
        // no subagent directory exists. Observe absence at those paths rather
        // than inventing unrelated placeholder names.
        const claudeSubagents = path.join(
          path.dirname(transcriptPath),
          context.sessionId,
          'subagents'
        );
        const qwenSubagents = path.join(
          path.dirname(path.dirname(transcriptPath)),
          'subagents',
          context.sessionId
        );
        assert(
          !fs.existsSync(claudeSubagents) && !fs.existsSync(qwenSubagents),
          'controlled corpus requires absent stock subagent directories'
        );
        const prepared = await prepareSessionArtifactsWithCalendar(
          {
            transcript: {
              path: transcriptPath,
              disposition: 'read',
              source: {
                sourceId: transcriptPath,
                sourceGeneration: 'qualification',
                inode: '1',
                size: BigInt(bytes.length),
                bytes,
              },
            },
            audit: { path: path.join(request.outputRoot, 'absent-audit'), disposition: 'absent' },
            hookOutcomes: {
              path: path.join(request.outputRoot, 'absent-hooks'),
              disposition: 'absent',
            },
            subagents: {
              claudeCandidate: { path: claudeSubagents, kind: 'absent' },
              qwenCandidate: { path: qwenSubagents, kind: 'absent' },
            },
            registry: createDefaultTranscriptRegistry({ surface: 'opencode', numericProfile }),
            numericProfile,
            context,
            priorInventory: { observationId: 'qualification-empty-inventory', artifacts: [] },
            limits: {
              maximumInputBytes: 1000000,
              maximumArtifactBytes: 1000000,
              maximumTotalArtifactBytes: 2000000,
              maximumArtifacts: 100,
            },
          },
          (catalog) =>
            calendar.resolveRendererCalendar({
              profile: calendar.RENDERER_CALENDAR_PROFILE,
              id: 'qualification',
              runtimeDigest: request.candidate.engine.sha256,
              token: 'qualification',
              context: {
                originalPid: process.pid,
                tz: { kind: 'present', value: 'UTC0' },
                tzdir: { kind: 'absent' },
              },
              timestamps: catalog.timestamps,
              sortEpochs: catalog.sortEpochs,
              maximumTimestampBytes: 100000,
              maximumQueries: 1024,
              port: {
                observe() {
                  throw Error('component corpus unexpectedly requires native local calendar');
                },
              },
              signal: new globalThis.AbortController().signal,
              deadlineEpochMs: started + 60000,
            })
        );
        let actual;
        if (prepared.disposition === 'ready')
          actual = {
            kind: 'artifacts',
            files: Object.fromEntries(
              prepared.generation.artifacts.map((artifact) => [
                artifact.name,
                Buffer.from(artifact.bytes()).toString('base64'),
              ])
            ),
          };
        else if (prepared.disposition === 'failed') {
          save(path.join(request.outputRoot, leaf + '.candidate-failure.json'), prepared.failure);
          actual = normalizeRendererFailure(
            prepared,
            name,
            limit,
            name === 'html-decimal4301' ? BigInt(Buffer.byteLength(firstRow)) : 0n
          );
        } else throw Error(`unqualified renderer disposition ${prepared.disposition}`);
        verifyFixedOutcome('renderer', name, limit, reference.observation);
        verifyFixedOutcome('renderer', name, limit, actual);
        compare(id, reference.observation, actual, reference.identity);
      }
    }
    verifyCoverage(comparisons);
    if (implementation) {
      assert.deepEqual(
        capturePolicyImage(request, require),
        implementation,
        'image changed during comparison'
      );
    }
    const candidateModulePins = verifyRequiredModuleClosure(
      require,
      request.candidate.distRoot,
      request.candidate.distFiles
    );
    for (const [file, digest] of Object.entries(request.reference.pythonDependencies))
      pinFile({ path: file, sha256: digest });
    for (const pin of [
      request.candidate.node,
      request.candidate.native,
      request.candidate.engine,
      request.reference.python,
      request.reference.adapter,
      request.corpus.cells,
    ])
      pinFile(pin);
    pinTree(request.candidate.distRoot, request.candidate.distFiles);
    pinTree(request.reference.sharedRoot, request.reference.sharedFiles);
    for (const [file, digest] of Object.entries(fixturePins))
      pinFile({ path: file, sha256: digest });
    pinFile(adapterPin);
    pinFile(driverPin);
    const artifactPins = {};
    function captureArtifacts(directory, relative = '') {
      for (const name of fs.readdirSync(directory).sort()) {
        const rel = relative ? `${relative}/${name}` : name,
          file = path.join(request.outputRoot, rel),
          info = fs.lstatSync(file);
        assert(!info.isSymbolicLink(), 'unexpected output symlink');
        if (info.isDirectory()) captureArtifacts(file, rel);
        else {
          assert(info.isFile());
          artifactPins[rel] = sha(read(file));
        }
      }
    }
    captureArtifacts(request.outputRoot);
    const receipt = {
      schema: 'caws.stop-profile.component-comparison.v1',
      surface: 'opencode',
      event: 'stop',
      referenceMode: 'controlled-no-site-explicit-X',
      requestSha256: sha(raw),
      driverSha256: driverPin.sha256,
      adapter: adapterPin,
      candidate: request.candidate,
      reference: request.reference,
      sqliteIdentity: sqlite,
      corpus: {
        cells: request.corpus.cells,
        fixturePins,
        requiredCases: { sql: SQL_CASES, renderer: RENDER_CASES },
      },
      comparisons,
      executions,
      artifactPins,
      referenceDependencyPins,
      candidateModulePins,
      remainingJoins: [
        'Native UTC and local-calendar observations under original environment, matched to this exact native image/source',
        'Original generation and selection admission',
        'Ordinary Stop transport/acquisition/publication/consumer result',
        'Other supported surfaces',
        'Bundled engine dispatch equivalence to the compared dist modules',
        'Preparation failure records erase original exception constructors; typed primitive refusals and exact preparation stage/message are compared separately',
        'Ambient legacy startup equivalence is not established',
      ],
    };
    const receiptFile = path.join(request.outputRoot, 'component-comparison.json');
    save(receiptFile, receipt);
    if (implementation) {
      // Emitted only after this invocation executed every fixed comparison and
      // repeated exact tool/dist/image observations. No historical receipt input.
      save(
        path.join(request.outputRoot, 'native-stop-profile.json'),
        semanticPolicy(receipt, sha(read(receiptFile)), implementation)
      );
    }
    save(path.join(request.outputRoot, 'stop-profile-component-draft.json'), {
      schema: 'caws.stop-profile.component-draft.v1',
      surface: 'opencode',
      event: 'stop',
      candidate: request.candidate,
      sqlProfiles: ['cpython-3.11.13-unicode14-int4300', 'cpython-3.11.13-unicode14-int0'],
      rendererProfiles: [4300, 0].map((integerMaxDigits) => ({
        id: `cpython3.11-json/int-max-str-digits:${integerMaxDigits}`,
        integerMaxDigits,
      })),
      referenceMode: receipt.referenceMode,
      componentReceiptSha256: sha(read(receiptFile)),
      remainingJoins: receipt.remainingJoins,
    });
    return receipt;
  } catch (error) {
    save(path.join(request.outputRoot, 'failure.json'), {
      schema: 'caws.stop-profile.component-failure.v1',
      message: String(error),
      error: { name: error?.name, message: error?.message, stack: error?.stack },
      comparisons,
      executions,
    });
    throw error;
  }
}
if (process.argv[1] && path.resolve(process.argv[1]) === ownFile) {
  if (process.argv.length !== 3)
    throw Error('usage: pinned-node qualify-stop-profile.mjs ABSOLUTE_REQUEST_JSON');
  await qualify(path.resolve(process.argv[2]));
}
