'use strict';

// Component probe of a selected Qwen host's real pre-tool function. It does
// not invoke a model, run a tool, authenticate a publisher, or prove end-to-end
// enforcement. A fail-open result is an explicit failing verdict.
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { setTimeout, clearTimeout } = require('node:timers');
const { verifyHostTree } = require('./native-qualification-host-tree.cjs');

async function probe(hostRoot, expectedDigest) {
  if (!path.isAbsolute(hostRoot) || path.resolve(hostRoot) !== hostRoot)
    throw new Error('Expected a normalized absolute host tree');
  const before = verifyHostTree(hostRoot, expectedDigest);
  const packageFile = path.join(hostRoot, '@qwen-code/qwen-code/package.json');
  const version = require(packageFile).version;
  if (version !== '0.21.14') throw new Error('Unexpected Qwen package version');
  const moduleFile = path.join(hostRoot, '@qwen-code/qwen-code/chunks/chunk-OFTPCOGR.js');
  const { firePreToolUseHook } = await import(pathToFileURL(moduleFile).href);
  if (typeof firePreToolUseHook !== 'function') throw new Error('Missing Qwen pre-tool function');
  const invoke = (bus) =>
    firePreToolUseHook(
      bus,
      'write_file',
      { file_path: '/fixture/protected' },
      'hook-id',
      'default',
      undefined,
      'call-id'
    );
  const failed = await invoke({
    request: async () => ({ success: false, error: new Error('fixture transport failure') }),
  });
  const missing = await invoke({ request: async () => ({ success: true }) });
  const thrown = await invoke({
    request: async () => {
      throw new Error('fixture transport exception');
    },
  });
  const denied = await invoke({
    request: async () => ({
      success: true,
      output: {
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: 'deny',
          permissionDecisionReason: 'fixture refusal',
        },
      },
    }),
  });
  const after = verifyHostTree(hostRoot, expectedDigest);
  const cases = {
    failedTransportProceeds: failed.shouldProceed,
    missingOutputProceeds: missing.shouldProceed,
    thrownTransportProceeds: thrown.shouldProceed,
    explicitDenialProceeds: denied.shouldProceed,
    explicitDenialType: denied.blockType,
  };
  if (
    ![
      cases.failedTransportProceeds,
      cases.missingOutputProceeds,
      cases.thrownTransportProceeds,
      cases.explicitDenialProceeds,
    ].every((value) => typeof value === 'boolean')
  )
    throw new Error('Unexpected Qwen pre-tool result shape');
  return {
    schema: 'caws.qualification.qwen-hook-failure.v1',
    hostVersion: version,
    hostTreeDigest: before.digest,
    hostTreeReadback: after.digest,
    nodeVersion: process.version,
    boundary: 'real-host-function-with-stub-transport',
    cases,
    safeForFailClosed:
      !cases.failedTransportProceeds &&
      !cases.missingOutputProceeds &&
      !cases.thrownTransportProceeds &&
      !cases.explicitDenialProceeds &&
      cases.explicitDenialType === 'denied',
  };
}

if (require.main === module) {
  // Only a fresh process can bind Node's module cache to the supplied digest.
  // An unsettleable component is an incomplete result, never success.
  process.exitCode = 2;
  const [root, digest, ...extra] = process.argv.slice(2);
  if (!root || !digest || extra.length || process.execArgv.length || process.env.NODE_OPTIONS) {
    process.stderr.write('Expected absolute host-tree path and expected SHA256\n');
  } else {
    const timer = setTimeout(() => {
      process.stderr.write('Qwen hook failure probe did not settle\n');
      process.exit(2);
    }, 5000);
    probe(root, digest).then(
      (observation) => {
        clearTimeout(timer);
        process.stdout.write(JSON.stringify(observation) + '\n');
        process.exitCode = observation.safeForFailClosed ? 0 : 1;
      },
      (error) => {
        clearTimeout(timer);
        process.stderr.write('Qwen hook failure probe incomplete: ' + String(error) + '\n');
        process.exitCode = 2;
      }
    );
  }
}
