'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { describe, beforeAll, afterAll, test, expect } = require('@jest/globals');

const RUNNER = String.raw`
if (process.argv[2]) process.env.__STRYKER_ACTIVE_MUTANT__ = process.argv[2];
const fs = require('node:fs');
const cp = require('node:child_process');
const payload = JSON.parse(fs.readFileSync(0, 'utf8'));
const savedEnvironment = { ...process.env };
const originalExec = cp.execFileSync;
let scenario, calls;
const facts = ['GIT_DIR','GIT_WORK_TREE','GIT_OPTIONAL_LOCKS','GIT_TERMINAL_PROMPT','GIT_PAGER','CAWS_QUERY_MARKER','PREFIX_GIT_DIR'];
try {
  Object.assign(process.env, payload.inherited);
  cp.execFileSync = (file, args, options) => {
    const { env = {}, ...otherOptions } = options || {};
    calls.push({ file, args, options: otherOptions,
      gitKeys: Object.keys(env).filter(key => key.startsWith('GIT_')).sort(),
      environment: Object.fromEntries(facts.map(key => [key, env[key] ?? null])) });
    if (scenario.failure) {
      if (scenario.primitive === 'null') throw null;
      if (scenario.primitive === 'string') throw 'Controlled primitive failure';
      throw Object.assign(new Error('Controlled discovery failure'), {code: scenario.errorCode});
    }
    return scenario.stdout;
  };
  const { resolveGitContext } = require(process.argv[1]);
  const output = [];
  for (scenario of payload.cases) {
    calls = [];
    const before = Object.entries(process.env).sort(([a], [b]) => a.localeCompare(b));
    const failures = [];
    const value = resolveGitContext({ cwd: payload.cwd, overrides: scenario.overrides || {} }, code => failures.push(code));
    const after = Object.entries(process.env).sort(([a], [b]) => a.localeCompare(b));
    output.push({ id: scenario.id, value, calls, failures,
      environmentUnchanged: JSON.stringify(before) === JSON.stringify(after) });
  }
  process.stdout.write(JSON.stringify({
    activeMutant: process.env.__STRYKER_ACTIVE_MUTANT__ ?? '', output,
  }));
} finally {
  cp.execFileSync = originalExec;
  for (const key of Object.keys(process.env)) {
    if (!Object.hasOwn(savedEnvironment, key)) delete process.env[key];
  }
  Object.assign(process.env, savedEnvironment);
}
`;

