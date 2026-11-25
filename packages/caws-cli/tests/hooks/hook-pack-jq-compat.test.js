'use strict';

/**
 * CAWS-GUARD-JQ-16-COMPAT-001: shipped hook programs run on jq 1.6.
 *
 * jq 1.6 is what Debian 12 installs. It differs from 1.7 in three ways that
 * reach the hooks: a keyword used as an object shorthand does not compile, an
 * `if` without `else` does not compile, and `contains` compares C strings, so
 * `contains("\u0000")` is true of every string.
 *
 * Every program is compiled by the installed jq, so this file is the jq 1.6
 * check when it runs on Debian 12. The static rules hold on any version, and
 * the guard cases run over a jq that answers `contains("\u0000")` as 1.6 does.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '../..');
const PACKS = path.join(ROOT, 'templates/hook-packs');
const SHARED = path.join(PACKS, 'shared');
const YAML_MODULES = path.dirname(
  path.dirname(require.resolve('js-yaml/package.json', { paths: [ROOT] }))
);
const quote = (value) => "'" + value.replace(/'/g, "'\\''") + "'";
const JQ = execFileSync('/bin/sh', ['-c', 'command -v jq'], { encoding: 'utf8' }).trim();

function shellScripts(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) return shellScripts(full);
    return entry.isFile() && entry.name.endsWith('.sh') ? [full] : [];
  });
}

// One shell word starting at `at`: its decoded text, whether any part of it was
// double-quoted or bare (so the shell could expand it), and where it ends.
function readWord(source, at) {
  let text = '';
  let expands = false;
  let i = at;
  while (i < source.length && !/[\s;|&<>()]/.test(source[i])) {
    const c = source[i];
    if (c === "'") {
      const end = source.indexOf("'", i + 1);
      text += source.slice(i + 1, end);
      i = end + 1;
    } else if (c === '"') {
      let depth = 0;
      i += 1;
      while (source[i] !== '"' || depth > 0) {
        if (source[i] === '\\') {
          text += source[i + 1];
          i += 2;
          continue;
        }
        if (source[i] === '$') expands = true;
        if (source[i] === '$' && source[i + 1] === '(') depth += 1;
        if (source[i] === ')' && depth > 0) depth -= 1;
        text += source[i];
        i += 1;
      }
      i += 1;
    } else if (c === '\\') {
      text += source[i + 1];
      i += 2;
    } else {
      if (c === '$') expands = true;
      text += c;
      i += 1;
    }
  }
  return { text, expands, end: i };
}

const OPERANDS = { '--arg': 2, '--argjson': 2, '--slurpfile': 2, '--rawfile': 2, '--indent': 1 };

/** Every jq call in one script: its line, and the program text it passes. */
function jqCalls(source) {
  const calls = [];
  const pattern = /(^|[\s;|&(])jq(?=\s)/g;
  for (let match; (match = pattern.exec(source)); ) {
    const start = match.index + match[1].length;
    const lineStart = source.lastIndexOf('\n', start - 1) + 1;
    const before = source.slice(lineStart, start);
    // Prose and lookups, not calls: a comment, `command -v jq`, a word in a string.
    if (/^\s*#/.test(before) || /command -v $/.test(before)) continue;
    const rest = source.slice(start + 2, start + 40);
    if (!/^\s+(?:\\\n\s*)?(?:-|'|"|\.)/.test(rest)) continue;
    const line = source.slice(0, start).split('\n').length;
    let at = start + 2;
    let program = null;
    for (;;) {
      const gap = /^(?:[ \t]|\\\n)+/.exec(source.slice(at));
      if (gap) at += gap[0].length;
      const word = readWord(source, at);
      if (word.end === at) break;
      at = word.end;
      if (OPERANDS[word.text] !== undefined) {
        for (let n = 0; n < OPERANDS[word.text]; n += 1) {
          const space = /^(?:[ \t]|\\\n)+/.exec(source.slice(at));
          at += space ? space[0].length : 0;
          // A process substitution is one operand.
          if (source.startsWith('<(', at)) at = source.indexOf(')', at) + 1;
          else at = readWord(source, at).end;
        }
        continue;
      }
      if (word.text.startsWith('-')) continue;
      program = word;
      break;
    }
    calls.push({ line, program: program && program.text, expands: program && program.expands });
  }
  return calls;
}

const CALLS = shellScripts(PACKS).flatMap((file) =>
  jqCalls(fs.readFileSync(file, 'utf8')).map((call) => ({
    ...call,
    where: path.relative(PACKS, file) + ':' + call.line,
  }))
);

// Program text with string literals and comments blanked, so a keyword inside
// either is not read as syntax.
function syntaxOnly(program) {
  return program
    .replace(/"(?:\\.|[^"\\])*"/g, (literal) => '"' + ' '.repeat(literal.length - 2) + '"')
    .replace(/#[^\n]*/g, '');
}

const KEYWORDS =
  'and|as|catch|def|elif|else|end|foreach|if|import|include|label|not|or|reduce|then|try';

/** What jq 1.6 rejects or answers differently. */
function problems(program) {
  const found = [];
  if (/contains\(\s*"[^"]*\\u0000/.test(program)) found.push('contains NUL');
  const syntax = syntaxOnly(program);
  if (new RegExp('[{,]\\s*(?:' + KEYWORDS + ')\\s*(?=[,}])').test(syntax)) {
    // `not` and friends are ordinary filters between commas outside an object.
    for (const body of syntax.match(/\{[^{}]*\}/g) ?? [])
      if (new RegExp('[{,]\\s*(?:' + KEYWORDS + ')\\s*(?=[,}])').test(body))
        found.push('keyword shorthand');
  }
  const open = [];
  for (const { 0: word } of syntax.matchAll(/(?<![.$\w])(?:if|else|end)(?![\w:])/g)) {
    if (word === 'if') open.push(false);
    else if (word === 'else') open[open.length - 1] = true;
    else if (open.pop() === false) found.push('if without else');
  }
  if (
    /(?<![.$\w])(?:pick|toarray|trim|ltrim|rtrim|abs|have_decnum|have_literal_numbers|trimstr|skip)(?:\(|\b(?!\s*:))/.test(
      syntax
    )
  )
    found.push('builtin newer than 1.6');
  return found;
}

describe('every shipped jq program', () => {
  test('is found by the extractor', () => {
    // A call whose program the extractor could not read would be skipped by
    // every check below.
    expect(CALLS.filter((call) => call.program === null)).toEqual([]);
    const mentions = shellScripts(PACKS).flatMap((file) =>
      fs
        .readFileSync(file, 'utf8')
        .split('\n')
        .filter((text) => !/^\s*#/.test(text))
        .filter((text) => /(?:^|[|({;]|\bif !?|=\$\(|\$\()\s*jq\s+(?:-|'|"|\\)/.test(text))
    );
    expect(CALLS.length).toBeGreaterThanOrEqual(mentions.length);
    expect(CALLS.length).toBeGreaterThan(80);
  });

  test.each(CALLS.map((call) => [call.where, call]))('%s compiles', (_where, call) => {
    // A shell positional inside a program stands for a path expression.
    const program = call.expands ? call.program.replace(/\$[0-9]/g, '.value') : call.program;
    const names = [...new Set([...program.matchAll(/\$([A-Za-z_]\w*)/g)].map((m) => m[1]))].filter(
      (name) => name !== 'ENV'
    );
    const result = spawnSync(JQ, ['-n', ...names.flatMap((name) => ['--arg', name, '']), program], {
      encoding: 'utf8',
      timeout: 15000,
    });
    expect(result.error).toBeUndefined();
    // 3 is jq's compile error. A run-time error on null input is not one.
    expect({
      status: result.status === 3,
      stderr: result.status === 3 ? result.stderr : '',
    }).toEqual({ status: false, stderr: '' });
  });

  test.each(CALLS.map((call) => [call.where, call]))('%s means the same on jq 1.6', (_w, call) => {
    expect(problems(call.program)).toEqual([]);
  });
});

describe('the rules reject what jq 1.6 rejects', () => {
  test.each([
    ['{operation,start,end}', ['keyword shorthand']],
    ['.value|contains("\\u0000")|not', ['contains NUL']],
    ['if .ok then 1 end', ['if without else']],
    ['if .a then if .b then 1 end else 2 end', ['if without else']],
    ['.name|ltrim', ['builtin newer than 1.6']],
  ])('%s', (program, expected) => expect(problems(program)).toEqual(expected));

  test.each([
    '[.operation,.start,.end]',
    '{start: .start, end: .end}',
    '(keys==["end","operation","start"])',
    'if .a then 1 elif .b then 2 else 3 end',
    'if .a then if .b then 1 else 0 end else 2 end',
    '.value|explode|any(.==0)|not',
    '"if this then that end"',
  ])('but not %s', (program) => expect(problems(program)).toEqual([]));
});

describe('bash-write-guard over a jq that answers contains as 1.6 does', () => {
  const SESSION = 'jq-fixture-session';
  let fx;

  beforeAll(() => {
    const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'caws-jq-')));
    const project = path.join(root, 'project');
    const foreign = path.join(project, '.caws/worktrees/foreign');
    const hooks = path.join(root, 'hooks');
    const bin = path.join(root, 'bin');
    fs.mkdirSync(path.join(project, '.caws/specs'), { recursive: true });
    fs.mkdirSync(foreign, { recursive: true });
    fs.mkdirSync(bin);
    execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: project });
    fs.writeFileSync(
      path.join(project, '.caws/worktrees.json'),
      JSON.stringify({
        foreign: {
          name: 'foreign',
          spec_id: 'CLAIM',
          path: foreign,
          owner: { session_id: 'foreign-fixture-session' },
          baseBranch: 'main',
        },
      })
    );
    fs.cpSync(SHARED, hooks, { recursive: true });
    const cli = path.join(root, 'caws');
    fs.writeFileSync(
      cli,
      '#!/bin/sh\nexec ' +
        [process.execPath, path.join(ROOT, 'dist/index.js')].map(quote).join(' ') +
        ' "$@"\n',
      { mode: 0o755 }
    );
    // jq 1.6 searches for the C string "", which every string contains.
    const needle = 'contains("\\u0000")';
    fs.writeFileSync(
      path.join(bin, 'jq'),
      '#!/bin/bash\n' +
        'needle=' +
        quote(needle) +
        '\nargs=()\nfor value in "$@"; do args+=( "${value//"$needle"/true}" ); done\n' +
        'exec ' +
        quote(JQ) +
        ' "${args[@]}"\n',
      { mode: 0o755 }
    );
    fx = { root, project, foreign, hooks, bin, cli };
  });
  afterAll(() => fs.rmSync(fx.root, { recursive: true, force: true }));

  function guard(command) {
    const result = spawnSync('/bin/bash', [path.join(fx.hooks, 'bash-write-guard.sh')], {
      cwd: fx.project,
      encoding: 'utf8',
      input: JSON.stringify({
        tool_name: 'Bash',
        cwd: fx.project,
        session_id: SESSION,
        permission_mode: 'bypassPermissions',
        tool_input: { command },
      }),
      timeout: 15000,
      env: {
        ...Object.fromEntries(
          Object.entries(process.env).filter(([name]) => !/^(?:LD_|DYLD_)/.test(name))
        ),
        PATH: fx.bin + path.delimiter + process.env.PATH,
        HOME: fx.root,
        NODE_PATH: YAML_MODULES,
        HOOK_TOOL_NAME: 'Bash',
        HOOK_COMMAND: command,
        HOOK_CWD: fx.project,
        HOOK_SESSION_ID: SESSION,
        HOOK_PERMISSION_MODE: 'bypassPermissions',
        CAWS_PROJECT_DIR: fx.project,
        CAWS_HOOKS_DIR: fx.hooks,
        CAWS_AGENT_SURFACE: 'claude-code',
        CAWS_BIN: fx.cli,
      },
    });
    expect(result.error).toBeUndefined();
    return result;
  }

  test('the stand-in answers contains as jq 1.6 does', () => {
    const answer = execFileSync(path.join(fx.bin, 'jq'), ['-n', '"abc"|contains("\\u0000")'], {
      encoding: 'utf8',
    });
    expect(answer.trim()).toBe('true');
  });

  test.each(['ls -la', 'git status', 'printf done > notes.txt'])('admits %s', (command) => {
    const result = guard(command);
    expect({ status: result.status, stderr: result.stderr }).toEqual({ status: 0, stderr: '' });
  });

  test('refuses a write into a worktree another session owns, for that reason', () => {
    const result = guard('printf x > ' + quote(path.join(fx.foreign, 'taken.txt')));
    expect(result.status).toBe(2);
    expect(result.stderr).toContain('DIFFERENT session');
    expect(result.stderr).not.toContain('invalid or incomplete contract');
  });

  // The check the code point test replaces: a NUL would end a framed field and
  // shift every later one.
  test('refuses an analyzer response that carries a NUL', () => {
    const command = 'printf done > notes.txt';
    const view = JSON.parse(
      execFileSync(
        fx.cli,
        ['hooks', 'mutation-view', '--json', '--cwd', fx.project, '--project', fx.project],
        {
          cwd: fx.project,
          encoding: 'utf8',
          input: JSON.stringify({
            tool_name: 'Bash',
            cwd: fx.project,
            session_id: SESSION,
            tool_input: { command },
          }),
          env: { ...process.env, NODE_PATH: YAML_MODULES, CAWS_AGENT_SURFACE: 'claude-code' },
        }
      )
    );
    expect(view.tokens.length).toBeGreaterThan(0);
    view.tokens[0].value += '\u0000';
    const response = path.join(fx.root, 'response.json');
    fs.writeFileSync(response, JSON.stringify(view));
    const backend = path.join(fx.root, 'nul-backend');
    fs.writeFileSync(backend, '#!/bin/sh\ncat > /dev/null\ncat ' + quote(response) + '\n', {
      mode: 0o755,
    });
    const real = fx.cli;
    fx.cli = backend;
    try {
      const result = guard(command);
      expect(result.status).toBe(2);
      expect(result.stderr).toContain('invalid or incomplete contract');
    } finally {
      fx.cli = real;
    }
  });
});
