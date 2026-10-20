const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

// Bounded qualification fixtures retain raw observations, stop on first failure,
// and never derive signal authority from a process listing.
module.exports = function runtimeAssetFixture() {
  const artifactRoot = process.env.CAWS_RUNTIME_ASSET_ARTIFACT_ROOT;
  if (artifactRoot && !path.isAbsolute(artifactRoot))
    throw new Error('Artifact root must be absolute');
  const roots = new Set();
  let firstFailure;
  let sequence = 0;
  const nonclaims = [
    'A fixture-path process snapshot does not establish birth-pinned descendant cleanup.',
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
      fs.appendFileSync(
        path.join(artifactRoot, 'preserved-roots.jsonl'),
        JSON.stringify({
          executedRoots: [...roots],
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
    });
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
    if (result.error || result.signal !== null || !Number.isInteger(result.status)) {
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
  afterEach(() => {
    if (firstFailure || !roots.size) return;
    try {
      const liveRoots = [...roots];
      const observation = invoke(liveRoots[0], '/bin/ps', ['-axo', 'pid=,ppid=,lstart=,args=']);
      succeeds(observation);
      const matches = observation.stdout
        .toString()
        .split('\n')
        .filter((line) => liveRoots.some((root) => line.includes(root + '/')));
      for (const root of liveRoots)
        fs.writeFileSync(
          path.join(root, 'postcase-processes.json'),
          JSON.stringify(
            {
              command: ['/bin/ps', '-axo', 'pid=,ppid=,lstart=,args='],
              status: observation.status,
              receipt: observation.receipt,
              executedRoots: liveRoots,
              matches,
              nonclaims,
            },
            null,
            2
          )
        );
      expect(matches).toEqual([]);
      if (artifactRoot) {
        fs.mkdirSync(artifactRoot, { recursive: true });
        for (const root of liveRoots) {
          const retainedRoot = path.join(artifactRoot, path.basename(root));
          if (fs.existsSync(retainedRoot)) throw new Error('Refusing to overwrite ' + retainedRoot);
          fs.cpSync(root, retainedRoot, {
            recursive: true,
            dereference: false,
            filter: (source) => path.basename(source) !== 'node_modules',
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
    } catch (error) {
      preserve(error);
      throw error;
    }
  });
  return { scenario, temporaryRoot, invoke, succeeds, refuses, snapshot };
};
