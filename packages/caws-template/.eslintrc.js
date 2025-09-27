module.exports = {
  env: {
    node: true,
    es2021: true,
    jest: true,
  },
  extends: ['eslint:recommended', 'plugin:node/recommended', 'prettier'],
  parserOptions: {
    ecmaVersion: 2022,
    sourceType: 'module',
  },
  rules: {
    'no-console': 'off', // CLI tools need console output
    'no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
    'no-case-declarations': 'off', // CLI switch statements need lexical declarations
    'node/no-missing-require': 'off',
    'node/no-extraneous-require': 'off',
    'node/no-unpublished-require': 'off',
    'node/shebang': 'off',
    'no-process-exit': 'off', // CLI tools need process.exit
  },
  ignorePatterns: ['node_modules/', 'dist/', 'build/'],
};
