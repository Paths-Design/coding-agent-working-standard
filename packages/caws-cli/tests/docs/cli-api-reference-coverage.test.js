const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const PKG_ROOT = path.resolve(__dirname, '..', '..');
const LOCAL_METADATA_PATH = path.join(PKG_ROOT, 'dist', 'shell', 'command-metadata.js');
const CLI_DOC_PATH = path.join(PKG_ROOT, 'docs', 'command-reference.md');

function loadMetadata() {
  if (!fs.existsSync(LOCAL_METADATA_PATH)) throw new Error('Build this checkout before checking docs');
  return require(LOCAL_METADATA_PATH).COMMAND_SURFACE_METADATA;
}

function leafKeys(metadata, prefix = 'caws') {
  return metadata.flatMap(command => {
    const key = `${prefix} ${command.name}`;
    return command.kind === 'leaf' ? [key] : [
      ...(command.defaultAction ? [key] : []), ...leafKeys(command.subcommands, key),
    ];
  });
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

describe('packaged command reference coverage', () => {
  beforeAll(() => execFileSync(process.execPath, [path.join(PKG_ROOT, 'scripts/stage-consumer-docs.mjs')], { stdio: 'pipe' }));
  test('documents every visible CLI leaf command from COMMAND_SURFACE_METADATA', () => {
    const documented = headingCommandKeys(fs.readFileSync(CLI_DOC_PATH, 'utf8'));
    const missing = leafKeys(loadMetadata()).filter((key) => !documented.has(key));

    expect(missing).toEqual([]);
  });
});
