'use strict';
// Node 18.0 can report exit zero after a synchronous later module-load error
// once node:test has registered tests. Catch load failures explicitly.
const path = require('node:path');
const fs = require('node:fs');
const compiled = process.argv[2];
if (!compiled || !path.isAbsolute(compiled)) {
  console.error('Usage: node run.cjs <absolute compiled tests/transcripts directory>');
  process.exitCode = 2;
} else {
  try {
    const names = fs
      .readdirSync(compiled, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith('.test.js'))
      .map((entry) => entry.name)
      .sort();
    if (names.length === 0) throw new Error('No compiled transcript tests found');
    for (const name of names) require(path.join(compiled, name));
  } catch (error) {
    console.error(error);
    process.exitCode = 1;
  }
}
