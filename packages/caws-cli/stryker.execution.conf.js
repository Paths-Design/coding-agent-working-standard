/** Execution authority targets and per-file floors live in mutation-policy.json. */
module.exports = require('./scripts/stryker-config.cjs').createStrykerConfig('execution');
