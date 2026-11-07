import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { observedSpawn } from './runtime-upgrade-smoke.mjs';
import { requireQualificationSupervisor } from './runtime-upgrade-supervisor.mjs';

function fixture(name) {
  const parent = process.env.CAWS_RELEASE_ARTIFACT_DIR ?? os.tmpdir();
  fs.mkdirSync(parent, { recursive: true });
  const root = fs.realpathSync(fs.mkdtempSync(path.join(parent, `upgrade-${name}-`)));
  const run = (script, options = {}) =>
    observedSpawn(process.execPath, ['-e', script], {
      cwd: root,
      encoding: 'utf8',
      timeout: 3000,
      env: { ...process.env, CAWS_QUALIFICATION_ARTIFACT_DIR: root },
      qualificationSupervisor: requireQualificationSupervisor(
        process.env.CAWS_QUALIFICATION_SUPERVISOR
      ),
      ...options,
    });
  return { root, run };
}

test('qualification requires an explicit built supervisor, never a PATH fallback', () => {
  for (const value of [undefined, '', 'upgrade-supervisor'])
    assert.throws(() => requireQualificationSupervisor(value), /absolute executable/);
});

test('supervisor preserves actual input, outputs, exit status and bounded custody receipt', () => {
  const { run, root } = fixture('stdio');
  const result = run(
    'const fs=require("fs"); process.stdout.write(fs.readFileSync(0)); process.stderr.write("actual-error"); process.exitCode=7;',
    { input: 'actual-input\u0000\u00e9' }
  );
  assert.equal(result.status, 7);
  assert.equal(result.error, undefined);
  assert.equal(result.stdout, 'actual-input\u0000\u00e9');
  assert.equal(result.stderr, 'actual-error');
  assert.equal(result.qualificationCustody.group_settlement, 'settled');
  assert.equal(result.qualificationCustody.direct_child_reaped, true);
  assert.equal(result.qualificationCustody.stdout_eof, true);
  assert.equal(result.qualificationCustody.stderr_eof, true);
  const receipt = JSON.parse(fs.readFileSync(path.join(root, result.qualificationReceipt.file)));
  assert.equal(receipt.exit_code, 7);
  assert.equal(receipt.stdout, result.stdout);
  assert.equal(receipt.custody.uncertain, false);
  assert.equal(
    'env' in
      JSON.parse(
        fs.readFileSync(path.join(result.qualificationCustody.retained_root, 'request.json'))
      ),
    false
  );
});

test('natural leader exit stops its still-running original group', async () => {
  const { run, root } = fixture('natural-group');
  const child =
    'const fs=require("fs"); fs.writeFileSync("ready","yes"); setTimeout(()=>fs.writeFileSync("late","no"),1500);';
  const parent = `const fs=require('fs'); const c=require('child_process').spawn(process.execPath,['-e',${JSON.stringify(child)}],{stdio:'ignore'}); c.unref(); const t=setInterval(()=>{if(fs.existsSync('ready')){clearInterval(t);process.exit(0)}},5);`;
  const result = run(parent);
  assert.equal(result.status, 0);
  assert.equal(result.error, undefined);
  assert.equal(fs.readFileSync(path.join(root, 'ready'), 'utf8'), 'yes');
  assert.equal(result.qualificationCustody.group_settlement, 'settled');
  await delay(1800);
  assert.equal(fs.existsSync(path.join(root, 'late')), false);
});

for (const mode of ['blocked-input', 'closed-output', 'overflow']) {
  test(`supervisor original deadline survives ${mode}`, () => {
    const { run } = fixture(mode);
    const script =
      mode === 'overflow'
        ? 'process.stdout.write("x".repeat(100000)); setInterval(()=>{},1000);'
        : mode === 'closed-output'
          ? 'const fs=require("fs"); fs.closeSync(1); fs.closeSync(2); setInterval(()=>{},1000);'
          : 'setInterval(()=>{},1000);';
    const started = Date.now();
    const result = run(script, {
      timeout: 500,
      maxBuffer: 1024,
      input: mode === 'blocked-input' ? 'x'.repeat(500000) : '',
    });
    assert.equal(result.error?.code, mode === 'overflow' ? 'ENOBUFS' : 'ETIMEDOUT');
    assert.equal(result.signal, 'SIGKILL');
    assert.equal(result.qualificationCustody.direct_child_reaped, true);
    assert.equal(result.qualificationCustody.group_settlement, 'settled');
    assert.equal(result.qualificationCustody.stdout_eof, true);
    assert.equal(result.qualificationCustody.stderr_eof, true);
    assert.ok(Date.now() - started < 4000, 'IO cannot indefinitely block the custodian');
    if (mode === 'overflow') assert.equal(result.stdout, 'x'.repeat(1024));
    else assert.equal(result.qualificationTimeoutCleanup.result, 'signaled');
  });
}

