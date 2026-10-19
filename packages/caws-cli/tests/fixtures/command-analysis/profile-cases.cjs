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
  ['git-grep-missing-data', 'git grep -e', 'unresolved', 'git-option-unmodeled'],
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

for (const [id, command, decision, reason] of [
  ['printf-percent-literal', "printf '%%'", 'allow'],
  ['printf-percent-write-looking-data', "printf '%%n'", 'allow'],
  ['printf-real-write-after-percent', "printf '%%%n' destination", 'unresolved', 'printf-format'],
  ['printf-missing-conversion', "printf '%'", 'unresolved', 'printf-format'],
  ['printf-format-is-not-data', "printf '%n' destination", 'unresolved', 'printf-format'],
  ['printf-argument-is-data', "printf '%s' '%n'", 'allow'],
])
  add(id, command, decision, reason);

for (const [id, command, decision] of [
  ['concurrent-write-first', 'printf x > note | git status', 'unresolved'],
  ['concurrent-write-last', 'git status | printf x > note', 'unresolved'],
  ['concurrent-nested-write', '(printf x > note | cat) | git status', 'unresolved'],
  ['concurrent-lifecycle', 'caws worktree create next | git status', 'unresolved'],
  ['concurrent-reader', 'printf x | git status', 'allow'],
  ['concurrent-write-looking-data', "printf '%s' 'printf x > note' | git status", 'allow'],
  ['sequential-later-write', 'git status; printf x > note', 'allow'],
])
  add(id, command, decision, decision === 'unresolved' ? 'git-context-changed' : undefined);

for (const [failure, fact] of [
  ['git-discovery-timeout', '500 ms'],
  ['git-discovery-protocol', 'protocol'],
  ['git-discovery-failed', 'availability'],
])
  cases.push({
    id: `external-${failure}`,
    command: 'git status',
    gitFailure: failure,
    decision: 'unresolved',
    reason: failure,
    reasonIncludes: fact,
  });

for (const [id, command, decision, reason, reasonSource] of [
  [
    'redirect-only-effects',
    '> note; git status',
    'unresolved',
    'git-context-changed',
    'git status',
  ],
  [
    'assignment-redirect-effects',
    'D=ordinary > note; git status',
    'unresolved',
    'git-context-changed',
    'git status',
  ],
  ['redirect-only-null', '> /dev/null; git status', 'allow'],
  [
    'redirect-compound-effects',
    '{ printf x; } > note; git status',
    'unresolved',
    'git-context-changed',
    'git status',
  ],
  ['redirect-compound-null', '{ printf x; } > /dev/null; git status', 'allow'],
  ['backtick-plain-source-custody', 'printf \'%s\' "`printf x`"', 'allow'],
  ['parameter-length', 'D=known; cat -- "${#D}"', 'unresolved', 'parameter-operation', '${#D}'],
  [
    'parameter-indirection',
    'D=known; cat -- "${!D}"',
    'unresolved',
    'parameter-operation',
    '${!D}',
  ],
  ['parameter-index', 'D=known; cat -- "${D[0]}"', 'unresolved', 'parameter-operation', '${D[0]}'],
])
  cases.push({
    id: `profile-${id}`,
    command,
    decision,
    ...(reason ? { reason, reasonSource } : {}),
  });
for (const [target, decision] of [
  ['OWN', 'allow'],
  ['FOREIGN', 'deny'],
])
  cases.push({
    id: `inherited-git-worktree-${target}`,
    command: 'git status',
    environment: { GIT_WORK_TREE: `{{${target}}}` },
    decision,
    ...(decision === 'deny' ? { reason: 'foreign-git-target', reasonSource: 'git status' } : {}),
  });

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

cases.push({
  id: 'profile-backtick-decoded-source-custody',
  command: "printf '%s' \"`printf '%s' '\\$HOME'`\"",
  decision: 'unresolved',
  reason: 'substitution-source',
  reasonSource: "`printf '%s' '\\$HOME'`",
});

cases.find((item) => item.id === 'profile-backtick-plain-source-custody').traceCommands = [
  'printf x',
];

for (const [id, redirect] of [
  ['output', '{D}> /dev/null'],
  ['input', '{D}< /dev/null'],
  ['duplicate', '{D}>&1'],
  ['close', '{D}>&-'],
  ['here-string', '{D}<<<data'],
  ['here-doc', "{D}<<'EOF'\ndata\nEOF\n"],
])
  cases.push({
    id: 'named-fd-' + id,
    command: 'D=printf; ' + redirect + (redirect.endsWith('\n') ? '' : '; ') + '"$D" status',
    decision: 'unresolved',
    reason: 'redirect-variable',
    reasonSource: '{D}',
  });
