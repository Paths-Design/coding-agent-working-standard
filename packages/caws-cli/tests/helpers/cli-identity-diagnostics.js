'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { CLI_IDENTITY_LIMITS } = require('../../dist/runtime/cli-identity');

function firstInvalidPin(reviewed) {
  const pins = [
    ['node', reviewed.node, CLI_IDENTITY_LIMITS.nodeBytes],
    ['domain', reviewed.domain, CLI_IDENTITY_LIMITS.fileBytes],
    ...Object.entries(reviewed.files).map(([name, pin]) => [
      name,
      pin,
      CLI_IDENTITY_LIMITS.fileBytes,
    ]),
  ];
  for (const [name, pin, maximum] of pins) {
    const checks = [
      ['sha256', /^[a-f0-9]{64}$/.test(pin.sha256)],
      ['safeInteger', Number.isSafeInteger(pin.sizeBytes)],
      ['nonnegative', pin.sizeBytes >= 0],
      ['maximum', pin.sizeBytes <= maximum],
      ['mode', [0o644, 0o755].includes(pin.mode)],
    ];
    const failed = checks.find(([, admitted]) => !admitted);
    if (failed) return { name, pin, maximum, failedCheck: failed[0], checks };
  }
  return null;
}

function retainUnexpectedCliIdentity({ suite, test, reviewed, result }) {
  if (result.status === 'matched') return;
  try {
    let actualNode;
    try {
      const realpath = fs.realpathSync(process.execPath);
      const stat = fs.lstatSync(realpath);
      actualNode = {
        realpath,
        sizeBytes: stat.size,
        mode: stat.mode & 0o777,
        fullMode: stat.mode,
        nlink: stat.nlink,
        isFile: stat.isFile(),
      };
    } catch (error) {
      actualNode = { error: { code: error.code, message: error.message } };
    }
    const report = {
      schema: 'caws.test.cli-identity-diagnostic.v1',
      candidate: process.env.GITHUB_SHA || null,
      suite,
      test,
      interpreter: {
        platform: process.platform,
        arch: process.arch,
        version: process.version,
        execPath: process.execPath,
      },
      limits: CLI_IDENTITY_LIMITS,
      reviewedNode: reviewed.node,
      actualNode,
      firstInvalidPin: firstInvalidPin(reviewed),
      result,
    };
    const text = JSON.stringify(report, null, 2) + '\n';
    process.stderr.write(text);
    const root = process.env.CAWS_TEST_ARTIFACT_DIR;
    if (!root) return;
    const directory = path.join(root, 'cli-identity-diagnostics', suite);
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    const name = createHash('sha256').update(test).digest('hex').slice(0, 16);
    fs.writeFileSync(path.join(directory, `${process.pid}-${name}.json`), text, {
      mode: 0o600,
      flag: 'wx',
    });
  } catch (error) {
    // Retention must not replace the original comparator assertion.
    process.stderr.write(
      `CLI identity diagnostic retention failed: ${error.code} ${error.message}\n`
    );
  }
}

module.exports = { retainUnexpectedCliIdentity };
