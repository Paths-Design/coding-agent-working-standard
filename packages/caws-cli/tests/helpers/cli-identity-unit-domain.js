'use strict';
// On-disk miniature comparison domain, not reviewed installer/native admission.
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { cliClosureDigest } = require('../../dist/runtime/cli-identity');
const CLI = 'node_modules/@paths.design/caws-cli';
const pin = (file) => ({
  sha256: createHash('sha256').update(fs.readFileSync(file)).digest('hex'),
  sizeBytes: fs.statSync(file).size,
  mode: fs.statSync(file).mode & 0o777,
});
function createCliIdentityUnitDomain(root) {
  const reference = path.join(root, 'identity-reference');
  const selected = path.join(root, 'identity-selected');
  const bin = path.join(root, 'identity-bin');
  const entry = CLI + '/dist/index.js';
  const contents = {
    [CLI + '/package.json']: JSON.stringify({
      name: '@paths.design/caws-cli',
      version: '1.0.0',
      bin: { caws: 'dist/index.js' },
    }),
    [entry]: '#!/usr/bin/env node\nmodule.exports = {};\n',
  };
  const files = {};
  for (const [relative, text] of Object.entries(contents)) {
    for (const prefix of [reference, selected]) {
      const file = path.join(prefix, relative);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, text, { mode: relative === entry ? 0o755 : 0o644 });
      fs.chmodSync(file, relative === entry ? 0o755 : 0o644);
    }
    files[relative] = pin(path.join(reference, relative));
  }
  for (const prefix of [reference, selected]) {
    const file = path.join(prefix, 'package.json');
    fs.writeFileSync(
      file,
      JSON.stringify({ private: true, dependencies: { '@paths.design/caws-cli': '1.0.0' } }),
      { mode: 0o644 }
    );
    fs.chmodSync(file, 0o644);
  }
  fs.mkdirSync(bin);
  const node = fs.realpathSync(process.execPath);
  fs.symlinkSync(path.join(selected, entry), path.join(bin, 'caws'));
  fs.symlinkSync(node, path.join(bin, 'node'));
  const reviewed = {
    prefixRoot: reference,
    files,
    packages: { [CLI]: { name: '@paths.design/caws-cli', version: '1.0.0' } },
    omissions: {},
    node: { ...pin(node), path: node },
  };
  const domain = path.join(root, 'identity-domain.json');
  fs.writeFileSync(
    domain,
    JSON.stringify({
      schema: 'caws.cli.agents-stop-domain.v1',
      operation: 'agents-stop-explicit-session-opencode',
      closureSha256: cliClosureDigest(reviewed),
      importers: [{ path: entry, sha256: files[entry].sha256, requests: [] }],
      dormantSites: [],
    }),
    { mode: 0o644 }
  );
  fs.chmodSync(domain, 0o644);
  reviewed.domain = { ...pin(domain), path: domain };
  return reviewed;
}
module.exports = { createCliIdentityUnitDomain };
