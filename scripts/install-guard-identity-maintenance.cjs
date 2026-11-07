'use strict';

// Reproduce the compatible runtime before applying the existing canonical-scope
// repair. Publication uses the retained installer; installed snapshots stay immutable.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');

const BASE = '7be8065a4c48620937351dc12b9b205ac870d1d1bd553b945e1adb99472aaf36';
const REPAIR = '199b65af8dbe09afd9165836a510c02509415849';
const GUARD = 'scope-guard.sh';
const SOURCE = 'packages/caws-cli/templates/hook-packs/shared/' + GUARD;
const BEFORE = '8b898cc940209a04d1d328264137c50d1498bc7a2e242b52cdc03b71fad06a6e';
const AFTER = '0d2776b09158753a05cb77e4e62fdcd05ac3943a9938aa5c24c63ca546cf3e3c';
const INSTALLER = 'c2c13338450d28cd8e1eca2f10adb8f5dc6333a6a14fdf87733b5056eb7f8f90';
const sha = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');
const read = (file) => {
  assert.equal(fs.realpathSync(file), path.resolve(file), 'Physical input path required');
  assert(fs.lstatSync(file).isFile(), 'Regular input file required');
  return fs.readFileSync(file);
};
function snapshot(home, digest) {
  assert.match(digest, /^[a-f0-9]{64}$/);
  const root = path.join(home, 'lib/runtimes', digest);
  const bytes = read(path.join(root, 'manifest.json'));
  assert.equal(sha(bytes), digest, 'Manifest digest mismatch');
  const manifest = JSON.parse(bytes);
  for (const [member, pin] of Object.entries(manifest)) {
    assert(member && !path.isAbsolute(member) && !member.split('/').includes('..'));
    assert.equal(sha(read(path.join(root, member))), pin, 'Member changed: ' + member);
  }
  return manifest;
}
function verifyDelta(before, after) {
  assert.deepEqual(Object.keys(after).sort(), Object.keys(before).sort(), 'Membership changed');
  assert.equal(before[GUARD], BEFORE, 'Unexpected scope-guard baseline');
  assert.equal(after[GUARD], AFTER, 'Unexpected scope-guard repair');
  const changed = Object.keys(before).filter((name) => before[name] !== after[name]);
  assert.deepEqual(changed, [GUARD], 'Unrelated runtime change');
  return changed;
}
function installer(file) {
  assert.equal(sha(read(file)), INSTALLER, 'Unexpected retained installer');
  return require(file);
}
function pointer(home) {
  return JSON.parse(read(path.join(home, 'state/adapter-runtime.json')));
}
function prepare(options) {
  const { state, templates, machine, apiPath } = options;
  assert(!fs.existsSync(state), 'Preserve prior attempts: state directory already exists');
  const api = installer(apiPath);
  assert.equal(pointer(machine).digest, BASE, 'Selected runtime changed');
  const before = snapshot(machine, BASE);
  const privateHome = path.join(state, 'machine');
  assert.equal(api.installMachineRuntime({ home: privateHome, templatesRoot: templates, plan: true }).digest, BASE,
    'Retained templates do not reproduce the compatible baseline');
  fs.mkdirSync(state, { recursive: true });
  const exported = path.join(state, 'templates');
  fs.cpSync(templates, exported, { recursive: true, errorOnExist: true, force: false });
  assert.equal(api.installMachineRuntime({ home: privateHome, templatesRoot: exported }).digest, BASE);
  assert.deepEqual(snapshot(privateHome, BASE), before);
  const repaired = execFileSync('git', ['show', REPAIR + ':' + SOURCE], {
    cwd: path.resolve(__dirname, '..'), maxBuffer: 1024 * 1024,
  });
  assert.equal(sha(repaired), AFTER, 'Repair source bytes changed');
  fs.writeFileSync(path.join(exported, 'shared', GUARD), repaired);
  const selected = api.installMachineRuntime({ home: privateHome, templatesRoot: exported });
  const after = snapshot(privateHome, selected.digest);
  const changed = verifyDelta(before, after);
  const build = { schema: 'caws.guard-identity-maintenance.v1', baseline: BASE,
    repairCommit: REPAIR, digest: selected.digest, changed, members: Object.keys(after).length,
    apiPath, templates: exported, privateHome, machine };
  fs.writeFileSync(path.join(state, 'build.json'), JSON.stringify(build, null, 2) + '\n', { flag: 'wx' });
  return build;
}
function activate(state, expectedDigest, expectedMachine) {
  const build = JSON.parse(read(path.join(state, 'build.json')));
  assert.equal(build.schema, 'caws.guard-identity-maintenance.v1');
  assert.equal(build.baseline, BASE);
  assert.equal(build.repairCommit, REPAIR);
  assert.equal(build.digest, expectedDigest, 'Explicit qualified candidate identity required');
  assert.equal(build.machine, expectedMachine, 'Explicit target machine identity required');
  assert.equal(build.templates, path.join(state, 'templates'));
  assert.equal(build.privateHome, path.join(state, 'machine'));
  const api = installer(build.apiPath);
  assert.equal(pointer(build.machine).digest, BASE, 'Selected runtime changed since qualification');
  assert.equal(pointer(build.privateHome).digest, expectedDigest, 'Private candidate not selected');
  verifyDelta(snapshot(build.machine, BASE), snapshot(build.privateHome, expectedDigest));
  const options = { home: build.machine, templatesRoot: build.templates };
  assert.equal(api.installMachineRuntime({ ...options, plan: true }).digest, expectedDigest,
    'Candidate inputs changed since qualification');
  const selected = api.installMachineRuntime(options);
  assert.equal(selected.digest, expectedDigest);
  assert.equal(selected.previousDigest, BASE);
  snapshot(build.machine, expectedDigest);
  return selected;
}

module.exports = { BASE, REPAIR, BEFORE, AFTER, sha, snapshot, verifyDelta, installer, pointer, prepare, activate };
if (require.main === module) {
  try {
    const [operation, ...args] = process.argv.slice(2);
    const options = {};
    for (let i = 0; i < args.length; i += 2) {
      assert(['--state', '--templates', '--machine', '--api-path', '--digest'].includes(args[i]) && args[i + 1],
        'Expected named maintenance inputs');
      const key = args[i].slice(2).replace('-p', 'P');
      assert(!Object.hasOwn(options, key), 'Duplicate argument');
      options[key] = args[i + 1];
    }
    for (const [key, value] of Object.entries(options))
      if (key !== 'digest') assert(path.isAbsolute(value), 'Absolute paths required');
    assert(['prepare', 'activate'].includes(operation), 'Expected prepare or activate');
    const result = operation === 'prepare' ? prepare(options) : activate(options.state, options.digest, options.machine);
    console.log(JSON.stringify(result, null, 2));
  } catch (error) {
    console.error(error.stack);
    process.exitCode = 1;
  }
}
