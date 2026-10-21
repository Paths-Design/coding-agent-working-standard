'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
// Only this fixed runner executes; submitted shell/Node/Python source is data.
const RUNNER = String(async function main() {
  if (process.argv[2]) process.env.__STRYKER_ACTIVE_MUTANT__ = process.argv[2];
  const { projectMutationView } = require(process.argv[1]);
  const input = JSON.parse(require('node:fs').readFileSync(0, 'utf8'));
  const output = [];
  for (const request of input) {
    const previous = new Map(
      Object.keys(request.environment || {}).map((key) => [key, process.env[key]])
    );
    for (const [key, value] of Object.entries(request.environment || {})) {
      if (value === null) delete process.env[key];
      else process.env[key] = value;
    }
    try {
      const queries = [];
      let next = 0;
      const dependencies = request.metadataResults
        ? {
            gitContext: (input, onFailure) => {
              queries.push({ cwd: input.cwd, overrides: { ...input.overrides } });
              if (next >= request.metadataResults.length) throw Error('Unexpected metadata query');
              const value = request.metadataResults[next++];
              if (value === 'throw') throw Error('Controlled metadata resolver failure');
              if (typeof value === 'string') {
                onFailure(value);
                return null;
              }
              if (value && Object.hasOwn(value, 'failure')) {
                onFailure(value.failure);
                return value.context;
              }
              return value;
            },
          }
        : {};
      output.push({
        id: request.id,
        activeMutant: process.env.__STRYKER_ACTIVE_MUTANT__ ?? '',
        view: await projectMutationView(request.input, dependencies),
        queries,
      });
    } finally {
      for (const [key, value] of previous) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  }
  process.stdout.write(JSON.stringify(output));
});
// These Bash builtin names have no admitted projection profile. A name in a
// data operand must not create an invocation with unmodeled effects.
const BUILTINS = [
  '.',
  'alias',
  'bg',
  'bind',
  'break',
  'builtin',
  'caller',
  'compgen',
  'complete',
  'compopt',
  'continue',
  'declare',
  'dirs',
  'disown',
  'enable',
  'eval',
  'exit',
  'export',
  'fc',
  'fg',
  'getopts',
  'hash',
  'help',
  'history',
  'jobs',
  'kill',
  'let',
  'local',
  'logout',
  'mapfile',
  'popd',
  'pushd',
  'readarray',
  'readonly',
  'return',
  'set',
  'shift',
  'shopt',
  'source',
  'suspend',
  'times',
  'trap',
  'type',
  'typeset',
  'ulimit',
  'umask',
  'unalias',
  'unset',
  'wait',
];
const CODE_CASES = [
  [
    'node-eval-mode',
    'node --eval \'const x = "a > b";\'',
    'node',
    'const x = "a > b";',
    '\'const x = "a > b";\'',
  ],
  [
    'node-print-mode',
    'node --print \'(() => "a > b")()\'',
    'node',
    '(() => "a > b")()',
    '\'(() => "a > b")()\'',
  ],
  [
    'python-inline-mode',
    'python3 -c\'print("a > b")\'',
    'python',
    'print("a > b")',
    '-c\'print("a > b")\'',
  ],
];
const sourceCase = (n, character = 'x') => 'bash -c \'printf %s "' + character.repeat(n) + '"\'';
const textCase = (n, character = 'x') =>
  "BIG='" +
  character.repeat(n) +
  "'; for I in " +
  Array(32).fill('a').join(' ') +
  '; do printf %s "$BIG"; done';
const tokenCase = (n) =>
  Array(n)
    .fill("bash -c 'printf %s " + Array(128).fill('x').join(' ') + "'")
    .join('; ');
const CASES = [
  ...CODE_CASES.map(([id, command]) => [id, command]),
  ['node-missing-eval', 'node --eval'],
  ['python-opaque-code', 'python3 -c "$CODE"'],
  ['node-stdin-overridden', "node <<'JS' < input\nconst x = 1;\nJS\n"],
  ['node-stdin-selected', "node < input <<'JS'\nconst x = 1;\nJS\n"],
  ['shell-stdin-selected', "bash < input <<'SH'\nprintf x > '{{FOREIGN}}/chosen'\nSH\n"],
  ['wrapper-boundaries', "command -- env -- exec -- node -e '1'"],
  ['wrapper-query', "command -v node -e '1'"],
  ['wrapper-eight', 'command '.repeat(8) + "node -e '1'"],
  ['wrapper-nine', 'command '.repeat(9) + "node -e '1'"],
  ['literal-tab-heredoc', "node <<'JS'\n\tconst x = 1;\nJS\n"],
  ['transformed-tab-heredoc', "node <<-'JS'\n\tconst x = 1;\nJS\n"],
  ['shared-source-limit', sourceCase(32751)],
  ['shared-source-exceeded', sourceCase(32752)],
  ['shared-source-unicode', sourceCase(20000, 'ç')],
  ['shared-text-limit', textCase(8183)],
  ['shared-text-exceeded', textCase(8184)],
  ['shared-text-unicode', textCase(4096, 'ç')],
  ['shared-token-limit', tokenCase(30)],
  ['shared-token-exceeded', tokenCase(31)],
  ['node-arrow-argument', "node -e 'const fn = x => x;'"],
  ['node-arrow-heredoc', "node <<'JS'\nconst fn = x => x;\nJS\n"],
  ['real-redirection', "printf x > '{{FOREIGN}}/out'"],
  ['quoted-mutator-prose', "printf '%s' 'rm {{FOREIGN}}/out; node -e write()'"],
  ['finite-binding', 'OUT=\'{{FOREIGN}}/bound\'; printf x > "$OUT"'],
  [
    'branch-targets',
    'if test "$F" = yes; then OUT=\'{{PROJECT}}/owned\'; else OUT=\'{{FOREIGN}}/branch\'; fi; printf x > "$OUT"',
  ],
  ['nested-heredoc-write', "cat <<DATA\n$(printf x > '{{FOREIGN}}/nested')\nDATA\n"],
  ['unknown-target', 'printf x > "$OUT"'],
  ['shell-heredoc-write', "bash <<'SH'\nprintf x > '{{FOREIGN}}/shell'\nSH\n"],
  ['shell-c-write', 'bash -c \'printf x > "{{FOREIGN}}/shell-c"\''],
  ['opaque-shell-code', 'bash -c "$CODE"'],
  ['expanded-shell-heredoc', 'bash <<SH\nprintf x > "$OUT"\nSH\n'],
  ['quoted-heredoc-prose', "cat <<'DATA'\nrm {{FOREIGN}}/out\nDATA\n"],
  ['wrapped-node', "command env FLAG=value exec node -e 'const fn = x => x;'"],
  ['input-versus-write', "cat < '{{FOREIGN}}/read'; cat <> '{{FOREIGN}}/write'"],
  ['numeric-descriptors', 'printf x 2>&1; cat 0<&-'],
  ['printf-state-effect', "printf '%n' TARGET"],
  ['unknown-executable', '"$PROGRAM" data'],
  ['literal-application-residual', 'application-without-a-profile data'],
  ['shell-source-overridden', "bash <<'SH' < input\nrm {{FOREIGN}}/out\nSH\n"],
  ['shell-prefix-environment', "OUT='{{FOREIGN}}/env' bash -c 'printf x > \"$OUT\"'"],
  ['nested-budget', Array(33).fill("bash -c 'printf x'").join('; ')],
  ['node-submission-is-inert', 'node -e \'require("node:fs").writeFileSync("{{MARKER}}", "bad")\''],
  ['builtin-unset', 'OUT=\'{{PROJECT}}/owned\'; unset OUT; touch "$OUT"'],
  ['builtin-eval', 'OUT=\'{{PROJECT}}/owned\'; eval \'OUT="{{FOREIGN}}/eval"\'; touch "$OUT"'],
  ['builtin-source', "source '{{FOREIGN}}/script.sh'"],
  ['builtin-dispatch', 'builtin unset OUT'],
  ['sed-execution-visible', "sed 'e printf x' file"],
  ['sed-write-script-visible', "sed 'w {{FOREIGN}}/sed-out' file"],
  ['reader-execution-visible', 'rg --pre=tool -- needle file'],
  ['git-execution-visible', 'git diff --ext-diff'],
  ['builtin-prose-data', "printf '%s' 'unset OUT; eval source file'"],
  ['opaque-node-stdin', 'node < input'],
  ['opaque-python-stdin', 'python3 -'],
  ['posix-shell', 'sh -c \'G=printf; G=rm :; "$G" /foreign/x\''],
  ['node-preload', "NODE_OPTIONS='--require /tmp/preload.cjs' node -e 'console.log(1)'"],
  ['python-import-path', "env PYTHONPATH=/tmp/untrusted python3 -c 'import os'"],
  ['unknown-cwd-nested', "bash -c 'cd /; touch relative'"],
  ['unknown-cwd-node', "node <<'JS'\nconsole.log(1);\nJS\n"],
  ['effects-readonly', 'node -e \'console.log("/foreign/mentioned writeFileSync")\''],
  [
    'effects-finite-write',
    'node -e \'console.log("{{FOREIGN}}/decoy"); require("node:fs").writeFileSync("{{FOREIGN}}/actual", "{{PROJECT}}/data")\'',
  ],
  ['effects-dynamic-write', 'node -e \'require("node:fs").writeFileSync(process.env.DEST, "x")\''],
  ['effects-unknown-call', "node -e 'unknownFunction()'"],
  ['effects-entry-file', 'node entry.js'],
  ['effects-source-startup', "NODE_OPTIONS='--require /tmp/untrusted.cjs'; node -e '1'"],
  ['sed-combined-edit', 'sed -ni -e p /foreign/out'],
  ['uniq-output', 'uniq /dev/null /foreign/out'],
  ['sort-output', 'sort -o /foreign/out /dev/null'],
  ['git-source-pager', "PAGER='printf pager > {{MARKER}}' git log --oneline"],
  ['git-source-pager-env', "env PAGER='printf pager > {{MARKER}}' git log --oneline"],
  ['git-source-pager-cat', 'PAGER=cat git log --oneline'],
  ['git-source-pager-data', "DATA='printf pager > {{MARKER}}' git log --oneline"],
  ['all-builtins-as-data', "printf '%s' '" + BUILTINS.join(' ') + "'"],
  ...BUILTINS.map((name) => ['builtin-profile-' + name, name + ' fixture']),
];
describe('mutation view uses shared traversal without granting scope', () => {
  let root, locations, requests, views, metadataCases, metadataQueries, metadataContext;
  const expand = (value) => value.replace(/\{\{([A-Z]+)\}\}/g, (_, key) => locations[key]);
  const view = (id) => views.get(id);
  const words = (id) =>
    view(id)
      .tokens.filter((token) => token.kind === 'word')
      .map((token) => token.value);
  const codes = (id) => view(id).issues.map((issue) => issue.code);
  beforeAll(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'caws-mutation-view-'));
    locations = {
      PROJECT: path.join(root, 'project'),
      FOREIGN: path.join(root, 'foreign'),
      MARKER: path.join(root, 'must-not-exist'),
    };
    for (const directory of [locations.PROJECT, locations.FOREIGN]) fs.mkdirSync(directory);
    locations.META = path.join(root, 'metadata');
    locations.COMMON = path.join(root, 'common');
    locations.INDEX = path.join(locations.FOREIGN, 'index');
    fs.mkdirSync(locations.META);
    fs.mkdirSync(locations.COMMON);
    fs.writeFileSync(locations.INDEX, '');
    for (let i = 0; i < 9; i++) fs.mkdirSync(path.join(locations.PROJECT, 'context' + i));
    metadataContext = {
      directory: fs.realpathSync.native(locations.META),
      common: fs.realpathSync.native(locations.COMMON),
      worktree: fs.realpathSync.native(locations.PROJECT),
    };
    requests = CASES.map(([id, command]) => ({
      id,
      input: {
        command: expand(command),
        cwd: id.startsWith('unknown-cwd-') ? null : locations.PROJECT,
        project: locations.PROJECT,
      },
    }));
    const query = { cwd: fs.realpathSync.native(locations.PROJECT), overrides: {} };
    const contextQuery = (index) => ({
      cwd: fs.realpathSync.native(path.join(locations.PROJECT, 'context' + index)),
      overrides: {},
    });
    metadataCases = [
      {
        id: 'metadata-nested-disabled-exported-pager',
        command: "GIT_PAGER=cat; bash -c 'git log --oneline'",
        environment: { GIT_PAGER: 'less' },
        plan: [],
        queries: [],
        rows: [],
      },
      {
        id: 'metadata-deep-disabled-exported-pager',
        command: "GIT_PAGER=cat; bash <<'SH'\nbash -c 'git log --oneline'\nSH\n",
        environment: { GIT_PAGER: 'less' },
        plan: [],
        queries: [],
        rows: [],
      },
      {
        id: 'metadata-nested-disabled-pager-overwritten',
        command: `GIT_PAGER=cat; bash -c 'GIT_PAGER="printf pager > {{MARKER}}"; git log --oneline'`,
        environment: { GIT_PAGER: 'less' },
        plan: [],
        queries: [],
        rows: [],
        code: 'git-environment',
      },
      {
        id: 'metadata-nested-disabled-exported-pager-expansion',
        command: `GIT_PAGER=cat; bash -c 'touch "{{FOREIGN}}/$GIT_PAGER"'`,
        environment: { GIT_PAGER: 'less' },
        plan: [],
        queries: [],
        rows: [],
        expectedWord: '{{FOREIGN}}/cat',
      },
      {
        id: 'metadata-nested-disabled-unexported-pager-expansion',
        command: `GIT_PAGER=cat; bash -c 'touch "{{FOREIGN}}/$GIT_PAGER"'`,
        environment: { GIT_PAGER: null },
        plan: [],
        queries: [],
        rows: [],
        expectedDynamic: true,
      },
      {
        id: 'metadata-nested-disabled-exported-fallback-pager-expansion',
        command: `PAGER=cat; bash -c 'touch "{{FOREIGN}}/$PAGER"'`,
        environment: { PAGER: 'less' },
        plan: [],
        queries: [],
        rows: [],
        expectedWord: '{{FOREIGN}}/cat',
      },
      {
        id: 'metadata-nested-disabled-empty-pager-expansion',
        command: `GIT_PAGER=''; bash -c 'touch "{{FOREIGN}}/$GIT_PAGER"'`,
        environment: { GIT_PAGER: 'less' },
        plan: [],
        queries: [],
        rows: [],
        expectedWord: '{{FOREIGN}}/',
      },
      {
        id: 'metadata-nested-rebound-export',
        command: "GIT_DIR='{{FOREIGN}}'; bash -c 'git add -- file'",
        environment: { GIT_DIR: metadataContext.directory },
        plan: [metadataContext],
        queries: [],
        rows: [],
        code: 'metadata-coordinate-unresolved',
      },
      {
        id: 'metadata-deep-rebound-export',
        command: "GIT_DIR='{{FOREIGN}}'; bash <<'SH'\nbash -c 'git add -- file'\nSH\n",
        environment: { GIT_DIR: metadataContext.directory },
        plan: [metadataContext],
        queries: [],
        rows: [],
        code: 'metadata-coordinate-unresolved',
      },
      {
        id: 'metadata-nested-unchanged-export',
        command: "GIT_DIR='{{META}}'; bash -c 'git add -- file'",
        environment: { GIT_DIR: locations.META },
        plan: [metadataContext],
        queries: [{ ...query, overrides: { GIT_DIR: metadataContext.directory } }],
        rows: ['add'],
      },
      ...[
        ['pager', "PAGER='printf pager > {{MARKER}}'; bash -c 'git log --oneline'"],
        [
          'pager-deep',
          "PAGER='printf pager > {{MARKER}}'; bash <<'SH'\nbash -c 'git log --oneline'\nSH\n",
        ],
      ].map(([id, command]) => ({
        id: 'metadata-nested-' + id,
        command,
        plan: [],
        queries: [],
        rows: [],
        code: 'mutation-shell-environment',
      })),
      ...[
        ['pager-disabled', "PAGER=cat; bash -c 'git log --oneline'"],
        ['pager-data', "DATA='printf pager > {{MARKER}}'; bash -c 'git log --oneline'"],
        ['pager-no-git', "PAGER='printf pager > {{MARKER}}'; bash -c 'printf safe'"],
      ].map(([id, command]) => ({
        id: 'metadata-nested-' + id,
        command,
        plan: [],
        queries: [],
        rows: [],
      })),
      {
        id: 'metadata-add',
        command: 'git add -- file',
        plan: [metadataContext],
        queries: [query],
        rows: ['add'],
      },
      {
        id: 'metadata-commit',
        command: 'git commit -m note',
        plan: [metadataContext],
        queries: [query],
        rows: ['commit'],
      },
      { id: 'metadata-read-only', command: 'git status', plan: [], queries: [], rows: [] },
      {
        id: 'metadata-read-after-node',
        command: "node -e 'const fn = x => x;'; git status --short",
        plan: [],
        queries: [],
        rows: [],
        code: 'mutation-interpreter-effects',
      },
      {
        id: 'metadata-read-after-application',
        command: 'application-without-a-profile data; git status --short',
        plan: [],
        queries: [],
        rows: [],
      },
      {
        id: 'metadata-write-after-node',
        command: "node -e 'const fn = x => x;'; git add -- file",
        plan: [],
        queries: [],
        rows: [],
        code: 'metadata-coordinate-unresolved',
      },
      ...[
        ['metadata-after-copy', "cp '{{FOREIGN}}/.git' '{{PROJECT}}/.git'; git add -- file"],
        [
          'metadata-after-substitution-copy',
          "X=$(cp '{{FOREIGN}}/.git' '{{PROJECT}}/.git'); git add -- file",
        ],
        [
          'metadata-after-prefix-substitution-copy',
          "X=$(cp '{{FOREIGN}}/.git' '{{PROJECT}}/.git') true; git add -- file",
        ],
        [
          'metadata-after-substitution-word',
          "printf %s \"$(cp '{{FOREIGN}}/.git' '{{PROJECT}}/.git')\"; git add -- file",
        ],
        [
          'metadata-after-substitution-nested',
          "X=$(cp '{{FOREIGN}}/.git' '{{PROJECT}}/.git'); bash -c 'git add -- file'",
        ],
        ['metadata-after-opaque-app', 'application-without-a-profile data; git add -- file'],
        ['metadata-after-opaque-argv-app', 'application-without-a-profile "$ARG"; git add -- file'],
        [
          'metadata-after-subshell-copy',
          "(cp '{{FOREIGN}}/.git' '{{PROJECT}}/.git'); git add -- file",
        ],
        ['metadata-nested-copy', "bash -c 'cp {{FOREIGN}}/.git {{PROJECT}}/.git; git add -- file'"],
        [
          'metadata-inherited-copy',
          "cp '{{FOREIGN}}/.git' '{{PROJECT}}/.git'; bash -c 'git add -- file'",
        ],
        [
          'metadata-after-effect-pipeline',
          "cp '{{FOREIGN}}/.git' '{{PROJECT}}/.git' | cat; git add -- file",
        ],
        [
          'metadata-nested-pipeline-left',
          "cp '{{FOREIGN}}/.git' '{{PROJECT}}/.git' | bash -c 'git add -- file'",
        ],
        [
          'metadata-nested-pipeline-right',
          "bash -c 'git add -- file' | cp '{{FOREIGN}}/.git' '{{PROJECT}}/.git'",
        ],
        ['metadata-parent-redirect', "printf x > mapping; bash -c 'git add -- file'"],
        ['metadata-later-parent-redirect', "bash -c 'git add -- file'; printf x > mapping"],
        ['metadata-sibling-shell', "bash -c 'git add -- file'; bash -c 'printf x'"],
        [
          'metadata-mixed-callee',
          'for RUNNER in bash application-without-a-profile; do "$RUNNER" -c \'git add -- file\'; done',
        ],
      ].map(([id, command]) => ({
        id,
        command,
        plan: [],
        queries: [],
        rows: [],
        code: 'metadata-coordinate-unresolved',
      })),
      ...[
        ['metadata-after-prose', "printf '%s' 'cp foreign/.git owned/.git'; git add -- file"],
        ['metadata-after-reader', 'cat /dev/null; git add -- file'],
        ['metadata-after-reader-substitution', 'X=$(cat /dev/null); git add -- file'],
        ['metadata-after-read-pipeline', 'printf x | cat; git add -- file'],
        ['metadata-sole-nested-shell', "bash -c 'git add -- file'"],
        ['metadata-nested-reader', "cat /dev/null; bash -c 'git add -- file'"],
        ['metadata-deep-nested-shell', "bash <<'SH'\nbash -c 'git add -- file'\nSH\n"],
      ].map(([id, command]) => ({
        id,
        command,
        plan: [metadataContext],
        queries: [query],
        rows: ['add'],
      })),
      ...[
        [
          'metadata-direct-pipeline-left',
          "cp '{{FOREIGN}}/.git' '{{PROJECT}}/.git' | git add -- file",
        ],
        [
          'metadata-direct-pipeline-right',
          "git add -- file | cp '{{FOREIGN}}/.git' '{{PROJECT}}/.git'",
        ],
      ].map(([id, command]) => ({
        id,
        command,
        plan: [metadataContext],
        queries: [query],
        rows: ['add'],
        code: 'git-context-changed',
      })),
      {
        id: 'metadata-opaque-argv',
        command: 'git add "$FILE"',
        plan: [],
        queries: [],
        rows: [],
        code: 'git-unknown-argument',
      },
      {
        id: 'metadata-null-cwd',
        command: "git -C '{{PROJECT}}' add -- file",
        cwd: null,
        plan: [],
        queries: [],
        rows: [],
        code: 'metadata-coordinate-unresolved',
      },
      {
        id: 'metadata-missing-cwd',
        command: "git -C '{{PROJECT}}/missing' add -- file",
        plan: [],
        queries: [],
        rows: [],
        code: 'metadata-coordinate-unresolved',
      },
      {
        id: 'metadata-missing-override',
        command: "GIT_DIR='{{PROJECT}}/missing' git add -- file",
        plan: [],
        queries: [],
        rows: [],
        code: 'metadata-coordinate-unresolved',
      },
      {
        id: 'metadata-redirected-index',
        command: "GIT_INDEX_FILE='{{INDEX}}' git add -- file",
        plan: [],
        queries: [],
        rows: [],
        code: 'metadata-coordinate-unresolved',
      },
      {
        id: 'metadata-earlier-effects',
        command: 'printf x > note; git add -- file',
        plan: [],
        queries: [],
        rows: [],
        code: 'metadata-coordinate-unresolved',
      },
      {
        id: 'metadata-cache-shared-jobs',
        command: "git add -- one; git add -- three; bash -c 'git commit -m two'",
        plan: [metadataContext],
        queries: [query],
        rows: ['add', 'add', 'commit'],
      },
      {
        id: 'metadata-timeout-cached',
        command: 'git add -- one; git commit -m two',
        plan: ['git-discovery-timeout'],
        queries: [query],
        rows: [],
        code: 'metadata-discovery-timeout',
        occurrences: 2,
      },
      {
        id: 'metadata-protocol',
        command: 'git add -- file',
        plan: ['git-discovery-protocol'],
        queries: [query],
        rows: [],
        code: 'metadata-discovery-failure',
      },
      {
        id: 'metadata-null',
        command: 'git add -- file',
        plan: [null],
        queries: [query],
        rows: [],
        code: 'metadata-discovery-failure',
      },
      {
        id: 'metadata-bare',
        command: 'git add -- file',
        plan: [{ ...metadataContext, worktree: null }],
        queries: [query],
        rows: [],
        code: 'metadata-discovery-failure',
      },
      {
        id: 'metadata-exception',
        command: 'git add -- file',
        plan: ['throw'],
        queries: [query],
        rows: [],
        code: 'metadata-discovery-failure',
      },
      {
        id: 'metadata-budget',
        command: Array.from(
          { length: 9 },
          (_, index) => "git -C '{{PROJECT}}/context" + index + "' add -- file"
        ).join('; '),
        plan: Array(8).fill(metadataContext),
        queries: Array.from({ length: 8 }, (_, index) => contextQuery(index)),
        rows: Array(8).fill('add'),
        code: 'metadata-discovery-budget',
      },
      {
        id: 'metadata-explicit-routing',
        command: "GIT_DIR='{{META}}' git add -- file",
        plan: [metadataContext],
        queries: [{ ...query, overrides: { GIT_DIR: metadataContext.directory } }],
        rows: ['add'],
      },
      ...['directory', 'common', 'worktree'].map((field) => ({
        id: 'metadata-relative-' + field,
        command: 'git add -- file',
        plan: [{ ...metadataContext, [field]: 'relative-coordinate' }],
        queries: [query],
        rows: [],
        code: 'metadata-discovery-failure',
      })),
      {
        id: 'metadata-contradictory-result',
        command: 'git add -- file',
        plan: [{ failure: 'git-discovery-protocol', context: metadataContext }],
        queries: [query],
        rows: [],
        code: 'metadata-discovery-failure',
      },
    ];
    requests.push(
      ...metadataCases.map((fixture) => ({
        id: fixture.id,
        metadataResults: fixture.plan,
        environment: fixture.environment,
        input: {
          command: expand(fixture.command),
          cwd: fixture.cwd === null ? null : locations.PROJECT,
          project: locations.PROJECT,
        },
      }))
    );
    const active = String(
      globalThis.__stryker__?.activeMutant ?? process.env.__STRYKER_ACTIVE_MUTANT__ ?? ''
    );
    const child = spawnSync(
      process.execPath,
      [
        '-e',
        '(' + RUNNER + ')().catch(error=>{console.error(error);process.exitCode=1;})',
        path.resolve(__dirname, '../../dist/shell/analysis/mutation-view.js'),
        active,
      ],
      {
        input: JSON.stringify(requests),
        shell: false,
        encoding: 'utf8',
        timeout: 30000,
        maxBuffer: 4 * 1024 * 1024,
      }
    );
    if (child.error || child.status !== 0)
      throw new Error(
        JSON.stringify({ status: child.status, error: child.error?.message, stderr: child.stderr })
      );
    const batch = JSON.parse(child.stdout);
    expect(batch).toHaveLength(requests.length);
    for (const item of batch) expect(item.activeMutant).toBe(active);
    views = new Map(batch.map((item) => [item.id, item.view]));
    metadataQueries = new Map(batch.map((item) => [item.id, item.queries]));
  });
  afterAll(() => {
    if (root) fs.rmSync(root, { recursive: true, force: true });
  });
  test('Git metadata writes preserve actual coordinates, bounded discovery, and source custody', () => {
    for (const fixture of metadataCases) {
      const actual = view(fixture.id);
      const command = requests.find((item) => item.id === fixture.id).input.command;
      expect({ id: fixture.id, queries: metadataQueries.get(fixture.id) }).toEqual({
        id: fixture.id,
        queries: fixture.queries,
      });
      expect(actual.gitMetadata.map((row) => row.subcommand)).toEqual(fixture.rows);
      if (fixture.expectedWord) expect(words(fixture.id)).toContain(expand(fixture.expectedWord));
      if (fixture.expectedDynamic) {
        expect(
          actual.tokens.some((token) => token.dynamic && token.value.includes('$GIT_PAGER'))
        ).toBe(true);
        expect(words(fixture.id)).not.toContain(locations.FOREIGN + '/cat');
      }
      for (const row of actual.gitMetadata) {
        expect(row.directory).toBe(metadataContext.directory);
        expect(row.common).toBe(metadataContext.common);
        expect(row.worktree).toBe(metadataContext.worktree);
        expect(Number.isInteger(row.start)).toBe(true);
        expect(row.start).toBeGreaterThanOrEqual(0);
        expect(Number.isInteger(row.end)).toBe(true);
        expect(row.end).toBeGreaterThan(row.start);
        expect(row.end).toBeLessThanOrEqual(command.length);
      }
      if (fixture.code) {
        expect(actual.issues.map((item) => item.code)).toContain(fixture.code);
        if (fixture.occurrences !== undefined) {
          const failures = actual.issues.filter((item) => item.code === fixture.code);
          expect(failures).toHaveLength(fixture.occurrences);
          expect(failures.map((item) => command.slice(item.start, item.end))).toEqual([
            'git add -- one',
            'git commit -m two',
          ]);
        }
      } else expect(actual.issues).toEqual([]);
      if (fixture.id === 'metadata-add' || fixture.id === 'metadata-commit') {
        expect(actual.gitMetadata[0].start).toBe(0);
        expect(actual.gitMetadata[0].end).toBe(command.length);
      }
    }
    const nested = view('metadata-cache-shared-jobs');
    const nestedCommand = requests.find((item) => item.id === 'metadata-cache-shared-jobs').input
      .command;
    expect(nested.gitMetadata.map((row) => nestedCommand.slice(row.start, row.end))).toEqual([
      'git add -- one',
      'git add -- three',
      "'git commit -m two'",
    ]);
    const budget = view('metadata-budget');
    const budgetCommand = requests.find((item) => item.id === 'metadata-budget').input.command;
    expect(budget.gitMetadata.map((row) => budgetCommand.slice(row.start, row.end))).toEqual(
      Array.from(
        { length: 8 },
        (_, i) => "git -C '" + locations.PROJECT + '/context' + i + "' add -- file"
      )
    );
    const exhausted = budget.issues.filter((item) => item.code === 'metadata-discovery-budget');
    expect(exhausted).toHaveLength(1);
    expect(budgetCommand.slice(exhausted[0].start, exhausted[0].end)).toBe(
      "git -C '" + locations.PROJECT + "/context8' add -- file"
    );
    expect(metadataQueries.get('metadata-redirected-index')).toEqual([]);
    expect(view('metadata-redirected-index').gitMetadata).toEqual([]);
  });
  // Large boundary cases have concrete multiplicity/limit assertions below;
  // repeating every scalar shape assertion for thousands of equal tokens adds
  // no distinct provenance case.
  test.each(CASES.filter(([id]) => !id.startsWith('shared-')))(
    '%s preserves source spans and the non-authoritative carrier',
    (id) => {
      const actual = view(id),
        command = requests.find((item) => item.id === id).input.command;
      expect(actual.schema).toBe('caws.shell_mutation_view.v2');
      expect(Object.hasOwn(actual, 'decision')).toBe(false);
      expect(
        actual.interpreterInvocations.map(({ language, start, end }) => ({ language, start, end }))
      ).toEqual(
        actual.interpreters
          .map(({ language, start, end }) => ({ language, start, end }))
          .concat(
            ['node-missing-eval', 'python-opaque-code'].includes(id)
              ? [
                  {
                    language: id === 'node-missing-eval' ? 'node' : 'python',
                    start: 0,
                    end: command.length,
                  },
                ]
              : []
          )
      );
      expect(actual.tokens.length).toBeLessThanOrEqual(4096);
      for (const token of actual.tokens) {
        expect(token.prefix).toBe('');
        expect(token.prefixBasis).toBe('none');
        expect(token.resolution).toBe(token.dynamic ? 'runtime' : '');
        expect(token.unrepresentable).toBe(/[\n\t]/.test(token.value));
        expect(token.cwd).toBe(
          id.startsWith('unknown-cwd-') ? null : fs.realpathSync.native(locations.PROJECT)
        );
      }
      for (const item of [
        ...actual.tokens,
        ...actual.issues,
        ...actual.interpreterInvocations,
        ...actual.interpreters,
        ...actual.gitMetadata,
      ]) {
        expect(Number.isInteger(item.start)).toBe(true);
        expect(item.start).toBeGreaterThanOrEqual(0);
        expect(item.end).toBeGreaterThanOrEqual(item.start);
        expect(item.end).toBeLessThanOrEqual(command.length);
      }
    }
  );
  test.each(['node-arrow-argument', 'node-arrow-heredoc', 'wrapped-node'])(
    '%s keeps actual interpreter code separate from shell redirections',
    (id) => {
      expect(codes(id)).toEqual(['mutation-interpreter-effects']);
      expect(view(id).tokens.filter((token) => token.kind === 'redirect')).toEqual([]);
      expect(view(id).interpreters).toHaveLength(1);
      expect(view(id).interpreters[0].language).toBe('node');
      expect(view(id).interpreters[0].argv[0]).toBe('node');
      expect(view(id).interpreters[0].effects.kind).toBe('unresolved');
      expect(view(id).interpreters[0].payloads.map((payload) => payload.text)).toEqual([
        id === 'node-arrow-heredoc' ? 'const fn = x => x;\n' : 'const fn = x => x;',
      ]);
    }
  );
  test.each(CODE_CASES)(
    '%s attributes actual code with original word provenance',
    (id, _source, language, code, original) => {
      const actual = view(id);
      const source = requests.find((item) => item.id === id).input.command;
      expect(codes(id)).toEqual(language === 'python' ? ['mutation-interpreter-effects'] : []);
      expect(actual.tokens.filter((token) => token.kind === 'redirect')).toEqual([]);
      expect(actual.interpreters).toHaveLength(1);
      expect(actual.interpreters[0].language).toBe(language);
      expect(actual.interpreters[0].effects.kind).toBe(
        language === 'python' ? 'unresolved' : 'readonly'
      );
      expect(actual.interpreters[0].payloads).toHaveLength(1);
      const payload = actual.interpreters[0].payloads[0];
      expect(payload.text).toBe(code);
      expect(payload.origin).toBe('argument');
      expect(source.slice(payload.start, payload.end)).toBe(original);
    }
  );
  test.each(['node-missing-eval', 'python-opaque-code'])(
    '%s cannot invent executable code',
    (id) => {
      expect(codes(id)).toContain('mutation-code-source');
      expect(view(id).interpreters).toEqual([]);
      expect(view(id).interpreterInvocations.map((entry) => entry.language)).toEqual([
        id === 'node-missing-eval' ? 'node' : 'python',
      ]);
    }
  );
  test('the last stdin redirection selects executable input', () => {
    expect(codes('node-stdin-overridden')).toContain('mutation-interpreter-source');
    expect(view('node-stdin-overridden').interpreters).toHaveLength(1);
    expect(view('node-stdin-overridden').interpreters[0].payloads).toEqual([]);
    expect(words('shell-source-overridden')).not.toContain('rm');
    expect(words('shell-source-overridden')).not.toContain(locations.FOREIGN + '/out');
    for (const id of ['node-stdin-selected', 'literal-tab-heredoc']) {
      const expected = (id === 'literal-tab-heredoc' ? '\t' : '') + 'const x = 1;\n';
      const actual = view(id);
      const source = requests.find((item) => item.id === id).input.command;
      expect(actual.issues).toEqual([]);
      expect(actual.interpreters).toHaveLength(1);
      expect(actual.interpreters[0].payloads).toHaveLength(1);
      const payload = actual.interpreters[0].payloads[0];
      expect(payload.text).toBe(expected);
      expect(payload.origin).toBe('heredoc');
      expect(source.slice(payload.start, payload.end)).toBe(expected);
      expect(actual.tokens.filter((token) => token.kind === 'redirect')).toEqual([]);
    }
    expect(view('shell-stdin-selected').issues).toEqual([]);
    const target = view('shell-stdin-selected').tokens.find(
      (token) => token.value === locations.FOREIGN + '/chosen'
    );
    expect(target).toBeDefined();
    const source = requests.find((item) => item.id === 'shell-stdin-selected').input.command;
    expect(source.slice(target.start, target.end)).toBe("'" + locations.FOREIGN + "/chosen'");
    expect(codes('transformed-tab-heredoc')).toContain('mutation-heredoc-source');
    expect(view('transformed-tab-heredoc').interpreters[0].payloads).toEqual([]);
  });
  test('wrapper roles and depth do not lend code identity to a query', () => {
    for (const id of ['wrapper-boundaries', 'wrapper-eight']) {
      expect(view(id).issues).toEqual([]);
      expect(view(id).interpreters).toHaveLength(1);
      expect(view(id).interpreters[0].argv).toEqual(['node', '-e', '1']);
      expect(view(id).interpreters[0].payloads.map((payload) => payload.text)).toEqual(['1']);
    }
    for (const [id, code] of [
      ['wrapper-query', 'mutation-wrapper-option'],
      ['wrapper-nine', 'mutation-wrapper-budget'],
    ]) {
      expect(codes(id)).toContain(code);
      expect(view(id).interpreters).toEqual([]);
    }
  });
  test('shared source, byte and token limits stop projection with concrete lower controls', () => {
    expect(
      Buffer.byteLength(sourceCase(32751)) +
        Buffer.byteLength('printf %s "' + 'x'.repeat(32751) + '"')
    ).toBe(65536);
    expect(view('shared-source-limit').issues).toEqual([]);
    expect(words('shared-source-limit')).toContain('x'.repeat(32751));
    expect(view('shared-text-limit').issues).toEqual([]);
    expect(words('shared-text-limit').filter((value) => value === 'x'.repeat(8183))).toHaveLength(
      32
    );
    expect(view('shared-text-limit').tokens).toHaveLength(128);
    expect(view('shared-token-limit').issues).toEqual([]);
    expect(view('shared-token-limit').tokens).toHaveLength(4050);
    expect(words('shared-token-limit').filter((value) => value === 'printf')).toHaveLength(30);
    expect(words('shared-token-limit').filter((value) => value === 'x')).toHaveLength(3840);
    for (const id of [
      'shared-source-exceeded',
      'shared-source-unicode',
      'shared-text-exceeded',
      'shared-text-unicode',
      'shared-token-exceeded',
    ]) {
      expect(codes(id)).toEqual(['mutation-view-budget']);
      expect(view(id).tokens.every((token) => !token.dynamic)).toBe(true);
    }
    expect(words('shared-source-exceeded')).not.toContain('printf');
    const sourceBudget = view('shared-source-exceeded').issues[0];
    const sourceCommand = requests.find((item) => item.id === 'shared-source-exceeded').input
      .command;
    expect({ start: sourceBudget.start, end: sourceBudget.end }).toEqual({
      start: 8,
      end: sourceCommand.length,
    });
    expect(view('shared-text-exceeded').tokens).toHaveLength(126);
    expect(view('shared-token-exceeded').tokens).toHaveLength(4096);
    const textBudget = view('shared-text-exceeded').issues[0];
    const source = requests.find((item) => item.id === 'shared-text-exceeded').input.command;
    expect(source.slice(textBudget.start, textBudget.end)).toBe('"$BIG"');
  });
  test('a real output redirection retains its original word span', () => {
    const actual = view('real-redirection');
    expect(actual.issues).toEqual([]);
    expect(
      actual.tokens.filter((token) => token.kind === 'redirect').map((token) => token.value)
    ).toEqual(['>']);
    const target = actual.tokens.find((token) => token.value === locations.FOREIGN + '/out');
    expect(target).toBeDefined();
    const source = requests.find((item) => item.id === 'real-redirection').input.command;
    expect(source.slice(target.start, target.end)).toBe("'" + locations.FOREIGN + "/out'");
  });
  test('finite bindings and branch alternatives retain every candidate', () => {
    expect(view('finite-binding').issues).toEqual([]);
    expect(words('finite-binding')).toContain(locations.FOREIGN + '/bound');
    expect(view('branch-targets').issues).toEqual([]);
    expect(words('branch-targets')).toEqual(
      expect.arrayContaining([locations.PROJECT + '/owned', locations.FOREIGN + '/branch'])
    );
  });
  test('nested shell expansions are inspected while heredoc data stays data', () => {
    expect(words('nested-heredoc-write')).toContain(locations.FOREIGN + '/nested');
    expect(codes('nested-heredoc-write')).toContain('substitution-effects');
    expect(view('quoted-heredoc-prose').issues).toEqual([]);
    expect(words('quoted-heredoc-prose')).not.toContain('rm');
    expect(view('quoted-heredoc-prose').interpreters).toEqual([]);
    expect(view('quoted-mutator-prose').interpreters).toEqual([]);
    expect(words('quoted-mutator-prose')).toContain(
      'rm ' + locations.FOREIGN + '/out; node -e write()'
    );
  });
  test('opaque target retains raw source without confinement proof', () => {
    expect(view('unknown-target').tokens.find((token) => token.dynamic)).toMatchObject({
      value: '"$OUT"',
      dynamic: true,
      resolution: 'runtime',
      prefix: '',
      prefixBasis: 'none',
    });
    expect(codes('unknown-target')).toContain('redirect-target');
  });
  test.each(['shell-heredoc-write', 'shell-c-write'])('%s projects executable shell code', (id) => {
    expect(view(id).issues).toEqual([]);
    expect(words(id)).toContain(
      locations.FOREIGN + (id === 'shell-c-write' ? '/shell-c' : '/shell')
    );
    expect(view(id).tokens.some((token) => token.kind === 'redirect')).toBe(true);
    const target = view(id).tokens.find((token) =>
      token.value.endsWith(id === 'shell-c-write' ? '/shell-c' : '/shell')
    );
    const command = requests.find((item) => item.id === id).input.command;
    expect(command.slice(target.start, target.end)).toBe(
      id === 'shell-c-write'
        ? '\'printf x > "' + locations.FOREIGN + '/shell-c"\''
        : "'" + locations.FOREIGN + "/shell'"
    );
  });
  test.each([
    ['opaque-shell-code', 'mutation-code-source'],
    ['expanded-shell-heredoc', 'mutation-code-expanded'],
    ['shell-source-overridden', 'mutation-shell-source'],
    ['shell-prefix-environment', 'mutation-shell-environment'],
    ['unknown-executable', 'mutation-executable-unknown'],
    ['printf-state-effect', 'printf-format'],
    ['nested-budget', 'mutation-view-budget'],
    ['opaque-node-stdin', 'mutation-interpreter-source'],
    ['opaque-python-stdin', 'mutation-interpreter-source'],
    ['builtin-unset', 'mutation-shell-builtin'],
    ['builtin-eval', 'mutation-shell-builtin'],
    ['builtin-source', 'mutation-shell-builtin'],
    ['builtin-dispatch', 'mutation-shell-builtin'],
    ['sed-execution-visible', 'sed-execution'],
    ['sed-write-script-visible', 'sed-script-unsupported'],
    ['reader-execution-visible', 'reader-execution'],
    ['git-execution-visible', 'git-execution'],
    ['posix-shell', 'mutation-shell-dialect'],
    ['node-preload', 'environment-change'],
    ['python-import-path', 'environment-change'],
    ['sed-combined-edit', 'sed-option'],
    ['uniq-output', 'reader-output'],
    ['sort-output', 'reader-option'],
    ['git-source-pager', 'git-environment'],
    ['git-source-pager-env', 'git-environment'],
  ])('%s exposes unresolved facts', (id, code) => expect(codes(id)).toContain(code));
  test.each(['git-source-pager-cat', 'git-source-pager-data'])(
    '%s retains no execution issue',
    (id) => {
      expect(view(id).issues).toEqual([]);
      expect(view(id).gitMetadata).toEqual([]);
    }
  );
  test('input and descriptor duplication do not become file writes', () => {
    expect(
      view('input-versus-write')
        .tokens.filter((token) => token.kind === 'input_redirect')
        .map((token) => token.value)
    ).toEqual(['<']);
    expect(
      view('input-versus-write')
        .tokens.filter((token) => token.kind === 'redirect')
        .map((token) => token.value)
    ).toEqual(['<>']);
    expect(
      view('numeric-descriptors').tokens.filter((token) => token.kind.endsWith('redirect'))
    ).toEqual([]);
    expect(view('numeric-descriptors').issues).toEqual([]);
  });
  test('literal applications retain the documented limited-recognizer residual', () => {
    expect(view('literal-application-residual').issues).toEqual([]);
    expect(words('literal-application-residual')).toEqual([
      'application-without-a-profile',
      'data',
    ]);
    expect(view('builtin-prose-data').issues).toEqual([]);
    expect(words('builtin-prose-data')).toContain('unset OUT; eval source file');
  });
  test('submitted interpreter code is never executed', () => {
    expect(view('node-submission-is-inert').interpreters[0].payloads[0].text).toContain(
      'writeFileSync'
    );
    expect(fs.existsSync(locations.MARKER)).toBe(false);
  });
  test('effect knowledge separates literal data from proven write operands', () => {
    expect(view('effects-readonly').issues).toEqual([]);
    expect(view('effects-readonly').interpreters[0].effects).toEqual({
      kind: 'readonly',
      profile: 'caws.node-source-effects.v1',
      writes: [],
    });
    const actual = view('effects-finite-write');
    expect(actual.issues).toEqual([]);
    const interpreter = actual.interpreters[0];
    expect(interpreter.effects.kind).toBe('finite-writes');
    expect(interpreter.effects.profile).toBe('caws.node-source-effects.v1');
    expect(
      interpreter.effects.writes.map(({ target, operation }) => ({ target, operation }))
    ).toEqual([{ target: locations.FOREIGN + '/actual', operation: 'write' }]);
    for (const write of interpreter.effects.writes) {
      expect(interpreter.payloads[0].text.slice(write.start, write.end)).toBe(
        '"' + locations.FOREIGN + '/actual"'
      );
    }
    expect(actual.tokens.filter((token) => token.kind === 'redirect')).toEqual([]);
  });
  test.each([
    'effects-dynamic-write',
    'effects-unknown-call',
    'effects-entry-file',
    'effects-source-startup',
    'wrapped-node',
  ])('%s cannot turn absent proven write facts into permission', (id) => {
    expect(codes(id)).toContain('mutation-interpreter-effects');
    const interpreter = view(id).interpreters[0];
    expect(interpreter.effects).toEqual({
      kind: 'unresolved',
      profile: null,
      reason: expect.any(String),
      writes: [],
    });
    expect(view(id).interpreterInvocations).toEqual([
      { language: interpreter.language, start: interpreter.start, end: interpreter.end },
    ]);
    const issue = view(id).issues.find((entry) => entry.code === 'mutation-interpreter-effects');
    expect({ start: issue.start, end: issue.end }).toEqual({
      start: interpreter.start,
      end: interpreter.end,
    });
  });
  test('unknown coordinates survive nested source and interpreter rows', () => {
    expect(words('unknown-cwd-nested')).toContain('relative');
    expect(view('unknown-cwd-nested').tokens.every((token) => token.cwd === null)).toBe(true);
    expect(view('unknown-cwd-node').interpreters).toHaveLength(1);
    expect(view('unknown-cwd-node').interpreters[0].cwd).toBe(null);
    expect(view('unknown-cwd-node').issues).toEqual([]);
  });
  test.each(BUILTINS)('%s keeps its unprofiled builtin limitation explicit', (name) => {
    expect(codes('builtin-profile-' + name)).toContain('mutation-shell-builtin');
    expect(view('all-builtins-as-data').issues).toEqual([]);
    expect(words('all-builtins-as-data')).toContain(BUILTINS.join(' '));
  });
});

