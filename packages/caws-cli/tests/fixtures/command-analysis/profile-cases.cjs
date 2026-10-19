'use strict';

// Fixed utility-role requirements, independent of the analyzer's implementation.
// These commands are inert analysis inputs. They do not certify every GNU/BSD
// version, successful utility execution, or an unrestricted shell sandbox.
const cases = [];
function add(id, command, decision = 'allow', reason) {
  cases.push({ id: `profile-${id}`, command, decision, ...(reason ? { reason } : {}) });
}

// Each literal flag has an observable data-reading or output-formatting role.
// Argument-taking options have a separate matrix below.
const readers = [
  {
    name: 'rg',
    short: 'nliIvowcHFsSuaq0',
    long: [
      'files',
      'hidden',
      'no-ignore',
      'no-config',
      'line-number',
      'files-with-matches',
      'fixed-strings',
      'ignore-case',
      'count',
      'heading',
      'no-heading',
      'color=never',
      "glob='*.js'",
      'type=js',
      'encoding=utf-8',
      "replace='--pre=tool'",
    ],
    operands: '-- needle file',
    seed: 'count',
    data: (value) => `rg -F -- '${value}' file`,
  },
  {
    name: 'grep',
    short: 'nliIvowcHEFrsa',
    long: [
      'line-number',
      'files-with-matches',
      'fixed-strings',
      'extended-regexp',
      'ignore-case',
      'count',
      'color=never',
    ],
    operands: '-- needle file',
    seed: 'count',
    data: (value) => `grep -F -- '${value}' file`,
  },
  {
    name: 'cat',
    short: 'benstuvAET',
    long: ['number', 'number-nonblank', 'show-all'],
    operands: '-- file',
    seed: 'number',
    data: (value) => `cat -- '${value}'`,
  },
  {
    name: 'head',
    short: '',
    long: ['lines=2', 'bytes=8'],
    operands: '-- file',
    seed: 'lines=2',
    data: (value) => `head -n 2 -- '${value}'`,
  },
  {
    name: 'tail',
    short: '',
    long: ['lines=2', 'bytes=8'],
    operands: '-- file',
    seed: 'lines=2',
    data: (value) => `tail -n 2 -- '${value}'`,
  },
  {
    name: 'wc',
    short: 'clwmL',
    long: ['lines', 'bytes', 'words', 'chars'],
    operands: '-- file',
    seed: 'words',
    data: (value) => `wc -- '${value}'`,
  },
  {
    name: 'ls',
    short: 'alhAdtrRS1',
    long: ['all', 'almost-all', 'directory', 'human-readable', 'color=never'],
    operands: '-- file',
    seed: 'all',
    data: (value) => `ls -- '${value}'`,
  },
  {
    name: 'cut',
    short: '',
    long: ['bytes=1', 'characters=1', 'fields=1', 'delimiter=: --fields=1'],
    operands: '-- file',
    seed: 'fields=1',
    data: (value) => `cut -f1 -- '${value}'`,
  },
  {
    name: 'tr',
    short: '',
    long: [],
    operands: "-- 'a-z' 'A-Z'",
    seed: 'delete',
    data: (value) => `tr -d -- '${value}'`,
  },
  {
    name: 'sort',
    short: 'bdfginrMu',
    long: ['numeric-sort', 'reverse', 'unique'],
    operands: '-- file',
    seed: 'reverse',
    data: (value) => `sort -- '${value}'`,
  },
  {
    name: 'uniq',
    short: 'cdui',
    long: ['count', 'repeated', 'unique', 'ignore-case'],
    operands: '-- file',
    seed: 'count',
    data: (value) => `uniq -- '${value}'`,
  },
];
for (const reader of readers) {
  for (const flag of reader.short) {
    add(`${reader.name}-short-${flag}`, `${reader.name} -${flag} ${reader.operands}`);
  }
  if (reader.short.length > 1) {
    add(`${reader.name}-short-cluster`, `${reader.name} -${reader.short} ${reader.operands}`);
  }
  for (const [index, option] of reader.long.entries()) {
    add(`${reader.name}-long-${index}`, `${reader.name} --${option} ${reader.operands}`);
  }

  // An unsupported option stays unsupported when it contains a valid spelling.
  const [name, value] = reader.seed.split('=');
  const suffix = `--${name}X${value === undefined ? '' : `=${value}`}`;
  const suspicious = [`--X--${reader.seed}`, suffix, '-Z'];
  for (const [index, option] of suspicious.entries()) {
    add(
      `${reader.name}-unknown-option-${index}`,
      `${reader.name} ${option} ${reader.operands}`,
      'unresolved',
      'reader-option'
    );
    add(`${reader.name}-option-looking-data-${index}`, reader.data(option));
  }
  add(`${reader.name}-single-dash-input`, reader.data('-'));
  add(`${reader.name}-execution-looking-data`, reader.data('--pre=tool'));
}

