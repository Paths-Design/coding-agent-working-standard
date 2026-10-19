const fs = require('node:fs');
const { spawn } = require('node:child_process');
const mode = process.env.CAWS_NATIVE_TEST_MODE || 'exact';
const record = (name, value) => {
  if (process.env[name]) fs.appendFileSync(process.env[name], `${JSON.stringify(value)}\n`);
};
if (process.env.CAWS_NATIVE_TEST_ENGINE_PID)
  fs.writeFileSync(process.env.CAWS_NATIVE_TEST_ENGINE_PID, String(process.pid));
let request;
let ready;
let text = '';
const token = 'fixture-proposal';
const emit = (value, done) => process.stdout.write(`${JSON.stringify(value)}\n`, done);
const failure = message =>
  emit({
    schema: 'caws.runtime.failure.v1',
    id: request.id,
    runtimeDigest: request.runtimeDigest,
    message,
  });
const response = () => ({
  schema: 'caws.runtime.response.v1',
  id: request.id,
  runtimeDigest: request.runtimeDigest,
  result: {
    exitCode: 7,
    stdoutBase64: Buffer.from('native\n雪\u0000exact').toString('base64'),
    stderrBase64: Buffer.from('diagnostic\nexact\n').toString('base64'),
  },
});
function propose() {
  const answer = response();
  if (mode === 'large-native-result')
    answer.result.stdoutBase64 = Buffer.alloc(1_000_000, 0x78).toString('base64');
  if (mode === 'guard-block')
    answer.result = {
      exitCode: 2,
      stdoutBase64: Buffer.from('{"decision":"block","reason":"real guard"}\n').toString('base64'),
      stderrBase64: Buffer.from('real guard\n').toString('base64'),
    };
  if (mode === 'large-guard-block')
    answer.result = {
      exitCode: 2,
      stdoutBase64: Buffer.from(
        JSON.stringify({ decision: 'block', reason: 'x'.repeat(1_000_000) }) + '\n'
      ).toString('base64'),
      stderrBase64: Buffer.from('real guard\n').toString('base64'),
    };
  if (mode === 'nonblock' || mode === 'inactive')
    answer.result = { exitCode: 0, stdoutBase64: '', stderrBase64: '' };
  if (mode === 'binary') {
    answer.result.stdoutBase64 = Buffer.from([0xff, 0, 0x61]).toString('base64');
    answer.result.stderrBase64 = Buffer.from(Array.from({ length: 256 }, (_, n) => n)).toString(
      'base64'
    );
  }
  if (mode === 'bad-base64') answer.result.stdoutBase64 = 'Zg==\n';
  if (mode === 'pad-bits') answer.result.stderrBase64 = 'Zh==';
  if (mode === 'old-text-shape') answer.result = { exitCode: 7, stdout: 'old text', stderr: '' };
  if (mode === 'id') answer.id += '-foreign';
  if (mode === 'digest') answer.runtimeDigest = 'b'.repeat(64);
  if (mode === 'schema') answer.schema = 'caws.runtime.response.v2';
  if (mode === 'exit-code') answer.result.exitCode = 256;
  if (mode === 'extra-field') answer.unrecognized = true;
  if (mode === 'oversize') return process.stdout.write('x'.repeat(4_198_401));
  if (mode === 'stderr-oversize') return process.stderr.write('x'.repeat(65_537));
  if (mode === 'malformed') return process.stdout.write('{\n');
  if (mode === 'failure' || mode === 'inactive-failure')
    return failure('fixture execution failure');
  if (mode === 'ready-twice') return emit(ready);
  if (mode === 'crash') return process.exit(1);
  if (mode === 'timeout') return setInterval(() => {}, 1000);
  if (mode === 'closed-pipes') {
    fs.closeSync(1);
    fs.closeSync(2);
    return setInterval(() => {}, 1000);
  }
  if (mode === 'pipe-holder' || mode === 'pipe-holder-wait') {
    const child = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { stdio: 'inherit' });
    fs.writeFileSync(process.env.CAWS_NATIVE_TEST_CHILD, String(child.pid));
    if (mode === 'pipe-holder-wait') return setInterval(() => {}, 1000);
  }
  const proposal = {
    schema: 'caws.runtime.proposal.v2',
    id: request.id,
    runtimeDigest: request.runtimeDigest,
    token,
    response: answer,
    containment: null,
  };
  if (mode === 'outer-id') proposal.id += '-foreign';
  if (mode === 'outer-digest') proposal.runtimeDigest = 'b'.repeat(64);
  if (mode === 'proposal-token') proposal.token = 'invalid token';
  if (mode === 'proposal-extra') proposal.extra = true;
  if (mode === 'proposal-missing-containment') delete proposal.containment;
  if (mode === 'proposal-malformed-containment') { proposal.containment = {pid:1}; answer.result = {exitCode:2,stdoutBase64:Buffer.from('{\"decision\":\"block\",\"reason\":\"retained\"}\n').toString('base64'),stderrBase64:''}; }
  if (mode === 'late-post-proposal-hang')
    return setTimeout(
      () => emit(proposal),
      Math.max(0, request.deadlineEpochMs - Date.now() - 150)
    );
  emit(proposal, mode === 'nonzero' ? () => process.exit(1) : undefined);
}
function accept(frame) {
  if (!request) {
    request = frame;
    if (request.caller.processId !== process.ppid)
      throw new Error('caller processId is not native parent PID');
    record('CAWS_NATIVE_TEST_RECEIPT', request);
    if (mode === 'pre-ready-failure') return failure('fixture configuration failure');
    ready = {
      schema: 'caws.runtime.ready.v1',
      id: request.id,
      runtimeDigest: request.runtimeDigest,
      active: !['inactive', 'inactive-failure'].includes(mode),
      budgetHome: process.env.CAWS_NATIVE_TEST_BUDGET_HOME,
      projectDigest: ['inactive', 'inactive-failure'].includes(mode)
        ? null
        : process.env.CAWS_NATIVE_TEST_PROJECT_DIGEST || 'c'.repeat(64),
      sessionId: process.env.CAWS_NATIVE_TEST_SESSION_ID || 'session',
    };
    if (mode === 'ready-id') ready.id += '-foreign';
    if (mode === 'ready-digest') ready.runtimeDigest = 'b'.repeat(64);
    if (mode === 'ready-schema') ready.schema = 'caws.runtime.ready.v2';
    if (mode === 'ready-home') ready.budgetHome = 'relative';
    if (mode === 'ready-extra') ready.extra = true;
    if (mode === 'ready-project') ready.projectDigest = null;
    if (mode === 'ready-session') ready.sessionId = 's'.repeat(129);
    if (mode === 'ready-missing-session') delete ready.sessionId;
    if (mode === 'ready-missing-project') delete ready.projectDigest;
    if (mode === 'proposal-before-ready')
      return emit({
        schema: 'caws.runtime.proposal.v2',
        id: request.id,
        runtimeDigest: request.runtimeDigest,
        token,
        response: response(),
        containment: null,
      });
    return emit(ready);
  }
  if (frame.id !== request.id || frame.runtimeDigest !== request.runtimeDigest)
    throw new Error('native frame identity');
  if (frame.schema === 'caws.runtime.dispatch.v1') {
    if (Object.keys(frame).sort().join(',') !== 'id,runtimeDigest,schema')
      throw new Error('dispatch keys');
    record('CAWS_NATIVE_TEST_EVENTS', { dispatch: true });
    return propose();
  }
  if (
    frame.schema !== 'caws.runtime.handoff.v2' ||
    frame.token !== token ||
    typeof frame.success !== 'boolean' ||
    Object.keys(frame).sort().join(',') !== 'containment,id,runtimeDigest,schema,success,token'
  )
    throw new Error('native ACK');
  record('CAWS_NATIVE_TEST_EVENTS', frame);
  if (frame.success) record('CAWS_NATIVE_TEST_EVENTS', { settled: true });
  if (mode === 'post-proposal-hang' || mode === 'late-post-proposal-hang')
    return setInterval(() => {}, 1000);
  process.stdin.destroy();
  if (mode === 'pipe-holder') process.exit(0);
}
if (mode === 'no-read') setInterval(() => {}, 1000);
else {
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', data => {
    text += data;
    let end;
    while ((end = text.indexOf('\n')) >= 0) {
      const line = text.slice(0, end);
      text = text.slice(end + 1);
      if (process.env.CAWS_NATIVE_TEST_RAW_REQUEST)
        fs.appendFileSync(process.env.CAWS_NATIVE_TEST_RAW_REQUEST, line + '\n');
      accept(JSON.parse(line));
    }
  });
}
