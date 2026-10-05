/** Kernel mutation config. Canonical target/test policy lives in mutation-policy.json. */
module.exports = require('./scripts/stryker-config.cjs').createStrykerConfig('kernel');
