'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');
const { spawnSync } = require('node:child_process');
const jestConfigRequire = Module.createRequire(require.resolve('jest-config'));
const merge = jestConfigRequire('deepmerge');

const vendor = path.resolve(__dirname, '../../scripts/vendor/deepmerge/index.cjs');
const repoRoot = path.resolve(__dirname, '../../../..');
const adapter = path.resolve(__dirname, '../../scripts/vendor/minimatch-legacy-adapter/index.cjs');
function packageAt(entry) {
  let directory = path.dirname(entry);
  for (;;) {
    const file = path.join(directory, 'package.json');
    if (fs.existsSync(file)) {
      const data = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (typeof data.name === 'string') return { directory, data };
    }
    const parent = path.dirname(directory);
    if (parent === directory) throw new Error('Missing package metadata: ' + entry);
    directory = parent;
  }
}

test('the real Jest consumer and root dependency load the maintained deepmerge bytes', () => {
  const entry = jestConfigRequire.resolve('deepmerge');
  expect(fs.readFileSync(entry)).toEqual(fs.readFileSync(vendor));
  expect(packageAt(entry).data).toMatchObject({
    name: '@paths.design/deepmerge',
    version: '4.3.1-caws.1',
    private: true,
  });
  expect(packageAt(require.resolve('jest-config')).data.version).toBe('30.5.1');
  expect(merge).toBe(require('deepmerge'));
});

test('every installed minimatch consumer resolves the reviewed adapter or patched upstream implementation', () => {
  const lock = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package-lock.json'), 'utf8'));
  const consumers = [];
  for (const [location, metadata] of Object.entries(lock.packages)) {
    if (metadata.link) continue;
    const dependencies = {
      ...metadata.dependencies,
      ...(location === '' ? metadata.devDependencies : {}),
    };
    if (!dependencies.minimatch) continue;
    const resolver = Module.createRequire(path.join(repoRoot, location, 'package.json'));
    const entry = resolver.resolve('minimatch');
    const loaded = resolver('minimatch');
    const actual = packageAt(entry).data;
    const parent =
      location === ''
        ? '<root>'
        : metadata.name || packageAt(path.join(repoRoot, location, 'package.json')).data.name;
    if (actual.name === '@paths.design/minimatch-legacy-adapter') {
      expect(actual).toMatchObject({ version: '1.0.0', private: true });
      expect(fs.readFileSync(entry)).toEqual(fs.readFileSync(adapter));
      const modernResolver = Module.createRequire(entry);
      const modern = modernResolver('minimatch-modern');
      expect(packageAt(modernResolver.resolve('minimatch-modern')).data).toMatchObject({
        name: 'minimatch',
        version: '11.0.4',
      });
      expect(loaded).toBe(modern.minimatch);
      expect(loaded.Minimatch).toBe(modern.Minimatch);
      consumers.push([parent, location === '' ? '' : metadata.version, 'adapter']);
    } else {
      expect(actual).toMatchObject({ name: 'minimatch', version: '11.0.4' });
      expect(typeof loaded.minimatch).toBe('function');
      expect(typeof loaded.Minimatch).toBe('function');
      consumers.push([parent, metadata.version, 'upstream']);
    }
  }
  expect(consumers.sort()).toEqual(
    [
      ['<root>', '', 'adapter'],
      ['eslint', '9.37.0', 'adapter'],
      ['@eslint/config-array', '0.21.0', 'adapter'],
      ['@eslint/eslintrc', '3.3.1', 'adapter'],
      ['glob', '14.0.3', 'upstream'],
      ['@stryker-mutator/core', '9.6.1', 'upstream'],
      ['@typescript-eslint/typescript-estree', '8.71.0', 'upstream'],
      ['test-exclude', '7.0.2', 'upstream'],
      ['test-exclude', '7.0.2', 'upstream'],
    ].sort()
  );
});

