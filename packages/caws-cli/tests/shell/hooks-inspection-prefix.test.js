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
  fs.copyFileSync(
    path.join(pkg, 'dist/shell/duration.js'),
    path.join(path.dirname(analysis), 'duration.js')
  );
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

// These strings are inert classification/projection input, never shell actions.
const cawsReaders = [
  'caws specs show EXAMPLE-001 --data --archived',
  '/opt/reviewed/bin/caws specs recover OTHER-42',
  'caws specs list --status active --archived',
  'caws specs list --lifecycle closed',
  'caws specs list --state draft --session-id another-session',
  'caws specs list --active',
  'caws specs list --draft',
  'caws specs list --closed',
  'caws specs --status archived --data',
  'caws specs verify-acs OTHER-42 --strict --runner=node --json',
  'caws specs validate "spec inputs/spec.yaml" --data',
  'caws scope show "src/a b.ts" --spec OTHER-42 --json',
  'caws scope check -- --output=literal',
  'caws scope plan --path "a b" --path other --spec OTHER-42 --json',
  'caws scope plan --paths-file "input paths.txt"',
  'caws scope contention "src/a b.ts" --json',
  'caws status --specs --worktrees --agents --doctor --json',
  'caws status -h',
  'caws status --help',
  'caws doctor --repair-plan --json --data',
  'caws worktree list --json',
  'caws worktree review another-lane --json',
  'caws gates list --spec OTHER-42 --json',
  'caws gates explain scope_boundary --data',
  'caws evidence list --spec OTHER-42 --type human_decision --json',
  'caws evidence show 12 --data',
  'caws evidence schema --type ac --json',
  'caws events list --limit=0 --json',
  'caws events show latest-rotation --data',
  'caws events verify-archive',
  'caws waiver list --include-revoked --include-expired',
  'caws waiver show waiver-1',
  'caws reprieve list --surface codex --json',
  'caws reprieve show --current --surface codex --json',
  'caws agents list --include-stale --stale-ttl 1h30m --json',
  'caws agents list --active --stale-ttl-ms 10',
  'caws agents list --stale-ttl 0s',
  'caws agents show another-session --stale-ttl-ms 1000 --data',
  'caws working-tree check --json',
  'caws goal show --data',
  'caws message inbox --all --limit 10 --json',
  'caws message history --with other-session --limit 5 --json',
  'caws message status message-id --json',
  'caws message status --id message-id',
  'caws message status --mine --queued --older-than 2h --json',
];
const cawsRejected = [
  'caws claim',
  'caws specs create OTHER-42',
  'caws specs close OTHER-42',
  'caws worktree create other',
  'caws worktree repair',
  'caws worktree merge other --dry-run',
  'caws init --overwrite --force',
  'caws gates run --spec OTHER-42',
  'caws message poll',
  'caws working-tree ack --session other',
  'caws agents heartbeat',
  'caws hooks compile',
  'caws init --plan',
  'caws specs unknown OTHER-42',
  'caws unknown --help',
  'caws status --output file',
  'caws status --json=false',
  'caws status extra',
  'caws status --short --short',
  'caws specs show',
  'caws specs validate',
  'caws specs show OTHER-42 extra',
  'caws specs show ""',
  'caws specs show "invalid id"',
  'caws specs show ../../file',
  'caws specs show OTHER-42 --unknown',
  'caws specs list --status unknown',
  'caws specs list --state',
  'caws specs list --status active --lifecycle draft',
  'caws specs recover OTHER-42 --out file',
  'caws specs recover OTHER-42 --out=file',
  'caws specs verify-acs OTHER-42 --run',
  'caws specs verify-acs OTHER-42 --runner nope',
  'caws scope show',
  'caws scope check path --spec',
  'caws scope plan',
  'caws events list --limit nope',
  'caws events list --limit -1',
  'caws events list --limit 9007199254740992',
  'caws events list --limit=',
  'caws events show nonsense',
  'caws evidence list',
  'caws evidence schema --type invalid',
  'caws agents show',
  'caws agents list --stale-ttl nonsense',
  'caws agents list --stale-ttl 9007199254740992d',
  'caws agents list --stale-ttl 1h --stale-ttl-ms 1',
  'caws message history',
  'caws message status',
  'caws message status --mine',
  'caws message status --queued',
  'caws message status message-id --older-than 1h',
  'caws message status --mine --queued --older-than 1h --older-than-ms 1',
  'caws reprieve show --current --session other',
  'caws doctor --json',
  './caws status',
  '../caws status',
  '/opt/caws.js status',
  '/opt//caws status',
  '/opt/../caws status',
  '/opt/caws/ status',
  'env caws status',
  'command caws status',
  'CAWS_HOME=/tmp caws status',
  'caws() { echo changed; }',
  'alias caws=sh',
  'hash -p /bin/sh caws',
  'caws status > output',
  'caws status < input',
  'caws status; pwd',
  'caws specs show "$id"',
  'caws specs show $(touch marker)',
];

