const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const PKG_ROOT = path.resolve(__dirname, '..', '..');
const REPO_ROOT = path.resolve(PKG_ROOT, '..', '..');
const LOCAL_METADATA_PATH = path.join(PKG_ROOT, 'dist', 'shell', 'command-metadata.js');
const CLI_DOC_PATH = path.join(REPO_ROOT, 'docs', 'api', 'cli.md');

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
  const { COMMAND_SURFACE_METADATA } = require(metadataPath);
  return COMMAND_SURFACE_METADATA;
}

function leafKeys(metadata) {
  const keys = [];
  for (const command of metadata) {
    if (command.kind === 'leaf') {
      keys.push(`caws ${command.name}`);
      continue;
    }
    for (const subcommand of command.subcommands) {
      keys.push(`caws ${command.name} ${subcommand.name}`);
    }
  }
  return keys;
}

function headingCommandKeys(markdown) {
  const keys = new Set();
  const headingRegex = /^#{2,6}\s+(.+)$/gm;
  let match;
  while ((match = headingRegex.exec(markdown)) !== null) {
    const heading = match[1];
    const codeSpanRegex = /`([^`]+)`/g;
    let codeSpanMatch;
    while ((codeSpanMatch = codeSpanRegex.exec(heading)) !== null) {
      const key = codeSpanMatch[1]
        .replace(/\s+(<[^>]+>|\[[^\]]+\])/g, '')
        .replace(/\s+/g, ' ')
        .trim();
      if (key.startsWith('caws ')) {
        keys.add(key);
      }
    }
  }
  return keys;
}

describe('docs/api/cli.md command leaf coverage', () => {
  test('documents every visible CLI leaf command from COMMAND_SURFACE_METADATA', () => {
    const documented = headingCommandKeys(fs.readFileSync(CLI_DOC_PATH, 'utf8'));
    const missing = leafKeys(loadMetadata()).filter((key) => !documented.has(key));

    expect(missing).toEqual([]);
  });
});
