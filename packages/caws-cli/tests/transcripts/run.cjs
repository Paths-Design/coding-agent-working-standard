'use strict';
// Node 18.0 can report exit zero after a synchronous later module-load error
// once node:test has registered tests. Catch load failures explicitly.
const path = require('node:path');
const compiled = process.argv[2];
if (!compiled || !path.isAbsolute(compiled)) {
  console.error('Usage: node run.cjs <absolute compiled tests/transcripts directory>');
  process.exitCode = 2;
} else {
  for (const name of ['lossless-json', 'common', 'occurrence', 'codex']) {
    try { require(path.join(compiled, name + '.test.js')); }
    catch (error) { console.error(error); process.exitCode = 1; break; }
  }
}
