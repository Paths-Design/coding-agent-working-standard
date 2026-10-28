'use strict';
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawnSync } = require('node:child_process');
const pkg = path.resolve(__dirname, '../..');
const entry = path.join(pkg, 'dist/shell/analysis/inspection-prefix-entry.js');
const cli = path.join(pkg, 'dist/index.js');
const allow = 'caws.inspection-prefix.v1:allow\n';
const unsupported = 'caws.inspection-prefix.v1:unsupported\n';
const failure = 'caws.inspection-prefix.v1:error\n';
jest.setTimeout(30000);
let root,
  sequence = 0,
  baseNode;
beforeAll(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'caws-prefix-'));
  baseNode = path.join(root, 'node-copy');
  fs.copyFileSync(process.execPath, baseNode);
});
afterAll(() => fs.rmSync(root, { recursive: true, force: true }));
function invoke(input, diagnostic = false, selected = entry) {
  const child = spawnSync(
    process.execPath,
    diagnostic ? [cli, 'hooks', 'inspection-prefix'] : [selected],
    {
      input,
      encoding: 'utf8',
      cwd: root,
      timeout: 8000,
      shell: false,
    }
  );
  if (child.error) throw child.error;
  expect(child.signal).toBeNull();
  expect(child.stderr).toBe('');
  return { status: child.status, stdout: child.stdout };
}
function fixture() {
  const digest = 'a'.repeat(64);
  const generation = path.join(root, String(++sequence), 'machine/lib/runtimes', digest);
  const lib = path.join(generation, 'lib/heredoc.sh');
  const modules = path.join(generation, 'native-prefix/node_modules');
  const analysis = path.join(modules, '@paths.design/caws-cli/dist/shell/analysis');
  fs.mkdirSync(path.dirname(lib), { recursive: true });
  fs.copyFileSync(path.join(pkg, 'templates/hook-packs/shared/lib/heredoc.sh'), lib);
  fs.mkdirSync(path.join(generation, 'native'), { recursive: true });
  // Hardlink only the disposable fixture copy, never the host executable.
  fs.linkSync(baseNode, path.join(generation, 'native/node'));
  fs.mkdirSync(path.dirname(analysis), { recursive: true });
  fs.cpSync(path.join(pkg, 'dist/shell/analysis'), analysis, { recursive: true });
  const parserRoot = path.dirname(path.dirname(require.resolve('unbash')));
  fs.cpSync(parserRoot, path.join(modules, 'unbash'), { recursive: true });
  return {
    generation,
    digest,
    lib,
    analysis,
    entry: path.join(analysis, 'inspection-prefix-entry.js'),
  };
}
const raw =
  "git diff -- .gitignore\ncat '.caws/policy.yaml'\nnode <<'NODE'\nconst rows = ['1'].map(l=>JSON.parse(l));\nNODE\n\n";
const projected = "git diff -- .gitignore\ncat '.caws/policy.yaml'\nnode <<'NODE'\n\nNODE\n\n";
function project(f, input = raw, env = {}, lib = f.lib) {
  const child = spawnSync(
    '/bin/bash',
    ['-eu', '-o', 'pipefail', '-c', 'source "$1"; caws_blank_heredoc_bodies "$2"', '_', lib, input],
    {
      encoding: 'utf8',
      cwd: root,
      shell: false,
      timeout: 8000,
      env: {
        ...process.env,
        CAWS_SHARED_LIB_DIR: path.dirname(f.lib),
        CAWS_ADAPTER_RUNTIME_DIGEST: f.digest,
        ...env,
      },
    }
  );
  if (child.error) throw child.error;
  expect(child.status).toBe(0);
  expect(child.signal).toBeNull();
  expect(child.stderr).toBe('');
  return child.stdout;
}

