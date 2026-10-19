const fs = require('node:fs');
const { spawn } = require('node:child_process');
const mode = process.env.CAWS_NATIVE_TEST_MODE || 'exact';
if (process.env.CAWS_NATIVE_TEST_ENGINE_PID)
  fs.writeFileSync(process.env.CAWS_NATIVE_TEST_ENGINE_PID, String(process.pid));
if (mode === 'no-read') {
  setInterval(() => {}, 1000);
} else {
  let text = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', data => {
    text += data;
  });
  process.stdin.on('end', () => {
    const request = JSON.parse(text);
    if (process.env.CAWS_NATIVE_TEST_RECEIPT)
      fs.appendFileSync(process.env.CAWS_NATIVE_TEST_RECEIPT, `${JSON.stringify(request)}\n`);
    const response = {
      schema: 'caws.runtime.response.v1',
      id: request.id,
      runtimeDigest: request.runtimeDigest,
      result: {
        exitCode: 7,
        stdoutBase64: Buffer.from('native\n雪\u0000exact').toString('base64'),
        stderrBase64: Buffer.from('diagnostic\nexact\n').toString('base64'),
      },
    };
    if (mode === 'large-native-result' || mode === 'late-large-native-result')
      response.result.stdoutBase64 = Buffer.alloc(1_000_000, 0x78).toString('base64');
    if (mode === 'binary') {
      response.result.stdoutBase64 = Buffer.from([0xff, 0x00, 0x61]).toString('base64');
      response.result.stderrBase64 = Buffer.from(
        Array.from({ length: 256 }, (_, value) => value)
      ).toString('base64');
    }
    if (mode === 'bad-base64') response.result.stdoutBase64 = 'Zg==\n';
    if (mode === 'pad-bits') response.result.stderrBase64 = 'Zh==';
    if (mode === 'old-text-shape')
      response.result = { exitCode: 7, stdout: 'old text', stderr: '' };
    if (mode === 'id') response.id += '-foreign';
    if (mode === 'digest') response.runtimeDigest = 'b'.repeat(64);
    if (mode === 'schema') response.schema = 'caws.runtime.response.v2';
    if (mode === 'exit-code') response.result.exitCode = 256;
    if (mode === 'extra-field') response.unrecognized = true;
    if (mode === 'oversize') return process.stdout.write('x'.repeat(4_194_305));
    if (mode === 'stderr-oversize') return process.stderr.write('x'.repeat(65_537));
    if (mode === 'malformed') return process.stdout.write('{');
    if (mode === 'nonzero') {
      process.stdout.write(JSON.stringify(response));
      process.exitCode = 1;
      return;
    }
    if (mode === 'timeout') {
      setInterval(() => {}, 1000);
      return;
    }
    if (mode === 'closed-pipes') {
      fs.closeSync(1);
      fs.closeSync(2);
      setInterval(() => {}, 1000);
      return;
    }
    if (mode === 'pipe-holder') {
      const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
        stdio: 'inherit',
      });
      fs.writeFileSync(process.env.CAWS_NATIVE_TEST_CHILD, String(child.pid));
      process.stdout.write(JSON.stringify(response));
      setTimeout(() => process.exit(0), 30);
      return;
    }
    if (mode === 'late-large-native-result') {
      setTimeout(
        () => process.stdout.write(JSON.stringify(response)),
        Math.max(0, request.deadlineEpochMs - Date.now() - 150)
      );
      return;
    }
    process.stdout.write(JSON.stringify(response));
  });
}
