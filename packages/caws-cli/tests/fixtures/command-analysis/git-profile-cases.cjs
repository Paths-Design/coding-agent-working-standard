'use strict';
// Fixed documented roles, independent of the analyzer's regular expressions.
// Oracles: https://git-scm.com/docs/git-{status,diff,log,show,rev-parse,
// ls-files,ls-tree,grep,add,commit}; copied-spelling corrections also use
// https://raw.githubusercontent.com/git/git/v2.54.0/builtin/grep.c .
// Submitted commands are inert strings; paths, config and hooks are not certified.
const cases = [];
const add = (id, command, decision = 'allow', reason) =>
  cases.push({ id: 'git-doc-' + id, command, decision, ...(reason ? { reason } : {}) });
const profiles = {
  status: {
    seed: 'short',
    options: [
      '-sbz',
      '--porcelain',
      '--porcelain=v2',
      '--ignored',
      '--untracked-files',
      '--untracked-files=all',
    ],
  },
  diff: {
    seed: 'stat',
    options: [
      '-p',
      '-s',
      '-w',
      '-U0',
      '--numstat',
      '--shortstat',
      '--name-only',
      '--name-status',
      '--check',
      '--quiet',
      '--exit-code',
    ],
  },
  log: {
    seed: 'graph',
    options: [
      '--oneline',
      '--graph',
      '--all',
      '--first-parent',
      '--no-merges',
      '--merges',
      '--no-walk',
      '--decorate=full',
      '--format=%H',
      '--pretty=%B',
    ],
  },
  show: {
    seed: 'raw',
    options: ['-p', '-s', '-w', '-U2', '--raw', '--no-patch', '--format=%h', '--pretty=oneline'],
  },
  'rev-parse': {
    seed: 'verify',
    options: [
      '--verify HEAD',
      '--verify --quiet HEAD',
      '--short HEAD',
      '--short=8 HEAD',
      '--abbrev-ref HEAD',
      '--symbolic-full-name HEAD',
      '--show-prefix',
      '--show-cdup',
      '--git-dir',
      '--is-inside-work-tree',
      '--is-bare-repository',
    ],
  },
  'ls-files': {
    seed: 'stage',
    options: ['-z', '-s', '-o', '-m', '-c', '-d', '--exclude-standard', '--cached'],
  },
  'ls-tree': { seed: 'long', options: ['-r', '-z', '-l', '--name-only', '--long', '--full-tree'] },
  grep: {
    seed: 'line-number',
    options: [
      '-nHi',
      '-lv',
      '-Iowc',
      '-E',
      '-F',
      '-ra',
      '--line-number',
      '--files-with-matches',
      '--fixed-strings',
      '--extended-regexp',
      '--ignore-case',
      '--count',
      '--color=auto',
    ],
  },
  add: { seed: 'dry-run', options: ['-A', '-u', '-n', '-v', '--all', '--update'] },
  commit: {
    seed: 'quiet',
    options: [
      '-a',
      '-q',
      '--all',
      '--quiet',
      '--dry-run',
      '--allow-empty',
      '--signoff',
      '--no-gpg-sign',
    ],
  },
};
const optionCommand = (subcommand, option) => {
  if (subcommand === 'grep') return 'git grep ' + option + ' -e needle -- file';
  if (subcommand === 'ls-tree' || subcommand === 'show')
    return 'git ' + subcommand + ' ' + option + ' HEAD -- file';
  if (subcommand === 'rev-parse') return 'git rev-parse ' + option;
  if (subcommand === 'commit') return 'git commit ' + option + ' --dry-run --no-gpg-sign -m probe';
  return 'git ' + subcommand + ' ' + option + ' -- file';
};
const dataCommand = (subcommand, value) => {
  const data = "'" + value + "'";
  if (subcommand === 'grep') return 'git grep -e needle -- ' + data;
  if (subcommand === 'ls-tree' || subcommand === 'show')
    return 'git ' + subcommand + ' HEAD -- ' + data;
  if (subcommand === 'rev-parse') return 'git rev-parse -- ' + data;
  if (subcommand === 'commit') return 'git commit --dry-run --no-gpg-sign -m probe -- ' + data;
  return 'git ' + subcommand + ' -- ' + data;
};
for (const [subcommand, profile] of Object.entries(profiles)) {
  profile.options.forEach((option, index) =>
    add(subcommand + '-known-' + index, optionCommand(subcommand, option))
  );
  ['--X--' + profile.seed, '--' + profile.seed + 'X'].forEach((option, index) => {
    add(
      subcommand + '-unmodeled-' + index,
      optionCommand(subcommand, option),
      'unresolved',
      'git-option-unmodeled'
    );
    add(subcommand + '-literal-' + index, dataCommand(subcommand, option));
  });
}
for (const [subcommand, option] of [
  ['grep', '-s'],
  ['grep', '--regexp=needle'],
  ['grep', '--file=patterns'],
  ['diff', '-q'],
  ['log', '-q'],
  ['show', '-q'],
]) {
  const id = subcommand + '-' + option.replace(/[^A-Za-z0-9]+/g, '_');
  add('copied-' + id, optionCommand(subcommand, option), 'unresolved', 'git-option-unmodeled');
  add('copied-data-' + id, dataCommand(subcommand, option));
}
for (const [id, command] of [
  ['log-max-count', 'git log --max-count 2'],
  ['log-author', "git log --author 'A U Thor'"],
  ['log-committer', "git log --committer 'C O Mitter'"],
  ['log-since', 'git log --since 2001-01-01'],
  ['log-until', 'git log --until 2001-01-02'],
  ['diff-unified', 'git diff --unified 3 -- file'],
  ['commit-message', "git commit --dry-run --no-gpg-sign --message 'literal --exec=tool'"],
  ['commit-file-short', 'git commit --dry-run --no-gpg-sign -F message.txt'],
  ['commit-file-long', 'git commit --dry-run --no-gpg-sign --file message.txt'],
  ['grep-pattern-file', 'git grep -f patterns -- file'],
])
  add('operand-' + id, command);
module.exports = cases;