describe('Git optional unified-count roles', () => {
  const { inspectGitOptions } = require('../../dist/shell/analysis/inspection-profiles.js');
  const hostile = ['-U', '--unified'].flatMap((option) =>
    ['--output=target', '--ext-diff'].map((next) => [option, next])
  );
  test.each(hostile)('%s does not consume following %s', (option, next) => {
    const issues = [];
    expect(inspectGitOptions('diff', [option, next], (code) => issues.push(code))).toEqual([
      option,
      next,
    ]);
    expect(issues).toEqual(next.startsWith('--output=') ? ['git-option-unmodeled'] : []);
    expect(invoke(`git diff ${option} ${next}\n`)).toEqual({ status: 1, stdout: unsupported });
  });
  test.each(['-U', '-U3', '--unified', '--unified=3'])(
    '%s remains a readonly count flag',
    (option) => {
      expect(invoke(`git diff ${option}\n`)).toEqual({ status: 0, stdout: allow });
      expect(invoke(`git diff ${option} -- --output=literal --ext-diff\n`)).toEqual({
        status: 0,
        stdout: allow,
      });
    }
  );
  test('required Git data operands keep their distinct role', () => {
    const issues = [];
    expect(
      inspectGitOptions('log', ['--grep', '--ext-diff', '--oneline'], (code) => issues.push(code))
    ).toEqual(['--oneline']);
    expect(issues).toEqual([]);
  });
  test.each(hostile)('%s followed by %s retains the Node body', (option, next) => {
    const f = fixture();
    const input = `git diff ${option} ${next}\n` + "node <<'N'\nconst f=x=>x;\nN\n";
    expect(project(f, input)).toBe(input);
  });
  test.each(['-U', '-U3', '--unified', '--unified=3'])(
    '%s permits body-only projection with literal path data',
    (option) => {
      const f = fixture();
      const prefix = `git diff ${option} -- --output=literal --ext-diff\n`;
      expect(project(f, prefix + "node <<'N'\nconst f=x=>x;\nN\n")).toBe(
        prefix + "node <<'N'\n\nN\n"
      );
    }
  );
});

