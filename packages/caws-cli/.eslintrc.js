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
    'no-unused-vars': ['error', { argsIgnorePattern: '^_', ignoreRestSiblings: true }],
    'node/no-missing-require': 'off',
    'node/no-extraneous-require': 'off',
    'node/no-unpublished-require': 'off',
    'node/shebang': 'off',
    'no-process-exit': 'off', // CLI tools need process.exit
  },
  overrides: [
    {
      files: ['src/**/*.js'],
      rules: {
        'no-console': 'off', // CLI source files need console output
        'no-process-exit': 'off', // CLI tools need process.exit
      },
    },
  ],
  ignorePatterns: ['node_modules/', 'dist/', 'build/'],
};