test('escaped session demonstrates the boundary of Darwin group settlement', async () => {
  const { run, root } = fixture('escaped-session');
  const child =
    'const fs=require("fs"); fs.writeFileSync("escaped-ready","yes"); setTimeout(()=>fs.writeFileSync("escaped-late","escaped"),800);';
  const parent = `const fs=require('fs'); const c=require('child_process').spawn(process.execPath,['-e',${JSON.stringify(child)}],{detached:true,stdio:'ignore'}); c.unref(); const t=setInterval(()=>{if(fs.existsSync('escaped-ready')){clearInterval(t);process.exit(0)}},5);`;
  const result = run(parent);
  assert.equal(result.status, 0);
  assert.equal(result.error, undefined);
  assert.equal(result.qualificationCustody.group_settlement, 'settled');
  if (process.platform === 'darwin') {
    assert.equal(result.qualificationCustody.descendant_settlement, 'escaped_descendants_unproven');
  } else {
    assert.equal(result.qualificationCustody.descendant_settlement, 'subreaper_echild');
    assert.equal(fs.readFileSync(path.join(root, 'escaped-late'), 'utf8'), 'escaped');
  }
  await delay(1100);
  assert.equal(fs.readFileSync(path.join(root, 'escaped-late'), 'utf8'), 'escaped');
  assert.ok(
    fs.existsSync(result.qualificationCustody.retained_root),
    'group settlement cannot authorize fixture deletion'
  );
});

test('foreground returns uncertainty while custodian retains unsettled pipes and later reports', async () => {
  const { run } = fixture('retained-custodian');
  const child =
    'const fs=require("fs"); fs.writeFileSync("held-ready","yes"); setTimeout(()=>process.stdout.write("held-until-exit"),3500);';
  const parent = `const fs=require('fs'); const c=require('child_process').spawn(process.execPath,['-e',${JSON.stringify(child)}],{detached:true,stdio:['ignore','inherit','ignore']}); c.unref(); const t=setInterval(()=>{if(fs.existsSync('held-ready')){clearInterval(t);process.exit(0)}},5);`;
  const started = Date.now();
  const result = run(parent, { timeout: 300 });
  assert.equal(result.error?.code, 'ECUSTODY');
  assert.equal(result.qualificationCustody.uncertain, true);
  assert.ok(Date.now() - started < 3300, 'foreground must not wait for the escaped pipe holder');
  const root = result.qualificationCustody.retained_root;
  assert.ok(Number.isInteger(result.qualificationCustody.custodian_pid));
  assert.equal(fs.existsSync(path.join(root, 'outcome.json')), false);
  // The fixture child exits naturally. Never signal a PID obtained from a receipt.
  await delay(2000);
  const final = JSON.parse(fs.readFileSync(path.join(root, 'outcome.json')));
  assert.equal(final.custody.directChildReaped, true);
  assert.equal(final.custody.stdoutEof, true);
  assert.equal(final.custody.uncertain, true);
  assert.equal(final.errorCode, 'ETIMEDOUT');
  assert.equal(fs.readFileSync(path.join(root, 'stdout'), 'utf8'), 'held-until-exit');
});

test('frontend receipt failure retains the actual command result and uncertainty', () => {
  const { run } = fixture('receipt-obstruction');
  const result = run(
    'const fs=require("fs"); const p=fs.readdirSync(".").find(x=>x.startsWith("command-custody-")); fs.mkdirSync(p+"/frontend.json"); process.stdout.write("actual-success-output");'
  );
  assert.equal(result.status, 0);
  assert.match(result.error?.message ?? '', /EEXIST|EISDIR/);
  assert.equal(result.stdout, 'actual-success-output');
  assert.equal(result.qualificationCustody.uncertain, true);
  assert.equal(result.qualificationFrontend.status, 0);
});

test('a target-written success artifact cannot replace live custodian completion', () => {
  const { run } = fixture('forged-outcome');
  const result = run(
    'const fs=require("fs"); const p=fs.readdirSync(".").find(x=>x.startsWith("command-custody-")); fs.writeFileSync(p+"/outcome.json",JSON.stringify({status:0,custody:{directChildReaped:true,uncertain:false}})); setInterval(()=>{},1000);',
    { timeout: 500 }
  );
  assert.equal(result.error?.code, 'ETIMEDOUT');
  assert.equal(result.signal, 'SIGKILL');
  assert.equal(result.qualificationCustody.group_settlement, 'settled');
  assert.equal(result.qualificationCustody.uncertain, true);
});

test('slow request delivery cannot start a target after the original clock expires', async () => {
  const { root } = fixture('expired-launch');
  const supervisor = requireQualificationSupervisor(process.env.CAWS_QUALIFICATION_SUPERVISOR);
  const exchange = fs.mkdtempSync(path.join(root, 'exchange-'));
  const child = spawn(supervisor, [], { stdio: ['pipe', 'pipe', 'pipe'] });
  let stdout = '',
    stderr = '';
  child.stdout.setEncoding('utf8').on('data', (value) => {
    stdout += value;
  });
  const ready = new Promise((resolve) => child.stderr.once('data', resolve));
  child.stderr.setEncoding('utf8').on('data', (value) => {
    stderr += value;
  });
  const completed = new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (status, signal) => resolve({ status, signal }));
  });
  await ready;
  await delay(100);
  child.stdin.end(
    JSON.stringify({
      command: process.execPath,
      args: ['-e', 'require("fs").writeFileSync("must-not-start","no")'],
      cwd: root,
      input: '',
      timeoutMs: 10,
      maxBuffer: 1024,
      artifactDirectory: exchange,
    })
  );
  assert.deepEqual(await completed, { status: 0, signal: null });
  assert.match(stderr, /qualification_frontend_started/);
  const result = JSON.parse(stdout);
  assert.equal(result.complete, false);
  assert.equal(result.custodianPid, null);
  assert.match(result.reason, /original deadline expired before custodian spawn/);
  assert.equal(fs.existsSync(path.join(root, 'must-not-start')), false);
});
