import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setTimeout } from 'node:timers';
import { observedSpawn, retainFixtureDiagnostics } from './runtime-upgrade-smoke.mjs';

test(
  'timeout stops an owned descendant before fixture cleanup',
  { skip: process.platform === 'win32' },
  async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'upgrade-timeout-'));
    try {
      const ready = path.join(root, 'child-ready');
      const lateWrite = path.join(root, 'child-ran-after-timeout');
      const child = `const fs=require('fs'); fs.writeFileSync(${JSON.stringify(ready)},'ready'); setTimeout(()=>fs.writeFileSync(${JSON.stringify(lateWrite)},'late'),5000);`;
      const parent = `require('child_process').spawn(process.execPath,['-e',${JSON.stringify(child)}],{stdio:'ignore'}); setInterval(()=>{},1000);`;
      const result = observedSpawn(process.execPath, ['-e', parent], {
        cwd: root,
        env: { ...process.env, CAWS_QUALIFICATION_ARTIFACT_DIR: root },
        encoding: 'utf8',
        timeout: 3000,
      });
      assert.equal(result.error?.code, 'ETIMEDOUT');
      assert.equal(fs.readFileSync(ready, 'utf8'), 'ready');
      const receipt = JSON.parse(
        fs.readFileSync(
          path.join(
            root,
            fs.readdirSync(root).find((name) => name.startsWith('command-'))
          ),
          'utf8'
        )
      );
      assert.equal(receipt.timeout_cleanup.result, 'signaled');
      await new Promise((resolve) => setTimeout(resolve, 5500));
      const childLateWrite = fs.existsSync(lateWrite);
      if (process.env.CAWS_RELEASE_ARTIFACT_DIR) {
        fs.mkdirSync(process.env.CAWS_RELEASE_ARTIFACT_DIR, { recursive: true });
        fs.writeFileSync(
          path.join(process.env.CAWS_RELEASE_ARTIFACT_DIR, 'timeout-cleanup.json'),
          JSON.stringify(
            { ...receipt, child_ready: true, child_late_write: childLateWrite },
            null,
            2
          ) + '\n'
        );
      }
      assert.equal(childLateWrite, false);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  }
);

test('failed qualification preserves fixture telemetry through cleanup without following links', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'upgrade-traces-'));
  try {
    const fixture = path.join(root, 'fixture');
    const artifacts = path.join(root, 'artifacts');
    const logs = path.join(fixture, 'claude-code-custom/.caws/sessions/probe');
    fs.mkdirSync(logs, { recursive: true });
    fs.writeFileSync(path.join(logs, 'hook-events.jsonl'), '{"event":"observed"}\n');
    fs.mkdirSync(path.join(fixture, 'tmp'));
    fs.writeFileSync(
      path.join(fixture, 'tmp/caws-hook-execution-interrupted.jsonl'),
      '{"handler":"observed-before-timeout"}\n'
    );
    fs.writeFileSync(path.join(root, 'unrelated'), 'must not copy');
    fs.symlinkSync(path.join(root, 'unrelated'), path.join(logs, 'external-link'));
    retainFixtureDiagnostics(fixture, artifacts);
    fs.rmSync(fixture, { recursive: true });
    const retained = path.join(artifacts, 'failure-traces/claude-code-custom/.caws/sessions/probe');
    assert.equal(
      fs.readFileSync(path.join(retained, 'hook-events.jsonl'), 'utf8'),
      '{"event":"observed"}\n'
    );
    assert.equal(fs.existsSync(path.join(retained, 'external-link')), false);
    assert.equal(fs.existsSync(path.join(artifacts, 'unrelated')), false);
    assert.equal(
      fs.readFileSync(
        path.join(
          artifacts,
          'failure-traces/runtime-exchange/caws-hook-execution-interrupted.jsonl'
        ),
        'utf8'
      ),
      '{"handler":"observed-before-timeout"}\n'
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

for (const missing of [false, true]) {
  test(`upgrade evidence retains ${missing ? 'spawn failure' : 'failed child output and input'}`, () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'upgrade-evidence-'));
    try {
      const env = { ...process.env, CAWS_QUALIFICATION_ARTIFACT_DIR: root };
      const result = observedSpawn(
        missing ? path.join(root, 'absent-command') : process.execPath,
        missing
          ? []
          : [
              '-e',
              'process.stdout.write("observed-output"); process.stderr.write("observed-error"); process.exitCode=7;',
            ],
        { cwd: root, env, encoding: 'utf8', input: 'observed-input', timeout: 5000 }
      );
      const files = fs.readdirSync(root);
      assert.equal(files.length, 1);
      const receipt = JSON.parse(fs.readFileSync(path.join(root, files[0]), 'utf8'));
      assert.equal(receipt.input, 'observed-input');
      assert.equal(receipt.cwd, root);
      assert.equal(receipt.exit_code, missing ? null : 7);
      assert.equal(result.status, receipt.exit_code);
      if (missing) assert.match(receipt.error, /ENOENT/);
      else {
        assert.equal(receipt.stdout, 'observed-output');
        assert.equal(receipt.stderr, 'observed-error');
        assert.equal(receipt.error, null);
      }
      assert.equal('env' in receipt, false);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
}
