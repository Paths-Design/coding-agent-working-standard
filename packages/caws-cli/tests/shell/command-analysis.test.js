'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const corpus = require('../fixtures/command-analysis/contract.json');
// Feed inert command strings to the compiled consumer over stdin. Jest's VM
// cannot import the parser's ESM, so use one real Node process, without a shell.
const RUNNER = String.raw`
const fs = require('node:fs');
if (process.argv[2]) process.env.__STRYKER_ACTIVE_MUTANT__ = process.argv[2];
const { analyzeCommand } = require(process.argv[1]);
(async () => {
  const out = [];
  for (const request of JSON.parse(fs.readFileSync(0, 'utf8'))) {
    out.push({id: request.id, activeMutant:process.env.__STRYKER_ACTIVE_MUTANT__ ?? '', first: await analyzeCommand(request.input), repeated: await analyzeCommand(request.input)});
  }
  process.stdout.write(JSON.stringify(out));
})().catch(error => { console.error(error); process.exitCode = 1; });
`;
describe('bounded shell analysis contract', () => {
  let root, locations, requests, results, activeMutant;
  const expand = (text) =>
    text.replace(/\{\{([A-Z_]+)\}\}/g, (_, key) => {
      if (!Object.hasOwn(locations, key)) throw new Error('Unknown fixture location ' + key);
      return locations[key];
    });
  beforeAll(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'caws-analysis-'));
    locations = {
      CANONICAL: path.join(root, 'project'),
      SCRATCH: path.join(root, 'scratch'),
      MARKER: path.join(root, 'executed'),
    };
    locations.OWN = path.join(locations.CANONICAL, '.caws/worktrees/own');
    locations.FOREIGN = path.join(locations.CANONICAL, '.caws/worktrees/foreign');
    for (const key of ['CANONICAL', 'OWN', 'FOREIGN', 'SCRATCH'])
      fs.mkdirSync(locations[key], { recursive: true });
    fs.symlinkSync(locations.FOREIGN, path.join(locations.OWN, 'escape'));
    fs.mkdirSync(path.join(locations.OWN, 'route'));
    fs.symlinkSync(locations.FOREIGN, path.join(locations.SCRATCH, 'route'));
    requests = corpus.map((fixture) => {
      let command = fixture.command;
      if (fixture.payload)
        command = command.replace(
          '{{PAYLOAD}}',
          fixture.payload.value.repeat(fixture.payload.repeat)
        );
      if (fixture.nestedSubstitutions) {
        command = "printf '%s' data";
        for (let depth = 0; depth < fixture.nestedSubstitutions; depth++)
          command = "printf '%s' \"$(" + command + ')"';
      }
      command = expand(command);
      return {
        id: fixture.id,
        input: {
          command,
          cwd: locations[(fixture.cwd || 'own').toUpperCase()],
          worktree: locations.OWN,
          ...(fixture.shell ? { shell: fixture.shell } : {}),
        },
      };
    });
    activeMutant = String(
      globalThis.__stryker__?.activeMutant ?? process.env.__STRYKER_ACTIVE_MUTANT__ ?? ''
    );
    const child = spawnSync(
      process.execPath,
      ['-e', RUNNER, path.resolve(__dirname, '../../dist/shell/analysis/analyze.js'), activeMutant],
      {
        input: JSON.stringify(requests),
        encoding: 'utf8',
        shell: false,
        timeout: 30000,
        maxBuffer: 32 * 1024 * 1024,
      }
    );
    if (child.error || child.status !== 0)
      throw new Error(
        JSON.stringify({ status: child.status, error: child.error?.message, stderr: child.stderr })
      );
    results = new Map(JSON.parse(child.stdout).map((item) => [item.id, item]));
  });
  afterAll(() => {
    if (root) fs.rmSync(root, { recursive: true, force: true });
  });
  test.each(corpus)('$id', (fixture) => {
    const actual = results.get(fixture.id);
    const request = requests.find((item) => item.id === fixture.id);
    expect(actual.activeMutant).toBe(activeMutant);
    expect(actual.first.decision).toBe(fixture.decision);
    if (fixture.decision !== 'allow') expect(actual.first.reasons.length).toBeGreaterThan(0);
    expect(actual.repeated).toEqual(actual.first);
    if (fixture.reason)
      expect(actual.first.reasons.map((item) => item.code)).toContain(fixture.reason);
    for (const entry of [...actual.first.reasons, ...actual.first.trace]) {
      if ('code' in entry) {
        expect(entry.code).toMatch(/^[a-z][a-z-]+$/);
        expect(entry.message.trim()).not.toBe('');
      } else {
        expect(entry.kind).toMatch(/^[a-z][a-z-]+$/);
        expect(entry.detail.trim()).not.toBe('');
      }
      expect(Number.isInteger(entry.start)).toBe(true);
      expect(Number.isInteger(entry.end)).toBe(true);
      expect(entry.start).toBeGreaterThanOrEqual(0);
      expect(entry.end).toBeGreaterThanOrEqual(entry.start);
      expect(entry.end).toBeLessThanOrEqual(request.input.command.length);
    }
    for (const command of fixture.traceCommands || []) {
      expect(
        actual.first.trace
          .filter((item) => item.kind === 'command')
          .map((item) => request.input.command.slice(item.start, item.end))
      ).toContain(expand(command));
    }
  });
  test('submitted code never executes its sentinel', () => {
    expect(results.get('submission-is-never-executed').first.decision).toBe('unresolved');
    expect(results.get('sed-execution-command').first.decision).toBe('deny');
    expect(fs.existsSync(locations.MARKER)).toBe(false);
  });
  test('delivers every unique case', () => {
    expect(new Set(corpus.map((item) => item.id)).size).toBe(corpus.length);
    expect([...results.keys()].sort()).toEqual(corpus.map((item) => item.id).sort());
  });
  test.each([
    [
      'policies.js',
      'if (inside(cwd, ctx.canonical) && !inside(cwd, ctx.worktree))',
      'if (false)',
      'git-canonical',
    ],
    ['policies.js', 'sedPolicy(args, ctx, node);', 'void 0;', 'sed-execution-command'],
    ['words.js', 'inspect(part.script, state, depth + 1);', 'void 0;', 'nested-reader-foreign-git'],
    [
      'words.js',
      "ctx.reason(word, 'unknown-splitting', 'Unquoted unknown expansion can change argument count and options.');",
      'void 0;',
      'unknown-unquoted-filename',
    ],
    ['analyze.js', 'if (tree.errors?.length)', 'if (false)', 'malformed-quote'],
    [
      'analyze.js',
      /list\(node.body.commands, \[clone\(state\)\], reader, depth \+ 1\);\s*return \[state\];/,
      'return list(node.body.commands, [clone(state)], reader, depth + 1);',
      'subshell-cannot-sanitize-parent',
    ],
  ])('semantic mutation in %s is caught by %s', (file, search, replacement, fixtureId) => {
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'caws-analysis-mutant-'));
    try {
      const moduleDir = path.join(temp, 'analysis');
      fs.cpSync(path.resolve(__dirname, '../../dist/shell/analysis'), moduleDir, {
        recursive: true,
      });
      fs.mkdirSync(path.join(temp, 'node_modules'));
      fs.symlinkSync(
        path.dirname(path.dirname(require.resolve('unbash'))),
        path.join(temp, 'node_modules/unbash')
      );
      const target = path.join(moduleDir, file);
      const original = fs.readFileSync(target, 'utf8');
      const mutated = original.replace(search, replacement);
      expect(mutated).not.toBe(original);
      fs.writeFileSync(target, mutated);
      const request = requests.find((item) => item.id === fixtureId);
      const child = spawnSync(
        process.execPath,
        ['-e', RUNNER, path.join(moduleDir, 'analyze.js')],
        {
          input: JSON.stringify([request]),
          encoding: 'utf8',
          shell: false,
          timeout: 15000,
        }
      );
      if (child.error || child.status !== 0)
        throw new Error('Mutation infrastructure failed: ' + child.stderr);
      const actual = JSON.parse(child.stdout)[0].first;
      expect(actual.decision).not.toBe(corpus.find((item) => item.id === fixtureId).decision);
      // A runtime/import crash is not a semantic kill.
      expect(actual.reasons.map((item) => item.code)).not.toContain('analysis-failure');
    } finally {
      fs.rmSync(temp, { recursive: true, force: true });
    }
  });
});