for (const name of ['head', 'tail']) {
  for (const option of ['-n2', '-c8', '-v', '-q', '-2']) {
    add(`${name}-count-${option.slice(1)}`, `${name} ${option} -- file`);
  }
  add(`${name}-numeric-suffix-unsupported`, `${name} -2X -- file`, 'unresolved', 'reader-option');
}
for (const [id, command] of [
  ['cut-byte-list', 'cut -b1 -- file'],
  ['cut-character-list', 'cut -c1 -- file'],
  ['cut-field-list', 'cut -f1 -- file'],
  ['cut-delimiter', 'cut -d: -f1 -- file'],
  ['tr-complement-bytes', "tr -c -- 'a-z' '?'"],
  ['tr-complement-characters', "tr -C -- 'a-z' '?'"],
  ['tr-delete', "tr -d -- '0-9'"],
  ['tr-squeeze', "tr -s -- ' '"],
  ['tr-long-complement', "tr --complement -- 'a-z' '?'"],
  ['tr-long-delete', "tr --delete -- '0-9'"],
  ['tr-long-squeeze', "tr --squeeze-repeats -- ' '"],
])
  add(id, command);

// A consumed option operand cannot become another option, even if its bytes
// resemble one. Opaque values in these slots retain that data role.
const operands = [
  ['rg', '-e', "'--pre=tool'", '-- file'],
  ['rg', '--regexp', "'--hostname-bin=tool'", '-- file'],
  ['rg', '--glob', "'*.js'", '-- needle file'],
  ['rg', '--type', 'js', '-- needle file'],
  ['rg', '-r', "'--pre=tool'", '-- needle file'],
  ['rg', '--replace', "'--hostname-bin=tool'", '-- needle file'],
  ['rg', '-E', 'utf-8', '-- needle file'],
  ['rg', '--encoding', 'utf-8', '-- needle file'],
  ['grep', '-e', "'--pre=tool'", '-- file'],
  ['grep', '--regexp', "'--hostname-bin=tool'", '-- file'],
  ['grep', '-f', "'--pre=tool'", '-- file'],
  ['grep', '--file', "'--hostname-bin=tool'", '-- file'],
  ['head', '-n', '2', '-- file'],
  ['head', '-c', '8', '-- file'],
  ['head', '--lines', '2', '-- file'],
  ['head', '--bytes', '8', '-- file'],
  ['tail', '-n', '2', '-- file'],
  ['tail', '-c', '8', '-- file'],
  ['tail', '--lines', '2', '-- file'],
  ['tail', '--bytes', '8', '-- file'],
  ['cut', '-b', '1', '-- file'],
  ['cut', '-c', '1', '-- file'],
  ['cut', '-d', "':'", '-f1 -- file'],
  ['cut', '-f', '1', '-- file'],
  ['cut', '--bytes', '1', '-- file'],
  ['cut', '--characters', '1', '-- file'],
  ['cut', '--delimiter', "':'", '--fields=1 -- file'],
  ['cut', '--fields', '1', '-- file'],
  ['sort', '-k', '1,1', '-- file'],
  ['sort', '--key', '1,1', '-- file'],
  ['sort', '-S', '1M', '-- file'],
  ['sort', '--buffer-size', '1M', '-- file'],
];
for (const [index, [name, option, value, rest]] of operands.entries()) {
  add(`operand-known-${index}`, `${name} ${option} ${value} ${rest}`);
  add(`operand-opaque-${index}`, `V=$(printf '%s' data); ${name} ${option} "$V" ${rest}`);
  add(`operand-missing-${index}`, `${name} ${option}`, 'unresolved', 'reader-option');
}