test.each(['eslint', '@eslint/config-array', '@eslint/eslintrc'])(
  '%s preserves the reviewed matcher operations',
  (parent) => {
    const resolver = Module.createRequire(require.resolve(parent));
    const { Minimatch } = resolver('minimatch');
    const cases = [
      ['src/**/*.js', { dot: true, allowWindowsEscape: true }, 'src/a.js', false, true],
      ['src/**/*.js', { dot: true, allowWindowsEscape: true }, 'src/a.ts', false, false],
      ['src/**/*.js', { dot: true }, 'src', true, true],
      ['src/**/*.js', { dot: true }, 'other', true, false],
      ['**/*.js', { dot: true }, '.hidden/a.js', false, true],
      ['**/*.js', { dot: false }, '.hidden/a.js', false, false],
      ['*.js', { dot: true, matchBase: true }, 'a/b.js', false, true],
      ['*.js', { dot: true, matchBase: true }, 'a/b.ts', false, false],
      ['!**/*.test.js', { dot: true, flipNegate: true }, 'src/a.test.js', false, true],
      ['!**/*.test.js', { dot: true, flipNegate: true }, 'src/a.js', false, false],
      ['src/*.{js,ts}', { dot: true }, 'src/a.ts', false, true],
      ['src/*.{js,ts}', { dot: true }, 'src/a.jsx', false, false],
      ['a/**/file.js', { dot: true }, 'a/b/c/file.js', false, true],
      ['src/literal\\[x\\].js', { allowWindowsEscape: true }, 'src/literal[x].js', false, true],
    ];
    for (const [pattern, options, candidate, partial, expected] of cases) {
      const matcher = new Minimatch(pattern, options);
      expect({ pattern, candidate, partial, matched: matcher.match(candidate, partial) }).toEqual({
        pattern,
        candidate,
        partial,
        matched: expected,
      });
      if (!pattern.startsWith('!')) expect(matcher.pattern).toBe(pattern);
    }
  }
);

