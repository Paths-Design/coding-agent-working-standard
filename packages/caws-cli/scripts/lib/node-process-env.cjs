'use strict';

const fs = require('node:fs');
const path = require('node:path');

// Bind child lookup at a command boundary, never while importing or rechecking identity.
function nodeProcessEnv(env = process.env, platform = process.platform) {
  const child = { ...env };
  const keys = platform === 'win32'
    ? Object.keys(env).filter(key => key.toLowerCase() === 'path').sort()
    : ['PATH'];
  const inherited = env[keys[0]];
  // Node passes only the first lexically sorted case-insensitive key on Windows.
  // Emit one canonical key so Node, npm and our strict capture agree on its value.
  if (platform === 'win32') for (const key of keys) delete child[key];
  const directory = path.dirname(fs.realpathSync(process.execPath));
  child.PATH = directory + (inherited ? (platform === 'win32' ? ';' : path.delimiter) + inherited : '');
  return child;
}

module.exports = { nodeProcessEnv };
