// Offline evidence tool. Private records are explicit inputs, never programs.
const fs = require('node:fs'),
  path = require('node:path'),
  crypto = require('node:crypto'),
  assert = require('node:assert/strict');
const { analyzeCommand } = require('../../../dist/shell/analysis/analyze.js');
async function main() {
  const [recordsPath, indexPath, oraclesPath, laneArg, output] = process.argv.slice(2);
  assert(output, 'Usage: replay.cjs RECORDS INDEX ORACLES OWNED_LANE OUTPUT');
  const read = (p) => JSON.parse(fs.readFileSync(p, 'utf8'));
  const input = read(recordsPath),
    index = read(indexPath),
    oracles = read(oraclesPath),
    lane = path.resolve(laneArg);
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
    const conditional = oracle.expected === 'safe-if-pure-integer-arithmetic-supported';
    const allowed =
      oracle.expected === 'safe'
        ? ['allow']
        : conditional
          ? ['allow', 'unresolved']
          : ['deny', 'unresolved'];
    return {
      id: oracle.id,
      expected: oracle.expected,
      observed: actual.decision,
      admissionDisagreement: !allowed.includes(actual.decision),
      contextDependent:
        actual.reasoncodes.includes('cwd-unresolved') ||
        oracle.id.endsWith(':toolu_01LjxtPpX2yTdYxpxn1BPHuE'),
      reasoncodes: actual.reasoncodes,
    };
  });
  const report = {
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
  console.log(JSON.stringify({ ...report, records: undefined }, null, 2));
}
main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
