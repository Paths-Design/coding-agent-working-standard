'use strict';
const {
  preparedEnvironment,
  ENV,
} = require('../../scripts/lib/native-test-prerequisite-receipt.cjs');
// Jest runs globalSetup before creating its scheduler and worker processes.
// Missing preparation leaves the variable absent: selected filesystem probes
// still fail their mandatory prerequisite; pure port tests remain independent.
module.exports = async (_globalConfig, projectConfig) => {
  const env = preparedEnvironment(projectConfig.rootDir, process.env);
  if (Object.hasOwn(env, ENV)) process.env[ENV] = env[ENV];
  else delete process.env[ENV];
};