// These programs are analyzed as source only, including the hostile payloads.
const HARDENING_PAYLOAD = 'require("node:fs").writeFileSync("{{MARKER}}", "unexpected")';
const HARDENING_PYTHON_PAYLOAD = 'open("{{MARKER}}", "w").write("unexpected")';
const NODE_CODE_OPTIONS = ["-e '1'", "--eval '1'", "--eval='1'", "-p '1'", "--print '1'"];
const NODE_STARTUP_OPTIONS = [
  '--require /not-executed.cjs',
  '-r /not-executed.cjs',
  '--import=/not-executed.mjs',
];
const NODE_OPTION_HOLDS = NODE_CODE_OPTIONS.flatMap((selected, index) => [
  ...NODE_STARTUP_OPTIONS.flatMap((startup, option) => [
    [
      `node-startup-before-${index}-${option}`,
      `node ${startup} ${selected}`,
      'mutation-interpreter-option',
    ],
    [
      `node-startup-after-${index}-${option}`,
      `node ${selected} ${startup}`,
      'mutation-interpreter-option',
    ],
  ]),
  ...['-e', '--eval', '-p', '--print'].map((override, option) => [
    `node-repeated-source-${index}-${option}`,
    `node ${selected} ${override} '${HARDENING_PAYLOAD}'`,
    'mutation-code-source',
  ]),
  [
    `node-repeated-inline-${index}`,
    `node ${selected} --eval='${HARDENING_PAYLOAD}'`,
    'mutation-code-source',
  ],
  [`node-opaque-tail-${index}`, `node ${selected} "$OPTION"`, 'mutation-code-source'],
]);
NODE_OPTION_HOLDS.push(
  ['node-empty-inline-eval', "node --eval=''", 'mutation-code-source'],
  ...['-p', '--print'].flatMap((option, index) => [
    [
      `node-empty-print-${index}`,
      `node ${option} '' <<'JS'\n${HARDENING_PAYLOAD}\nJS`,
      'mutation-code-source',
    ],
    [
      `node-print-option-operand-${index}`,
      `node ${option} --require /not-executed.cjs`,
      'mutation-code-source',
    ],
  ]),
  [
    'node-inline-print-is-not-code',
    `node --print='1' <<'JS'\n${HARDENING_PAYLOAD}\nJS`,
    'mutation-interpreter-option',
  ],
  ['node-leading-dash-eval', "node -e '-1'", 'mutation-code-source'],
  ['node-transformed-eval', "node -e '\\-1'", 'mutation-code-source'],
  [
    'node-combined-options',
    "node -pe '1' --require /not-executed.cjs",
    'mutation-interpreter-option',
  ]
);
const NODE_OPTION_DATA = NODE_CODE_OPTIONS.flatMap((selected, index) =>
  ['--', 'arg0', '-'].map((boundary, option) => [
    `node-option-data-${index}-${option}`,
    `node ${selected} ${boundary} --require /not-executed.cjs --eval='${HARDENING_PAYLOAD}' "$UNKNOWN"`,
  ])
);
const HARDENING_CODE = [
  ['node-short-print', "node -p '1'", 'node', '1', "'1'"],
  ['node-long-print', "node --print '1'", 'node', '1', "'1'"],
  ['node-inline-eval', "node --eval='1'", 'node', '1', "--eval='1'"],
  ['node-empty-eval', "node -e ''", 'node', '', "''"],
  ['env-leading-terminator', "env -- A=x node -e '1'", 'node', '1', "'1'"],
  ['env-assignment-equals-data', "env A=x=y node -e '1'", 'node', '1', "'1'"],
  ['nodejs-identity', "nodejs -e '1'", 'node', '1', "'1'"],
  ...['python', 'python3', 'python3.12', 'python10.22'].map((program) => [
    'python-identity-' + program,
    program + " -c '" + HARDENING_PYTHON_PAYLOAD + "'",
    'python',
    HARDENING_PYTHON_PAYLOAD,
    "'" + HARDENING_PYTHON_PAYLOAD + "'",
  ]),
  ...['--no-warnings', '--input-type=module', '--input-type=commonjs'].map((flag) => [
    'node-neutral-' + flag,
    'node ' + flag + " -e '1'",
    'node',
    '1',
    "'1'",
  ]),
  ...['-u', '-B', '-E', '-I', '-s', '-S', '-O', '-OO', '-q'].map((flag) => [
    'python-neutral-' + flag,
    'python3 ' + flag + " -c '1'",
    'python',
    '1',
    "'1'",
  ]),
  [
    'env-assignment-identity',
    "env A=x node -e '" + HARDENING_PAYLOAD + "'",
    'node',
    HARDENING_PAYLOAD,
    "'" + HARDENING_PAYLOAD + "'",
  ],
];
const HARDENING_REJECT = [
  ['node-opaque-selection', 'node "$FLAG" -e 1', 'mutation-code-source', '"$FLAG"'],
  ['node-python-flag', "node -B -e '1'", 'mutation-interpreter-option', '-B'],
  [
    'python-node-flag',
    "python3 --no-warnings -c '1'",
    'mutation-interpreter-option',
    '--no-warnings',
  ],
  [
    'shell-node-flag',
    "bash --no-warnings -c 'printf x'",
    'mutation-interpreter-option',
    '--no-warnings',
  ],
  ['python-node-eval', "python3 --eval='1'", 'mutation-interpreter-option', "--eval='1'"],
  ['shell-node-eval', "bash --eval='printf x'", 'mutation-interpreter-option', "--eval='printf x'"],
  [
    'node-warning-suffix',
    "node --no-warnings-extra -e '1'",
    'mutation-interpreter-option',
    '--no-warnings-extra',
  ],
  [
    'node-input-prefix',
    "node --other--input-type=module -e '1'",
    'mutation-interpreter-option',
    '--other--input-type=module',
  ],
  [
    'node-input-suffix',
    "node --input-type=module-extra -e '1'",
    'mutation-interpreter-option',
    '--input-type=module-extra',
  ],
  [
    'node-eval-prefix',
    "node --other--eval='1'",
    'mutation-interpreter-option',
    "--other--eval='1'",
  ],
  ['env-clear', "env -i node -e '1'", 'mutation-wrapper-option', null],
  ['exec-name', "exec -a alias node -e '1'", 'mutation-wrapper-option', null],
  ['env-missing-program', 'env --', 'mutation-executable-unknown', null],
  ['command-missing-program', 'command --', 'mutation-executable-unknown', null],
];
const HARDENING_BODY = 'const selected = 1;\n';
const HARDENING_STDIN = [
  ['stdin-double-dash', "node -- <<'JS'\n" + HARDENING_BODY + 'JS\n', HARDENING_BODY],
  ['stdin-double-dash-minus', "node -- - <<'JS'\n" + HARDENING_BODY + 'JS\n', HARDENING_BODY],
  ['stdin-minus', "node - <<'JS'\n" + HARDENING_BODY + 'JS\n', HARDENING_BODY],
  ['stdin-explicit-zero', "node 0<<'JS'\n" + HARDENING_BODY + 'JS\n', HARDENING_BODY],
  ['stdin-other-input', "node <<'JS' 3<input\n" + HARDENING_BODY + 'JS\n', HARDENING_BODY],
  [
    'stdin-other-heredoc',
    "node 0<<'JS' 3<<'OTHER'\n" + HARDENING_BODY + 'JS\nnotSelected();\nOTHER\n',
    HARDENING_BODY,
  ],
  ['stdin-output-independent', "node <<'JS' > output\n" + HARDENING_BODY + 'JS\n', HARDENING_BODY],
  ['stdin-unquoted-literal', 'node <<JS\n' + HARDENING_BODY + 'JS\n', HARDENING_BODY],
  [
    'stdin-quoted-variable-data',
    'node <<\'JS\'\nconst selected = "$DATA";\nJS\n',
    'const selected = "$DATA";\n',
  ],
];
const HARDENING_NO_STDIN = [
  [
    'stdin-only-other-fd',
    "node 0<input 3<<'JS'\n" + HARDENING_BODY + 'JS\n',
    'mutation-interpreter-source',
  ],
  ['stdin-closed', "node <<'JS' 0<&-\n" + HARDENING_BODY + 'JS\n', 'mutation-interpreter-source'],
  [
    'stdin-replaced-string',
    "node <<'JS' <<< 'replacement'\n" + HARDENING_BODY + 'JS\n',
    'mutation-interpreter-source',
  ],
  [
    'stdin-expanded-variable',
    'node <<JS\nconst selected = "$DATA";\nJS\n',
    'mutation-code-expanded',
  ],
];
const hardeningNested = (depth) => {
  let source = "printf x > '{{FOREIGN}}/deep'";
  for (let level = 0; level < depth; level++)
    source = "bash <<'LEVEL" + level + "'\n" + source + '\nLEVEL' + level + '\n';
  return source;
};

