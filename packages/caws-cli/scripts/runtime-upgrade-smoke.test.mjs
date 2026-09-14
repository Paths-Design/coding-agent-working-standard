import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { observedSpawn } from './runtime-upgrade-smoke.mjs';

for (const missing of [false, true]) {
  test(`upgrade evidence retains ${missing ? 'spawn failure' : 'failed child output and input'}`, () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'upgrade-evidence-'));
    try {
      const env = { ...process.env, CAWS_QUALIFICATION_ARTIFACT_DIR: root };
      const result = observedSpawn(missing ? path.join(root, 'absent-command') : process.execPath,
        missing ? [] : ['-e', 'process.stdout.write("observed-output"); process.stderr.write("observed-error"); process.exitCode=7;'],
        { cwd: root, env, encoding: 'utf8', input: 'observed-input', timeout: 5000 });
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
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });
}