describe('CAWS literal read routes', () => {
  test.each(cawsReaders)('workflow reader %s', (command) => {
    expect(invoke(command + '\n')).toEqual({ status: 0, stdout: allow });
  });
  test.each(cawsRejected)('workflow refusal %s', (command) => {
    expect(invoke(command + '\n')).toEqual({ status: 1, stdout: unsupported });
  });
  test.each([
    'caws specs show EXAMPLE-001',
    '/opt/reviewed/bin/caws specs show EXAMPLE-001 --archived',
    'caws scope check "src/a b.ts" --spec EXAMPLE-001 --json',
    'caws status --short',
    'caws doctor --repair-plan --json',
  ])('admits catalog-backed %s', (command) => {
    expect(invoke(command + '\n')).toEqual({ status: 0, stdout: allow });
  });
  test.each([
    'caws specs recover EXAMPLE-001 --out file',
    'caws specs verify-acs EXAMPLE-001 --run',
    'caws specs show',
    'caws specs show EXAMPLE-001 --unknown',
  ])('declines effects or invalid shape %s', (command) => {
    expect(invoke(command + '\n')).toEqual({ status: 1, stdout: unsupported });
  });
});

describe('shared CAWS command authority', () => {
  const purePath = path.join(pkg, 'dist/shell/analysis/caws-read-metadata.js');
  const { CAWS_READ_COMMANDS, isCawsReadInvocation } = require(purePath);
  test('every reviewed data operand has an explicit role and every option has an effect', () => {
    for (const definition of Object.values(CAWS_READ_COMMANDS)) {
      expect(definition.effect).toBe('read');
      for (const option of definition.options) {
        expect(['read', 'write', 'execute']).toContain(option.effect);
        if (option.flag.includes('<')) expect(typeof option.valueRole).toBe('string');
      }
      for (const argument of definition.arguments ??
        (definition.argument ? [definition.argument] : [])) {
        expect(typeof argument.valueRole).toBe('string');
      }
    }
  });
  test('registration consumes every reviewed leaf object and its option arity', () => {
    const { COMMAND_SURFACE_METADATA } = require('../../dist/shell/command-metadata');
    const { registerShellCommands } = require('../../dist/shell/register');
    const { Command } = require('commander');
    const program = new Command('caws');
    registerShellCommands(program, { exit: () => {} });
    for (const [route, definition] of Object.entries(CAWS_READ_COMMANDS)) {
      let catalog = COMMAND_SURFACE_METADATA;
      let meta,
        registered = program;
      for (const name of route.split(' ')) {
        meta = catalog.find((item) => item.name === name);
        expect(meta).toBeDefined();
        catalog = meta.subcommands ?? [];
        registered = registered.commands.find((command) => command.name() === name);
        expect(registered).toBeDefined();
      }
      if (route === 'specs') expect(meta.options).toBe(definition.options);
      else expect(meta).toBe(definition);
      for (const option of definition.options) {
        expect(registered.options.find((item) => item.flags === option.flag)).toBeDefined();
      }
      const declared = definition.arguments ?? (definition.argument ? [definition.argument] : []);
      expect(registered.registeredArguments.map((item) => [item.name(), item.required])).toEqual(
        declared.map((item) => [item.name, item.required])
      );
    }
  });
  test('future flags share registration but need an explicit read effect and valid operand', () => {
    const { registerShellCommands } = require('../../dist/shell/register');
    const { Command } = require('commander');
    const future = {
      flag: '--future-count <n>',
      description: 'Test-only declaration',
      valueRole: 'integer',
    };
    const options = CAWS_READ_COMMANDS.status.options;
    options.push(future);
    try {
      const program = new Command('caws');
      registerShellCommands(program, { exit: () => {} });
      expect(
        program.commands
          .find((item) => item.name() === 'status')
          .options.some((item) => item.flags === future.flag)
      ).toBe(true);
      expect(isCawsReadInvocation(['caws', 'status', '--future-count', '3'])).toBe(false);
      future.effect = 'read';
      expect(isCawsReadInvocation(['caws', 'status', '--future-count', '3'])).toBe(true);
      expect(isCawsReadInvocation(['caws', 'status', '--future-count'])).toBe(false);
      expect(isCawsReadInvocation(['caws', 'status', '--future-count', 'nope'])).toBe(false);
      future.effect = 'execute';
      expect(isCawsReadInvocation(['caws', 'status', '--future-count', '3'])).toBe(false);
      future.effect = 'read';
      for (const flag of [
        '--future-count [n]',
        '--future-count <n> <extra>',
        '--future-count <n...>',
      ]) {
        future.flag = flag;
        expect(isCawsReadInvocation(['caws', 'status', '--future-count', '3'])).toBe(false);
      }
    } finally {
      options.pop();
    }
  });
  test('pure metadata has no runtime dependency on the catalog, store or lifecycle', () => {
    const child = spawnSync(
      process.execPath,
      [
        '-e',
        'require(process.argv[1]);console.log(JSON.stringify(Object.keys(require.cache)))',
        purePath,
      ],
      { cwd: root, encoding: 'utf8', shell: false }
    );
    expect(child.status).toBe(0);
    expect(child.stderr).toBe('');
    expect(JSON.parse(child.stdout).sort()).toEqual(
      [purePath, path.join(pkg, 'dist/shell/duration.js')].sort()
    );
  });
});

