const js = require('@eslint/js');
const tseslint = require('typescript-eslint');

// TS-family globs shared by the tseslint blocks below. templates/ is included:
// hook-pack templates are shipped consumer code, not docs.
const TS_GLOBS = ['src/**/*.ts', 'tests/**/*.ts', 'templates/**/*.ts'];
// The runtime Node globals both blocks need. (eslint-plugin-node is gone; its
// env presets died with .eslintrc.js.)
const NODE_GLOBALS = {
  console: 'readonly',
  process: 'readonly',
  __dirname: 'readonly',
  __filename: 'readonly',
  require: 'readonly',
  module: 'readonly',
  exports: 'writable',
  Buffer: 'readonly',
  setImmediate: 'readonly',
  clearImmediate: 'readonly',
};

module.exports = [
  // Ignore patterns
  {
    ignores: ['node_modules/**', 'dist/**', 'build/**', 'coverage/**', '.stryker*-tmp/**', 'test-*/**', '**/.venv/**'],
  },

  // Base configuration (JS family). `eslint .` lints every file some block
  // matches, so *.mjs/*.cjs MUST be listed explicitly — an unmatched file is
  // silently linted with zero rules (verified: a planted no-unused-vars +
  // no-constant-condition violation in scripts/*.mjs passed before this).
  {
    files: ['**/*.js', '**/*.mjs', '**/*.cjs'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: NODE_GLOBALS,
    },
    rules: {
      ...js.configs.recommended.rules,
      'no-console': 'off', // CLI tools need console output
      'no-unused-vars': ['error', { argsIgnorePattern: '^_', caughtErrors: 'none', ignoreRestSiblings: true }],
      'no-process-exit': 'off', // CLI tools need process.exit
    },
  },

  // TypeScript configuration (vNext shell + store, kernel tests, templates)
  // Slice 8a1: TS lint coverage for the new shell/store TS code that
  // was previously typechecked but never linted. Recommended config
  // only — no type-aware rules, so this stays fast and doesn't need a
  // tsconfig path resolved here.
  ...tseslint.configs.recommended.map((cfg) => ({
    ...cfg,
    files: TS_GLOBS,
  })),
  {
    files: TS_GLOBS,
    languageOptions: {
      globals: NODE_GLOBALS,
    },
    rules: {
      'no-console': 'off',
      // Defer to TS itself for unused vars; @typescript-eslint/no-unused-vars
      // double-flags `_`-prefixed args without an opt-in pattern.
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', caughtErrors: 'none', ignoreRestSiblings: true },
      ],
      'no-unused-vars': 'off',
    },
  },

  // Test files configuration
  {
    files: ['tests/**/*.js'],
    languageOptions: {
      globals: {
        describe: 'readonly',
        it: 'readonly',
        test: 'readonly',
        expect: 'readonly',
        beforeAll: 'readonly',
        afterAll: 'readonly',
        beforeEach: 'readonly',
        afterEach: 'readonly',
        jest: 'readonly',
        performance: 'readonly',
      },
    },
  },
];
