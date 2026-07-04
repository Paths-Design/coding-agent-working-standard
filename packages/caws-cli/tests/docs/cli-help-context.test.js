const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const PKG_ROOT = path.resolve(__dirname, '..', '..');
const LOCAL_METADATA_PATH = path.join(PKG_ROOT, 'dist', 'shell', 'command-metadata.js');

function canonicalMetadataPath() {
  try {
    const commonDir = execFileSync('git', ['rev-parse', '--git-common-dir'], {
      cwd: PKG_ROOT,
      encoding: 'utf8',
    }).trim();
    const canonicalRoot = path.dirname(path.resolve(PKG_ROOT, commonDir));
    return path.join(canonicalRoot, 'packages', 'caws-cli', 'dist', 'shell', 'command-metadata.js');
  } catch {
    return null;
  }
}

function loadMetadata() {
  let metadataPath = LOCAL_METADATA_PATH;
  if (!fs.existsSync(metadataPath)) {
    const canonical = canonicalMetadataPath();
    if (canonical && fs.existsSync(canonical)) {
      metadataPath = canonical;
    }
  }
  if (!fs.existsSync(metadataPath)) {
    throw new Error(`command metadata not found at ${LOCAL_METADATA_PATH}; run npm run build first`);
  }
  return require(metadataPath).COMMAND_SURFACE_METADATA;
}

describe('CLI help context metadata', () => {
  test('specs group description names every visible specs subcommand', () => {
    const specs = loadMetadata().find((command) => command.name === 'specs');
    const missing = specs.subcommands
      .map((subcommand) => subcommand.name)
      .filter((name) => !specs.description.includes(name));

    expect(missing).toEqual([]);
  });
});
