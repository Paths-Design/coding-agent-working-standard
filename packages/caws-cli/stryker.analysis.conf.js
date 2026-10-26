/** Child-process parser integration uses every test for each active mutant. */
const config = require('./scripts/stryker-config.cjs').createStrykerConfig('analysis');
// Literal-edit controls test their own pristine compiled snapshots. Instrumented
// Stryker source is a different snapshot and invalidates those edit anchors.
// Match only that control group; ordinary source/data titles can contain its
// words or line breaks without being excluded from mutation checks.
config.jest.config.testNamePattern = '^(?!bounded shell analysis contract semantic mutation in )';
module.exports = config;
