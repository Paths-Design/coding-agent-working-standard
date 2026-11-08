'use strict';

const { createHash } = require('node:crypto');

const SURFACES = Object.freeze(['kernel', 'store', 'shell', 'analysis', 'execution']);
const COMPLETION_JOBS = Object.freeze(['harness_integrity', 'mutation_plan', 'mutation']);
const digest = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
function need(value, message) {
  if (!value) throw new Error('mutation selection: ' + message);
}
function selectMutationScope(policy, surfaceId, target = null) {
  const surface = policy.surfaces?.[surfaceId];
  need(surface && typeof surface === 'object', 'unknown surface ' + surfaceId);
  need(Array.isArray(surface.targets) && surface.targets.length > 0, 'empty targets');
  const sources = surface.targets.map((entry) => entry.source);
  need(
    sources.every((source) => typeof source === 'string' && source.length > 0) &&
      new Set(sources).size === sources.length,
    'invalid or duplicate targets'
  );
  need(target === null || typeof target === 'string', 'invalid target selector');
  const targets =
    target === null ? surface.targets : surface.targets.filter((entry) => entry.source === target);
  need(
    target === null || targets.length === 1,
    'target is not an exact member of ' + surfaceId + ': ' + JSON.stringify(target)
  );
  return { surface, targets, selection: { surfaceId, target } };
}
function selectionDigest(selection) {
  return digest({ surfaceId: selection.surfaceId, target: selection.target });
}
function assertSelectionBinding(holder, expected) {
  const actual = holder?.selection;
  need(
    actual &&
      Object.keys(actual).sort().join(',') === 'surfaceId,target' &&
      actual.surfaceId === expected.surfaceId &&
      actual.target === expected.target,
    'selection differs from original invocation'
  );
  need(holder.selectionDigest === selectionDigest(expected), 'selection digest mismatch');
}
function mutationMatrix(policy) {
  need(
    Object.keys(policy.surfaces || {})
      .sort()
      .join(',') === [...SURFACES].sort().join(','),
    'matrix requires exactly five surfaces'
  );
  const sources = new Set(),
    ids = new Set(),
    include = [];
  for (const surfaceId of SURFACES) {
    const { surface } = selectMutationScope(policy, surfaceId);
    need(Array.isArray(surface.tests) && surface.tests.length > 0, 'empty tests');
    for (const { source } of surface.targets) {
      need(!sources.has(source), 'duplicate policy target ' + source);
      sources.add(source);
      const shard = digest({ surfaceId, target: source });
      need(!ids.has(shard), 'duplicate shard identity');
      ids.add(shard);
      include.push({ surface: surfaceId, target: source, shard });
    }
  }
  return { include };
}
function assertMutationMatrix(policy, matrix) {
  const expected = mutationMatrix(policy).include;
  need(
    matrix &&
      Object.keys(matrix).join(',') === 'include' &&
      Array.isArray(matrix.include) &&
      matrix.include.length === expected.length,
    'matrix target count mismatch'
  );
  const remaining = new Set(expected.map((entry) => JSON.stringify(entry)));
  for (const entry of matrix.include) {
    need(
      entry && Object.keys(entry).sort().join(',') === 'shard,surface,target',
      'invalid matrix entry'
    );
    need(
      remaining.delete(
        JSON.stringify({
          surface: entry.surface,
          target: entry.target,
          shard: entry.shard,
        })
      ),
      'duplicate, substituted or undeclared matrix cell'
    );
  }
  need(remaining.size === 0, 'missing matrix cell');
}
function assertFullMutationCompletion(needs) {
  for (const job of COMPLETION_JOBS)
    need(needs?.[job]?.result === 'success', job + ' did not complete successfully');
}
async function main(argv) {
  if (argv.length === 1 && argv[0] === '--assert-complete') {
    assertFullMutationCompletion(JSON.parse(process.env.CAWS_MUTATION_NEEDS || 'null'));
    console.log('All planned full mutation shards completed successfully.');
    return;
  }
  need(argv.length === 1 && argv[0] === '--matrix', 'expected --matrix or --assert-complete');
  const fs = require('node:fs'),
    path = require('node:path');
  const root = path.resolve(__dirname, '..');
  const policyFile = path.join(root, 'mutation-policy.json');
  const { validateMutationPolicy } = await import('./validate-mutation-policy.mjs');
  const validation = validateMutationPolicy({ root, policyFile });
  need(validation.errors.length === 0, validation.errors.join('\n'));
  const policy = JSON.parse(fs.readFileSync(policyFile, 'utf8'));
  const matrix = mutationMatrix(policy);
  assertMutationMatrix(policy, matrix);
  process.stdout.write('matrix=' + JSON.stringify(matrix) + '\n');
}
if (require.main === module)
  main(process.argv.slice(2)).catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
module.exports = {
  SURFACES,
  selectMutationScope,
  selectionDigest,
  assertSelectionBinding,
  mutationMatrix,
  assertMutationMatrix,
  assertFullMutationCompletion,
};