describe('mutation projection preserves program roles and source custody', () => {
  let temporary, locations, requests, results;
  const expand = (value) => value.replace(/\{\{([A-Z]+)\}\}/g, (_, key) => locations[key]);
  const result = (id) => results.get(id).view;
  const source = (id) => requests.find((item) => item.id === id).input.command;
  const issueCodes = (id) => result(id).issues.map((item) => item.code);
  const ordinary = [
    ...NODE_OPTION_HOLDS.map(([id, command]) => [id, command]),
    ...NODE_OPTION_DATA,
    ['node-neutral-tail', "node -e '1' --no-warnings --input-type=commonjs"],
    ['python-option-tail-data', "python3 -c '1' --require /not-executed.cjs"],
    ['bash-option-tail-data', "bash -c 'printf safe' --require /not-executed.cjs"],
    ...HARDENING_CODE.map(([id, command]) => [id, command]),
    ...HARDENING_REJECT.map(([id, command]) => [id, command]),
    ...HARDENING_STDIN.map(([id, command]) => [id, command]),
    ...HARDENING_NO_STDIN.map(([id, command]) => [id, command]),
    ['shell-stdin-mode', "bash -s <<'SH'\nprintf %s selected\nSH\n"],
    ['node-entry-stops-options', "node entry.js -e 'not code'"],
    ['node-end-stops-options', "node -- entry.js -e 'not code'"],
    ['python-prefix-is-data', "mypython3 -c '" + HARDENING_PYTHON_PAYLOAD + "'"],
    ['python-suffix-is-data', "python3-wrapper -c '" + HARDENING_PYTHON_PAYLOAD + "'"],
    ['descriptor-multidigit', 'printf x 2>&10'],
    ['descriptor-prefix-data', "printf x 2>&'1x'"],
    ['descriptor-suffix-data', "printf x 2>&'x1'"],
    ['descriptor-unknown', 'printf x 2>&"$FD"'],
    ['env-child-assignment-data', 'env A=x printf %s 9A=x'],
    ['here-string-data', "cat <<< 'a > b'"],
    ['nested-depth-eight', hardeningNested(8)],
    ['nested-depth-nine', hardeningNested(9)],
    ['issue-same-source', 'for I in a a; do node -e "$CODE"; done'],
    ['issue-distinct-source', 'node -e "$CODE"; node -e "$CODE"'],
    ['explicit-bash', 'printf x', 'bash'],
    ['unsupported-shell', 'printf x', 'zsh'],
    ['env-unsupported-name', "env 9A=x node -e '" + HARDENING_PAYLOAD + "'"],
    [
      'inherited-node-path',
      'node -e \'require("fs").readFileSync("input", "utf8")\'',
      undefined,
      { NODE_PATH: '/untrusted/node_modules' },
    ],
    [
      'inherited-node-path-nonbuiltin',
      'node -e \'require("untrusted-module")\'',
      undefined,
      { NODE_PATH: '/untrusted/node_modules' },
    ],
    [
      'inherited-node-options',
      "node -e 'console.log(1)'",
      undefined,
      { NODE_OPTIONS: '--require /must-not-execute.cjs' },
    ],
    ['inherited-empty-node-options', "node -e 'console.log(1)'", undefined, { NODE_OPTIONS: '' }],
    ['inherited-empty-coverage', "node -e '1'", undefined, { NODE_V8_COVERAGE: '' }],
    ...['NODE_V8_COVERAGE', 'NODE_COMPILE_CACHE', 'NODE_REDIRECT_WARNINGS', 'OPENSSL_CONF'].map(
      (name) => [
        'inherited-startup-' + name,
        "node -e '1'",
        undefined,
        { [name]: '/untrusted/output' },
      ]
    ),
    ...['NODE_OPTIONS', 'NODE_PATH', 'NODE_V8_COVERAGE', 'NODE_COMPILE_CACHE', 'OPENSSL_CONF'].map(
      (name) => [
        'rebound-startup-' + name,
        name + "='/untrusted/output'; node -e '1'",
        undefined,
        { [name]: '' },
      ]
    ),
    ...['NODE_ENV', 'NODE_NO_WARNINGS', 'NODE_DISABLE_COLORS', 'NODE_OPTIONS_DATA'].flatMap(
      (name) => [
        ['inherited-data-' + name, "node -e '1'", undefined, { [name]: '1' }],
        ['rebound-data-' + name, name + "='1'; node -e '1'", undefined, { [name]: '' }],
      ]
    ),
  ];
  beforeAll(() => {
    temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'caws-projection-roles-'));
    locations = {
      PROJECT: path.join(temporary, 'project'),
      FOREIGN: path.join(temporary, 'foreign'),
      META: path.join(temporary, 'metadata'),
      MARKER: path.join(temporary, 'must-not-exist'),
    };
    for (const directory of [locations.PROJECT, locations.FOREIGN, locations.META])
      fs.mkdirSync(directory);
    requests = ordinary.map(([id, command, shell, environment]) => ({
      id,
      environment,
      input: {
        command: expand(command),
        cwd: locations.PROJECT,
        project: locations.PROJECT,
        ...(shell ? { shell } : {}),
      },
    }));
    const context = {
      directory: fs.realpathSync.native(locations.META),
      common: fs.realpathSync.native(locations.META),
      worktree: fs.realpathSync.native(locations.PROJECT),
    };
    requests.push({
      id: 'metadata-routing-order',
      metadataResults: [context],
      input: {
        command: expand(
          "GIT_DIR='{{META}}' GIT_WORK_TREE='{{PROJECT}}' git add -- one; GIT_WORK_TREE='{{PROJECT}}' GIT_DIR='{{META}}' git add -- two"
        ),
        cwd: locations.PROJECT,
        project: locations.PROJECT,
      },
    });
    const active = String(
      globalThis.__stryker__?.activeMutant ?? process.env.__STRYKER_ACTIVE_MUTANT__ ?? ''
    );
    const child = spawnSync(
      process.execPath,
      [
        '-e',
        '(' + RUNNER + ')().catch(error=>{console.error(error);process.exitCode=1;})',
        path.resolve(__dirname, '../../dist/shell/analysis/mutation-view.js'),
        active,
      ],
      {
        input: JSON.stringify(requests),
        shell: false,
        encoding: 'utf8',
        timeout: 30000,
        maxBuffer: 8 * 1024 * 1024,
      }
    );
    if (child.error || child.status !== 0)
      throw new Error(
        JSON.stringify({ status: child.status, error: child.error?.message, stderr: child.stderr })
      );
    const batch = JSON.parse(child.stdout);
    expect(batch).toHaveLength(requests.length);
    for (const row of batch) expect(row.activeMutant).toBe(active);
    results = new Map(batch.map((row) => [row.id, row]));
  });
  afterAll(() => {
    if (temporary) fs.rmSync(temporary, { recursive: true, force: true });
  });
  test.each([
    ...['NODE_V8_COVERAGE', 'NODE_COMPILE_CACHE', 'NODE_REDIRECT_WARNINGS', 'OPENSSL_CONF'].map(
      (name) => 'inherited-startup-' + name
    ),
    ...['NODE_OPTIONS', 'NODE_PATH', 'NODE_V8_COVERAGE', 'NODE_COMPILE_CACHE', 'OPENSSL_CONF'].map(
      (name) => 'rebound-startup-' + name
    ),
  ])('%s cannot borrow the literal payload effects', (id) => {
    expect(issueCodes(id)).toContain('mutation-interpreter-effects');
    expect(result(id).interpreters).toHaveLength(1);
    expect(result(id).interpreters[0].effects).toEqual({
      kind: 'unresolved',
      profile: null,
      reason: 'Interpreter environment or startup effects are not proven.',
      writes: [],
    });
    if (id.startsWith('rebound-')) expect(issueCodes(id)).toContain('environment-change');
  });
  test.each([
    'inherited-empty-coverage',
    ...['NODE_ENV', 'NODE_NO_WARNINGS', 'NODE_DISABLE_COLORS', 'NODE_OPTIONS_DATA'].flatMap(
      (name) => ['inherited-data-' + name, 'rebound-data-' + name]
    ),
  ])('%s preserves the proven readonly payload', (id) => {
    expect(result(id).issues).toEqual([]);
    expect(result(id).interpreters[0].effects).toEqual({
      kind: 'readonly',
      profile: 'caws.node-source-effects.v1',
      writes: [],
    });
  });
  test.each(NODE_OPTION_HOLDS)(
    '%s cannot certify an incomplete Node option vector',
    (id, _command, code) => {
      expect(issueCodes(id)).toContain(code);
      expect(result(id).interpreters).toEqual([]);
      expect(result(id).interpreterInvocations).toHaveLength(1);
      expect(fs.existsSync(locations.MARKER)).toBe(false);
    }
  );
  test.each([...NODE_OPTION_DATA, ['node-neutral-tail']])(
    '%s preserves the selected source after an option boundary',
    (id) => {
      expect(result(id).issues).toEqual([]);
      expect(result(id).interpreters).toHaveLength(1);
      expect(result(id).interpreters[0].payloads[0].text).toBe('1');
      expect(result(id).interpreters[0].effects).toEqual({
        kind: 'readonly',
        profile: 'caws.node-source-effects.v1',
        writes: [],
      });
      expect(fs.existsSync(locations.MARKER)).toBe(false);
    }
  );
  test('Python and Bash code options keep following arguments as data', () => {
    expect(result('python-option-tail-data').interpreters[0].payloads[0].text).toBe('1');
    expect(issueCodes('python-option-tail-data')).toEqual(['mutation-interpreter-effects']);
    expect(result('bash-option-tail-data').issues).toEqual([]);
    expect(result('bash-option-tail-data').interpreters).toEqual([]);
    expect(fs.existsSync(locations.MARKER)).toBe(false);
  });
  test.each(HARDENING_CODE)(
    '%s keeps the actual finite executable payload',
    (id, _command, language, code, original) => {
      const actual = result(id);
      const unsupportedEffects = language === 'python' || id.startsWith('env-');
      expect(issueCodes(id)).toEqual(unsupportedEffects ? ['mutation-interpreter-effects'] : []);
      expect(actual.interpreters).toHaveLength(1);
      const interpreter = actual.interpreters[0];
      expect(interpreter.language).toBe(language);
      expect(interpreter.effects.kind).toBe(unsupportedEffects ? 'unresolved' : 'readonly');
      expect(interpreter.cwd).toBe(fs.realpathSync.native(locations.PROJECT));
      expect(interpreter.payloads).toHaveLength(1);
      const payload = interpreter.payloads[0];
      expect(payload.text).toBe(expand(code));
      expect(payload.origin).toBe('argument');
      expect(source(id).slice(payload.start, payload.end)).toBe(expand(original));
      expect(actual.tokens.filter((token) => token.kind.endsWith('redirect'))).toEqual([]);
      expect(fs.existsSync(locations.MARKER)).toBe(false);
    }
  );
  test('inherited module fallback paths do not override builtin-only source effects', () => {
    const actual = result('inherited-node-path');
    expect(actual.issues).toEqual([]);
    expect(actual.interpreters[0].effects).toEqual({
      kind: 'readonly',
      profile: 'caws.node-source-effects.v1',
      writes: [],
    });
    expect(actual.interpreters[0].payloads[0].text).toBe(
      'require("fs").readFileSync("input", "utf8")'
    );
    expect(issueCodes('inherited-node-path-nonbuiltin')).toEqual(['mutation-interpreter-effects']);
    expect(result('inherited-node-path-nonbuiltin').interpreters[0].effects.kind).toBe(
      'unresolved'
    );
  });
  test('nonempty inherited startup options remain unresolved and empty options preserve the profile', () => {
    expect(issueCodes('inherited-node-options')).toEqual(['mutation-interpreter-effects']);
    expect(result('inherited-node-options').interpreters[0].effects.kind).toBe('unresolved');
    expect(result('inherited-empty-node-options').issues).toEqual([]);
    expect(result('inherited-empty-node-options').interpreters[0].effects).toEqual({
      kind: 'readonly',
      profile: 'caws.node-source-effects.v1',
      writes: [],
    });
  });
  test.each(HARDENING_REJECT)(
    '%s refuses unsupported selection without attributing code',
    (id, _command, code, original) => {
      expect(issueCodes(id)).toContain(code);
      expect(result(id).interpreters).toEqual([]);
      const issue = result(id).issues.find((item) => item.code === code);
      expect(source(id).slice(issue.start, issue.end)).toBe(
        original === null ? source(id) : original
      );
    }
  );
  test.each(HARDENING_STDIN)('%s respects stdin descriptor ownership', (id, _command, body) => {
    expect(result(id).issues).toEqual([]);
    expect(result(id).interpreters).toHaveLength(1);
    const payloads = result(id).interpreters[0].payloads;
    expect(payloads).toHaveLength(1);
    expect(payloads[0].text).toBe(body);
    expect(payloads[0].origin).toBe('heredoc');
    expect(source(id).slice(payloads[0].start, payloads[0].end)).toBe(body);
  });
  test.each(HARDENING_NO_STDIN)(
    '%s cannot borrow a different descriptor or expanded body',
    (id, _command, code) => {
      expect(issueCodes(id)).toContain(code);
      expect(result(id).interpreters).toHaveLength(1);
      expect(result(id).interpreters[0].payloads).toEqual([]);
    }
  );
  test('shell stdin mode projects the body while entry-script operands stop option parsing', () => {
    expect(result('shell-stdin-mode').issues).toEqual([]);
    expect(
      result('shell-stdin-mode')
        .tokens.filter((token) => token.kind === 'word')
        .map((token) => token.value)
    ).toEqual(['bash', '-s', 'printf', '%s', 'selected']);
    for (const id of ['node-entry-stops-options', 'node-end-stops-options']) {
      expect(issueCodes(id)).toEqual(['mutation-interpreter-effects']);
      expect(result(id).interpreters).toHaveLength(1);
      expect(result(id).interpreters[0].payloads).toEqual([]);
      expect(result(id).interpreters[0].effects.kind).toBe('unresolved');
    }
    for (const id of ['python-prefix-is-data', 'python-suffix-is-data']) {
      expect(result(id).issues).toEqual([]);
      expect(result(id).interpreters).toEqual([]);
      expect(
        result(id).tokens.find((token) => token.value === expand(HARDENING_PYTHON_PAYLOAD)).kind
      ).toBe('word');
    }
  });
  test('descriptor duplication requires a whole numeric descriptor, not a numeric substring', () => {
    expect(result('descriptor-multidigit').issues).toEqual([]);
    for (const id of ['descriptor-prefix-data', 'descriptor-suffix-data', 'descriptor-unknown'])
      expect(issueCodes(id)).toContain('redirect-descriptor');
    for (const id of [
      'descriptor-multidigit',
      'descriptor-prefix-data',
      'descriptor-suffix-data',
      'descriptor-unknown',
    ])
      expect(result(id).tokens.filter((token) => token.kind.endsWith('redirect'))).toEqual([]);
    expect(result('here-string-data').issues).toEqual([]);
    const input = result('here-string-data').tokens.filter(
      (token) => token.kind === 'input_redirect'
    );
    expect(input.map((token) => token.value)).toEqual(['<<<']);
    expect(result('here-string-data').tokens.filter((token) => token.kind === 'redirect')).toEqual(
      []
    );
    const data = result('here-string-data').tokens.find((token) => token.value === 'a > b');
    expect(data.kind).toBe('word');
    expect(source('here-string-data').slice(data.start, data.end)).toBe("'a > b'");
  });
  test('nested source depth has a complete lower control and an explicit stopping boundary', () => {
    expect(result('nested-depth-eight').issues).toEqual([]);
    const targets = result('nested-depth-eight').tokens.filter(
      (token) => token.value === locations.FOREIGN + '/deep'
    );
    expect(targets).toHaveLength(1);
    expect(source('nested-depth-eight').slice(targets[0].start, targets[0].end)).toBe(
      "'" + locations.FOREIGN + "/deep'"
    );
    expect(issueCodes('nested-depth-nine')).toEqual(['mutation-view-budget']);
    expect(
      result('nested-depth-nine').tokens.filter(
        (token) => token.value === locations.FOREIGN + '/deep'
      )
    ).toEqual([]);
    const issue = result('nested-depth-nine').issues[0];
    expect(source('nested-depth-nine').slice(issue.start, issue.end)).toBe(
      "printf x > '" + locations.FOREIGN + "/deep'\n"
    );
  });
  test('issues are unique per source occurrence and distinct occurrences retain their own custody', () => {
    expect(issueCodes('issue-same-source')).toEqual(['mutation-code-source']);
    const repeated = result('issue-same-source').issues[0];
    expect(source('issue-same-source').slice(repeated.start, repeated.end)).toBe('"$CODE"');
    expect(issueCodes('issue-distinct-source')).toEqual([
      'mutation-code-source',
      'mutation-code-source',
    ]);
    const distinct = result('issue-distinct-source').issues;
    expect(
      distinct.map((item) => source('issue-distinct-source').slice(item.start, item.end))
    ).toEqual(['"$CODE"', '"$CODE"']);
    expect(distinct[0].start).toBeLessThan(distinct[1].start);
  });
  test('explicit shell dialect is carried into the actual analyzer', () => {
    expect(result('explicit-bash').issues).toEqual([]);
    expect(
      result('explicit-bash')
        .tokens.filter((token) => token.kind === 'word')
        .map((token) => token.value)
    ).toEqual(['printf', 'x']);
    expect(issueCodes('unsupported-shell')).toEqual(['shell-dialect']);
    expect(result('unsupported-shell').tokens).toEqual([]);
    expect(
      result('unsupported-shell').issues.map((item) =>
        source('unsupported-shell').slice(item.start, item.end)
      )
    ).toEqual(['printf x']);
  });
  test('routing-equivalent Git contexts share one query without losing either source observation', () => {
    const actual = result('metadata-routing-order');
    const directory = fs.realpathSync.native(locations.META);
    const worktree = fs.realpathSync.native(locations.PROJECT);
    expect(actual.issues).toEqual([]);
    expect(results.get('metadata-routing-order').queries).toEqual([
      { cwd: worktree, overrides: { GIT_DIR: directory, GIT_WORK_TREE: worktree } },
    ]);
    expect(
      actual.gitMetadata.map(({ subcommand, directory, common, worktree }) => ({
        subcommand,
        directory,
        common,
        worktree,
      }))
    ).toEqual(Array(2).fill({ subcommand: 'add', directory, common: directory, worktree }));
    expect(
      actual.gitMetadata.map((row) => source('metadata-routing-order').slice(row.start, row.end))
    ).toEqual(source('metadata-routing-order').split('; '));
  });
  test('unsupported env names do not hide a known interpreter behind a fictitious application', () => {
    expect(issueCodes('env-unsupported-name')).toContain('mutation-wrapper-option');
    expect(result('env-unsupported-name').interpreters).toEqual([]);
    expect(fs.existsSync(locations.MARKER)).toBe(false);
  });
  test('assignment-shaped child data cannot be consumed by the env wrapper', () => {
    const actual = result('env-child-assignment-data');
    expect(actual.issues).toEqual([]);
    expect(actual.interpreters).toEqual([]);
    const data = actual.tokens.filter((token) => token.value === '9A=x');
    expect(data).toHaveLength(1);
    expect(data[0].kind).toBe('word');
    expect(source('env-child-assignment-data').slice(data[0].start, data[0].end)).toBe('9A=x');
  });
});
