'use strict';

// Public interpreter metadata only. This observation does not grant execution
// authority or repair permissions; admission continues to enforce its contract.
const fs = require('node:fs');
const path = require('node:path');
const [phase, output] = process.argv.slice(2);
if (!['after-setup-node', 'before-tests', 'after-tests'].includes(phase) || !output)
  throw new Error('Expected observation phase and output path');
const realpath = fs.realpathSync(process.execPath);
const stat = fs.lstatSync(realpath);
const record = {
  schema: 'caws.test.interpreter-mode-observation.v1',
  phase,
  candidate: process.env.GITHUB_SHA || null,
  time: new Date().toISOString(),
  nodeVersion: process.version,
  execPath: process.execPath,
  realpath,
  dev: stat.dev,
  ino: stat.ino,
  nlink: stat.nlink,
  mode: stat.mode & 0o7777,
  sizeBytes: stat.size,
  mtimeMs: stat.mtimeMs,
  ctimeMs: stat.ctimeMs,
  regular: stat.isFile(),
};
const bytes = JSON.stringify(record, null, 2) + '\n';
fs.mkdirSync(path.dirname(path.resolve(output)), { recursive: true });
fs.writeFileSync(output, bytes, { flag: 'wx' });
process.stdout.write(bytes);
