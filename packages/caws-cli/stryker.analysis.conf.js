/** Child-process parser integration uses every test for each active mutant. */
const config = require('./scripts/stryker-config.cjs').createStrykerConfig('analysis');
// Core interprets testFiles as file-path filters, but the Jest runner interprets
// mutant testFilter values as test names. Jest's testMatch owns file selection.
delete config.testFiles;
// Literal-edit controls test their own pristine compiled snapshots. Instrumented
// Stryker source is a different snapshot and invalidates those edit anchors.
config.jest.config.testNamePattern = '^(?!.*semantic mutation in ).*$';
module.exports = config;