// The unchanged original07 is inert fixture data. It is never executed.
const original07 = String.raw`/Users/darianrosebrook/.codex/artifacts/01a171b1-ff30-7782-9755-aa02c6c6a3ae/local-rust-cutover-06/bin/caws specs show NATIVE-BOOTSTRAP-001
node <<'NODE'
const fs=require('fs');const rows=fs.readFileSync('.caws/events.jsonl','utf8').trim().split('\n').map(x=>JSON.parse(x));const matches=rows.filter(x=>JSON.stringify(x).includes('NATIVE-BOOTSTRAP-001')&&JSON.stringify(x).includes('ac_recorded'));console.log('matchingAcRecorded',JSON.stringify(matches));
NODE`;
describe('CAWS reader body-only projection', () => {
  test('unchanged original05 preserves its pinned command and body-only projection', () => {
    const input =
      "git diff -- .gitignore\ncat .caws/policy.yaml\nnode <<'NODE'\nconst fs=require('fs'),p=require('path'),c=require('crypto');const m=JSON.parse(fs.readFileSync('/Users/darianrosebrook/.codex/artifacts/01a17941-cbb6-7b92-b5c7-0ba8f5f238d3/native-agent-workflow-02/fixture-inputs.json'));for(const f of m.files.filter(f=>f.path!=='.gitignore')){const b=fs.readFileSync(f.path),h=c.createHash('sha256').update(b).digest('hex');console.log(JSON.stringify({path:f.path,bytes:b.length,sha256:h,match:b.length===f.bytes&&h===f.sha256}));}for(const name of ['.gitignore','.caws/policy.yaml']) {const b=fs.readFileSync(name);console.log('bootstrapBaseline',JSON.stringify({path:name,bytes:b.length,sha256:c.createHash('sha256').update(b).digest('hex')}));}\nNODE";
    expect(Buffer.byteLength(input)).toBe(747);
    expect(require('node:crypto').createHash('sha256').update(input).digest('hex')).toBe(
      '25a3c1015068419cede8e31a58a8193e65118a1d3f5ae2c5c889a9fae5d65d8a'
    );
    const prefix = input.slice(0, input.indexOf("node <<'NODE'"));
    const f = fixture();
    expect(invoke(prefix)).toEqual({ status: 0, stdout: allow });
    for (const ending of ['', '\n', '\n\n']) {
      const output = project(f, input + ending);
      expect(output).toBe(prefix + "node <<'NODE'\n\nNODE" + ending);
      expect(output.split('\n')).toHaveLength((input + ending).split('\n').length);
    }
  });
  test('unchanged original07 has pinned bytes and projects only its Node body', () => {
    expect(Buffer.byteLength(original07)).toBe(461);
    expect(require('node:crypto').createHash('sha256').update(original07).digest('hex')).toBe(
      '59daf34c7c27febaa466d9f16eeacc198d4febed4a104704c68b89ccc414f74c'
    );
    const f = fixture();
    const prefix = original07.slice(0, original07.indexOf('\n')) + '\n';
    expect(invoke(prefix)).toEqual({ status: 0, stdout: allow });
    const output = project(f, original07);
    expect(output).toBe(prefix + "node <<'NODE'\n\nNODE");
    expect(output.split('\n')).toHaveLength(original07.split('\n').length);
  });
  test('the entire reader matrix preserves prefix, delimiter, suffix and line counts', () => {
    const f = fixture();
    for (const command of cawsReaders) {
      for (const ending of ['', '\n', '\n\n']) {
        const prefix = command + '\n';
        const input = prefix + "node <<'N'\nconst rows = x.map(x=>JSON.parse(x));\nN" + ending;
        const output = project(f, input);
        expect(output).toBe(prefix + "node <<'N'\n\nN" + ending);
        expect(output.split('\n')).toHaveLength(input.split('\n').length);
      }
    }
  });
  test('every rejected matrix prefix retains the raw body and protocol', () => {
    const f = fixture();
    for (const command of cawsRejected) {
      const input = command + "\nnode <<'N'\nconst rows = x.map(x=>JSON.parse(x));\nN\n";
      expect(project(f, input)).toBe(input);
    }
  });
});

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

