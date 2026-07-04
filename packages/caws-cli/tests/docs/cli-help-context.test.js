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

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function namesCommand(description, name) {
  return new RegExp(`(^|[^a-z0-9-])${escapeRegExp(name)}($|[^a-z0-9-])`, 'i').test(
    description
  );
}

function findGroup(metadata, groupName) {
  const group = metadata.find((command) => command.kind === 'group' && command.name === groupName);
  if (!group) {
    throw new Error(`missing command group metadata: ${groupName}`);
  }
  return group;
}

function findLeaf(metadata, groupName, leafName) {
  const group = findGroup(metadata, groupName);
  const leaf = group.subcommands.find((subcommand) => subcommand.name === leafName);
  if (!leaf) {
    throw new Error(`missing command leaf metadata: ${groupName} ${leafName}`);
  }
  return leaf;
}

function leafHelpText(leaf) {
  return [
    leaf.description,
    ...leaf.options.map((option) => `${option.flag} ${option.description}`),
  ].join(' ');
}

const CLEANUP_LEAF_EXPECTATIONS = [
  {
    group: 'specs',
    leaf: 'prune-drafts',
    options: ['--older-than-ms', '--include', '--exclude', '--apply', '--json'],
    terms: ['dry-run by default', 'include/exclude selectors', '--apply', 'candidate drafts'],
  },
  {
    group: 'specs',
    leaf: 'archive',
    options: [
      '--status',
      '--include',
      '--exclude',
      '--older-than-ms',
      '--updated-before',
      '--without-worktree',
      '--apply',
      '--json',
    ],
    terms: ['batch mode defaults to dry-run', '--apply', 'selected specs'],
  },
  {
    group: 'worktree',
    leaf: 'untrack',
    options: ['--reason', '--apply', '--json'],
    terms: ['dry-run by default', 'requires --reason', '--apply removes only the control-plane binding'],
  },
  {
    group: 'worktree',
    leaf: 'prune',
    options: ['--state', '--status', '--include', '--exclude', '--apply', '--json'],
    terms: ['dry-run by default', 'with --apply', 'ghost-registry', 'dead-binding', 'closed-spec-residue'],
  },
  {
    group: 'worktree',
    leaf: 'cleanup-plan',
    options: ['--state', '--status', '--include', '--exclude', '--apply', '--json'],
    terms: ['dry-run by default', 'with --apply', 'requires an explicit selector', 'destroy-ready'],
  },
  {
    group: 'events',
    leaf: 'migrate',
    options: ['--from', '--apply', '--reason'],
    terms: ['dry-run by default', '--apply executes'],
  },
  {
    group: 'events',
    leaf: 'rotate',
    options: ['--reason', '--dry-run', '--json'],
    terms: ['supports --dry-run preview', 'without mutating events.jsonl'],
  },
  {
    group: 'waiver',
    leaf: 'prune',
    options: ['--status', '--apply', '--reason', '--revoked-by', '--json'],
    terms: ['dry-run by default', '--apply revokes', 'expired'],
  },
  {
    group: 'agents',
    leaf: 'prune',
    options: ['--dead', '--status', '--older-than-ms', '--apply', '--json'],
    terms: ['defaults to dry-run', 'pass --apply', '--dead', '--status'],
  },
  {
    group: 'message',
    leaf: 'prune',
    options: ['--status', '--older-than-ms', '--include', '--exclude', '--apply', '--json'],
    terms: ['dry-run by default', 'delivered', 'undelivered inbox messages are preserved'],
  },
];

describe('CLI help context metadata', () => {
  test('group descriptions that enumerate visible subcommands name all visible subcommands', () => {
    const enumeratedGroups = loadMetadata().filter(
      (command) =>
        command.kind === 'group' &&
        command.subcommands.some((subcommand) => namesCommand(command.description, subcommand.name))
    );

    expect(enumeratedGroups.map((command) => command.name).sort()).toEqual([
      'agents',
      'events',
      'evidence',
      'gates',
      'message',
      'specs',
      'worktree',
    ]);

    const missing = enumeratedGroups.flatMap((group) =>
      group.subcommands
        .map((subcommand) => subcommand.name)
        .filter((name) => !namesCommand(group.description, name))
        .map((name) => `${group.name} ${name}`)
    );

    expect(missing).toEqual([]);
  });

  test('cleanup leaves keep dry-run/apply and selector help context explicit', () => {
    const metadata = loadMetadata();
    const failures = CLEANUP_LEAF_EXPECTATIONS.flatMap((expectation) => {
      const leaf = findLeaf(metadata, expectation.group, expectation.leaf);
      const flags = leaf.options.map((option) => option.flag.split(/\s+/)[0]);
      const helpText = leafHelpText(leaf).toLowerCase();
      const missingOptions = expectation.options
        .filter((option) => !flags.includes(option))
        .map((option) => `${expectation.group} ${expectation.leaf} missing option ${option}`);
      const missingTerms = expectation.terms
        .filter((term) => !helpText.includes(term.toLowerCase()))
        .map((term) => `${expectation.group} ${expectation.leaf} missing help context "${term}"`);

      return [...missingOptions, ...missingTerms];
    });

    expect(failures).toEqual([]);
  });
});
