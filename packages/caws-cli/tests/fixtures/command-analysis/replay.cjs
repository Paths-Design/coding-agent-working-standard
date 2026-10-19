// Offline evidence tool. Private records are explicit inputs, never programs.
const fs = require('node:fs'),
  path = require('node:path'),
  crypto = require('node:crypto'),
  assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const { analyzeCommand } = require('../../../dist/shell/analysis/analyze.js');
const sha256 = (value) => crypto.createHash('sha256').update(value).digest('hex');
function buildIdentity() {
  const entries = [];
  const pkg = path.resolve(__dirname, '../../..');
  function collect(scope, root, directory = root) {
    for (const item of fs.readdirSync(directory, { withFileTypes: true })) {
      const filename = path.join(directory, item.name);
      if (item.isDirectory()) {
        if (item.name !== 'node_modules') collect(scope, root, filename);
      } else if (item.isFile()) {
        entries.push({
          scope,
          path: path.relative(root, filename),
          sha256: sha256(fs.readFileSync(filename)),
        });
      }
    }
  }
  collect('source-analysis', path.join(pkg, 'src/shell/analysis'));
  collect('compiled-cli', path.join(pkg, 'dist'));
  collect('parser', path.dirname(path.dirname(require.resolve('unbash'))));
  for (const relative of [
    'package.json',
    'src/store/git-binary.ts',
    'src/store/repo-root.ts',
    'dist/store/git-binary.js',
  ])
    entries.push({
      scope: 'package',
      path: relative,
      sha256: sha256(fs.readFileSync(path.join(pkg, relative))),
    });
  return entries.sort((a, b) => {
    const left = a.scope + '/' + a.path,
      right = b.scope + '/' + b.path;
    return left < right ? -1 : left > right ? 1 : 0;
  });
}
async function main() {
  const [recordsPath, indexPath, oraclesPath, laneArg, output] = process.argv.slice(2);
  assert(output, 'Usage: replay.cjs RECORDS INDEX ORACLES OWNED_LANE OUTPUT');
  const read = (p) => JSON.parse(fs.readFileSync(p, 'utf8'));
  const input = read(recordsPath),
    index = read(indexPath),
    frozenOracles = read(oraclesPath),
    lane = path.resolve(laneArg);
  const full = !Array.isArray(frozenOracles);
  if (full) {
    assert.equal(frozenOracles.schema, 'caws.shell_corpus_adjudication.v1');
    assert.equal(frozenOracles.corpus_sha256, sha256(fs.readFileSync(recordsPath)));
    assert.equal(frozenOracles.records.length, input.length);
    assert(Array.isArray(frozenOracles.independent_labels));
    assert(frozenOracles.independent_labels.length > 0);
    const independent = new Map();
    for (const label of frozenOracles.independent_labels) {
      assert.equal(sha256(fs.readFileSync(label.file)), label.sha256);
      for (const row of read(label.file)) {
        assert(!independent.has(row.id));
        independent.set(row.id, row);
      }
    }
    assert.equal(independent.size, input.length);
    for (const row of frozenOracles.records) {
      const label = independent.get(row.id);
      assert(label);
      assert.equal(label.command_sha256, row.command_sha256);
      assert.equal(label.expected_counterfactual.toLowerCase(), row.independent_expected);
      if (
        row.adjudicated_expected !== row.independent_expected ||
        row.effect_class !== label.effect_class
      )
        assert(
          typeof row.discharge === 'string' && row.discharge.trim(),
          'Changed adjudication requires a source-grounded discharge.'
        );
    }
  }
  // Only frozen requirements are consumed. Prior observed decisions and prior
  // mismatch counts in a full adjudication artifact never supply the oracle.
  const oracles = full ? frozenOracles.records : frozenOracles;
  assert.equal(new Set(oracles.map((item) => item.id)).size, oracles.length);
  const warningIds = new Set(index.events.map((item) => item.id));
  const incidentId = (item) =>
    item.source?.incident_id || item.id.slice(item.id.lastIndexOf(':') + 1);
  assert.equal(input.length, 209);
  assert.equal(warningIds.size, 207);
  assert.equal(new Set(input.map((item) => item.id)).size, 209);
  assert.equal(new Set(input.map(incidentId).filter((id) => warningIds.has(id))).size, 207);
  const fresh = () => ({ records: 0, allow: 0, deny: 0, unresolved: 0 });
  const groups = { indexed: fresh(), extra: fresh() },
    reasons = {},
    records = [];
  let redactedCount = 0;
  for (const item of input) {
    assert.equal(typeof item.command, 'string');
    const redacted = /<redacted:[^>]*>/.test(item.command);
    const result = redacted
      ? { decision: 'unresolved', reasons: [{ code: 'replay-redacted' }] }
      : await analyzeCommand({ command: item.command, cwd: lane, worktree: lane, shell: 'bash' });
    if (redacted) redactedCount++;
    assert(['allow', 'deny', 'unresolved'].includes(result.decision));
    const codes = [...new Set(result.reasons.map((reason) => reason.code))].sort();
    for (const code of codes) reasons[code] = (reasons[code] || 0) + 1;
    const group = warningIds.has(incidentId(item)) ? groups.indexed : groups.extra;
    group.records++;
    group[result.decision]++;
    records.push({
      id: item.id,
      commandhash: crypto.createHash('sha256').update(item.command).digest('hex'),
      sourcecorrelation: item.source?.correlation || 'unknown',
      historycwdknown: typeof item.cwd === 'string' && item.cwd.length > 0,
      decision: result.decision,
      reasoncodes: codes,
    });
  }
  assert.equal(redactedCount, 2);
  const byId = new Map(records.map((item) => [item.id, item]));
  const oracleComparisons = oracles.map((oracle) => {
    const actual = byId.get(oracle.id);
    assert(actual);
    if (full) {
      assert.equal(oracle.command_sha256, actual.commandhash);
      assert(['allow', 'deny', 'unresolved'].includes(oracle.adjudicated_expected));
    }
    const expected = full ? oracle.adjudicated_expected : oracle.expected;
    const conditional = expected === 'safe-if-pure-integer-arithmetic-supported';
    const allowed = full
      ? [expected]
      : expected === 'safe'
        ? ['allow']
        : conditional
          ? ['allow', 'unresolved']
          : ['deny', 'unresolved'];
    return {
      id: oracle.id,
      expected,
      ...(full
        ? {
            effectClass: oracle.effect_class,
            independentExpected: oracle.independent_expected,
            discharge: oracle.discharge,
          }
        : {}),
      observed: actual.decision,
      admissionDisagreement: !allowed.includes(actual.decision),
      contextDependent:
        actual.reasoncodes.includes('cwd-unresolved') ||
        oracle.id.endsWith(':toolu_01LjxtPpX2yTdYxpxn1BPHuE'),
      reasoncodes: actual.reasoncodes,
    };
  });
  const report = {
    schema: 'caws.shell_corpus_replay.v1',
    revision: execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: lane,
      encoding: 'utf8',
      timeout: 2000,
    }).trim(),
    trackedDiffSha256: sha256(
      execFileSync('git', ['diff', 'HEAD', '--'], {
        cwd: lane,
        timeout: 2000,
        maxBuffer: 8 * 1024 * 1024,
      })
    ),
    corpusSha256: sha256(fs.readFileSync(recordsPath)),
    oracleSha256: sha256(fs.readFileSync(oraclesPath)),
    oracleCoverage: full ? 'full-adjudication' : 'representatives',
    buildIdentity: buildIdentity(),
    context: {
      mode: 'counterfactual-owned-lane',
      cwd: lane,
      worktree: lane,
      shell: 'bash',
      historicalCwdUsed: false,
      historicalCwdKnown: records.filter((item) => item.historycwdknown).length,
      historicalShellEnvironmentVerified: false,
      historicalOwnershipVerified: false,
      historicalNativeExecutionVerified: false,
      storedCommandsExecuted: false,
    },
    groups,
    redactedCount,
    reasonFrequencies: reasons,
    oracleComparisons,
    records,
  };
  fs.writeFileSync(output, JSON.stringify(report, null, 2), { mode: 0o600 });
  fs.chmodSync(output, 0o600);
  const disagreements = oracleComparisons.filter((item) => item.admissionDisagreement);
  console.log(
    JSON.stringify(
      {
        revision: report.revision,
        context: report.context,
        groups,
        redactedCount,
        oracleCoverage: report.oracleCoverage,
        compared: oracleComparisons.length,
        disagreements: disagreements.length,
        corpusSha256: report.corpusSha256,
        oracleSha256: report.oracleSha256,
        buildFiles: report.buildIdentity.length,
        outputSha256: sha256(fs.readFileSync(output)),
        output,
      },
      null,
      2
    )
  );
  assert.equal(
    disagreements.length,
    0,
    'Replay disagrees with frozen adjudicated requirements; inspect the retained output.'
  );
}
main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