cases.push({
  id: 'named-fd-git-routing',
  command: 'GIT_DIR=\'{{OWN_METADATA}}\'; {GIT_DIR}> /dev/null; git --git-dir="$GIT_DIR" status',
  decision: 'unresolved',
  reason: 'redirect-variable',
  reasonSource: '{GIT_DIR}',
});
add('numeric-fd-preserves-binding', 'D=printf; 3>/dev/null; "$D" status');
const temporaryPrefix = 'G=printf; G=git :; cd \'{{FOREIGN}}\'; "$G" status';
for (const [id, environment, decision] of [
  ['default', {}, 'allow'],
  ['ordinary-options', { SHELLOPTS: 'braceexpand:hashall' }, 'allow'],
  ['posix-options', { SHELLOPTS: 'braceexpand:posix:hashall' }, 'unresolved'],
  ['keyword-options', { SHELLOPTS: 'braceexpand:keyword:hashall' }, 'unresolved'],
  ['posix-variable', { POSIXLY_CORRECT: '1' }, 'unresolved'],
  ['empty-posix-variable', { POSIXLY_CORRECT: '' }, 'unresolved'],
])
  cases.push({
    id: 'assignment-mode-' + id,
    command: temporaryPrefix,
    environment,
    decision,
    ...(decision === 'unresolved'
      ? { reason: 'inherited-environment', reasonSource: temporaryPrefix }
      : {}),
  });

for (const [id, command, reason] of [
  ['opaque-assignment-git-target', 'D=$(printf data); git -C "$D" status', 'git-unknown-argument'],
  [
    'branch-write-first',
    'if test "$F" = y; then printf x > note; else :; fi; git status',
    'git-context-changed',
  ],
  [
    'branch-write-second',
    'if test "$F" = y; then :; else printf x > note; fi; git status',
    'git-context-changed',
  ],
  [
    'read-implicit-reply',
    'REPLY=\'{{OWN}}\'; read; git -C "$REPLY" status',
    'git-unknown-argument',
  ],
  [
    'cd-invalidates-oldpwd',
    "OLDPWD='{{OWN}}'; cd '{{OWN}}'; git -C \"$OLDPWD\" status",
    'git-unknown-argument',
  ],
])
  add(id, command, 'unresolved', reason);

add(
  'embedded-bin-is-not-executable-path',
  "p/bin/rintf '%s' data",
  'unresolved',
  'executable-path'
);
add('absolute-bin-printf', "/bin/printf '%s' data");
add('absolute-usr-bin-printf', "/usr/bin/printf '%s' data");
add('git-writer-substitution', 'cat -- "$(git add -- file)"', 'unresolved', 'substitution-effects');
add('git-writer-ordinary', 'git add -- file');
for (const invocation of [
  'status',
  'diff',
  'log',
  'show',
  'rev-parse HEAD',
  'ls-files',
  'ls-tree HEAD',
])
  add('git-reader-substitution-' + invocation.split(' ')[0], 'cat -- "$(git ' + invocation + ')"');
for (const [id, value, decision] of [
  ['cat', 'cat', 'allow'],
  ['empty', "''", 'allow'],
  ['program', 'tool', 'unresolved'],
  ['opaque', '"$VALUE"', 'unresolved'],
])
  add(
    'git-pager-' + id,
    'GIT_PAGER=' + value + ' git status',
    decision,
    decision === 'unresolved' ? 'git-environment' : undefined
  );
for (const [id, destination] of [
  ['sensitive', 'PATH'],
  ['hyphen', 'bad-name'],
  ['digit', '9NAME'],
  ['empty', "''"],
  ['opaque', '"$NAME"'],
])
  add('read-destination-' + id, 'read ' + destination, 'unresolved', 'read-options');

add('literal-unquoted-heredoc', 'cat <<EOF\nliteral\nEOF\n');
add('empty-unquoted-heredoc', 'cat <<EOF\nEOF\n');
add(
  'binding-insertion-order-is-not-state',
  Array.from({ length: 6 }, (_, i) => {
    const a = 'A' + (i + 1),
      b = 'B' + (i + 1);
    return 'if test "$F" = y; then ' + a + '=a; ' + b + '=b; else ' + b + '=b; ' + a + '=a; fi;';
  }).join(' ') + ' printf x'
);
add(
  'negation-preserves-directory-change',
  "! cd '{{FOREIGN}}'; git status",
  'deny',
  'foreign-git-target'
);

for (const [id, command, source] of [
  ['argument-format-binding', 'D=printf; HOME=%n; printf D=~ D; "$D" status', 'D=~'],
  [
    'assignment-colon-format-binding',
    'G=printf; HOME=%n; F=x:~; printf "$F" G; "$G" status',
    'x:~',
  ],
  ['argument-colon', "printf '%s' D=x:~", 'D=x:~'],
  ['mixed-leading', 'printf %s ~"$V"', '~"$V"'],
  [
    'git-routing',
    'GIT_DIR=\'{{OWN_METADATA}}\'; HOME=%n; printf D=~ GIT_DIR; git --git-dir="$GIT_DIR" status',
    'D=~',
  ],
])
  cases.push({
    id: 'tilde-' + id,
    command,
    decision: 'unresolved',
    reason: 'tilde-expansion',
    reasonSource: source,
  });
for (const [id, command] of [
  ['quoted-assignment', "printf '%s' 'D=~'"],
  ['quoted-value', "printf '%s' D='~'"],
  ['quoted-colon-value', "F=x:'~'; printf '%s' \"$F\""],
  ['escaped-value', "printf '%s' D=\\~"],
  ['ordinary-colon-data', "printf '%s' x:~"],
  ['second-equals-argument', "printf '%s' D=x=~"],
  ['second-equals-assignment', 'D=x=~; printf \'%s\' "$D"'],
  ['expanded-tilde-data', "D='~'; printf '%s' \"$D\""],
])
  add('tilde-data-' + id, command);

module.exports = cases;
