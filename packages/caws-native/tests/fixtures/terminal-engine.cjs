// Protocol fixture only: this exercises native terminal transport/effects, not
// selected guard policy, latch authority, installed hooks, or real harness action.
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync, spawn } = require('node:child_process');
const root = process.env.TERMINAL_CASE_ROOT;
const record = row => fs.appendFileSync(path.join(root, 'wire-events.jsonl'), JSON.stringify(row) + '\n');
let request, terminal = false, dispatches = 0, input = '';
const watchdog = setTimeout(() => {
  fs.writeFileSync(path.join(root, 'engine-watchdog-fired.marker'), 'fixture deadline');
  record({ stage: 'fixture-watchdog-fired' });
  process.exit(78);
}, 8000);
const emit = row => process.stdout.write(JSON.stringify(row) + '\n');
const ps = (field, pid) => execFileSync('/bin/ps', ['-o', field + '=', '-p', String(pid)], {
  encoding: 'utf8', timeout: 500, maxBuffer: 8192,
  env: { LC_ALL: 'C', TZ: 'UTC' },
}).replace(/\n+$/, '');
function accept(frame) {
  if (!request) {
    request = frame;
    // The retained native Child publishes its PID before request input is sent.
    // Custody may change this engine's parent without changing the request caller.
    const frontend = Number(fs.readFileSync(path.join(root, 'native-pid.txt'), 'utf8'));
    if (!Number.isSafeInteger(frontend) || frontend <= 1
        || frame.schema !== 'caws.runtime.request.v1' || frame.caller.processId !== frontend)
      throw new Error('fixture request does not identify the retained original frontend');
    record({ stage: 'request-identity', frontendPid: frontend,
      callerPid: frame.caller.processId, engineParentPid: process.ppid });
    fs.writeFileSync(path.join(root, 'engine-pid.txt'), String(process.pid));
    return emit({ schema: 'caws.runtime.ready.v1', id: frame.id, runtimeDigest: frame.runtimeDigest,
      active: true, budgetHome: path.join(root, 'budget-home'), projectDigest: 'c'.repeat(64), sessionId: 'terminal-fixture' });
  }
  if (frame.id !== request.id || frame.runtimeDigest !== request.runtimeDigest)
    throw new Error('foreign fixture control');
  if (frame.schema === 'caws.runtime.dispatch.v1') {
    if (terminal || ++dispatches !== 1) {
      record({ stage: 'dispatch-after-terminal' });
      throw new Error('unexpected second dispatch');
    }
    record({ stage: 'dispatch', count: dispatches });
    const pid = Number(process.env.TERMINAL_CALLER_PID);
    // The cleanup case has one surviving owner between caller and native.
    // Reject any other ancestry before proposing the effect.
    const owner = process.env.TERMINAL_OUTPUT_MODE === 'post-effect-stall'
      ? Number(process.env.TERMINAL_OWNER_PID) : pid;
    if (!Number.isSafeInteger(pid) || pid <= 1
        || !Number.isSafeInteger(owner) || owner <= 1
        || Number(ps('ppid', request.caller.processId).trim()) !== owner
        || (owner !== pid && Number(ps('ppid', owner).trim()) !== pid))
      throw new Error('target is not the configured sacrificial caller ancestry');
    if (process.env.TERMINAL_OUTPUT_MODE === 'post-effect-stall') {
      const holder = spawn(process.execPath, ['-e', `
        const fs = require('node:fs'), path = require('node:path');
        const root = process.env.TERMINAL_CASE_ROOT, until = Date.now() + 8000;
        setInterval(() => {
          if (fs.existsSync(path.join(root, 'abort-stalled-engine'))) process.exit(79);
          if (Date.now() >= until) {
            fs.writeFileSync(path.join(root, 'holder-watchdog-fired.marker'), 'fixture deadline');
            process.exit(78);
          }
        }, 20);
      `], { stdio: 'inherit' });
      const group = Number(ps('pgid', process.pid).trim());
      const holderGroup = Number(ps('pgid', holder.pid).trim());
      if (group !== process.pid || holderGroup !== group)
        throw new Error('stall fixtures do not share the native-owned engine group');
      fs.writeFileSync(path.join(root, 'stalled-group.json'), JSON.stringify({
        enginePid: process.pid, holderPid: holder.pid, groupPid: group,
        engineStart: ps('lstart', process.pid), holderStart: ps('lstart', holder.pid),
      }, null, 2));
    }
    const comm = ps('comm', pid);
    const epoch = Math.floor(Date.parse(ps('lstart', pid).trim() + ' UTC') / 1000);
    if (!Number.isSafeInteger(epoch) || epoch <= 0) throw new Error('caller start epoch unavailable');
    const containment = { schema: 'caws.containment.intent.v1', pid, startEpoch: String(epoch), comm,
      sessionId: 'terminal-fixture', latchPath: path.join(root, 'fixture-latch.json'), latchGeneration: 'd'.repeat(32) };
    fs.writeFileSync(path.join(root, 'intent.json'), JSON.stringify(containment, null, 2));
    const result = { exitCode: 2, stdoutBase64: Buffer.from(JSON.stringify({ decision: 'block', reason: 'x'.repeat(1_000_000) }) + '\n').toString('base64'), stderrBase64: '' };
    fs.writeFileSync(path.join(root, 'proposed-native-result.json'), JSON.stringify(result));
    terminal = true;
    record({ stage: 'proposal', token: 'terminal-proposal', targetPid: pid });
    return emit({ schema: 'caws.runtime.proposal.v2', id: request.id, runtimeDigest: request.runtimeDigest, token: 'terminal-proposal',
      response: { schema: 'caws.runtime.response.v1', id: request.id, runtimeDigest: request.runtimeDigest, result }, containment });
  }
  if (frame.schema !== 'caws.runtime.handoff.v2' || frame.token !== 'terminal-proposal' || !terminal)
    throw new Error('unexpected terminal input');
  if (Object.keys(frame).sort().join(',') !== 'containment,id,runtimeDigest,schema,success,token')
    throw new Error('unexpected handoff keys');
  record({ stage: 'handoff', success: frame.success, containment: frame.containment });
  if (process.env.TERMINAL_OUTPUT_MODE === 'post-effect-stall')
    record({ stage: 'post-effect-stall' });
  fs.writeFileSync(path.join(root, 'handoff.pending'), JSON.stringify(frame, null, 2));
  fs.renameSync(path.join(root, 'handoff.pending'), path.join(root, 'handoff.json'));
  if (process.env.TERMINAL_OUTPUT_MODE === 'post-effect-stall') {
    process.stdin.destroy();
    setInterval(() => {
      if (fs.existsSync(path.join(root, 'abort-stalled-engine'))) process.exit(79);
    }, 20);
    return;
  }
  clearTimeout(watchdog);
  process.stdin.destroy();
}
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => {
  input += chunk;
  let end;
  while ((end = input.indexOf('\n')) >= 0) {
    const frame = input.slice(0, end); input = input.slice(end + 1);
    accept(JSON.parse(frame));
  }
});