test('installed CJS and ESM consumers preserve authored versus excluded lint behavior', () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'caws-matcher-consumers-')));
  try {
    const configArray = packageAt(require.resolve('@eslint/config-array')).directory;
    const eslintrc = packageAt(require.resolve('@eslint/eslintrc')).directory;
    const edges = ['eslint', '@eslint/config-array', '@eslint/eslintrc'].map((parent) =>
      Module.createRequire(require.resolve(parent)).resolve('minimatch')
    );
    const script = `
      import assert from 'node:assert/strict';
      import path from 'node:path';
      import { createRequire } from 'node:module';
      import { pathToFileURL } from 'node:url';
      const require = createRequire(${JSON.stringify(__filename)});
      const root = ${JSON.stringify(root)};
      const observations = { edges: [], configurations: [], lint: [] };
      for (const edge of ${JSON.stringify(edges)}) {
        const loaded = require(edge);
        const imported = await import(pathToFileURL(edge));
        assert.equal(imported.default, loaded);
        const modern = createRequire(edge)('minimatch-modern');
        assert.equal(loaded, modern.minimatch);
        assert.equal(loaded.Minimatch, modern.Minimatch);
        observations.edges.push({ edge, defaultInterop: true });
      }
      require('@eslint/config-array');
      require('@eslint/eslintrc');
      const { ConfigArray } = await import(pathToFileURL(${JSON.stringify(path.join(configArray, 'dist/esm/index.js'))}));
      const configs = new ConfigArray([{ files: ['src/**/*.js'], ignores: ['**/*.test.js'] }], { basePath: root });
      await configs.normalize();
      for (const [file, status] of [['src/a.js','matched'],['src/a.test.js','unconfigured'],['other/a.js','unconfigured']]) {
        const actual = configs.getConfigWithStatus(path.join(root,file)).status;
        assert.equal(actual,status);
        observations.configurations.push({ file, status: actual });
      }
      const eslintrcModule = await import(pathToFileURL(${JSON.stringify(path.join(eslintrc, 'lib/index.js'))}));
      const compat = new eslintrcModule.FlatCompat({ baseDirectory: root });
      const translated = compat.config({ overrides: [{ files: ['src/**/*.js'], excludedFiles: ['**/*.test.js'], rules: { 'no-unused-vars': 'error' } }] });
      const scoped = translated.find(config => config.files && typeof config.files[0] === 'function');
      assert.ok(scoped);
      assert.equal(scoped.files[0](path.join(root,'src/a.js')),true);
      assert.equal(scoped.files[0](path.join(root,'src/a.test.js')),false);
      const { loadESLint } = require('eslint');
      for (const flat of [true,false]) {
        const ESLint = await loadESLint({useFlatConfig:flat});
        const options = flat
          ? {cwd:root,overrideConfigFile:true,overrideConfig:[{languageOptions:{ecmaVersion:2022}},{files:['**/*.js'],ignores:['**/*.test.js'],rules:{'no-unused-vars':'error'}}]}
          : {cwd:root,useEslintrc:false,overrideConfig:{parserOptions:{ecmaVersion:2022},overrides:[{files:['**/*.js'],excludedFiles:['**/*.test.js'],rules:{'no-unused-vars':'error'}}]}};
        const lint = new ESLint(options);
        for (const [file,expected] of [['src/a.js',['no-unused-vars']],['src/a.test.js',[]]]) {
          const results = await lint.lintText('const probe = 1;', {filePath:path.join(root,file),warnIgnored:false});
          const messages = results.flatMap(result => result.messages);
          assert.ok(messages.every(message => !message.fatal && message.ruleId !== null));
          assert.deepEqual(messages.map(message => message.ruleId),expected);
          observations.lint.push({flat,file,messages});
        }
      }
      console.log(JSON.stringify(observations));
    `;
    const args = ['--input-type=module', '-e', script];
    const observed = spawnSync(process.execPath, args, {
      cwd: root,
      encoding: 'utf8',
      env: { ...process.env, FORCE_COLOR: '0' },
    });
    if (process.env.CAWS_RELEASE_ARTIFACT_DIR) {
      fs.mkdirSync(process.env.CAWS_RELEASE_ARTIFACT_DIR, { recursive: true });
      fs.writeFileSync(
        path.join(process.env.CAWS_RELEASE_ARTIFACT_DIR, 'matcher-consumers.json'),
        JSON.stringify(
          {
            command: [process.execPath, ...args],
            cwd: root,
            status: observed.status,
            signal: observed.signal,
            stdout: observed.stdout,
            stderr: observed.stderr,
          },
          null,
          2
        )
      );
    }
    expect(observed.error).toBeUndefined();
    expect(observed.signal).toBeNull();
    expect(observed.status).toBe(0);
    const observations = JSON.parse(observed.stdout);
    expect(observations.edges).toHaveLength(3);
    expect(observations.configurations).toHaveLength(3);
    expect(observations.lint).toHaveLength(4);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
const poison = () => JSON.parse('{"useful":2,"__proto__":{"cawsPoison":true}}');
function assertOrdinary(value) {
  expect(Object.getPrototypeOf(value)).toBe(Object.prototype);
  expect(Object.hasOwn(value, '__proto__')).toBe(false);
  expect(value.cawsPoison).toBeUndefined();
  expect(Object.prototype.cawsPoison).toBeUndefined();
}

test.each([
  [
    'source',
    () => [Object.assign(Object.create(null), { retained: 1 }), poison()],
    { retained: 1, useful: 2 },
    (result) => result,
  ],
  ['target', () => [poison(), { retained: 1 }], { retained: 1, useful: 2 }, (result) => result],
  [
    'nested null placeholder',
    () => [{ retained: 1, settings: null }, { settings: poison() }],
    { retained: 1, settings: { useful: 2 } },
    (result) => result.settings,
  ],
])('prototype safety: %s cannot poison the returned object', (_label, inputs, expected, select) => {
  const [target, source] = inputs();
  const before = [JSON.stringify(target), JSON.stringify(source)];
  const prototypes = [Object.getPrototypeOf(target), Object.getPrototypeOf(source)];
  const result = merge(target, source);
  expect(result).toEqual(expected);
  assertOrdinary(select(result));
  expect([JSON.stringify(target), JSON.stringify(source)]).toEqual(before);
  expect(Object.getPrototypeOf(target)).toBe(prototypes[0]);
  expect(Object.getPrototypeOf(source)).toBe(prototypes[1]);
});

test.each(['target', 'source'])('prototype safety: forbidden %s getter is never read', (side) => {
  const attack = Object.create(null);
  attack.useful = 2;
  const read = jest.fn(() => {
    throw new Error('forbidden getter was read');
  });
  Object.defineProperty(attack, '__proto__', { enumerable: true, get: read });
  const result = side === 'target' ? merge(attack, {}) : merge(Object.create(null), attack);
  assertOrdinary(result);
  expect(result).toEqual({ useful: 2 });
  expect(read).not.toHaveBeenCalled();
  expect(Object.getOwnPropertyDescriptor(attack, '__proto__').get).toBe(read);
});

test('prototype safety also applies during array cloning and all()', () => {
  const values = merge([], [poison()]);
  expect(values).toHaveLength(1);
  expect(values).toEqual([{ useful: 2 }]);
  assertOrdinary(values[0]);
  const result = merge.all([poison(), { useful: true }]);
  assertOrdinary(result);
  expect(result).toEqual({ useful: true });
});

test('each object-copy guard has an independent failing control', () => {
  const source = fs.readFileSync(vendor, 'utf8');
  const variants = [
    [
      source.replace(/if \(propertyIsForbidden\(key\)\) \{\s*return;?\s*\}/, ''),
      () => [poison(), {}],
    ],
    [
      source.replace(
        'propertyIsForbidden(key) || propertyIsUnsafe(target, key)',
        'propertyIsUnsafe(target, key)'
      ),
      () => [Object.create(null), poison()],
    ],
  ];
  for (const [bytes, inputs] of variants) {
    expect(bytes).not.toBe(source);
    const loaded = new Module(vendor, module);
    loaded.filename = vendor;
    loaded._compile(bytes, vendor);
    const result = loaded.exports(...inputs());
    expect(Object.getPrototypeOf(result)).not.toBe(Object.prototype);
    expect(result.cawsPoison).toBe(true);
    expect(Object.prototype.cawsPoison).toBeUndefined();
  }
});

test('ordinary merging preserves null placeholders, own fields, and clone identity', () => {
  const source = { object: { value: 7 }, list: [{ value: 9 }], empty: undefined };
  const result = merge({ object: null, list: [1] }, source);
  expect(result).toEqual({ object: { value: 7 }, list: [1, { value: 9 }], empty: undefined });
  expect(Object.hasOwn(result, 'empty')).toBe(true);
  expect(result.object).not.toBe(source.object);
  expect(result.list[1]).not.toBe(source.list[0]);
  const shared = merge({}, source, { clone: false });
  expect(shared.object).toBe(source.object);
  expect(shared.list).toBe(source.list);
  const symbol = Symbol('enumerable');
  const input = Object.assign(Object.create({ inherited: true }), { own: 1, [symbol]: 2 });
  Object.defineProperty(input, 'hidden', { value: 3 });
  const copied = merge({}, input);
  expect(copied).toEqual({ own: 1, [symbol]: 2 });
  expect(Object.hasOwn(copied, 'inherited')).toBe(false);
  expect(Object.hasOwn(copied, 'hidden')).toBe(false);
});

test('arrays, special values, and caller-supplied merge options retain their contracts', () => {
  const left = Array(2),
    right = Array(2);
  left[1] = 1;
  right[1] = 2;
  const sparse = merge(left, right);
  expect(sparse).toHaveLength(4);
  expect(Object.keys(sparse)).toEqual(['1', '3']);
  const date = new Date('2020-01-01T00:00:00Z');
  const regex = /probe/;
  const react = { $$typeof: Symbol.for('react.element'), props: {} };
  const result = merge({}, { date, regex, react });
  expect(result.date).toBe(date);
  expect(result.regex).toBe(regex);
  expect(result.react).toBe(react);
  const atom = { value: 1 };
  const customObject = merge(
    {},
    { atom },
    { isMergeableObject: (value) => Boolean(value && value !== atom && typeof value === 'object') }
  );
  expect(customObject.atom).toBe(atom);
  expect(
    merge(
      { values: [1] },
      { values: [2] },
      {
        customMerge: (key) => (key === 'values' ? (left, right) => [...right, ...left] : undefined),
      }
    )
  ).toEqual({ values: [2, 1] });
  const arrayMerge = jest.fn((left, right, options) =>
    right.map((value) => options.cloneUnlessOtherwiseSpecified(value, options))
  );
  const customArray = merge([1], [atom], { arrayMerge });
  expect(arrayMerge).toHaveBeenCalledTimes(1);
  expect(customArray).toEqual([atom]);
  expect(customArray[0]).not.toBe(atom);
  expect(merge.all([{ values: [1] }, { values: [2], enabled: true }])).toEqual({
    values: [1, 2],
    enabled: true,
  });
  expect(() => merge.all({})).toThrow('first argument should be an array');
  const nested = merge(
    {},
    JSON.parse('{"constructor":{"prototype":{"cawsPoison":true}},"prototype":{"data":1}}')
  );
  assertOrdinary(nested);
  expect(Object.hasOwn(nested, 'constructor')).toBe(false);
  expect(nested.prototype).toEqual({ data: 1 });
});

test('the installed Jest merges real preset globals and executes the resulting configuration', () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'caws-merge-config-')));
  try {
    fs.writeFileSync(
      path.join(root, 'preset.js'),
      'module.exports={globals:{policy:{left:1,values:[1]}}};\n'
    );
    fs.writeFileSync(
      path.join(root, 'jest.config.json'),
      JSON.stringify({
        rootDir: root,
        preset: './preset.js',
        globals: { policy: { right: 2, values: [2] } },
        testEnvironment: 'node',
        testMatch: ['<rootDir>/merged.test.js'],
      })
    );
    fs.writeFileSync(
      path.join(root, 'merged.test.js'),
      "test('merged globals',()=>expect(globalThis.policy).toEqual({left:1,right:2,values:[1,2]}));\n"
    );
    const args = [
      require.resolve('jest/bin/jest'),
      '--config',
      path.join(root, 'jest.config.json'),
      '--runInBand',
      '--no-cache',
    ];
    const observed = spawnSync(process.execPath, args, {
      cwd: root,
      encoding: 'utf8',
      env: { ...process.env, FORCE_COLOR: '0' },
    });
    if (process.env.CAWS_RELEASE_ARTIFACT_DIR) {
      fs.mkdirSync(process.env.CAWS_RELEASE_ARTIFACT_DIR, { recursive: true });
      fs.writeFileSync(
        path.join(process.env.CAWS_RELEASE_ARTIFACT_DIR, 'deepmerge-jest-config.json'),
        JSON.stringify(
          {
            command: [process.execPath, ...args],
            cwd: root,
            status: observed.status,
            signal: observed.signal,
            stdout: observed.stdout,
            stderr: observed.stderr,
          },
          null,
          2
        )
      );
    }
    expect(observed.error).toBeUndefined();
    expect(observed.signal).toBeNull();
    expect(observed.status).toBe(0);
    expect(observed.stderr).toMatch(/1 passed/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