describe('pure structural inspection prefix', () => {
  test.each([
    'git diff -- .gitignore\ncat .caws/policy.yaml\n',
    'pwd -P\ngit rev-parse --show-toplevel\ngit rev-parse HEAD\ngit branch --show-current\ngit status --short\ncat AGENTS.md\n',
    'git --no-pager log -n 2 --oneline\ngit show --stat HEAD\ngit ls-files --cached\ngit ls-tree --name-only HEAD\n',
    'cat -- "file with spaces" other-file\nhead -n 3 -- file\ntail -c 12 file\nwc -l file\nls -lah ./docs\n',
    "rg -n -e '--pre=literal data' --glob '*.ts' src\ngrep -F -e '--output=data' -- file\n",
    "cut -d ':' -f 1 file\ntr -d 'x'\nsort -k 1,2 -r file\nuniq -c file\n",
    "sed -n '1,5p;6q' 'file with spaces'\nsed -e '2d' -e '$=' file\n",
    'pwd\npwd -L\ncat -\ngit status --short extra\n',
    "cat 'a; b > c'\nrg -e '$literal' -- file\n",
    "cat 'café/資料.txt'\n",
  ])('admits literal role-correct input %s', (input) => {
    expect(invoke(input)).toEqual({ status: 0, stdout: allow });
  });
  test('diagnostic command uses the same pure protocol outside a repository', () => {
    expect(invoke('git diff -- .gitignore\ncat "a b"\n', true)).toEqual({
      status: 0,
      stdout: allow,
    });
    expect(fs.existsSync(path.join(root, '.caws'))).toBe(false);
  });
  test.each([
    '',
    'echo plaintext\n',
    'unknown file\n',
    'caws claim\n',
    'caws claim --plan --spec X\n',
    'caws anything --help\n',
    'alias node=sh\n',
    'node() { sh; }\n',
    'function node { sh; }\n',
    'hash -p /bin/sh node\n',
    'enable -f x node\n',
    'eval pwd\n',
    'source file\n',
    'PATH=/tmp pwd\n',
    'DATA=x\n',
    'command cat file\n',
    'env cat file\n',
    'pwd; cat file\n',
    'pwd && cat file\n',
    'pwd | cat\n',
    'pwd &\n',
    '(pwd)\n',
    'if true; then pwd; fi\n',
    'cat file > target\n',
    'cat < input\n',
    'cat "$file"\n',
    'cat $(touch marker)\n',
    'cat `pwd`\n',
    'cat <(pwd)\n',
    'cat *.ts\n',
    'cat ~/file\n',
    'cat {a,b}\n',
    'cat file\\\nname\n',
    'pwd # comment\n',
    'rg --pre helper file\n',
    'rg --hostname-bin=helper x\n',
    'sort --compress-program helper file\n',
    'sort -o output input\n',
    'uniq input output\n',
    "sed '1p; w output' file\n",
    "sed 'e echo x' file\n",
    "sed 's/a/b/e' file\n",
    'sed -i file\n',
    'sed -f script file\n',
    'git -C /tmp status --short\n',
    'git -c alias.x=evil status\n',
    'git --git-dir=/tmp status\n',
    'git --paginate diff\n',
    'git diff --output=result\n',
    'git diff --ext-diff\n',
    'git show --textconv\n',
    'git branch other\n',
    'git branch --list\n',
    '\ufeffpwd\n',
  ])('declines unsupported syntax/roles %s', (input) => {
    const result = invoke(input);
    expect(result).toEqual({ status: 1, stdout: unsupported });
  });
  test.each([
    ['unterminated quote', 'cat "'],
    ['NUL', 'cat x\0'],
    ['UTF8', Buffer.from([0xff])],
    ['bytes', 'x'.repeat(32769)],
    ['commands', 'cat f\n'.repeat(65)],
    ['AST', 'cat ' + "'f' ".repeat(2200)],
  ])('%s parse/resource failure has status2', (_label, input) => {
    expect(invoke(input)).toEqual({ status: 2, stdout: failure });
  });
  test('submitted source never executes', () => {
    const marker = path.join(root, 'executed');
    expect(invoke('cat $(touch ' + marker + ')\n').status).toBe(1);
    expect(fs.existsSync(marker)).toBe(false);
  });
});

