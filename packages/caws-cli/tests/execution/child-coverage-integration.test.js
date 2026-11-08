'use strict';
// This qualifies the test transport with actual Stryker instrumentation and
// selection. The tiny functions and unrelated module are harness fixtures.
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { createHash } = require('node:crypto');
const packageRoot = path.resolve(__dirname, '../..');
const corePackage = require.resolve('@stryker-mutator/core/package.json');
const strykerBin = path.resolve(path.dirname(corePackage), require(corePackage).bin.stryker);

function canary(disruption) {
  fs.mkdirSync(path.join(packageRoot, 'reports/execution-boundary'), { recursive: true });
  const root = fs.mkdtempSync(
    path.join(packageRoot, 'reports/execution-boundary/coverage-canary-')
  );
  const hashes = {};
  for (const name of ['child-coverage.cjs', 'child-coverage-preload.cjs']) {
    let bytes = fs.readFileSync(path.join(__dirname, name));
    if (name === 'child-coverage-preload.cjs' && disruption === 'missing')
      bytes = Buffer.from('"use strict";\n');
    if (name === 'child-coverage-preload.cjs' && disruption === 'unknown')
      bytes = Buffer.from(
        bytes.toString().replace('testId: context.testId,', 'testId: "unknown test",')
      );
    if (name === 'child-coverage-preload.cjs' && disruption === 'unrelated-missing') {
      const previous = bytes.toString();
      bytes = Buffer.from(
        previous.replace(
          "process.once('exit', () => {",
          "process.once('exit', () => { if (process.argv[1] === 'unrelated') return;"
        )
      );
      expect(bytes.toString()).not.toBe(previous);
    }
    if (name === 'child-coverage-preload.cjs' && disruption === 'unrelated-null') {
      const previous = bytes.toString();
      bytes = Buffer.from(
        previous.replace(
          'coverage: globalThis.__stryker__?.mutantCoverage ?? null',
          'coverage: (process.argv[1] === "unrelated" ? null : globalThis.__stryker__?.mutantCoverage ?? null)'
        )
      );
      expect(bytes.toString()).not.toBe(previous);
    }
    hashes[name] = createHash('sha256').update(bytes).digest('hex');
    fs.writeFileSync(path.join(root, name), bytes);
  }
  fs.writeFileSync(
    path.join(root, 'branches.cjs'),
    'exports.left = function left() { return "LEFT"; };\nexports.right = function right() { return "RIGHT"; };\n'
  );
  fs.writeFileSync(path.join(root, 'unselected.cjs'), 'module.exports = "UNRELATED";\n');
  const trace = path.join(root, 'selected-tests.jsonl');
  fs.writeFileSync(
    path.join(root, 'branches.test.js'),
    `
const fs=require('node:fs');
const {spawnCoveredSync}=require('./child-coverage.cjs');
for(const name of ['left','right']) test(name,()=>{
  const child=spawnCoveredSync(process.execPath,['-e','const m=require("./branches.cjs");process.stdout.write(m[process.argv[1]]());',name],{cwd:__dirname,encoding:'utf8',timeout:3000});
  const collector=globalThis.__stryker__;
  fs.appendFileSync(process.env.CAWS_TEST_SELECTION_TRACE,JSON.stringify({name,active:String(collector?.activeMutant??process.env.__STRYKER_ACTIVE_MUTANT__??''),testId:collector?.currentTestId??null,hits:collector?.mutantCoverage?.perTest?.[collector?.currentTestId]??{}})+'\\n');
  expect(child.status).toBe(0); expect(child.stderr).toBe(''); expect(child.stdout).toBe(name.toUpperCase());
});
test('unrelated',()=>{
  const change=${JSON.stringify(disruption)} === 'unrelated-replaced'
    ? 'globalThis.__stryker__.mutantCoverage = { static: {}, perTest: {} };' : '';
  const child=spawnCoveredSync(process.execPath,['-e',change+'process.stdout.write(require("./unselected.cjs"));','unrelated'],{cwd:__dirname,encoding:'utf8',timeout:3000});
  const collector=globalThis.__stryker__;
  fs.appendFileSync(process.env.CAWS_TEST_SELECTION_TRACE,JSON.stringify({name:'unrelated',active:String(collector?.activeMutant??process.env.__STRYKER_ACTIVE_MUTANT__??''),testId:collector?.currentTestId??null,hits:collector?.mutantCoverage?.perTest?.[collector?.currentTestId]??{}})+'\\n');
  expect(child.status).toBe(0); expect(child.stderr).toBe(''); expect(child.stdout).toBe('UNRELATED');
});
`
  );
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ private: true }));
  fs.writeFileSync(
    path.join(root, 'stryker.conf.cjs'),
    `module.exports={mutate:['branches.cjs'],testRunner:'jest',coverageAnalysis:'perTest',concurrency:1,reporters:['json'],jsonReporter:{fileName:'mutation-report.json'},tempDirName:'.stryker-canary-tmp',cleanTempDir:'always',timeoutMS:5000,jest:{projectType:'custom',configFile:'package.json',enableFindRelatedTests:false,config:{rootDir:'.',testEnvironment:'node',testMatch:['<rootDir>/branches.test.js'],verbose:false}}};`
  );
  const run = spawnSync(process.execPath, [strykerBin, 'run', 'stryker.conf.cjs'], {
    cwd: root,
    env: { ...process.env, CAWS_TEST_SELECTION_TRACE: trace },
    encoding: 'utf8',
    timeout: 60000,
    maxBuffer: 8 * 1024 * 1024,
  });
  fs.writeFileSync(path.join(root, 'run.log'), (run.stdout ?? '') + (run.stderr ?? ''));
  fs.writeFileSync(
    path.join(root, 'invocation.json'),
    JSON.stringify({
      command: [process.execPath, strykerBin, 'run', 'stryker.conf.cjs'],
      cwd: root,
      status: run.status,
      signal: run.signal,
      error: run.error?.message ?? null,
      hashes,
    })
  );
  return { root, run, trace };
}