module.exports = function registerGitContextCases(compiledModulePath) {
  describe('constant Git context query adapter', () => {
    let root, cwd, expected, cases, results, activeMutant, actualMutant;
    beforeAll(() => {
      root = fs.mkdtempSync(path.join(os.tmpdir(), 'caws-git-context-contract-'));
      cwd = path.join(root, 'cwd ; $(not-executed)');
      const directory = path.join(root, 'metadata');
      const common = path.join(root, 'common');
      const worktree = path.join(root, 'checkout');
      for (const name of [cwd, directory, common, worktree]) fs.mkdirSync(name);
      const aliases = ['metadata-alias', 'common-alias', 'checkout-alias'].map((name) =>
        path.join(root, name)
      );
      [directory, common, worktree].forEach((target, index) =>
        fs.symlinkSync(target, aliases[index])
      );
      const physicalRoot = fs.realpathSync.native(root);
      expected = {
        directory: path.join(physicalRoot, 'metadata'),
        common: path.join(physicalRoot, 'common'),
        worktree: path.join(physicalRoot, 'checkout'),
      };
      const protocol = (d = aliases[0], c = aliases[1], bare = 'false', w = aliases[2]) =>
        [d, c, bare, w].join('\n') + '\n';
      const valid = protocol();
      const missing = path.join(root, 'does-not-exist');
      cases = [
        { id: 'physical-aliases', stdout: valid, expected },
        {
          id: 'explicit-overrides',
          stdout: valid,
          expected,
          overrides: {
            GIT_DIR: '/explicit/metadata',
            GIT_WORK_TREE: '/explicit/checkout',
            GIT_OPTIONAL_LOCKS: '1',
            GIT_TERMINAL_PROMPT: '1',
            GIT_PAGER: 'unsafe-pager',
            CAWS_QUERY_MARKER: 'explicit-marker',
          },
        },
        { id: 'missing-final-newline', stdout: valid.slice(0, -1), expected: null },
        { id: 'extra-final-newline', stdout: valid + '\n', expected: null },
        {
          id: 'missing-field',
          stdout: [aliases[0], aliases[1], 'false'].join('\n') + '\n',
          expected: null,
        },
        { id: 'extra-field', stdout: valid + aliases[0] + '\n', expected: null },
        { id: 'empty-output', stdout: '', expected: null },
        { id: 'bare-repository', stdout: protocol(undefined, undefined, 'true'), expected: null },
        {
          id: 'bare-field-case-sensitive',
          stdout: protocol(undefined, undefined, 'FALSE'),
          expected: null,
        },
        {
          id: 'bare-field-whitespace',
          stdout: protocol(undefined, undefined, 'false '),
          expected: null,
        },
        { id: 'empty-bare-field', stdout: protocol(undefined, undefined, ''), expected: null },
        { id: 'crlf-not-the-lf-protocol', stdout: valid.replace(/\n/g, '\r\n'), expected: null },
        { id: 'missing-directory', stdout: protocol(missing), expected: null },
        { id: 'missing-common', stdout: protocol(undefined, missing), expected: null },
        {
          id: 'missing-worktree',
          stdout: protocol(undefined, undefined, undefined, missing),
          expected: null,
        },
        { id: 'empty-directory-field', stdout: protocol(''), expected: null },
        { id: 'query-exception', failure: true, stdout: valid, expected: null },
        {
          id: 'query-timeout',
          failure: true,
          errorCode: 'ETIMEDOUT',
          stdout: valid,
          expected: null,
        },
        {
          id: 'query-missing-git',
          failure: true,
          errorCode: 'ENOENT',
          stdout: valid,
          expected: null,
        },
        {
          id: 'query-primitive',
          failure: true,
          primitive: 'string',
          stdout: valid,
          expected: null,
        },
        { id: 'query-null', failure: true, primitive: 'null', stdout: valid, expected: null },
      ];
      activeMutant = String(
        globalThis.__stryker__?.activeMutant ?? process.env.__STRYKER_ACTIVE_MUTANT__ ?? ''
      );
      const child = spawnSync(process.execPath, ['-e', RUNNER, compiledModulePath, activeMutant], {
        input: JSON.stringify({
          cwd,
          cases,
          inherited: {
            GIT_DIR: '/inherited/metadata',
            GIT_WORK_TREE: '/inherited/checkout',
            GIT_OBJECT_DIRECTORY: '/inherited/objects',
            GIT_CONFIG_COUNT: '1',
            GIT_CONFIG_KEY_0: 'core.pager',
            GIT_CONFIG_VALUE_0: 'unsafe-inherited-pager',
            GIT_OPTIONAL_LOCKS: '1',
            GIT_TERMINAL_PROMPT: '1',
            GIT_PAGER: 'unsafe-inherited-pager',
            CAWS_QUERY_MARKER: 'inherited-marker',
            PREFIX_GIT_DIR: 'unrelated-preserved',
          },
        }),
        encoding: 'utf8',
        shell: false,
        timeout: 15000,
        maxBuffer: 1024 * 1024,
      });
      if (child.error || child.status !== 0)
        throw new Error(
          'Git context fixture process failed: ' +
            JSON.stringify({
              status: child.status,
              error: child.error?.message,
              stderr: child.stderr,
            })
        );
      const batch = JSON.parse(child.stdout);
      actualMutant = batch.activeMutant;
      results = new Map(batch.output.map((item) => [item.id, item]));
    });
    afterAll(() => {
      if (root) fs.rmSync(root, { recursive: true, force: true });
    });
    test.each([
      'physical-aliases',
      'explicit-overrides',
      'missing-final-newline',
      'extra-final-newline',
      'missing-field',
      'extra-field',
      'empty-output',
      'bare-repository',
      'bare-field-case-sensitive',
      'bare-field-whitespace',
      'empty-bare-field',
      'crlf-not-the-lf-protocol',
      'missing-directory',
      'missing-common',
      'missing-worktree',
      'empty-directory-field',
      'query-exception',
      'query-timeout',
      'query-missing-git',
      'query-primitive',
      'query-null',
    ])('%s returns its independently specified context or refusal', (id) => {
      const fixture = cases.find((item) => item.id === id);
      const actual = results.get(id);
      expect(actual.value).toEqual(fixture.expected);
      const pathFailure = [
        'missing-directory',
        'missing-common',
        'missing-worktree',
        'empty-directory-field',
      ].includes(id);
      expect(actual.failures).toEqual(
        fixture.expected
          ? []
          : [
              fixture.errorCode === 'ETIMEDOUT'
                ? 'git-discovery-timeout'
                : fixture.failure || pathFailure
                  ? 'git-discovery-failed'
                  : 'git-discovery-protocol',
            ]
      );
      expect(actual.calls).toHaveLength(1);
      expect(actual.environmentUnchanged).toBe(true);
      const call = actual.calls[0];
      expect(call.file).toBe('git');
      expect(call.args).toEqual([
        '--no-pager',
        '-C',
        cwd,
        'rev-parse',
        '--path-format=absolute',
        '--absolute-git-dir',
        '--git-common-dir',
        '--is-bare-repository',
        '--show-toplevel',
      ]);
      expect(call.options).toEqual({
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: 500,
        maxBuffer: 65536,
      });
    });
    test('drops inherited Git settings while retaining unrelated environment keys', () => {
      const call = results.get('physical-aliases').calls[0];
      expect(call.gitKeys).toEqual(['GIT_OPTIONAL_LOCKS', 'GIT_PAGER', 'GIT_TERMINAL_PROMPT']);
      expect(call.environment).toEqual({
        GIT_DIR: null,
        GIT_WORK_TREE: null,
        GIT_OPTIONAL_LOCKS: '0',
        GIT_TERMINAL_PROMPT: '0',
        GIT_PAGER: 'cat',
        CAWS_QUERY_MARKER: 'inherited-marker',
        PREFIX_GIT_DIR: 'unrelated-preserved',
      });
    });
    test('carries explicit routing overrides but enforces noninteractive read-only query controls', () => {
      const call = results.get('explicit-overrides').calls[0];
      expect(call.gitKeys).toEqual([
        'GIT_DIR',
        'GIT_OPTIONAL_LOCKS',
        'GIT_PAGER',
        'GIT_TERMINAL_PROMPT',
        'GIT_WORK_TREE',
      ]);
      expect(call.environment).toEqual({
        GIT_DIR: '/explicit/metadata',
        GIT_WORK_TREE: '/explicit/checkout',
        GIT_OPTIONAL_LOCKS: '0',
        GIT_TERMINAL_PROMPT: '0',
        GIT_PAGER: 'cat',
        CAWS_QUERY_MARKER: 'explicit-marker',
        PREFIX_GIT_DIR: 'unrelated-preserved',
      });
    });
    test('runs every named protocol case with the active mutation selected before module loading', () => {
      expect(actualMutant).toBe(activeMutant);
      expect(new Set(cases.map((item) => item.id)).size).toBe(cases.length);
      expect([...results.keys()].sort()).toEqual(cases.map((item) => item.id).sort());
    });
  });
};