describe('physical managed-generation binding', () => {
  test('only SP/TAB/LF prefixes are empty; unsupported control bytes retain raw without binding', () => {
    const f = fixture();
    fs.unlinkSync(f.entry);
    for (const prefix of ['\r\n', '\v\n', '\f\n']) {
      const input = prefix + "node <<'N'\nconst f=x=>x;\nN";
      expect(project(f, input)).toBe(input);
    }
    expect(project(f, " \t\nnode <<'N'\nconst f=x=>x;\nN")).toBe(" \t\nnode <<'N'\n\nN");
  });
  test('compiled entry/parser and exact surrounding bytes are selected', () => {
    const f = fixture();
    expect(project(f)).toBe(projected);
    expect(project(f, '\ufeff' + raw)).toBe('\ufeff' + raw);
    expect(project(f, "cat 'café/資料.txt'\n" + raw)).toBe("cat 'café/資料.txt'\n" + projected);
    const prefix = 'git diff -- .gitignore\ncat ".caws/policy.yaml"\n';
    for (const trailing of ['', '\n', '\n\n']) {
      const body = prefix + "node <<'N'\nconst f = x => x;\nN" + trailing;
      expect(project(f, body)).toBe(prefix + "node <<'N'\n\nN" + trailing);
    }
  });
  test('ambient CLI, PATH and all startup write/preload controls cannot select authority', () => {
    const f = fixture(),
      marker = path.join(root, 'startup-executed');
    const poison = path.join(root, 'preload.cjs');
    fs.writeFileSync(poison, 'require("fs").writeFileSync(' + JSON.stringify(marker) + ',"bad");');
    const fake = path.join(root, 'fake-bin');
    fs.mkdirSync(fake);
    const script = '#!/bin/sh\nprintf "caws.inspection-prefix.v1:allow\\n"\ntouch ' + marker + '\n';
    fs.writeFileSync(path.join(fake, 'node'), script, { mode: 0o755 });
    fs.writeFileSync(path.join(fake, 'caws'), script, { mode: 0o755 });
    const writes = path.join(root, 'startup-writes');
    expect(
      project(f, raw, {
        CAWS_BIN: path.join(fake, 'caws'),
        PATH: fake,
        NODE_OPTIONS: '--require ' + poison,
        NODE_PATH: fake,
        NODE_V8_COVERAGE: writes,
        NODE_COMPILE_CACHE: writes,
        NODE_REDIRECT_WARNINGS: writes,
        NODE_REPL_EXTERNAL_MODULE: poison,
        NODE_REPL_HISTORY: writes,
        NODE_ICU_DATA: fake,
        OPENSSL_CONF: poison,
        OPENSSL_ENGINES: fake,
      })
    ).toBe(projected);
    expect(fs.existsSync(marker)).toBe(false);
    expect(fs.existsSync(writes)).toBe(false);
  });
  test('project override with forged sibling success cannot borrow the selected generation', () => {
    const selected = fixture(),
      fake = fixture();
    fs.writeFileSync(fake.entry, 'process.stdout.write(' + JSON.stringify(allow) + ');');
    expect(project(selected, raw, {}, fake.lib)).toBe(raw);
    expect(project(selected, raw, { CAWS_ADAPTER_RUNTIME_DIGEST: 'b'.repeat(64) })).toBe(raw);
    const standalone = path.join(root, 'override-heredoc.sh');
    fs.copyFileSync(selected.lib, standalone);
    expect(project(selected, raw, {}, standalone)).toBe(raw);
  });
  test.each(['missing', 'old', 'malformed', 'nul', 'large', 'signal', 'parser-missing'])(
    '%s entry/runtime retains raw',
    (kind) => {
      const f = fixture();
      if (kind === 'missing') fs.unlinkSync(f.entry);
      if (kind === 'old') fs.writeFileSync(f.entry, 'process.exit(0);');
      if (kind === 'malformed')
        fs.writeFileSync(f.entry, 'process.stdout.write(' + JSON.stringify(allow + '\n') + ');');
      if (kind === 'nul')
        fs.writeFileSync(f.entry, 'process.stdout.write(' + JSON.stringify(allow + '\0') + ');');
      if (kind === 'large') fs.writeFileSync(f.entry, 'process.stdout.write("x".repeat(10000));');
      if (kind === 'signal') fs.writeFileSync(f.entry, 'process.kill(process.pid,"SIGTERM");');
      if (kind === 'parser-missing')
        fs.rmSync(path.join(f.generation, 'native-prefix/node_modules/unbash'), {
          recursive: true,
        });
      expect(project(f)).toBe(raw);
      expect(project(f, "node <<'N'\nconst f = x => x;\nN")).toBe("node <<'N'\n\nN");
    }
  );
  test('a blocking parser is terminated by the supervisor wall clock, preserving raw', () => {
    const f = fixture();
    fs.writeFileSync(
      path.join(f.analysis, 'load-parser.js'),
      'exports.loadParser=async()=>({parse(){for(;;){}}});'
    );
    const start = Date.now();
    expect(project(f)).toBe(raw);
    expect(Date.now() - start).toBeLessThan(7000);
  });
  test.each([
    ['commands', 'cat f\n'.repeat(65)],
    ['AST', 'cat ' + "'f' ".repeat(2200) + '\n'],
    ['bytes', 'cat ' + 'f'.repeat(32769) + '\n'],
  ])('%s budget preserves raw', (_label, prefix) => {
    const f = fixture();
    const input = prefix + "node <<'N'\nconst f=x=>x;\nN";
    expect(project(f, input)).toBe(input);
  });
});