test('actual child-only branch coverage selects and kills only its corresponding real test', () => {
  const { root, run, trace } = canary();
  expect(run.status).toBe(0);
  const report = JSON.parse(fs.readFileSync(path.join(root, 'mutation-report.json'), 'utf8'));
  const file = Object.values(report.files).find((value) => value.source.includes('exports.left'));
  expect(file.source).toContain('exports.right');
  const tests = Object.values(report.testFiles).flatMap((entry) => entry.tests);
  const leftTest = tests.find((test) => test.name === 'left');
  const rightTest = tests.find((test) => test.name === 'right');
  expect(leftTest.name).toBe('left');
  expect(rightTest.name).toBe('right');
  const left = file.mutants.find(
    (mutant) => mutant.location.start.line === 1 && mutant.mutatorName === 'StringLiteral'
  );
  const right = file.mutants.find(
    (mutant) => mutant.location.start.line === 2 && mutant.mutatorName === 'StringLiteral'
  );
  expect(left.status).toBe('Killed');
  expect(right.status).toBe('Killed');
  expect(left.coveredBy).toEqual([leftTest.id]);
  expect(right.coveredBy).toEqual([rightTest.id]);
  expect(left.killedBy).toEqual([leftTest.id]);
  expect(right.killedBy).toEqual([rightTest.id]);
  const observations = fs
    .readFileSync(trace, 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));
  expect(observations.filter((row) => row.active === left.id).map((row) => row.name)).toEqual([
    'left',
  ]);
  expect(observations.filter((row) => row.active === right.id).map((row) => row.name)).toEqual([
    'right',
  ]);
  const leftCoverage = observations.find((row) => row.active === '' && row.name === 'left');
  const rightCoverage = observations.find((row) => row.active === '' && row.name === 'right');
  expect(leftCoverage.testId).toBe('left');
  expect(rightCoverage.testId).toBe('right');
  expect(leftCoverage.hits[left.id]).toBeGreaterThan(0);
  expect(leftCoverage.hits[right.id]).toBeUndefined();
  expect(rightCoverage.hits[right.id]).toBeGreaterThan(0);
  expect(rightCoverage.hits[left.id]).toBeUndefined();
  const unrelated = observations.find((row) => row.active === '' && row.name === 'unrelated');
  expect(unrelated).toBeDefined();
  expect(unrelated.testId).toBe('unrelated');
  expect(unrelated.hits).toEqual({});
}, 120000);

test.each(['missing', 'unknown', 'unrelated-missing', 'unrelated-null', 'unrelated-replaced'])(
  '%s child coverage makes the actual baseline fail',
  (disruption) => {
    const { root, run } = canary(disruption);
    expect(run.status).not.toBe(0);
    expect(fs.readFileSync(path.join(root, 'run.log'), 'utf8')).toContain(
      'Invalid or missing child mutation coverage'
    );
    expect(fs.existsSync(path.join(root, 'mutation-report.json'))).toBe(false);
  },
  120000
);
