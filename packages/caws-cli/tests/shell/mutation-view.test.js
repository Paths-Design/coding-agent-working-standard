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
    Object.assign(process.env, request.environment || {});
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
    'node --print=\'(() => "a > b")()\'',
    'node',
    '(() => "a > b")()',
    '--print=\'(() => "a > b")()\'',
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
      expect(actual.schema).toBe('caws.shell_mutation_view.v1');
      expect(Object.hasOwn(actual, 'decision')).toBe(false);
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
      expect(view(id).issues).toEqual([]);
      expect(view(id).tokens.filter((token) => token.kind === 'redirect')).toEqual([]);
      expect(view(id).interpreters).toHaveLength(1);
      expect(view(id).interpreters[0].language).toBe('node');
      expect(view(id).interpreters[0].argv[0]).toBe('node');
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
      expect(actual.issues).toEqual([]);
      expect(actual.tokens.filter((token) => token.kind === 'redirect')).toEqual([]);
      expect(actual.interpreters).toHaveLength(1);
      expect(actual.interpreters[0].language).toBe(language);
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
