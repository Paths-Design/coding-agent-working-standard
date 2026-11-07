const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

// Bounded qualification fixtures retain raw observations, stop on first failure,
// and never derive signal authority from a process listing.
module.exports = function runtimeAssetFixture() {
  const artifactRoot =
    process.env.CAWS_RUNTIME_ASSET_ARTIFACT_ROOT ||
    (process.env.CAWS_TEST_ARTIFACT_DIR &&
      path.join(process.env.CAWS_TEST_ARTIFACT_DIR, 'runtime-assets'));
  if (artifactRoot && !path.isAbsolute(artifactRoot))
    throw new Error('Artifact root must be absolute');
  const roots = new Set();
  const processGroups = new Set();
  let firstFailure;
  let sequence = 0;
  const nonclaims = [
    'Group absence does not establish escaped-session descendant settlement.',
    'Observed group IDs are not birth-pinned; reuse can conservatively retain fixtures.',
    'Timeout may terminate the directly spawned child; descendant settlement remains unproven.',
    'No process-scan-derived signals are sent.',
  ];
  const preserve = (error) => {
    if (firstFailure) return;
    firstFailure = String(error);
    console.error(
      'Preserved runtime asset fixtures: ' + JSON.stringify([...roots]) + '\n' + firstFailure
    );
    if (artifactRoot) {
      fs.mkdirSync(artifactRoot, { recursive: true });
      // Keep executed fixtures in their original temp location. Copy only their
      // raw command receipts into CI's uploaded tree; moving fixtures beneath
      // the checkout would change Git/CAWS ancestor discovery.
      const copiedReceipts = [];
      for (const [index, root] of [...roots].entries()) {
        const source = path.join(root, 'receipts');
        if (!fs.existsSync(source)) continue;
        const destination = path.join(artifactRoot, 'command-receipts', `${process.pid}-${index}`);
        try {
          fs.mkdirSync(path.dirname(destination), { recursive: true, mode: 0o700 });
          fs.cpSync(source, destination, {
            recursive: true,
            dereference: false,
            force: false,
            errorOnExist: true,
          });
          copiedReceipts.push({ executedRoot: root, source, destination });
        } catch (copyError) {
          console.error('Raw command receipt retention failed:', source, copyError.message);
          copiedReceipts.push({
            executedRoot: root,
            source,
            destination,
            error: copyError.message,
          });
        }
      }
      fs.appendFileSync(
        path.join(artifactRoot, 'preserved-roots.jsonl'),
        JSON.stringify({
          executedRoots: [...roots],
          copiedReceipts,
          reason: firstFailure,
          cleanup: 'not attempted',
          nonclaims,
        }) + '\n'
      );
    }
  };
  const scenario = (name, body) =>
    test(name, () => {
      if (firstFailure)
        throw new Error('Scenario not executed after earlier failure: ' + firstFailure);
      try {
        return body();
      } catch (error) {
        preserve(error);
        throw error;
      }
    });
  const temporaryRoot = () => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'caws-runtime-assets-')));
    roots.add(root);
    return root;
  };
  const invoke = (root, executable, args, input = Buffer.alloc(0), options = {}) => {
    if (!['darwin', 'linux'].includes(process.platform)) {
      const error = new Error('Fixture process-group observation is unsupported on this host');
      preserve(error);
      throw error;
    }
    const receipt = path.join(root, 'receipts', String(++sequence).padStart(4, '0'));
    fs.mkdirSync(receipt, { recursive: true });
    const timeout = options.timeoutMs ?? 10000;
    const cwd = options.cwd ?? root;
    fs.writeFileSync(path.join(receipt, 'stdin.bin'), input);
    fs.writeFileSync(
      path.join(receipt, 'command.json'),
      JSON.stringify(
        {
          argv: [executable, ...args],
          cwd,
          timeoutMs: timeout,
          timeoutKillSignal: 'SIGTERM',
          nonclaims,
        },
        null,
        2
      )
    );
    const result = spawnSync(executable, args, {
      cwd,
      env: options.env ?? { HOME: root, PATH: '' },
      input,
      timeout,
      killSignal: 'SIGTERM',
      maxBuffer: 8 * 1024 * 1024,
      detached: true,
    });
    if (Number.isSafeInteger(result.pid) && result.pid > 0) processGroups.add(result.pid);
    fs.writeFileSync(path.join(receipt, 'stdout.bin'), result.stdout ?? Buffer.alloc(0));
    fs.writeFileSync(path.join(receipt, 'stderr.bin'), result.stderr ?? Buffer.alloc(0));
    fs.writeFileSync(
      path.join(receipt, 'status.json'),
      JSON.stringify(
        {
          pid: result.pid,
          status: result.status,
          signal: result.signal,
          error: result.error ? String(result.error) : null,
        },
        null,
        2
      )
    );
    if (
      result.error ||
      result.signal !== null ||
      !Number.isInteger(result.status) ||
      !Number.isSafeInteger(result.pid) ||
      result.pid <= 0
    ) {
      const error = new Error('Unknown subprocess outcome; inspect ' + receipt);
      preserve(error);
      throw error;
    }
    return { ...result, receipt };
  };
  const succeeds = (result) =>
    expect({ status: result.status, signal: result.signal, error: result.error }).toEqual({
      status: 0,
      signal: null,
      error: undefined,
    });
  const refuses = (result) => {
    expect(result.error).toBeUndefined();
    expect(result.signal).toBeNull();
    expect(result.status).toBeGreaterThan(0);
  };
  const snapshot = (file) => {
    const stat = fs.statSync(file, { bigint: true });
    return { bytes: fs.readFileSync(file), mode: stat.mode, mtimeNs: stat.mtimeNs };
  };
  const cleanup = () => {
    if (firstFailure || !roots.size) return;
    try {
      const liveRoots = [...roots];
      // Do not use invoke: its raw receipt would retain unrelated processes.
      // Only numeric identity columns are inspected, never process arguments.
      const argv = ['-axo', 'pid=,ppid=,pgid='];
      const observation = spawnSync('/bin/ps', argv, {
        encoding: 'utf8',
        timeout: 10000,
        maxBuffer: 8 * 1024 * 1024,
        env: { PATH: '/usr/bin:/bin', LC_ALL: 'C' },
      });
      if (
        observation.error ||
        observation.signal !== null ||
        observation.status !== 0 ||
        observation.stderr !== ''
      )
        throw new Error('Fixture process-group observation failed');
      const matches = [];
      for (const line of observation.stdout.split('\n')) {
        if (!line.trim()) continue;
        const columns = line.match(/^\s*(\d+)\s+(\d+)\s+(\d+)\s*$/);
        if (!columns) throw new Error('Unparseable fixture process-group observation');
        const pgid = Number(columns[3]);
        if (processGroups.has(pgid))
          matches.push({ pid: Number(columns[1]), ppid: Number(columns[2]), pgid });
      }
      for (const root of liveRoots)
        fs.writeFileSync(
          path.join(root, 'postcase-processes.json'),
          JSON.stringify(
            {
              command: ['/bin/ps', ...argv],
              status: observation.status,
              groupIds: [...processGroups],
              executedRoots: liveRoots,
              matches,
              nonclaims,
            },
            null,
            2
          )
        );
      if (matches.length)
        throw new Error('Fixture process group still has members; roots retained');
      if (artifactRoot) {
        fs.mkdirSync(artifactRoot, { recursive: true });
        for (const root of liveRoots) {
          const retainedRoot = path.join(artifactRoot, path.basename(root));
          if (fs.existsSync(retainedRoot)) throw new Error('Refusing to overwrite ' + retainedRoot);
          fs.cpSync(root, retainedRoot, {
            recursive: true,
            dereference: false,
            // The root-level directory is the generator fixture's esbuild
            // dependency. Installed generation dependencies are runtime evidence.
            filter: (source) => source !== path.join(root, 'node_modules'),
          });
          const mapping = { executedRoot: root, retainedRoot, nonclaims };
          fs.writeFileSync(
            path.join(retainedRoot, 'retention.json'),
            JSON.stringify(mapping, null, 2)
          );
          fs.appendFileSync(
            path.join(artifactRoot, 'executed-roots.jsonl'),
            JSON.stringify(mapping) + '\n'
          );
        }
      }
      for (const root of liveRoots) {
        fs.rmSync(root, { recursive: true, force: true });
        roots.delete(root);
      }
      processGroups.clear();
    } catch (error) {
      preserve(error);
      throw error;
    }
  };
  afterEach(cleanup);
  return { scenario, temporaryRoot, invoke, succeeds, refuses, snapshot, cleanup };
};
