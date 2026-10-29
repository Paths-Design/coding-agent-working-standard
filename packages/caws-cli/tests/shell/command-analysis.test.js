'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const corpus = [
  ...require('../fixtures/command-analysis/contract.json'),
  ...require('../fixtures/command-analysis/profile-cases.cjs'),
  ...require('../fixtures/command-analysis/git-profile-cases.cjs'),
  ...['-U', '--unified'].flatMap((option, index) => [
    {
      id: `git-unified-${index}-output`,
      command: `git diff ${option} --output=target`,
      decision: 'unresolved',
      reason: 'git-option-unmodeled',
      absentReasons: ['git-mapping-unresolved'],
    },
    {
      id: `git-unified-${index}-execution`,
      command: `git diff ${option} --ext-diff`,
      decision: 'deny',
      reason: 'git-execution',
      absentReasons: ['git-mapping-unresolved'],
    },
  ]),
  ...['-U', '-U3', '--unified', '--unified=3'].flatMap((option, index) => [
    { id: `git-unified-${index}-bare`, command: `git diff ${option}`, decision: 'allow' },
    {
      id: `git-unified-${index}-path`,
      command: `git diff ${option} -- --output=literal --ext-diff`,
      decision: 'allow',
    },
  ]),
];
const linkedRepository = require('../fixtures/command-analysis/git-fixture.cjs');
const wordCases = require('../fixtures/command-analysis/abstract-words.cjs');
require('../fixtures/command-analysis/git-context-cases.cjs')(
  path.resolve(__dirname, '../../dist/shell/analysis/git-context.js')
);
describe('Node startup binding policy', () => {
  const { nodeStartupBinding, sensitiveBinding } = require('../../dist/shell/analysis/policies.js');
  test.each([
    ['NODE_OPTIONS', true],
    ['NODE_PATH', true],
    ['NODE_V8_COVERAGE', true],
    ['NODE_COMPILE_CACHE', true],
    ['NODE_REDIRECT_WARNINGS', true],
    ['NODE_REPL_EXTERNAL_MODULE', true],
    ['NODE_REPL_HISTORY', true],
    ['NODE_ICU_DATA', true],
    ['OPENSSL_CONF', true],
    ['OPENSSL_ENGINES', true],
    ['NODE_FUTURE_STARTUP', false],
    ['NODE_', false],
    ['NODE_OPTIONS_DATA', false],
    ['NODE_PATH_DATA', false],
    ['NODE_V8_COVERAGE_DATA', false],
    ['NODE_ENV_EXTRA', false],
    ['NODE_NO_WARNINGS_EXTRA', false],
    ['NODE_DISABLE_COLORS_EXTRA', false],
    ['NODE_ENV', false],
    ['NODE_NO_WARNINGS', false],
    ['NODE_DISABLE_COLORS', false],
    ['NODE', false],
    ['XNODE_OPTIONS', false],
    ['node_OPTIONS', false],
    ['OTHER', false],
  ])('%s has explicit startup sensitivity %s', (name, expected) => {
    expect(nodeStartupBinding(name)).toBe(expected);
    expect(sensitiveBinding(name)).toBe(expected);
  });
});
// Feed inert command strings to the compiled consumer over stdin. Jest's VM
// cannot import the parser's ESM, so use one real Node process, without a shell.
const RUNNER = String.raw`
const fs = require('node:fs');
if (process.argv[2]) process.env.__STRYKER_ACTIVE_MUTANT__ = process.argv[2];
const { analyzeCommand } = require(process.argv[1]);
const { resolveGitContext } = require(require('node:path').join(require('node:path').dirname(process.argv[1]), 'git-context.js'));
const { expandWord } = require(require('node:path').join(require('node:path').dirname(process.argv[1]), 'words.js'));
const { loadParser } = require(require('node:path').join(require('node:path').dirname(process.argv[1]), 'load-parser.js'));
// The fixture graph is immutable: submitted source never executes. Reuse only
// real discovery results for that graph; the production CLI has no shared cache.
const contexts = new Map();
const gitContext = input => {
  const key = JSON.stringify(input);
  if (!contexts.has(key)) contexts.set(key, resolveGitContext(input));
  return contexts.get(key);
};
(async () => {
  const out = [];
  for (const request of JSON.parse(fs.readFileSync(0, 'utf8'))) {
    const previous = new Map(Object.keys(request.environment || {}).map(key => [key,process.env[key]]));
    try {
      Object.assign(process.env, request.environment || {});
      if (request.wordDomain) {
        const fixture = request.wordDomain;
        const tree = (await loadParser()).parse('cat -- ' + fixture.source);
        if(tree.errors?.length) throw Error('Invalid component-domain word');
        const queue=[tree]; let word;
        while(queue.length) {
          const value=queue.shift();
          if(value && typeof value==='object') {
            if(value.type==='Word' && value.text===fixture.source) {word=value;break;}
            queue.push(...Object.values(value));
          }
        }
        if(!word) throw Error('Missing parsed component-domain word');
        const reasons=[];
        const context={reason:(_node,code)=>reasons.push(code)};
        const fields=expandWord(word,{cwd:request.input.cwd,bindings:new Map(Object.entries(fixture.bindings))},context,()=>{throw Error('Unexpected producer in component-domain word');},0,...(fixture.omitAssignment ? [] : [fixture.assignment===true]));
        out.push({id:request.id, fields:fields.map(argv=>argv.map(arg=>arg.value)), reasons});
        continue;
      }
      if (request.contextQuery) {
        out.push({id:request.id, context:resolveGitContext(request.contextQuery)});
        continue;
      }
      const inspect = async () => {
        const calls = [];
        let next = 0;
        const resolver = request.discoveryPlan ? (input, onFailure) => {
          calls.push(input);
          if (next >= request.discoveryPlan.length) throw Error('Unexpected metadata query');
          const outcome = request.discoveryPlan[next++];
          if (outcome === 'own') return request.ownContext;
          if (outcome !== 'null') onFailure(outcome);
          return null;
        } : request.gitFailure ? (_input, onFailure) => {onFailure(request.gitFailure); return null;} : gitContext;
        return {analysis: await analyzeCommand(request.input,{gitContext:resolver}), calls};
      };
      const first = await inspect(), repeated = await inspect();
      out.push({id: request.id, activeMutant:process.env.__STRYKER_ACTIVE_MUTANT__ ?? '', first:first.analysis, repeated:repeated.analysis, discoveryCalls:first.calls, repeatedDiscoveryCalls:repeated.calls});
    } finally {
      for(const [key,value] of previous) { if(value === undefined) delete process.env[key]; else process.env[key]=value; }
    }
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
    locations.SYMLINK_PIN = path.join(locations.CANONICAL, '.caws/worktrees/symlink-pin');
    locations.HARDLINK_PIN = path.join(locations.CANONICAL, '.caws/worktrees/hardlink-pin');
    locations.LARGE_PIN = path.join(locations.CANONICAL, '.caws/worktrees/large-pin');
    for (const key of ['CANONICAL', 'SCRATCH']) fs.mkdirSync(locations[key], { recursive: true });
    linkedRepository(locations.CANONICAL, [
      locations.OWN,
      locations.FOREIGN,
      locations.SYMLINK_PIN,
      locations.HARDLINK_PIN,
      locations.LARGE_PIN,
    ]);
    locations.OWN_METADATA = fs
      .readFileSync(path.join(locations.OWN, '.git'), 'utf8')
      .trim()
      .slice(8);
    fs.renameSync(
      path.join(locations.SYMLINK_PIN, '.git'),
      path.join(locations.SYMLINK_PIN, 'pointer')
    );
    fs.symlinkSync('pointer', path.join(locations.SYMLINK_PIN, '.git'));
    fs.linkSync(
      path.join(locations.HARDLINK_PIN, '.git'),
      path.join(locations.HARDLINK_PIN, 'pointer-alias')
    );
    fs.appendFileSync(path.join(locations.LARGE_PIN, '.git'), ' '.repeat(16385));
    linkedRepository(locations.SCRATCH, []);
    for (const key of ['UNMAPPED', 'FORGED', 'WRONG_RECIPROCAL']) {
      locations[key] = path.join(locations.CANONICAL, '.caws/worktrees', key.toLowerCase());
      fs.mkdirSync(locations[key]);
    }
    fs.writeFileSync(path.join(locations.FORGED, '.git'), `gitdir: ${locations.CANONICAL}/.git\n`);
    fs.copyFileSync(
      path.join(locations.FOREIGN, '.git'),
      path.join(locations.WRONG_RECIPROCAL, '.git')
    );
    fs.symlinkSync(
      path.join(locations.CANONICAL, '.git/config'),
      path.join(locations.OWN, 'metadata-alias')
    );
    fs.mkdirSync(path.join(locations.OWN, 'nested'));
    fs.writeFileSync(
      path.join(locations.OWN, 'nested/.git'),
      `gitdir: ${locations.CANONICAL}/.git\n`
    );
    for (let index = 0; index < 9; index++)
      fs.mkdirSync(path.join(locations.OWN, `context${index}`));
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
        environment: Object.fromEntries(
          Object.entries(fixture.environment || {}).map(([key, value]) => [key, expand(value)])
        ),
        gitFailure: fixture.gitFailure,
        discoveryPlan: fixture.discoveryPlan,
        ownContext: {
          directory: locations.OWN_METADATA,
          common: path.join(locations.CANONICAL, '.git'),
          worktree: locations.OWN,
        },
        input: {
          command,
          cwd: fixture.cwdPath
            ? expand(fixture.cwdPath)
            : locations[(fixture.cwd || 'own').toUpperCase()],
          worktree: fixture.worktreePath
            ? expand(fixture.worktreePath)
            : locations[(fixture.worktree || 'own').toUpperCase()],
          ...(fixture.shell ? { shell: fixture.shell } : {}),
        },
      };
    });
    requests.push(
      ...wordCases.map((fixture) => ({
        id: 'word-domain-' + fixture.id,
        wordDomain: fixture,
        input: { cwd: locations.OWN },
      }))
    );
    requests.push(
      { id: 'query-own', contextQuery: { cwd: locations.OWN, overrides: {} } },
      { id: 'query-scratch', contextQuery: { cwd: locations.SCRATCH, overrides: {} } },
      {
        id: 'query-missing',
        contextQuery: { cwd: path.join(locations.OWN, 'missing'), overrides: {} },
      },
      {
        id: 'query-host-override-ignored',
        environment: { GIT_DIR: '/missing-foreign-metadata' },
        contextQuery: { cwd: locations.OWN, overrides: {} },
      }
    );
    activeMutant = String(
      globalThis.__stryker__?.activeMutant ?? process.env.__STRYKER_ACTIVE_MUTANT__ ?? ''
    );
    const child = spawnSync(
      process.execPath,
      ['-e', RUNNER, path.resolve(__dirname, '../../dist/shell/analysis/analyze.js'), activeMutant],
      {
        // Jest isolates process.env in its VM; native children need that snapshot explicitly.
        env: { ...process.env },
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
    if (actual.first.decision !== fixture.decision)
      throw new Error(
        JSON.stringify({
          fixture: fixture.id,
          expectedDecision: fixture.decision,
          actualDecision: actual.first.decision,
          reasonCodes: [...new Set(actual.first.reasons.map((item) => item.code))],
        })
      );
    expect(actual.first.reasons.map((item) => item.code)).not.toContain('analysis-failure');
    if (fixture.decision !== 'allow') expect(actual.first.reasons.length).toBeGreaterThan(0);
    expect(actual.repeated).toEqual(actual.first);
    if (fixture.discoveryQueries) {
      const expected = fixture.discoveryQueries.map((cwd) => ({
        cwd: fs.realpathSync.native(expand(cwd)),
        overrides: {},
      }));
      expect(actual.discoveryCalls).toEqual(expected);
      expect(actual.repeatedDiscoveryCalls).toEqual(expected);
    }
    if (fixture.reason)
      expect(actual.first.reasons.map((item) => item.code)).toContain(fixture.reason);
    for (const code of fixture.absentReasons || [])
      expect(actual.first.reasons.map((item) => item.code)).not.toContain(code);
    for (const [code, count] of Object.entries(fixture.reasonCounts || {}))
      expect(actual.first.reasons.filter((item) => item.code === code)).toHaveLength(count);
    if (fixture.maxTraceEntries !== undefined)
      expect(actual.first.trace.length).toBeLessThanOrEqual(fixture.maxTraceEntries);
    if (fixture.reasonIncludes)
      expect(
        actual.first.reasons
          .filter((item) => item.code === fixture.reason)
          .some((item) => item.message.includes(fixture.reasonIncludes))
      ).toBe(true);
    if (fixture.reasonSource !== undefined)
      expect(
        actual.first.reasons
          .filter((item) => item.code === fixture.reason)
          .map((item) => request.input.command.slice(item.start, item.end))
      ).toContain(expand(fixture.reasonSource));
    if (fixture.bytes) expect(Buffer.byteLength(request.input.command, 'utf8')).toBe(fixture.bytes);
    if (fixture.reasonOccurrences) {
      const { code, source, count } = fixture.reasonOccurrences;
      const fragment = expand(source),
        expected = [];
      for (
        let start = request.input.command.indexOf(fragment);
        start >= 0;
        start = request.input.command.indexOf(fragment, start + fragment.length)
      )
        expected.push([start, start + fragment.length]);
      expect(expected).toHaveLength(count);
      expect(
        actual.first.reasons
          .filter((item) => item.code === code)
          .map((item) => [item.start, item.end])
      ).toEqual(expected);
    }
    if (fixture.reasonNames) {
      const matching = actual.first.reasons.filter((item) => item.code === fixture.reason);
      expect(matching).toHaveLength(fixture.reasonNames.length);
      for (const name of fixture.reasonNames)
        expect(matching.filter((item) => item.message.includes(name))).toHaveLength(1);
    }
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
    if (fixture.assignmentKnowledge) {
      const assignments = actual.first.trace.filter((item) => item.kind === 'assignment');
      expect(assignments.map((item) => request.input.command.slice(item.start, item.end))).toEqual(
        fixture.assignmentKnowledge.map((item) => item.source)
      );
      for (const [index, expected] of fixture.assignmentKnowledge.entries()) {
        const tokens = assignments[index].detail.split(/\W+/);
        expect(tokens).toContain(expected.binding);
        expect(tokens).toContain(expected.knowledge);
        if (expected.count !== undefined) expect(tokens).toContain(String(expected.count));
      }
    }
  });
  test('fixture identities are unique across the public and role corpora', () => {
    expect(new Set(corpus.map((fixture) => fixture.id)).size).toBe(corpus.length);
  });
  test('submitted code never executes its sentinel', () => {
    expect(results.get('submission-is-never-executed').first.decision).toBe('unresolved');
    expect(results.get('sed-execution-command').first.decision).toBe('deny');
    expect(fs.existsSync(locations.MARKER)).toBe(false);
  });
  test('delivers every unique case', () => {
    expect(new Set(requests.map((item) => item.id)).size).toBe(requests.length);
    expect([...results.keys()].sort()).toEqual(requests.map((item) => item.id).sort());
  });
  test.each(wordCases)('abstract word domain $id', (fixture) => {
    const actual = results.get('word-domain-' + fixture.id);
    expect(actual.fields).toEqual(fixture.fields);
    expect([...new Set(actual.reasons)].sort()).toEqual([...(fixture.reasons || [])].sort());
  });
  test('constant Git discovery returns actual metadata and ignores unrequested host overrides', () => {
    const physical = (value) => fs.realpathSync.native(value);
    const ownMetadata = physical(
      fs.readFileSync(path.join(locations.OWN, '.git'), 'utf8').trim().slice(8)
    );
    const own = {
      directory: ownMetadata,
      common: physical(path.join(locations.CANONICAL, '.git')),
      worktree: physical(locations.OWN),
    };
    expect(results.get('query-own').context).toEqual(own);
    expect(results.get('query-host-override-ignored').context).toEqual(own);
    expect(results.get('query-scratch').context).toEqual({
      directory: physical(path.join(locations.SCRATCH, '.git')),
      common: physical(path.join(locations.SCRATCH, '.git')),
      worktree: physical(locations.SCRATCH),
    });
    expect(results.get('query-missing').context).toBeNull();
  });
  test.each([
    [
      'policies.js',
      'gitPolicy(args, state, env, ctx, node, reader);',
      'void 0;',
      'git-canonical',
      'allow',
    ],
    ['policies.js', 'sedPolicy(args, ctx, node);', 'void 0;', 'sed-execution-command', 'allow'],
    [
      'inspection-profiles.js',
      'sort: /^-[bdfginrMu]+$/',
      'sort: /-[bdfginrMu]+$/',
      'profile-reader-sort-attached-output',
      'allow',
    ],
    [
      'words.js',
      'inspect(part.script, state, depth + 1);',
      'void 0;',
      'nested-reader-foreign-git',
      'allow',
    ],
    [
      'words.js',
      "ctx.reason(word, 'unknown-splitting', 'Unquoted unknown expansion can change argument count and options.');",
      'void 0;',
      'unknown-unquoted-filename',
      'allow',
    ],
    ['analyze.js', 'if (tree.errors?.length)', 'if (false)', 'malformed-quote', 'allow'],
    [
      'analyze.js',
      'const outputs = list(node.body.commands, [clone(state)], reader, depth + 1);',
      'return list(node.body.commands, [clone(state)], reader, depth + 1);',
      'subshell-cannot-sanitize-parent',
      'allow',
    ],
  ])(
    'semantic mutation in %s is caught by %s',
    (file, search, replacement, fixtureId, changedDecision) => {
      const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'caws-analysis-mutant-'));
      try {
        const moduleDir = path.join(temp, 'analysis');
        fs.cpSync(path.resolve(__dirname, '../../dist/shell/analysis'), moduleDir, {
          recursive: true,
        });
        fs.copyFileSync(
          path.resolve(__dirname, '../../dist/shell/duration.js'),
          path.join(temp, 'duration.js')
        );
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
            env: { ...process.env },
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
        expect(actual.decision).toBe(changedDecision);
        // A runtime/import crash is not a semantic kill.
        expect(actual.reasons.map((item) => item.code)).not.toContain('analysis-failure');
      } finally {
        fs.rmSync(temp, { recursive: true, force: true });
      }
    }
  );
});