describe('Git show presentation role', () => {
  const { inspectGitOptions } = require('../../dist/shell/analysis/inspection-profiles.js');
  const prefix = 'git rev-parse HEAD\ngit show --stat --oneline HEAD\ngit status --short\n';
  test('the exact oneline flag admits the single query and actual06 newline prefix', () => {
    expect(invoke('git show --stat --oneline HEAD\n')).toEqual({ status: 0, stdout: allow });
    expect(invoke(prefix)).toEqual({ status: 0, stdout: allow });
    const issues = [];
    expect(
      inspectGitOptions('show', ['--stat', '--oneline', 'HEAD'], (code) => issues.push(code))
    ).toEqual(['--stat', '--oneline']);
    expect(issues).toEqual([]);
  });
  test.each(['--output=target', '--ext-diff', '--textconv'])(
    'following %s retains its own role and the Node body',
    (next) => {
      const issues = [];
      expect(
        inspectGitOptions('show', ['--stat', '--oneline', next, 'HEAD'], (code) =>
          issues.push(code)
        )
      ).toEqual(['--stat', '--oneline', next]);
      expect(issues).toEqual(next.startsWith('--output=') ? ['git-option-unmodeled'] : []);
      const input = `git show --stat --oneline ${next} HEAD\n`;
      expect(invoke(input)).toEqual({ status: 1, stdout: unsupported });
      const f = fixture(),
        body = input + "node <<'N'\nconst f=x=>x;\nN\n";
      expect(project(f, body)).toBe(body);
    }
  );
  test.each(['--oneline=unexpected', '--unknown-presentation'])(
    'unmodeled %s is not admitted',
    (flag) => {
      expect(invoke(`git show --stat ${flag} HEAD\n`)).toEqual({ status: 1, stdout: unsupported });
    }
  );
  test('literal path operands after -- do not acquire option roles', () => {
    expect(
      invoke('git show --stat --oneline HEAD -- --output=literal --ext-diff --textconv\n')
    ).toEqual({ status: 0, stdout: allow });
  });
  test('actual06 prefix and representative body preserve exact surrounding bytes', () => {
    const f = fixture();
    for (const ending of ['', '\n', '\n\n']) {
      const input =
        prefix +
        "node <<'NODE'\nconst fs=require('fs'),c=require('crypto');const rows=[{path:'file'}].filter(f=>f.path!=='.gitignore').map(f=>f.path);\nNODE" +
        ending;
      expect(project(f, input)).toBe(prefix + "node <<'NODE'\n\nNODE" + ending);
    }
  });
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