for (const [id, command, decision, reason] of [
  ['rg-pre-separated', 'rg --pre tool -- needle file', 'deny', 'reader-execution'],
  ['rg-pre-equals', 'rg --pre=tool -- needle file', 'deny', 'reader-execution'],
  ['rg-hostname-separated', 'rg --hostname-bin tool -- needle file', 'deny', 'reader-execution'],
  ['rg-hostname-equals', 'rg --hostname-bin=tool -- needle file', 'deny', 'reader-execution'],
  ['sort-compressor-separated', 'sort --compress-program tool -- file', 'deny', 'reader-execution'],
  ['sort-compressor-equals', 'sort --compress-program=tool -- file', 'deny', 'reader-execution'],
  ['rg-pre-prefix-lookalike', 'rg --X--pre=tool -- needle file', 'unresolved', 'reader-option'],
  ['rg-pre-suffix-lookalike', 'rg --preX=tool -- needle file', 'unresolved', 'reader-option'],
  [
    'sort-compressor-prefix-lookalike',
    'sort --X--compress-program=tool -- file',
    'unresolved',
    'reader-option',
  ],
  [
    'sort-compressor-suffix-lookalike',
    'sort --compress-programX=tool -- file',
    'unresolved',
    'reader-option',
  ],
  ['rg-consumed-boundary', 'rg -e -- --pre=tool file', 'deny', 'reader-execution'],
  ['rg-real-boundary', 'rg -- -e --pre=tool', 'allow'],
  ['rg-hostname-data', "rg -F -- '--hostname-bin=tool' file", 'allow'],
  ['sort-compressor-data', "sort -- '--compress-program=tool'", 'allow'],
  ['rg-zip-short', 'rg -z -- needle file.gz', 'unresolved', 'reader-option'],
  ['rg-zip-long', 'rg --search-zip -- needle file.gz', 'unresolved', 'reader-option'],
  ['uniq-one-input', 'uniq input', 'allow'],
  ['uniq-second-output', 'uniq input output', 'unresolved', 'reader-output'],
  ['uniq-second-output-after-boundary', 'uniq -- input output', 'unresolved', 'reader-output'],
  ['uniq-output-pin-metadata', "uniq input '{{OWN}}/.git'", 'unresolved', 'reader-output'],
  [
    'uniq-output-canonical-metadata',
    "uniq input '{{CANONICAL}}/.git/config'",
    'unresolved',
    'reader-output',
  ],
  ['uniq-boundary-named-input', 'uniq -- --', 'allow'],
  ['uniq-boundary-named-output', 'uniq -- -- --', 'unresolved', 'reader-output'],
  ['uniq-boundary-after-input', 'uniq -- input --', 'unresolved', 'reader-output'],
])
  add(id, command, decision, reason);

