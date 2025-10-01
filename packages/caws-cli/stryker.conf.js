module.exports = function(config) {
    config.set({
      mutate: [
        'src/**/*.js',
        '!src/**/*.test.js',
        '!src/**/*.spec.js'
      ],
      mutator: 'javascript',
      testRunner: 'jest',
      jest: {
        config: require('./jest.config.js')
      },
      reporter: [
        'html',
        'json',
        'clear-text'
      ],
      coverageAnalysis: 'off',
      thresholds: {
        high: 80,
        low: 60,
        break: 50
      },
      maxConcurrentTestRunners: 2,
      timeoutMS: 300000
    });
  };