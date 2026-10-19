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
  for (const request of input)
    output.push({
      id: request.id,
      activeMutant: process.env.__STRYKER_ACTIVE_MUTANT__ ?? '',
      view: await projectMutationView(request.input),
    });
  process.stdout.write(JSON.stringify(output));
});
const CASES = [
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
];
describe('mutation view uses shared traversal without granting scope', () => {
  let root, locations, requests, views;
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
    requests = CASES.map(([id, command]) => ({
      id,
      input: {
        command: expand(command),
        cwd: id.startsWith('unknown-cwd-') ? null : locations.PROJECT,
        project: locations.PROJECT,
      },
    }));
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
    expect(batch).toHaveLength(CASES.length);
    for (const item of batch) expect(item.activeMutant).toBe(active);
    views = new Map(batch.map((item) => [item.id, item.view]));
  });
  afterAll(() => {
    if (root) fs.rmSync(root, { recursive: true, force: true });
  });
  test.each(CASES)('%s preserves source spans and the non-authoritative carrier', (id) => {
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
    for (const item of [...actual.tokens, ...actual.issues, ...actual.interpreters]) {
      expect(Number.isInteger(item.start)).toBe(true);
      expect(item.start).toBeGreaterThanOrEqual(0);
      expect(item.end).toBeGreaterThanOrEqual(item.start);
      expect(item.end).toBeLessThanOrEqual(command.length);
    }
  });
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
  ])('%s exposes unresolved facts', (id, code) => expect(codes(id)).toContain(code));
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
});