// Closed Git option profiles distinguish formatting/search data from executable
// option slots and refuse write/plugin extensions without running Git commands.
for (const [id, command, decision, reason] of [
  ['git-status-flags', 'git status -sb --porcelain=v1 --ignored --untracked-files=all', 'allow'],
  ['git-diff-flags', 'git diff --no-ext-diff --no-textconv --stat --color=never -U3', 'allow'],
  ['git-log-data', "git log -n 1 --grep '--ext-diff' -- '--textconv'", 'allow'],
  ['git-log-equals-data', "git log --grep='--ext-diff' --format=%h", 'allow'],
  ['git-grep-data', "git grep -e '--open-files-in-pager=tool' -- file", 'allow'],
  ['git-diff-data-boundary', 'git diff -U 3 -- --ext-diff', 'allow'],
  ['git-commit-data', "git commit -m '--exec=tool' --dry-run --no-gpg-sign", 'allow'],
  ['git-log-consumed-boundary', 'git log --grep -- --ext-diff', 'deny', 'git-execution'],
  ['git-log-real-boundary', 'git log -- --grep --ext-diff', 'allow'],
  ['git-grep-execution', 'git grep --open-files-in-pager=tool needle', 'deny', 'git-execution'],
  ['git-cat-file-execution', 'git cat-file --filters HEAD:file', 'deny', 'git-execution'],
  ['git-diff-output-option', 'git diff --output=file', 'unresolved', 'git-option-unmodeled'],
  ['git-log-format-extension', "git log --format='%(exec)'", 'unresolved', 'git-option-unmodeled'],
  ['git-log-missing-data', 'git log --grep', 'unresolved', 'git-option-unmodeled'],
  ['git-grep-missing-data', 'git grep --regexp', 'unresolved', 'git-option-unmodeled'],
  ['git-diff-missing-data', 'git diff --unified', 'unresolved', 'git-option-unmodeled'],
  ['git-commit-missing-data', 'git commit --message', 'unresolved', 'git-option-unmodeled'],
  [
    'git-global-extension',
    'git --config-env=alias.x=VALUE status',
    'unresolved',
    'git-global-option',
  ],
])
  add(id, command, decision, reason);

for (const pin of ['SYMLINK_PIN', 'HARDLINK_PIN', 'LARGE_PIN']) {
  cases.push({
    id: `mapping-${pin}`,
    command: 'git status',
    cwdPath: `{{${pin}}}`,
    worktreePath: `{{${pin}}}`,
    decision: 'unresolved',
    reason: 'git-mapping-unresolved',
  });
}

// Bash's closed data-only conditional subset: each predicate is independent of
// file existence or the truth result; admission asserts absence of evaluation.
for (const operator of [
  '-b',
  '-c',
  '-d',
  '-e',
  '-f',
  '-g',
  '-h',
  '-k',
  '-p',
  '-r',
  '-s',
  '-u',
  '-w',
  '-x',
  '-L',
  '-O',
  '-G',
  '-N',
  '-S',
  '-n',
  '-z',
]) {
  add(`test-unary-${operator}`, `test ${operator} 'literal[$(touch marker)]'`);
  add(`bracket-unary-${operator}`, `[ ${operator} "$VALUE" ]`);
}
for (const [index, operator] of ['=', '==', '!=', '<', '>', '-nt', '-ot', '-ef'].entries()) {
  add(`test-binary-${index}`, `test 'literal[$(touch marker)]' '${operator}' "$VALUE"`);
}
for (const operator of ['-eq', '-ne', '-lt', '-le', '-gt', '-ge']) {
  add(`test-integer-${operator}`, `test '+12' ${operator} '-3'`);
  add(
    `test-integer-name-${operator}`,
    `test 'value' ${operator} 1`,
    'unresolved',
    'test-expression'
  );
  add(
    `test-integer-opaque-${operator}`,
    `test "$VALUE" ${operator} 1`,
    'unresolved',
    'test-expression'
  );
}
for (const [id, command, decision, reason] of [
  ['test-empty', 'test', 'allow'],
  ['test-single-data', "test 'literal[$(touch marker)]'", 'allow'],
  ['bracket-empty', '[ ]', 'allow'],
  ['test-variable-reference', "test -v 'array[$(touch marker)]'", 'unresolved', 'test-expression'],
  ['test-nameref', 'test -R value', 'unresolved', 'test-expression'],
  ['test-compound', 'test -n x -a -n y', 'unresolved', 'test-expression'],
  [
    'test-integer-injection',
    "test 'array[$(touch marker)]' -eq 1",
    'unresolved',
    'test-expression',
  ],
  ['bracket-wrong-close', '[ -n x wrong', 'unresolved', 'test-expression'],
  ['bracket-opaque-close', '[ -n x "$CLOSE"', 'unresolved', 'test-expression'],
])
  add(id, command, decision, reason);

module.exports = cases;
