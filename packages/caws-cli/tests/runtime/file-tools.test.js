const { AbortController } = globalThis;
const crypto = require('node:crypto');
const {
  normalizeCodexFileTool,
  InvalidFileToolInventory,
} = require('../../dist/runtime/codex-file-tools');

const inventory = (command) =>
  normalizeCodexFileTool({
    tool_name: 'apply_patch',
    tool_input: { command },
  });
// Escaped context spaces retain the original bytes without source trailing whitespace.
const original564 = `*** Begin Patch
*** Update File: /Users/darianrosebrook/Desktop/Projects/caws/.caws/worktrees/literal-inspection-caws-read/packages/caws-cli/src/store/specs-writer.ts
@@
   readonly archived: readonly ArchivedSpecsListEntry[];
 }
\x20
-export const SPECS_LIST_STATUSES = ['active', 'draft', 'closed', 'archived'] as const;
+export { SPECS_LIST_STATUSES } from '../shell/analysis/caws-read-metadata';
+import { SPECS_LIST_STATUSES } from '../shell/analysis/caws-read-metadata';
 export type SpecsListStatus = (typeof SPECS_LIST_STATUSES)[number];
\x20
 /**
*** End Patch
`;

test('the retained original native file-tool patch preserves all 564 bytes', () => {
  expect(Buffer.byteLength(original564)).toBe(564);
  expect(crypto.createHash('sha256').update(original564).digest('hex')).toBe(
    '7d5506225ce9c9e61742a44898dddc0545e23ab7fef5a2c33f19c57d649a47fc'
  );
  expect(inventory(original564)).toEqual({
    originalTool: 'apply_patch',
    normalizedTool: 'Edit',
    patch: original564,
    targets: [
      '/Users/darianrosebrook/Desktop/Projects/caws/.caws/worktrees/literal-inspection-caws-read/packages/caws-cli/src/store/specs-writer.ts',
    ],
  });
});

test('complete inventory retains move source and destination and later protected targets', () => {
  const patch = `*** Begin Patch
*** Update File: src/a.js
*** Move to: src/b.js
@@
-old
+new
*** Delete File: protected.txt
*** Add File: src/c.js
+*** Move to: authored-content.txt
*** End Patch
`;
  expect(inventory(patch)).toEqual({
    originalTool: 'apply_patch',
    normalizedTool: 'Edit',
    patch,
    targets: ['src/a.js', 'src/b.js', 'protected.txt', 'src/c.js'],
  });
});

test('headers inside added or context lines are data and repeated targets retain first order', () => {
  expect(
    inventory(`*** Begin Patch
*** Add File: src/space name.js
+*** Update File: protected.txt
*** Update File: src/space name.js
@@
 *** Delete File: authored.txt
+new
*** End Patch
`).targets
  ).toEqual(['src/space name.js']);
});

test.each([
  '',
  '*** Begin Patch\n*** End Patch\n',
  'wrapper\n*** Begin Patch\n*** Delete File: x\n*** End Patch\n',
  '*** Begin Patch\n*** Delete File: \n*** End Patch\n',
  '*** Begin Patch\n*** Delete File: x\u0000y\n*** End Patch\n',
  '*** Begin Patch\n*** Add File: x\nnot-added\n*** End Patch\n',
  '*** Begin Patch\n*** Update File: x\n@@\n*** End Patch\n',
  '*** Begin Patch\n*** Update File: x\n@@\n@@ next\n+x\n*** End Patch\n',
  '*** Begin Patch\n*** Update File: x\n+x\n*** Move to: y\n*** End Patch\n',
  '*** Begin Patch\n*** Update File: x\n*** End of File\n*** End Patch\n',
  '*** Begin Patch\n*** Delete File: x\n*** Surprise: y\n*** End Patch\n',
  '*** Begin Patch\n*** Update File: x\n+x*** End Patch\n',
])('a malformed original inventory refuses the entire mutation: %j', (patch) => {
  expect(() => inventory(patch)).toThrow(InvalidFileToolInventory);
});

test.each(['Write', 'Edit'])(
  'direct %s retains authored text and only its actual file operand',
  (tool) => {
    const payload = {
      tool_name: tool,
      tool_input: {
        file_path: 'src/日本語.js',
        new_string: '*** Delete File: data-only',
        ignored: 'protected.txt',
      },
    };
    const before = JSON.stringify(payload);
    expect(normalizeCodexFileTool(payload)).toEqual({
      originalTool: tool,
      normalizedTool: tool,
      targets: ['src/日本語.js'],
      authoredContent: '*** Delete File: data-only',
    });
    expect(JSON.stringify(payload)).toBe(before);
  }
);

test.each([undefined, null, [], {}, { file_path: 4 }, { file_path: 'src/\ud800' }])(
  'recognized file tools cannot turn missing or invalid operands into an inactive guard: %j',
  (tool_input) =>
    expect(() => normalizeCodexFileTool({ tool_name: 'Write', tool_input })).toThrow(
      InvalidFileToolInventory
    )
);
test('unrelated tools are explicitly outside this normalization contract', () => {
  expect(normalizeCodexFileTool({ tool_name: 'Read', tool_input: { file_path: 'a' } })).toBeNull();
});

describe('complete stock file-tool prewrite handlers', () => {
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const { prepareFileToolHandlers } = require('../../dist/runtime/file-tool-handlers');
  const { guardConfigurationEnvironment } = require('../../dist/runtime/guard-config-loader');
  const { composeHandlers } = require('../../dist/runtime/composer');
  const {
    createNativeGuardStrikesPort,
    GUARD_STRIKES_REQUEST,
    GUARD_STRIKES_RESULT,
  } = require('../../dist/runtime/guard-strikes');
  const { parseJsonSource, objectMemberSource } = require('../../dist/runtime/json-custody');
  const templates = path.resolve(__dirname, '../../templates/hook-packs');
  // Ordered stock contract, independently asserted against the real source files.
  const names = [
    'agent-heartbeat.sh',
    'cwd-guard.sh',
    'block-dangerous.sh',
    'worktree-guard.sh',
    'scope-guard.sh',
    'worktree-write-guard.sh',
    'bash-write-guard.sh',
    'protected-paths.sh',
    'scan-secrets.sh',
    'quiet-merge.sh',
  ];
  const sha = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
  let root,
    repo,
    home,
    user,
    runtime,
    lane,
    selection,
    request,
    environment,
    context,
    registry,
    spec;
  let contextFacts;
  let retainConcurrentFixture;
  let qualificationChildren, qualificationBinaryPin;
  const observation = () => ({
    checkout: selection.checkout,
    canonical: selection.canonical,
    gitDir:
      selection.checkout === repo ? path.join(repo, '.git') : path.join(repo, '.git/worktrees/own'),
    commonDir: path.join(repo, '.git'),
    branch: selection.checkout === repo ? 'main' : 'caws/own',
    mergeInProgress: false,
    worktrees: [
      { path: repo, branch: 'refs/heads/main', detached: false, prunable: false, bare: false },
      { path: lane, branch: 'refs/heads/caws/own', detached: false, prunable: false, bare: false },
    ],
    ...contextFacts,
  });
  const put = (file, value) => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, typeof value === 'string' ? value : JSON.stringify(value));
  };
  const persist = () => {
    put(path.join(repo, '.caws/worktrees.json'), registry);
    put(path.join(repo, '.caws/specs/FILE-TOOLS-001.yaml'), spec);
  };
  const payload = (tool_name, tool_input) => {
    request.payload = {
      cwd: selection.checkout,
      session_id: 'file-tools-fixture',
      tool_name,
      tool_input,
    };
    request.inputJson = JSON.stringify(request.payload);
  };
  const patch = (...files) =>
    payload('apply_patch', {
      command:
        '*** Begin Patch\n' +
        files.map((file) => '*** Delete File: ' + file + '\n').join('') +
        '*** End Patch\n',
    });
  const strikes = () => path.join(user, '.caws/state/sessions/file-tools-fixture/strikes.json');
  const count = () =>
    fs.existsSync(strikes()) ? JSON.parse(fs.readFileSync(strikes())).scope_guard : 0;
  const seedStrikes = (value) =>
    fs.writeFileSync(strikes(), JSON.stringify(value), { mode: 0o600 });
  const within = (pending, milliseconds, label) => {
    let timer;
    return Promise.race([
      pending,
      new Promise((_resolve, reject) => {
        timer = globalThis.setTimeout(
          () => reject(new Error(label + ' deadline exceeded')),
          Math.max(1, milliseconds)
        );
      }),
    ]).finally(() => globalThis.clearTimeout(timer));
  };
  function coreQualificationBinary() {
    if (qualificationBinaryPin) return qualificationBinaryPin;
    const binary = process.env.CAWS_TEST_GUARD_STRIKES_CORE_TEST_BINARY;
    if (typeof binary !== 'string' || !path.isAbsolute(binary))
      throw new Error(
        'Guard-strike FS qualification prerequisite: set absolute CAWS_TEST_GUARD_STRIKES_CORE_TEST_BINARY to the physical Rust libtest executable; no public helper or JS fallback'
      );
    if (!fs.lstatSync(binary).isFile() || fs.realpathSync.native(binary) !== binary)
      throw new Error(
        'Guard-strike qualification binary must be a physical regular Rust libtest executable'
      );
    fs.accessSync(binary, fs.constants.X_OK);
    qualificationBinaryPin = { path: binary, sha256: sha(binary) };
    return qualificationBinaryPin;
  }
  function childReceipt(record) {
    return {
      pid: record.child.pid,
      spawned: record.spawned,
      exitObserved: record.exitObserved,
      closed: record.closed,
      code: record.code,
      signal: record.signal,
      stopRequested: record.stopRequested,
      failure: record.failure && String(record.failure),
      binary: record.binary,
      argv: record.argv,
      input: record.input,
      commit: record.commit,
      resultEof: record.resultEof,
      stdoutBase64: Buffer.concat(record.stdout).toString('base64'),
      stderrBase64: Buffer.concat(record.stderr).toString('base64'),
      resultBase64: Buffer.concat(record.result).toString('base64'),
      truncated: record.truncated,
    };
  }
  function invokeRealStrikeCore(ctx, signal, startGate) {
    const binary = coreQualificationBinary();
    const checkout = fs.realpathSync.native(ctx.selection.checkout);
    const input =
      JSON.stringify({
        schema: 'caws.guard-strikes.increment.v1',
        guard: 'scope_guard',
        sessionId: ctx.request.payload.session_id,
        checkout,
      }) + '\n';
    const remaining = Math.min(10000, ctx.request.deadlineEpochMs - Date.now());
    if (remaining <= 0 || signal.aborted)
      throw new Error('Original qualification request expired or cancelled');
    const { spawn } = require('node:child_process');
    const argv = [
      '--exact',
      'guard_strikes::tests::increment_scope_guard_worker',
      '--ignored',
      '--test-threads=1',
      '--nocapture',
    ];
    const child = spawn(binary.path, argv, {
      cwd: checkout,
      env: { ...ctx.request.caller.environment, TMPDIR: fs.realpathSync.native(os.tmpdir()) },
      // fd3 carries the cfg(test)-only worker result. Libtest stdout is diagnostic data.
      stdio: ['pipe', 'pipe', 'pipe', 'pipe'],
    });
    const record = {
      child,
      binary,
      argv,
      input,
      spawned: false,
      exitObserved: false,
      closed: false,
      code: null,
      signal: null,
      stopRequested: false,
      failure: null,
      commit: null,
      stdout: [],
      stderr: [],
      result: [],
      diagnosticBytes: 0,
      resultBytes: 0,
      resultEof: false,
      truncated: false,
    };
    let observedClose;
    record.closedPromise = new Promise((resolve) => {
      observedClose = resolve;
    });
    qualificationChildren.push(record);
    const operation = new Promise((accept, reject) => {
      let cleanupTimer;
      const stop = (error) => {
        record.failure ||= error;
        if (record.closed) return;
        child.stdin.destroy();
        if (!record.exitObserved && typeof child.pid === 'number' && !record.stopRequested) {
          record.stopRequested = true;
          // Only this owned helper Child is stopped; no PID discovery or group signal.
          child.kill('SIGKILL');
        }
        if (cleanupTimer === undefined)
          cleanupTimer = globalThis.setTimeout(() => {
            if (!record.closed)
              reject(
                new Error(
                  'Owned strike-helper cleanup unconfirmed: ' + JSON.stringify(childReceipt(record))
                )
              );
          }, 2000);
      };
      record.stop = stop;
      const timeout = globalThis.setTimeout(
        () => stop(new Error('Original strike-helper qualification deadline exceeded; no retry')),
        remaining
      );
      const abort = () =>
        stop(
          new Error(
            'Original strike-helper qualification cancelled; commit may be uncertain; no retry'
          )
        );
      signal.addEventListener('abort', abort, { once: true });
      if (signal.aborted) abort();
      for (const [name, stream] of [
        ['stdout', child.stdout],
        ['stderr', child.stderr],
        ['result', child.stdio[3]],
      ]) {
        stream.on('data', (bytes) => {
          const chunk = Buffer.from(bytes);
          const field = name === 'result' ? 'resultBytes' : 'diagnosticBytes';
          const available = Math.max(0, (name === 'result' ? 4096 : 8192) - record[field]);
          record[name].push(chunk.subarray(0, available));
          record[field] += Math.min(chunk.length, available);
          if (chunk.length > available) {
            record.truncated = true;
            stop(new Error('Core-test worker output exceeded byte bound'));
          }
        });
        stream.on('error', (error) => stop(error));
      }
      child.stdio[3].on('end', () => {
        record.resultEof = true;
      });
      child.stdin.on('error', (error) => stop(error));
      child.on('error', (error) => stop(error));
      child.on('exit', (code, termination) => {
        record.exitObserved = true;
        record.code = code;
        record.signal = termination;
      });
      child.on('close', (code, termination) => {
        record.closed = true;
        record.code = code;
        record.signal = termination;
        globalThis.clearTimeout(timeout);
        if (cleanupTimer !== undefined) globalThis.clearTimeout(cleanupTimer);
        signal.removeEventListener('abort', abort);
        observedClose();
        try {
          if (
            record.failure ||
            code !== 0 ||
            termination !== null ||
            !record.exitObserved ||
            !record.resultEof
          )
            throw (
              record.failure ||
              new Error(
                'Rust core-test worker refused, omitted fd3 EOF, or did not exit successfully'
              )
            );
          if (sha(binary.path) !== binary.sha256)
            throw new Error('Qualification core-test executable changed');
          const text = new (require('node:util').TextDecoder)('utf-8', { fatal: true }).decode(
            Buffer.concat(record.result)
          );
          if (!text.endsWith('\n') || text.slice(0, -1).includes('\n') || text.includes('\r'))
            throw new Error(
              'Rust core-test worker must emit exactly one LF-terminated fd3 JSON frame'
            );
          const source = parseJsonSource(text, 8, 64, true),
            value = JSON.parse(text);
          const keys = ['schema', 'count', 'stateSha256'];
          if (
            !value ||
            typeof value !== 'object' ||
            Array.isArray(value) ||
            Object.keys(value).length !== keys.length ||
            keys.some((key) => !Object.hasOwn(value, key)) ||
            value.schema !== 'caws.guard-strikes.committed.v1' ||
            !Number.isSafeInteger(value.count) ||
            value.count < 1 ||
            typeof value.stateSha256 !== 'string' ||
            value.stateSha256.length !== 64 ||
            !/^[a-f0-9]{64}$/.test(value.stateSha256)
          )
            throw new Error('Malformed Rust core-test worker commit receipt');
          const number = objectMemberSource(source, 'count');
          if (
            !number ||
            number.root.kind !== 'number' ||
            !/^[1-9][0-9]*$/.test(number.text.slice(number.root.start, number.root.end))
          )
            throw new Error('Noncanonical Rust core-test worker count');
          record.commit = { count: value.count, stateSha256: value.stateSha256 };
          accept(record.commit);
        } catch (error) {
          reject(
            new Error(
              'Actual Rust strike core-test worker failed; no JS fallback. ' +
                JSON.stringify(childReceipt(record)),
              { cause: error }
            )
          );
        }
      });
      child.on('spawn', () => {
        record.spawned = true;
        Promise.resolve()
          .then(() => (startGate ? startGate(record) : undefined))
          .then(() => {
            if (record.failure || signal.aborted || record.exitObserved) {
              stop(record.failure || new Error('Helper ended before its bounded stdin grant'));
              return;
            }
            child.stdin.end(input);
          }, stop);
      });
    });
    // A client cancellation can finish its wait first; preserve owned cleanup and
    // prevent an unobserved qualification-adapter rejection, without retrying it.
    operation.catch(() => {});
    return operation;
  }
  function fixtureStrikePort(ctx = context, startGate) {
    let pending, correlation;
    // Qualification adapter only: original fixture facts select the helper call.
    // The production client still emits no HOME/SID/path/guard/reset selectors.
    // Actual mutation/counting/locking occurs only in the selected cfg(test) Rust core worker.
    return createNativeGuardStrikesPort(
      ctx.request,
      {
        async write(frame, signal) {
          const keys = ['schema', 'id', 'runtimeDigest', 'token'];
          if (
            Object.keys(frame).length !== keys.length ||
            keys.some((key) => !Object.hasOwn(frame, key)) ||
            frame.schema !== GUARD_STRIKES_REQUEST ||
            frame.id !== ctx.request.id ||
            frame.runtimeDigest !== ctx.request.runtimeDigest
          )
            throw new Error('Qualification adapter rejected a nonfixed request');
          correlation = frame;
          pending = invokeRealStrikeCore(ctx, signal, startGate);
        },
        async read() {
          if (!pending || !correlation)
            throw new Error('Qualification adapter has no admitted request');
          const commit = await pending;
          return Buffer.from(
            JSON.stringify({
              schema: GUARD_STRIKES_RESULT,
              id: correlation.id,
              runtimeDigest: correlation.runtimeDigest,
              token: correlation.token,
              ...commit,
            })
          );
        },
      },
      ctx.signal
    );
  }
  const prepare = (revalidate = async () => observation(), suppliedPort) => {
    let port = suppliedPort;
    return prepareFileToolHandlers({
      ...context,
      nativeFileToolContext: {
        captured: observation(),
        revalidate,
        // Admission itself cannot construct a transport or launch a helper.
        incrementScopeGuard: () => {
          port ||= fixtureStrikePort();
          return port.incrementScopeGuard();
        },
      },
    });
  };
  const execute = async (name) => {
    const plan = prepare();
    expect(plan).not.toBeNull();
    return plan.execute(selection.handlers.find((handler) => handler.name === name));
  };
  const decoded = (result) => JSON.parse(Buffer.from(result.stdout).toString());
  beforeEach(() => {
    retainConcurrentFixture = false;
    qualificationChildren = [];
    qualificationBinaryPin = null;
    contextFacts = {};
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'caws-file-tools-')));
    repo = path.join(root, 'repo');
    home = path.join(root, 'machine');
    user = path.join(root, 'user');
    lane = path.join(repo, '.caws/worktrees/own');
    runtime = path.join(home, 'lib/runtimes', 'f'.repeat(64));
    fs.mkdirSync(lane, { recursive: true });
    fs.mkdirSync(user, { mode: 0o700 });
    // Original HOME is distinct from CAWS_HOME. The reusable core requires an owned root.
    fs.mkdirSync(path.join(user, '.caws/state/sessions/file-tools-fixture'), {
      recursive: true,
      mode: 0o700,
    });
    fs.mkdirSync(path.dirname(runtime), { recursive: true });
    fs.cpSync(path.join(templates, 'shared'), runtime, { recursive: true });
    // Typed substitution is limited to these reviewed semantics. Newer template
    // bytes must decline admission until their behavior is qualified separately.
    // The ownership fixture is the authentic source at 200edef2da345744c4603647858290ca22a2de7d.
    // The SID fixture is the authentic source at 79a8867fe8e12933d7e8c873352bb04b033093c5.
    const reviewedSources = {
      'block-dangerous.sh': '636f16dba6556cca02782e1df88864dafa920a35c38424afc88457a90cf57bb5',
      'worktree-write-guard.sh': '737ef2a0b6b6a4b4a87ed65cb2a45e56e81b9c95f0b803d6c076dce6e93c41a9',
      'lib/session-id.sh': 'cf662f10e6d3477cecbf5deabd8d2b63284f6f4ac14fa7070725ff8502515c53',
    };
    for (const [name, expectedSha256] of Object.entries(reviewedSources)) {
      const reviewedSource = fs.readFileSync(path.join(__dirname, 'fixtures/reviewed-stock', name));
      expect(crypto.createHash('sha256').update(reviewedSource).digest('hex')).toBe(expectedSha256);
      fs.writeFileSync(path.join(runtime, name), reviewedSource);
    }
    fs.cpSync(path.join(templates, 'codex/hooks/lib'), path.join(runtime, 'surfaces/codex/lib'), {
      recursive: true,
    });
    for (const name of ['dispatch.sh', 'handler-env.sh'])
      fs.copyFileSync(path.join(templates, 'runtime', name), path.join(runtime, name));
    // Model maintained machine installation, which marks every installed .sh
    // member executable; source template checkout modes are not installation modes.
    const installedDirectories = [runtime];
    while (installedDirectories.length) {
      const directory = installedDirectories.pop();
      for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
        const file = path.join(directory, entry.name);
        if (entry.isDirectory()) installedDirectories.push(file);
        else if (entry.isFile() && entry.name.endsWith('.sh')) fs.chmodSync(file, 0o755);
      }
    }
    put(path.join(repo, '.caws/policy.yaml'), {
      version: 1,
      risk_tiers: {
        1: { max_files: 10, max_loc: 250 },
        2: { max_files: 100, max_loc: 10000 },
        3: { max_files: 500, max_loc: 40000 },
      },
      gates: {
        budget_limit: { enabled: true, mode: 'warn' },
        spec_completeness: { enabled: true, mode: 'block' },
        scope_boundary: { enabled: true, mode: 'block' },
      },
    });
    spec = {
      id: 'FILE-TOOLS-001',
      title: 'Fixture file authority',
      mode: 'chore',
      lifecycle_state: 'active',
      worktree: 'own',
      blast_radius: { modules: ['fixture'] },
      scope: { in: ['src/allowed/'], out: ['src/forbidden/'] },
      invariants: ['Fixture ownership is explicit'],
      acceptance: [{ id: 'A1', given: 'fixture', when: 'edit', then: 'guard' }],
      non_functional: {},
      contracts: [],
    };
    registry = {
      own: {
        path: lane,
        branch: 'caws/own',
        baseBranch: 'main',
        specId: spec.id,
        owner: { session_id: 'file-tools-fixture' },
      },
    };
    persist();
    expect(
      require('../../dist/store/policy-store').loadPolicy(path.join(repo, '.caws')).errors
    ).toEqual([]);
    expect(
      require('../../dist/store/specs-store').loadSpecs(path.join(repo, '.caws')).diagnostics
    ).toEqual([]);
    const libraries = {};
    for (const name of [
      'agent-surface.sh',
      'parse-input.sh',
      'session-id.sh',
      'session-cache.sh',
      'emit.sh',
    ]) {
      const kind = ['parse-input.sh', 'emit.sh'].includes(name) ? 'surface' : 'shared';
      const file = path.join(runtime, kind === 'surface' ? 'surfaces/codex/lib' : 'lib', name);
      libraries[name] = { path: file, sha256: sha(file), kind };
    }
    selection = {
      status: 'active',
      runtimeDigest: 'f'.repeat(64),
      checkout: lane,
      canonical: repo,
      surface: 'codex',
      event: 'pre_tool_use',
      configuration: 'system',
      runtimeDirectory: runtime,
      hooksDirectory: runtime,
      libraries,
      overrides: {},
      libraryOverrides: {},
      transcriptAdapter: null,
      handlers: names.map((name) => ({
        name,
        entry: name,
        args: [],
        path: path.join(runtime, name),
        sha256: sha(path.join(runtime, name)),
        kind: 'stock',
        tier: 'stock',
      })),
    };
    const bin = path.join(root, 'bin');
    fs.mkdirSync(bin);
    fs.symlinkSync(path.resolve(__dirname, '../../dist/index.js'), path.join(bin, 'caws'));
    fs.symlinkSync(process.execPath, path.join(bin, 'node'));
    environment = { HOME: user, CAWS_HOME: home, PATH: bin + ':/usr/bin:/bin' };
    request = {
      schema: 'caws.runtime.request.v1',
      id: 'file-tools-fixture',
      runtimeDigest: selection.runtimeDigest,
      fileToolContext: 'caws.runtime.file-tool-context.v1',
      guardStrikes: 'caws.runtime.guard-strikes.v1',
      surface: 'codex',
      event: 'pre_tool_use',
      configuration: 'system',
      caller: { cwd: lane, processId: process.pid, environment: { ...environment } },
      deadlineEpochMs: Date.now() + 60000,
      inputJson: '',
      payload: {},
    };
    context = { request, selection, environment, signal: new AbortController().signal };
    payload('Write', { file_path: 'src/allowed/new.js', content: 'ordinary' });
  });
  afterEach(async () => {
    jest.restoreAllMocks();
    const failed = [];
    await Promise.all(
      qualificationChildren.map(async (record) => {
        try {
          if (!record.closed)
            record.stop(new Error('Fixture closing with an owned helper operation'));
          await within(record.closedPromise, 2000, 'owned helper exit/EOF receipt');
        } catch (error) {
          retainConcurrentFixture = true;
          failed.push({ error: String(error), receipt: childReceipt(record) });
        }
      })
    );
    if (!retainConcurrentFixture) fs.rmSync(root, { recursive: true, force: true });
    if (failed.length)
      throw new Error(
        'Strike-helper cleanup unconfirmed; fixture retained at ' +
          root +
          '\n' +
          JSON.stringify(failed)
      );
  });

  test('Rust strike core qualification binary is required for filesystem probes', () => {
    expect(coreQualificationBinary()).toEqual({
      path: expect.any(String),
      sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
  });
  test('concurrent scope strikes preserve one warning and one deny across independent Rust core test processes', async () => {
    // Two actual cfg(test) Rust OS processes mutate the same private fixture store.
    // The adapter joins the real client and real core; production Native IPC/phase/host custody is separate.
    // Core tests independently prove blocked-contender/fresh-read behavior.
    coreQualificationBinary();
    seedStrikes({ scope_guard: 0, another_guard: 7 });
    const targets = ['src/outside/race-a.js', 'src/outside/race-b.js'];
    const absoluteTargets = targets.map((file) => path.join(lane, file));
    expect(absoluteTargets.map((file) => fs.existsSync(file))).toEqual([false, false]);
    const arrivals = [];
    let release;
    const gate = new Promise((resolve) => {
      release = resolve;
    });
    const startGate = (record) => {
      arrivals.push(record);
      if (arrivals.length > 2) throw new Error('Unexpected additional helper operation');
      if (arrivals.length === 2) {
        if (
          arrivals.some(
            (child) => !child.spawned || child.exitObserved || typeof child.child.pid !== 'number'
          )
        )
          throw new Error('Both owned helper spawns were not observed before stdin');
        release();
      }
      return within(
        gate,
        5000,
        'both helper spawns before stdin; contention rendezvous inconclusive'
      );
    };
    const plans = targets.map((file, index) => {
      const value = {
        cwd: lane,
        session_id: 'file-tools-fixture',
        tool_name: 'Write',
        tool_input: { file_path: file, content: 'never applied' },
      };
      const ctx = {
        ...context,
        request: {
          ...request,
          id: 'scope-race-' + index,
          payload: value,
          inputJson: JSON.stringify(value),
          deadlineEpochMs: Date.now() + 10000,
        },
      };
      const port = fixtureStrikePort(ctx, startGate);
      const plan = prepareFileToolHandlers({
        ...ctx,
        nativeFileToolContext: {
          captured: observation(),
          revalidate: async () => observation(),
          incrementScopeGuard: () => port.incrementScopeGuard(),
        },
      });
      expect(plan).not.toBeNull();
      return plan;
    });
    const handler = selection.handlers.find((entry) => entry.name === 'scope-guard.sh');
    expect(handler).toBeDefined();
    let results;
    try {
      results = await within(
        Promise.all(plans.map((plan) => plan.execute(handler))),
        13000,
        'two actual scope handlers'
      );
      await Promise.all(
        qualificationChildren.map((record) =>
          within(record.closedPromise, 2000, 'actual helper exit/EOF')
        )
      );
      expect(arrivals).toHaveLength(2);
      expect(qualificationChildren).toHaveLength(2);
      expect(new Set(qualificationChildren.map((record) => record.child.pid)).size).toBe(2);
      expect(qualificationChildren.map((record) => record.argv)).toEqual([
        [
          '--exact',
          'guard_strikes::tests::increment_scope_guard_worker',
          '--ignored',
          '--test-threads=1',
          '--nocapture',
        ],
        [
          '--exact',
          'guard_strikes::tests::increment_scope_guard_worker',
          '--ignored',
          '--test-threads=1',
          '--nocapture',
        ],
      ]);
      expect(
        qualificationChildren.map((record) => ({
          spawned: record.spawned,
          exitObserved: record.exitObserved,
          closed: record.closed,
          resultEof: record.resultEof,
          code: record.code,
          signal: record.signal,
          stopRequested: record.stopRequested,
        }))
      ).toEqual([
        {
          spawned: true,
          exitObserved: true,
          closed: true,
          resultEof: true,
          code: 0,
          signal: null,
          stopRequested: false,
        },
        {
          spawned: true,
          exitObserved: true,
          closed: true,
          resultEof: true,
          code: 0,
          signal: null,
          stopRequested: false,
        },
      ]);
      expect(qualificationChildren.map((record) => record.commit.count).sort()).toEqual([1, 2]);
      const decisions = results
        .map((result) => {
          expect(result.exitCode).toBe(0);
          const output = decoded(result).hookSpecificOutput;
          if (
            output &&
            typeof output.additionalContext === 'string' &&
            output.additionalContext.includes('strike 1 of 3')
          )
            return 'warning';
          if (
            output &&
            output.permissionDecision === 'deny' &&
            typeof output.permissionDecisionReason === 'string' &&
            output.permissionDecisionReason.includes('strike 2 of 3')
          )
            return 'deny';
          return 'unexpected';
        })
        .sort();
      expect({ decisions, state: JSON.parse(fs.readFileSync(strikes(), 'utf8')) }).toEqual({
        decisions: ['deny', 'warning'],
        state: { scope_guard: 2, another_guard: 7 },
      });
      expect(absoluteTargets.map((file) => fs.existsSync(file))).toEqual([false, false]);
    } catch (error) {
      throw new Error(
        'Actual Rust strike-core concurrency qualification failed. Timeout is inconclusive, not lock proof.\n' +
          JSON.stringify(
            {
              fixture: root,
              targets: absoluteTargets,
              results,
              state: fs.existsSync(strikes()) ? fs.readFileSync(strikes(), 'utf8') : null,
              children: qualificationChildren.map(childReceipt),
            },
            null,
            2
          ),
        { cause: error }
      );
    }
  }, 20000);

  test('the complete ten-handler stock profile admits without prefix or governance effects', () => {
    expect(prepare()).not.toBeNull();
    expect(count()).toBe(0);
    expect(fs.existsSync(path.join(repo, '.caws/leases'))).toBe(false);
    expect(selection.handlers.map((handler) => handler.name)).toEqual(names);
  });

  const actualDefaultPatchProfile = () => {
    const { extractMachineHandlers } = require('../../dist/init/machine-handler-policy');
    const text = fs.readFileSync(path.join(templates, 'shared/dispatch/pre_tool_use.sh'), 'utf8');
    const defaults = extractMachineHandlers(text, text);
    expect(defaults).toHaveLength(11);
    expect(defaults[8]).toBe('shortcut-language-check.sh');
    selection.handlers = defaults.map((name) => ({
      name,
      entry: name,
      args: [],
      path: path.join(runtime, name),
      sha256: sha(path.join(runtime, name)),
      kind: 'stock',
      tier: 'stock',
    }));
    patch('src/a.js');
    return defaults;
  };

  const installCurrentFileToolMembers = (mask = 7) => {
    for (const [bit, name, expected] of [
      [1, 'block-dangerous.sh', '9e8a238b619632744edf0960d44b6c0d98bac546a36f0092147e8566955084f5'],
      [
        2,
        'worktree-write-guard.sh',
        '9c71094f1b7d9eba7803163ebf7f20cff4f6fa4f2cf3b84817ca2b5882791aa7',
      ],
      [4, 'lib/session-id.sh', 'dac4866c1576b65732ab3eb5b350fd978b3b746c6bce02b484210a1ce3676c8c'],
    ]) {
      if (!(mask & bit)) continue;
      const file = path.join(runtime, name);
      fs.copyFileSync(path.join(templates, 'shared', name), file);
      expect(sha(file)).toBe(expected);
      if (bit === 4) selection.libraries['session-id.sh'].sha256 = expected;
      else selection.handlers.find((handler) => handler.name === name).sha256 = expected;
    }
  };
  test.each(
    ['ten', 'eleven'].flatMap((profile) => Array.from({ length: 8 }, (_, mask) => [profile, mask]))
  )('only complete %s source cohorts admit, mask=%s', (profile, mask) => {
    if (profile === 'eleven') actualDefaultPatchProfile();
    installCurrentFileToolMembers(mask);
    expect(prepare() !== null).toBe(mask === 0 || mask === 7);
    expect(count()).toBe(0);
    expect(fs.existsSync(path.join(repo, '.caws/leases'))).toBe(false);
  });
  test.each(['historical-to-current', 'current-to-historical'])(
    'complete source cohort changes after admission cannot replay compatibility: %s',
    async (direction) => {
      const old = ['block-dangerous.sh', 'worktree-write-guard.sh', 'lib/session-id.sh'].map(
        (name) => [name, fs.readFileSync(path.join(runtime, name))]
      );
      if (direction === 'current-to-historical') installCurrentFileToolMembers();
      const plan = prepare();
      expect(plan).not.toBeNull();
      if (direction === 'historical-to-current') installCurrentFileToolMembers();
      else
        for (const [name, bytes] of old) {
          const file = path.join(runtime, name);
          fs.writeFileSync(file, bytes);
          if (name.startsWith('lib/')) selection.libraries['session-id.sh'].sha256 = sha(file);
          else selection.handlers.find((handler) => handler.name === name).sha256 = sha(file);
        }
      await expect(plan.execute(selection.handlers[1])).rejects.toThrow(
        'compatibility replay refused'
      );
      expect(count()).toBe(0);
    }
  );
  test.each([{}, [], false, 1, 'owner', { session_id: 1 }, { session_id: '../other' }])(
    'current ownership retains malformed presence %p',
    async (owner) => {
      installCurrentFileToolMembers();
      registry.own.owner = owner;
      persist();
      payload('Write', { file_path: 'docs/allowed.md' });
      const result = await execute('worktree-write-guard.sh');
      expect(result.exitCode).toBe(2);
      expect(decoded(result).reason).toContain('unresolved ownership census');
    }
  );
  test.each([null, { session_id: null }, { session_id: '' }, { session_id: 'unknown' }])(
    'current unconfirmed ownership cannot acquire ask capability %p',
    async (owner) => {
      installCurrentFileToolMembers();
      registry.own.owner = owner;
      persist();
      environment.CAWS_PERMISSION_VOCAB = 'ask';
      payload('Write', { file_path: 'docs/allowed.md' });
      const result = await execute('worktree-write-guard.sh');
      expect(result.exitCode).toBe(2);
      expect(decoded(result).reason).toContain('no confirmed owner');
      expect(decoded(result).reason).toContain('cannot request approval');
    }
  );
  test('current census finds a foreign owner after unresolved entries and targets', async () => {
    installCurrentFileToolMembers();
    delete registry.own.owner;
    const foreign = path.join(repo, '.caws/worktrees/foreign');
    fs.mkdirSync(foreign);
    registry.unresolved = { path: path.join(root, 'absent-worktree') };
    registry.foreign = { path: foreign, owner: { session_id: 'another-owner' } };
    persist();
    const dangling = path.join(lane, 'dangling');
    fs.symlinkSync(path.join(root, 'absent-target'), dangling);
    patch(dangling, path.join(foreign, 'docs/foreign.md'));
    const result = await execute('worktree-write-guard.sh');
    expect(result.exitCode).toBe(2);
    expect(decoded(result).reason).toContain("worktree 'foreign'");
  });
  test('absent legacy path retains corroborated conventional ownership', async () => {
    installCurrentFileToolMembers();
    delete registry.own.path;
    persist();
    expect(fs.existsSync(lane)).toBe(true);
    payload('Write', { file_path: 'docs/allowed.md' });
    const result = await execute('worktree-write-guard.sh');
    expect(result.exitCode).toBe(0);
    expect(Buffer.from(result.stdout).toString()).toBe('');
  });
  test.each(['', 42, null, false, [], {}, 'relative/missing'])(
    'explicit malformed root cannot inherit conventional ownership: %p',
    async (value) => {
      installCurrentFileToolMembers();
      registry.own.path = value;
      persist();
      expect(fs.existsSync(lane)).toBe(true);
      expect(registry.own.owner.session_id).toBe('file-tools-fixture');
      environment.CAWS_PERMISSION_VOCAB = 'ask';
      payload('Write', { file_path: 'docs/allowed.md' });
      expect((await execute('scope-guard.sh')).exitCode).toBe(2);
      expect(count()).toBe(0);
      const result = await execute('worktree-write-guard.sh');
      expect(result.exitCode).toBe(2);
      expect(decoded(result).reason).toContain('unresolved ownership census');
      expect(decoded(result)).not.toHaveProperty('hookSpecificOutput');
    }
  );
  test.each(['', 42])(
    'malformed root does not conceal later established foreign ownership: %p',
    async (value) => {
      installCurrentFileToolMembers();
      registry.own.path = value;
      const foreign = path.join(repo, '.caws/worktrees/foreign');
      fs.mkdirSync(foreign);
      registry.foreign = { path: foreign, owner: { session_id: 'another-owner' } };
      persist();
      patch('docs/allowed.md', path.join(foreign, 'docs/foreign.md'));
      const result = await execute('worktree-write-guard.sh');
      expect(result.exitCode).toBe(2);
      expect(decoded(result).reason).toContain("worktree 'foreign'");
      expect(decoded(result).reason).toContain('different session');
    }
  );
  test.each(['missing-directory', 'malformed-path'])(
    'canonical claim survives an unrelated unresolved root: %s',
    async (kind) => {
      installCurrentFileToolMembers();
      registry.unresolved = {
        path: kind === 'malformed-path' ? 42 : path.join(root, 'absent-worktree'),
      };
      persist();
      selection.checkout = repo;
      payload('Write', { file_path: path.join(repo, 'src/allowed/a') });
      const result = await execute('worktree-write-guard.sh');
      expect(result.exitCode).toBe(2);
      expect(decoded(result).reason).toContain('claimed by worktree');
    }
  );

  test('the actual default eleven-handler apply_patch profile admits without effects', () => {
    const defaults = actualDefaultPatchProfile();
    expect(selection.handlers.map((handler) => handler.entry)).toEqual(defaults);
    expect(prepare()).not.toBeNull();
    expect(count()).toBe(0);
    expect(fs.existsSync(path.join(repo, '.caws/leases'))).toBe(false);
  });

  test('default eleven pins the directly sourced shared parser separately from the surface parser', () => {
    actualDefaultPatchProfile();
    expect(prepare()).not.toBeNull();
    const surface = selection.libraries['parse-input.sh'];
    const surfaceBefore = fs.readFileSync(surface.path);
    const shared = path.join(runtime, 'lib/parse-input.sh');
    expect(shared).not.toBe(surface.path);
    fs.appendFileSync(shared, "\nprintf 'shared-parser-drift\\n' >&2\n");
    expect(fs.readFileSync(surface.path)).toEqual(surfaceBefore);
    expect(surface.sha256).toBe(sha(surface.path));
    expect(prepare()).toBeNull();
    expect(count()).toBe(0);
    expect(fs.existsSync(path.join(repo, '.caws/leases'))).toBe(false);
  });

  test.each(['Write', 'Edit'])(
    'default eleven %s retains whole compatibility before effects',
    (tool) => {
      actualDefaultPatchProfile();
      payload(
        tool,
        tool === 'Write'
          ? { file_path: 'src/a.js', content: 'ordinary' }
          : { file_path: 'src/a.js', old_string: 'old', new_string: 'new' }
      );
      request.payload.original_tool_name = 'apply_patch';
      expect(prepare()).toBeNull();
      expect(count()).toBe(0);
      expect(fs.existsSync(path.join(repo, '.caws/leases'))).toBe(false);
    }
  );

  test('default shortcut preserves the original Add-patch pre-tool no-op before file reads or strikes', async () => {
    actualDefaultPatchProfile();
    payload('apply_patch', {
      command:
        '*** Begin Patch\n*** Add File: src/a.js\n+// TODO: retained authored data\n*** End Patch\n',
    });
    const revalidate = jest.fn(async () => observation());
    const port = {
      incrementScopeGuard: jest.fn(async () => {
        throw new Error('must not strike');
      }),
    };
    const plan = prepare(revalidate, port);
    expect(plan).not.toBeNull();
    const target = path.join(lane, 'src/a.js');
    const open = fs.openSync;
    let targetReads = 0;
    jest.spyOn(fs, 'openSync').mockImplementation((file, ...args) => {
      if (file === target) {
        targetReads++;
        throw new Error('must not read a patch preimage');
      }
      return open(file, ...args);
    });
    try {
      const result = await plan.execute(selection.handlers[8]);
      expect({
        exitCode: result.exitCode,
        stdout: Buffer.from(result.stdout).toString(),
        stderr: Buffer.from(result.stderr).toString(),
      }).toEqual({ exitCode: 0, stdout: '', stderr: '' });
      expect(targetReads).toBe(0);
      expect(revalidate).not.toHaveBeenCalled();
      expect(port.incrementScopeGuard).not.toHaveBeenCalled();
      expect(count()).toBe(0);
    } finally {
      fs.openSync.mockRestore();
    }
  });

  test.each([
    'missing source',
    'changed source',
    'changed digest',
    'extra handler',
    'reordered handler',
    'handler arguments',
  ])('default eleven %s refuses typed admission before effects', (kind) => {
    actualDefaultPatchProfile();
    const shortcut = selection.handlers[8];
    if (kind === 'missing source') fs.unlinkSync(shortcut.path);
    if (kind === 'changed source') fs.appendFileSync(shortcut.path, '\n# changed\n');
    if (kind === 'changed digest') shortcut.sha256 = '0'.repeat(64);
    if (kind === 'extra handler') selection.handlers.push({ ...shortcut });
    if (kind === 'reordered handler')
      [selection.handlers[8], selection.handlers[9]] = [
        selection.handlers[9],
        selection.handlers[8],
      ];
    if (kind === 'handler arguments') shortcut.args.push('--custom');
    expect(prepare()).toBeNull();
    expect(count()).toBe(0);
    expect(fs.existsSync(path.join(repo, '.caws/leases'))).toBe(false);
  });

  test.each(names)('a custom selected %s retains complete compatibility before effects', (name) => {
    const handler = selection.handlers.find((entry) => entry.name === name);
    handler.sha256 = '0'.repeat(64);
    expect(prepare()).toBeNull();
    expect(count()).toBe(0);
  });

  test.each(
    ['ten', 'eleven'].flatMap((profile) =>
      ['block-dangerous.sh', 'worktree-write-guard.sh'].map((name) => [profile, name])
    )
  )(
    'current rehashed guard cannot inherit the %s-handler file-tool profile: %s',
    (profile, name) => {
      if (profile === 'eleven') actualDefaultPatchProfile();
      expect(prepare()).not.toBeNull();
      const handler = selection.handlers.find((entry) => entry.name === name);
      const original = fs.readFileSync(handler.path);
      const originalHash = handler.sha256;
      try {
        fs.copyFileSync(path.join(templates, 'shared', name), handler.path);
        handler.sha256 = sha(handler.path);
        expect(handler.sha256).not.toBe(originalHash);
        expect(prepare()).toBeNull();
        expect(count()).toBe(0);
        expect(fs.existsSync(path.join(repo, '.caws/leases'))).toBe(false);
      } finally {
        fs.writeFileSync(handler.path, original);
        handler.sha256 = originalHash;
      }
      expect(prepare()).not.toBeNull();
    }
  );

  test.each(['ten', 'eleven'])(
    'current rehashed SID helper cannot inherit the %s-handler file-tool profile',
    (profile) => {
      if (profile === 'eleven') actualDefaultPatchProfile();
      expect(prepare()).not.toBeNull();
      const library = selection.libraries['session-id.sh'];
      const original = fs.readFileSync(library.path);
      const originalHash = library.sha256;
      try {
        fs.copyFileSync(path.join(templates, 'shared/lib/session-id.sh'), library.path);
        library.sha256 = sha(library.path);
        expect(library.sha256).not.toBe(originalHash);
        expect(prepare()).toBeNull();
        expect(count()).toBe(0);
        expect(fs.existsSync(path.join(repo, '.caws/leases'))).toBe(false);
      } finally {
        fs.writeFileSync(library.path, original);
        library.sha256 = originalHash;
      }
      expect(prepare()).not.toBeNull();
    }
  );

  test.each([
    ['handler order', () => selection.handlers.reverse()],
    ['partial chain', () => selection.handlers.pop()],
    [
      'entry arguments',
      () => {
        selection.handlers[1].entry += ' --custom';
      },
    ],
    [
      'runtime identity',
      () => {
        request.runtimeDigest = 'a'.repeat(64);
      },
    ],
    [
      'event identity',
      () => {
        selection.event = 'post_tool_use';
      },
    ],
    [
      'configuration',
      () => {
        request.configuration = 'project';
      },
    ],
    [
      'library override',
      () => {
        selection.libraryOverrides['emit.sh'] = '/custom';
      },
    ],
    [
      'project library',
      () => {
        selection.libraries['emit.sh'].kind = 'project';
      },
    ],
    [
      'changed direct guard source',
      () => fs.appendFileSync(path.join(runtime, 'scope-guard.sh'), '\n# custom\n'),
    ],
    [
      'changed guard config helper',
      () => fs.appendFileSync(path.join(runtime, 'lib/guard-config.sh'), '\n# custom\n'),
    ],
    ['local bootstrap', () => put(path.join(lane, '.caws/hooks/runtime-paths.sh'), 'custom')],
    [
      'custom CLI',
      () => {
        environment.CAWS_BIN = '/custom/caws';
      },
    ],
    ['missing CLI', () => fs.unlinkSync(path.join(root, 'bin/caws'))],
    [
      'custom Node preload',
      () => {
        environment.NODE_OPTIONS = '--require custom';
      },
    ],
    [
      'armed latch',
      () => put(path.join(lane, '.codex/hooks/state/danger-latch-fixture.json'), '{}'),
    ],
  ])('%s declines whole typed route before any effects', (_, mutate) => {
    mutate();
    expect(prepare()).toBeNull();
    expect(count()).toBe(0);
  });

  test('ordinary in-scope edits admit without any scope strike', async () => {
    const result = await execute('scope-guard.sh');
    expect({ exitCode: result.exitCode, stdout: Buffer.from(result.stdout).toString() }).toEqual({
      exitCode: 0,
      stdout: '',
    });
    expect(count()).toBe(0);
  });
  test.each(['final', 'ancestor'])(
    'scope refuses an unresolved existing symlink at the %s target component without a strike',
    async (position) => {
      const link = path.join(lane, 'src/allowed/dangling');
      const outside = path.join(root, 'outside-not-created');
      fs.mkdirSync(path.dirname(link), { recursive: true });
      fs.symlinkSync(outside, link);
      const target = position === 'final' ? link : path.join(link, 'child.js');
      payload('Write', { file_path: target, content: 'never applied' });
      const result = await execute('scope-guard.sh');
      expect(result.exitCode).toBe(2);
      expect(decoded(result).reason).toContain('authority unavailable');
      expect(count()).toBe(0);
      expect(fs.lstatSync(link).isSymbolicLink()).toBe(true);
      expect(fs.readlinkSync(link)).toBe(outside);
      expect(fs.existsSync(outside)).toBe(false);
    }
  );
  test('scope admits an existing symlink whose resolved target is in scope', async () => {
    const target = path.join(lane, 'src/allowed/existing.js');
    const link = path.join(lane, 'src/allowed/alias.js');
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, 'original');
    fs.symlinkSync(target, link);
    payload('Write', { file_path: link, content: 'never applied' });
    const result = await execute('scope-guard.sh');
    expect({ exitCode: result.exitCode, stdout: Buffer.from(result.stdout).toString() }).toEqual({
      exitCode: 0,
      stdout: '',
    });
    expect(count()).toBe(0);
    expect(fs.readFileSync(target, 'utf8')).toBe('original');
  });
  test('one complete multi-target mutation records only one warning then Codex deny then hard block', async () => {
    patch('src/outside/a', 'src/outside/b');
    const first = await execute('scope-guard.sh');
    expect(first.exitCode).toBe(0);
    expect(decoded(first).hookSpecificOutput.additionalContext).toContain('strike 1 of 3');
    expect(count()).toBe(1);
    const second = await execute('scope-guard.sh');
    expect(second.exitCode).toBe(0);
    expect(decoded(second).hookSpecificOutput).toMatchObject({
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
    });
    expect(count()).toBe(2);
    const third = await execute('scope-guard.sh');
    expect(third.exitCode).toBe(2);
    expect(decoded(third).decision).toBe('block');
    expect(count()).toBe(3);
  });
  test.each(['src/forbidden/a', 'foreign'])(
    'a later hard refusal %s consumes no earlier queued strike',
    async (last) => {
      patch('src/outside/a', last === 'foreign' ? path.join(root, 'foreign/a') : last);
      expect((await execute('scope-guard.sh')).exitCode).toBe(2);
      expect(count()).toBe(0);
    }
  );
  test('configured scope prefixes use the actual loader keys and admit without strikes', async () => {
    Object.assign(
      environment,
      guardConfigurationEnvironment(
        JSON.stringify({
          guards: {
            'scope-guard.sh': {
              additional_allow_prefixes: [
                { prefix: 'src/extra/', reason: 'Fixture explicitly extends this prefix' },
              ],
            },
          },
        }),
        null
      )
    );
    payload('Edit', { file_path: 'src/extra/a' });
    expect((await execute('scope-guard.sh')).exitCode).toBe(0);
    expect(count()).toBe(0);
  });
  test('informational non-YAML spec entries do not break authoritative scope admission', async () => {
    put(path.join(repo, '.caws/specs/README.md'), 'fixture');
    expect((await execute('scope-guard.sh')).exitCode).toBe(0);
  });
  test('missing or malformed bound authority hard-refuses without strikes', async () => {
    put(path.join(repo, '.caws/specs/FILE-TOOLS-001.yaml'), 'bad: [');
    expect((await execute('scope-guard.sh')).exitCode).toBe(2);
    expect(count()).toBe(0);
  });
  test('a later foreign worktree target refuses even beneath allowlisted docs', async () => {
    const foreign = path.join(repo, '.caws/worktrees/foreign');
    fs.mkdirSync(foreign);
    registry.foreign = { path: foreign, owner: { session_id: 'another-owner' } };
    persist();
    patch('docs/own.md', path.join(foreign, 'docs/foreign.md'));
    expect((await execute('worktree-write-guard.sh')).exitCode).toBe(2);
  });
  test('move destinations cannot bypass owner or protected-path adjudication', async () => {
    payload('apply_patch', {
      command:
        '*** Begin Patch\n*** Update File: src/allowed/a\n*** Move to: .caws/hooks/guard.sh\n@@\n-old\n+new\n*** End Patch\n',
    });
    expect((await execute('protected-paths.sh')).exitCode).toBe(2);
  });
  test('documentation exemption does not stop inspection before a later protected target', async () => {
    patch('.caws/hooks/README.md', '.codex/hooks/protected.py');
    expect((await execute('protected-paths.sh')).exitCode).toBe(2);
    patch('.caws/hooks/README.md');
    expect((await execute('protected-paths.sh')).exitCode).toBe(0);
  });
  test('linked worktree private spec materialization and missing owner refuse', async () => {
    payload('Write', { file_path: '.caws/specs/private.yaml' });
    expect((await execute('worktree-write-guard.sh')).exitCode).toBe(2);
    delete registry.own.owner;
    persist();
    payload('Write', { file_path: 'docs/allowed.md' });
    expect((await execute('worktree-write-guard.sh')).exitCode).toBe(2);
  });
  test('source or latch substitution after admission fails without compatibility replay', async () => {
    const plan = prepare();
    expect(plan).not.toBeNull();
    put(path.join(repo, '.codex/hooks/state/danger-latch-new.json'), '{}');
    await expect(plan.execute(selection.handlers[1])).rejects.toThrow(
      'compatibility replay refused'
    );
    expect(count()).toBe(0);
  });
  test.each(['scope-guard.sh', 'lib/write-allowlist.sh', 'surfaces/codex/lib/parse-input.sh'])(
    'source substitution of %s after admission cannot replay compatibility',
    async (name) => {
      const plan = prepare();
      expect(plan).not.toBeNull();
      fs.appendFileSync(path.join(runtime, name), '\n# changed after prefix\n');
      await expect(plan.execute(selection.handlers[1])).rejects.toThrow(
        'compatibility replay refused'
      );
      expect(count()).toBe(0);
    }
  );
  test('malformed complete inventory blocks at scope and consumes no strike', async () => {
    payload('apply_patch', {
      command: '*** Begin Patch\n*** Update File: src/allowed/a\n@@\n*** End Patch\n',
    });
    const result = await execute('scope-guard.sh');
    expect(result.exitCode).toBe(2);
    expect(decoded(result).reason).toContain('Invalid original file-tool inventory');
    expect(count()).toBe(0);
  });
  test('global strike continuity folds legacy counts once and preserves other guard keys', async () => {
    put(path.join(lane, '.codex/logs/guard-strikes-file-tools-fixture.json'), {
      scope_guard: 1,
      another_guard: 7,
    });
    patch('src/outside/a');
    const result = await execute('scope-guard.sh');
    expect(decoded(result).hookSpecificOutput.permissionDecision).toBe('deny');
    expect(JSON.parse(fs.readFileSync(strikes()))).toEqual({ scope_guard: 2, another_guard: 7 });
    put(path.join(lane, '.codex/logs/guard-strikes-file-tools-fixture.json'), { scope_guard: 99 });
    expect((await execute('scope-guard.sh')).exitCode).toBe(2);
    expect(count()).toBe(3);
  });
  test('unbound scope remains progressive and unresolved raw strike identity cannot use fallback', async () => {
    selection.checkout = repo;
    request.payload.cwd = repo;
    patch('src/outside/a');
    expect((await execute('scope-guard.sh')).exitCode).toBe(0);
    expect(count()).toBe(1);
    request.payload = { ...request.payload, session_id: 'unknown' };
    request.inputJson = JSON.stringify(request.payload);
    environment.CAWS_SESSION_ID = 'file-tools-fixture';
    const result = await execute('scope-guard.sh');
    expect(result.exitCode).toBe(2);
    expect(decoded(result).reason).toContain('unresolved strike identity');
    expect(count()).toBe(1);
  });
  test.each(['historical', 'current'])(
    'own canonical scope claim requires its owning operating worktree: %s',
    async (profile) => {
      if (profile === 'current') installCurrentFileToolMembers();
      payload('Write', { file_path: path.join(repo, 'src/allowed/a') });
      expect((await execute('worktree-write-guard.sh')).exitCode).toBe(0);
      selection.checkout = repo;
      request.payload.cwd = repo;
      request.inputJson = JSON.stringify(request.payload);
      const result = await execute('worktree-write-guard.sh');
      expect(result.exitCode).toBe(2);
      expect(decoded(result).reason).toContain('claimed by worktree');
    }
  );
  test('secret advisory keeps token values out of output and never blocks', async () => {
    const token = 'AKIA' + 'A'.repeat(16);
    payload('Write', { file_path: 'src/allowed/config', content: token });
    const result = await execute('scan-secrets.sh');
    expect(result.exitCode).toBe(0);
    expect(decoded(result).hookSpecificOutput.additionalContext).toContain(
      'possible AWS access key'
    );
    expect(Buffer.from(result.stdout).toString()).not.toContain(token);
  });
  test('ordered composition runs heartbeat before guards and preserves warning before protected refusal', async () => {
    const observed = [];
    jest
      .spyOn(require('../../dist/runtime/agent-heartbeat'), 'executeAgentHeartbeat')
      .mockImplementation(async () => {
        observed.push('heartbeat-effect');
        return { exitCode: 0, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) };
      });
    patch('src/outside/a', '.caws/hooks/guard.sh');
    const plan = prepare();
    expect(plan).not.toBeNull();
    const result = await composeHandlers(
      selection,
      { signal: context.signal },
      {
        execute: (handler) => {
          observed.push(handler.name);
          return plan.execute(handler);
        },
        record: () => {},
      }
    );
    expect(observed.slice(0, 3)).toEqual([
      'agent-heartbeat.sh',
      'heartbeat-effect',
      'cwd-guard.sh',
    ]);
    expect(result.nativeResult.exitCode).toBe(2);
    expect(count()).toBe(1);
    expect(observed).toContain('protected-paths.sh');
    expect(observed).not.toContain('scan-secrets.sh');
  });

  // Routing checks use an injected context resolver and cache port, and replace
  // only heartbeat effects. They do not attest native execution/publication.
  test.each(['Write', 'Edit', 'apply_patch'])(
    'engine %s waits for prefix and executes all ten typed handlers with original input',
    async (tool) => {
      const { prepareRuntimeInvocation } = require('../../dist/runtime/engine');
      jest
        .spyOn(require('../../dist/runtime/agent-heartbeat'), 'executeAgentHeartbeat')
        .mockResolvedValue({ exitCode: 0, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) });
      if (tool === 'apply_patch') patch('src/allowed/a');
      else payload(tool, { file_path: 'src/allowed/a', content: 'ordinary' });
      request.sessionCache = 'caws.runtime.session-cache.v1';
      const original = request.inputJson;
      let release;
      const capture = jest.fn(
        () =>
          new Promise((resolve) => {
            release = resolve;
          })
      );
      const git = {
        run: jest.fn(async (args) =>
          args.includes('--show-toplevel') ? lane : path.join(repo, '.git')
        ),
      };
      const fileContext = {
        capture: jest.fn(async () => observation()),
        revalidate: jest.fn(async () => observation()),
      };
      const invocation = await prepareRuntimeInvocation(
        request,
        context.signal,
        { capture },
        git,
        undefined,
        undefined,
        async () => selection,
        undefined,
        undefined,
        undefined,
        undefined,
        fileContext,
        fixtureStrikePort()
      );
      expect(fileContext.capture).toHaveBeenCalledTimes(1);
      expect(fileContext.revalidate).not.toHaveBeenCalled();
      const pending = invocation.dispatch();
      await new Promise((resolve) => setImmediate(resolve));
      expect(capture).toHaveBeenCalledTimes(1);
      expect(
        require('../../dist/runtime/agent-heartbeat').executeAgentHeartbeat
      ).not.toHaveBeenCalled();
      expect(fileContext.revalidate).not.toHaveBeenCalled();
      release({ status: 'captured', envelopePublished: true, diagnostic: null });
      const result = await pending;
      expect(fileContext.revalidate).toHaveBeenCalledTimes(1);
      expect(result.nativeResult.exitCode).toBe(0);
      expect(request.inputJson).toBe(original);
      const rows = fs
        .readFileSync(
          path.join(
            repo,
            '.caws/sessions/file-tools-fixture/hook-invocations',
            request.id + '.jsonl'
          ),
          'utf8'
        )
        .trim()
        .split('\n')
        .map(JSON.parse);
      expect(
        rows.filter((row) => row.stage === 'handler_started').map((row) => row.handler)
      ).toEqual(names);
      expect(rows.some((row) => row.stage === 'compatibility_dispatch_completed')).toBe(false);
      expect(rows.findIndex((row) => row.stage === 'session_cache_completed')).toBeLessThan(
        rows.findIndex((row) => row.stage === 'handler_started')
      );
      await invocation.acknowledgeHandoff(true);
    }
  );

  test.each(['historical', 'current'])(
    'engine consumes one strike after prefix acknowledgement and before fresh ownership: %s',
    async (profile) => {
      if (profile === 'current') installCurrentFileToolMembers();
      // Routing proof with a receipt fixture; filesystem serialization is the real-core probe above.
      const { prepareRuntimeInvocation } = require('../../dist/runtime/engine');
      payload('Write', { file_path: 'src/outside/ordered.js', content: 'never applied' });
      request.sessionCache = 'caws.runtime.session-cache.v1';
      const observed = [];
      jest
        .spyOn(require('../../dist/runtime/agent-heartbeat'), 'executeAgentHeartbeat')
        .mockImplementation(async () => {
          observed.push('heartbeat');
          return { exitCode: 0, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) };
        });
      let release;
      const cache = {
        capture: jest.fn(() => {
          observed.push('cache-request');
          return new Promise((resolve) => {
            release = resolve;
          }).then((receipt) => {
            observed.push('cache-ack');
            return receipt;
          });
        }),
      };
      const fileContext = {
        capture: jest.fn(async () => {
          observed.push('capture1');
          return observation();
        }),
        revalidate: jest.fn(async () => {
          observed.push('capture2');
          return observation();
        }),
      };
      const strike = {
        incrementScopeGuard: jest.fn(async () => {
          observed.push('strike');
          return { count: 1, stateSha256: 'b'.repeat(64) };
        }),
      };
      const compatibility = jest.spyOn(
        require('../../dist/runtime/handler-executor'),
        'executeCompatibilityDispatch'
      );
      const git = {
        run: jest.fn(async (args) =>
          args.includes('--show-toplevel') ? lane : path.join(repo, '.git')
        ),
      };
      const invocation = await prepareRuntimeInvocation(
        request,
        context.signal,
        cache,
        git,
        undefined,
        undefined,
        async () => selection,
        undefined,
        undefined,
        undefined,
        undefined,
        fileContext,
        strike
      );
      expect(observed).toEqual(['capture1']);
      const pending = invocation.dispatch();
      await new Promise((resolve) => setImmediate(resolve));
      expect(observed).toEqual(['capture1', 'cache-request']);
      expect(strike.incrementScopeGuard).not.toHaveBeenCalled();
      release({ status: 'captured', envelopePublished: true, diagnostic: null });
      const result = await pending;
      expect(observed).toEqual([
        'capture1',
        'cache-request',
        'cache-ack',
        'heartbeat',
        'strike',
        'capture2',
      ]);
      expect(strike.incrementScopeGuard).toHaveBeenCalledTimes(1);
      expect(result.nativeResult.exitCode).toBe(0);
      expect(Buffer.from(result.nativeResult.stdout).toString()).toContain('strike 1 of 3');
      expect(compatibility).not.toHaveBeenCalled();
      const rows = fs
        .readFileSync(
          path.join(
            repo,
            '.caws/sessions/file-tools-fixture/hook-invocations',
            request.id + '.jsonl'
          ),
          'utf8'
        )
        .trim()
        .split('\n')
        .map(JSON.parse);
      expect(
        rows
          .filter((row) => row.stage === 'scope_strike_result')
          .map((row) => ({
            count: row.count,
            digest: row.state_sha256,
            boundary: row.observation_boundary,
          }))
      ).toEqual([{ count: 1, digest: 'b'.repeat(64), boundary: 'native_guard_strikes_result' }]);
      expect(count()).toBe(0);
      expect(qualificationChildren).toHaveLength(0);
      expect(fs.existsSync(path.join(lane, 'src/outside/ordered.js'))).toBe(false);
      await invocation.acknowledgeHandoff(true);
    }
  );

  test('bare primary linked checkout retains native heartbeat provenance and owned payload admission', async () => {
    const bare = path.join(repo, '.bare');
    fs.mkdirSync(bare);
    contextFacts = {
      commonDir: bare,
      gitDir: path.join(bare, 'worktrees/own'),
      worktrees: [
        { path: bare, branch: null, detached: false, prunable: false, bare: true },
        {
          path: lane,
          branch: 'refs/heads/caws/own',
          detached: false,
          prunable: false,
          bare: false,
        },
      ],
    };
    const createGit = jest
      .spyOn(require('../../dist/runtime/context'), 'createContextGitPort')
      .mockImplementation(() => {
        throw new Error('Node Git is forbidden');
      });
    const plan = prepare();
    expect(plan).not.toBeNull();
    const heartbeat = await plan.execute(selection.handlers[0]);
    expect(heartbeat.exitCode).toBe(0);
    expect(createGit).not.toHaveBeenCalled();
    const lease = JSON.parse(
      fs.readFileSync(path.join(repo, '.caws/leases/file-tools-fixture.json'), 'utf8')
    );
    expect(lease).toMatchObject({
      repo_root: repo,
      cwd: lane,
      git_common_dir: bare,
      git_dir: path.join(bare, 'worktrees/own'),
      branch: 'caws/own',
    });
    const owned = await plan.execute(
      selection.handlers.find((handler) => handler.name === 'worktree-write-guard.sh')
    );
    expect(owned.exitCode).toBe(0);
    expect(Buffer.from(owned.stdout).toString()).toBe('');
  });
  test('physical bare primary does not fabricate another working checkout', async () => {
    // This tests the consumer projection. Native owns the bare/commonDir topology join.
    const bare = path.join(repo, '.bare');
    fs.mkdirSync(bare);
    selection.checkout = repo;
    registry = {};
    persist();
    contextFacts = {
      commonDir: bare,
      gitDir: bare,
      branch: null,
      worktrees: [{ path: bare, branch: null, detached: false, prunable: false, bare: true }],
    };
    payload('Write', { file_path: 'src/unclaimed/a' });
    const result = await execute('worktree-write-guard.sh');
    expect(result.exitCode).toBe(0);
    expect(Buffer.from(result.stdout).toString()).toBe('');
  });
  test('missing strike capability declines the complete typed route before counter or heartbeat effects', () => {
    delete request.guardStrikes;
    expect(prepare()).toBeNull();
    expect(qualificationChildren).toHaveLength(0);
    expect(fs.existsSync(path.join(repo, '.caws/leases'))).toBe(false);
  });
  test.each([
    [1, 'warning'],
    [2, 'deny'],
    [3, 'block'],
    [99, 'block'],
  ])(
    'scope decision consumes exact injected count %s without claiming FS lock proof',
    async (countValue, expected) => {
      payload('Write', { file_path: 'src/outside/a' });
      const port = {
        incrementScopeGuard: jest.fn(async () => ({
          count: countValue,
          stateSha256: 'b'.repeat(64),
        })),
      };
      const plan = prepare(undefined, port);
      expect(plan).not.toBeNull();
      const result = await plan.execute(
        selection.handlers.find((handler) => handler.name === 'scope-guard.sh')
      );
      expect(port.incrementScopeGuard).toHaveBeenCalledTimes(1);
      if (expected === 'block') {
        expect(result.exitCode).toBe(2);
        expect(decoded(result).decision).toBe('block');
      } else if (expected === 'deny') {
        expect(result.exitCode).toBe(0);
        expect(decoded(result).hookSpecificOutput.permissionDecision).toBe('deny');
      } else {
        expect(result.exitCode).toBe(0);
        expect(decoded(result).hookSpecificOutput.additionalContext).toContain('strike 1 of 3');
      }
      expect(qualificationChildren).toHaveLength(0);
      expect(count()).toBe(0);
    }
  );
  test('later hard refusal consumes no fixed strike transaction', async () => {
    patch('src/outside/a', 'src/forbidden/a');
    const port = { incrementScopeGuard: jest.fn() };
    const plan = prepare(undefined, port);
    expect(plan).not.toBeNull();
    const result = await plan.execute(
      selection.handlers.find((handler) => handler.name === 'scope-guard.sh')
    );
    expect(result.exitCode).toBe(2);
    expect(port.incrementScopeGuard).not.toHaveBeenCalled();
    expect(qualificationChildren).toHaveLength(0);
    expect(count()).toBe(0);
  });
  test('a latch armed during the asynchronous increment refuses before a later guard', async () => {
    payload('Write', { file_path: 'src/outside/a' });
    const port = {
      incrementScopeGuard: jest.fn(async () => {
        put(path.join(lane, '.codex/hooks/state/danger-latch-during-increment.json'), '{}');
        return { count: 1, stateSha256: 'b'.repeat(64) };
      }),
    };
    const plan = prepare(undefined, port);
    expect(plan).not.toBeNull();
    const result = await plan.execute(
      selection.handlers.find((handler) => handler.name === 'scope-guard.sh')
    );
    expect(result.exitCode).toBe(2);
    expect(decoded(result).reason).toContain('compatibility replay refused');
    expect(port.incrementScopeGuard).toHaveBeenCalledTimes(1);
    expect(count()).toBe(0);
  });
  test('uncertain strike commit produces a hard refusal without retry or local write', async () => {
    payload('Write', { file_path: 'src/outside/a' });
    const port = {
      incrementScopeGuard: jest.fn(async () => {
        throw new Error('PublicationUncertain');
      }),
    };
    const plan = prepare(undefined, port);
    expect(plan).not.toBeNull();
    const result = await plan.execute(
      selection.handlers.find((handler) => handler.name === 'scope-guard.sh')
    );
    expect(result.exitCode).toBe(2);
    expect(decoded(result).reason).toContain('PublicationUncertain');
    expect(port.incrementScopeGuard).toHaveBeenCalledTimes(1);
    expect(count()).toBe(0);
  });
  test('older capability or absent native binding declines before heartbeat effects', () => {
    expect(prepareFileToolHandlers(context)).toBeNull();
    delete request.fileToolContext;
    expect(prepare()).toBeNull();
    expect(fs.existsSync(path.join(repo, '.caws/leases'))).toBe(false);
    expect(count()).toBe(0);
  });
  test('real heartbeat consumes captured native provenance without Node Git', async () => {
    const createGit = jest
      .spyOn(require('../../dist/runtime/context'), 'createContextGitPort')
      .mockImplementation(() => {
        throw new Error('Node Git is forbidden');
      });
    const plan = prepare();
    expect(plan).not.toBeNull();
    contextFacts.branch = 'later-branch';
    const result = await plan.execute(selection.handlers[0]);
    expect(result.exitCode).toBe(0);
    expect(createGit).not.toHaveBeenCalled();
    const lease = JSON.parse(
      fs.readFileSync(path.join(repo, '.caws/leases/file-tools-fixture.json'), 'utf8')
    );
    expect(lease).toMatchObject({
      repo_root: repo,
      cwd: lane,
      git_common_dir: path.join(repo, '.git'),
      git_dir: path.join(repo, '.git/worktrees/own'),
      branch: 'caws/own',
      hook_pid: process.pid,
    });
  });
  test('clear canonical base write requires Codex deny while worktrees are active', async () => {
    selection.checkout = repo;
    payload('Write', { file_path: 'src/unclaimed/a' });
    const result = await execute('worktree-write-guard.sh');
    expect(result.exitCode).toBe(0);
    expect(decoded(result).hookSpecificOutput).toMatchObject({
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
    });
    expect(decoded(result).hookSpecificOutput.permissionDecisionReason).toContain(
      'User approval is required'
    );
  });
  test('a registry branch-name match does not confer canonical ownership', async () => {
    selection.checkout = repo;
    contextFacts.branch = 'caws/own';
    payload('Write', { file_path: 'src/unclaimed/a' });
    expect(
      decoded(await execute('worktree-write-guard.sh')).hookSpecificOutput.permissionDecision
    ).toBe('deny');
  });
  test('unborn branch with no other worktrees permits bridged first-commit source edits', async () => {
    selection.checkout = repo;
    registry = {};
    delete spec.worktree;
    persist();
    put(path.join(repo, '.caws/claims/bridge.json'), {
      [spec.id]: {
        session_id: 'file-tools-fixture',
        platform: 'codex',
        acquired_at: '2026-10-29T00:00:00Z',
      },
    });
    contextFacts = {
      branch: null,
      worktrees: [
        { path: repo, branch: 'refs/heads/main', detached: false, prunable: false, bare: false },
      ],
    };
    payload('Write', { file_path: 'src/allowed/first.js' });
    const scoped = await execute('scope-guard.sh');
    expect(scoped.exitCode).toBe(0);
    expect(Buffer.from(scoped.stdout).toString()).toBe('');
    expect(count()).toBe(0);
    const owned = await execute('worktree-write-guard.sh');
    expect(owned.exitCode).toBe(0);
    expect(Buffer.from(owned.stdout).toString()).toBe('');
  });
  test('unavailable branch with a live other worktree cannot fabricate a branch match', async () => {
    selection.checkout = repo;
    registry = {};
    persist();
    contextFacts.branch = null;
    payload('Write', { file_path: 'src/unclaimed/a' });
    const result = await execute('worktree-write-guard.sh');
    expect(result.exitCode).toBe(2);
    expect(decoded(result).reason).toContain('current branch could not be established');
  });
  test('clear coordination allowlist does not need a fabricated branch fact', async () => {
    selection.checkout = repo;
    contextFacts.branch = null;
    payload('Write', { file_path: 'docs/coordination.md' });
    const result = await execute('worktree-write-guard.sh');
    expect(result.exitCode).toBe(0);
    expect(Buffer.from(result.stdout).toString()).toBe('');
  });
  test('fresh merge observation is consumed immediately before ownership', async () => {
    selection.checkout = repo;
    payload('Write', { file_path: 'src/unclaimed/a' });
    const fresh = jest.fn(async () => ({ ...observation(), mergeInProgress: true }));
    const plan = prepare(fresh);
    expect(plan).not.toBeNull();
    const result = await plan.execute(
      selection.handlers.find((handler) => handler.name === 'worktree-write-guard.sh')
    );
    expect(fresh).toHaveBeenCalledTimes(1);
    expect(result.exitCode).toBe(0);
    expect(Buffer.from(result.stdout).toString()).toBe('');
  });
  test('fresh merge state cannot override a foreign canonical claim', async () => {
    selection.checkout = repo;
    contextFacts.mergeInProgress = true;
    payload('Write', { file_path: 'src/allowed/a' });
    const result = await execute('worktree-write-guard.sh');
    expect(result.exitCode).toBe(2);
    expect(decoded(result).reason).toContain('claimed by worktree');
  });
  test('fresh context failure after real heartbeat refuses without compatibility replay', async () => {
    const plan = prepare(async () => {
      throw new Error('fresh native observation failed');
    });
    expect(plan).not.toBeNull();
    await plan.execute(selection.handlers[0]);
    expect(fs.existsSync(path.join(repo, '.caws/leases/file-tools-fixture.json'))).toBe(true);
    const result = await plan.execute(
      selection.handlers.find((handler) => handler.name === 'worktree-write-guard.sh')
    );
    expect(result.exitCode).toBe(2);
    expect(decoded(result).reason).toContain('fresh native observation failed');
  });
  test('source replacement during revalidation cannot reach ownership', async () => {
    const plan = prepare(async () => {
      fs.appendFileSync(path.join(runtime, 'worktree-write-guard.sh'), '\n# changed\n');
      return observation();
    });
    expect(plan).not.toBeNull();
    const result = await plan.execute(
      selection.handlers.find((handler) => handler.name === 'worktree-write-guard.sh')
    );
    expect(result.exitCode).toBe(2);
    expect(decoded(result).reason).toContain('compatibility replay refused');
  });
  test('a later canonical claim overrides a queued base-write approval', async () => {
    selection.checkout = repo;
    patch('src/unclaimed/a', path.join(repo, 'src/allowed/a'));
    const result = await execute('worktree-write-guard.sh');
    expect(result.exitCode).toBe(2);
    expect(decoded(result).reason).toContain('claimed by worktree');
  });
  test('actual detached worktree inventory prevents a false zero-worktree allow', async () => {
    selection.checkout = repo;
    registry = {};
    persist();
    contextFacts.worktrees = [
      { path: repo, branch: 'refs/heads/main', detached: false, prunable: false, bare: false },
      { path: lane, branch: null, detached: true, prunable: false, bare: false },
    ];
    payload('Write', { file_path: 'src/unclaimed/a' });
    expect(
      decoded(await execute('worktree-write-guard.sh')).hookSpecificOutput.permissionDecision
    ).toBe('deny');
  });
  test('prunable inventory rows do not fabricate live worktree contention', async () => {
    selection.checkout = repo;
    registry = {};
    persist();
    contextFacts.branch = null;
    contextFacts.worktrees = [
      { path: repo, branch: null, detached: true, prunable: false, bare: false },
      { path: lane, branch: null, detached: true, prunable: true, bare: false },
    ];
    payload('Write', { file_path: 'src/unclaimed/a' });
    const result = await execute('worktree-write-guard.sh');
    expect(result.exitCode).toBe(0);
    expect(Buffer.from(result.stdout).toString()).toBe('');
  });
  test('ask-incapable base write hard-refuses', async () => {
    selection.checkout = repo;
    environment.CAWS_GUARD_NO_ASK = '1';
    payload('Write', { file_path: 'src/unclaimed/a' });
    const result = await execute('worktree-write-guard.sh');
    expect(result.exitCode).toBe(2);
    expect(decoded(result).reason).toContain('cannot request approval');
  });
  test('older engine capability retains the complete original dispatcher before native prefix effects', async () => {
    const { prepareRuntimeInvocation } = require('../../dist/runtime/engine');
    delete request.fileToolContext;
    delete request.guardStrikes;
    request.sessionCache = 'caws.runtime.session-cache.v1';
    const original = request.inputJson;
    const cache = { capture: jest.fn() };
    const heartbeat = jest.spyOn(
      require('../../dist/runtime/agent-heartbeat'),
      'executeAgentHeartbeat'
    );
    const compatibility = jest
      .spyOn(require('../../dist/runtime/handler-executor'), 'executeCompatibilityDispatch')
      .mockResolvedValue({
        exitCode: 0,
        stdout: Buffer.alloc(0),
        stderr: Buffer.alloc(0),
        executionRecords: Buffer.alloc(0),
        offerReceipts: Buffer.alloc(0),
      });
    const git = {
      run: jest.fn(async (args) =>
        args.includes('--show-toplevel') ? lane : path.join(repo, '.git')
      ),
    };
    const invocation = await prepareRuntimeInvocation(
      request,
      context.signal,
      cache,
      git,
      undefined,
      undefined,
      async () => selection
    );
    const result = await invocation.dispatch();
    expect(result.nativeResult.exitCode).toBe(0);
    expect(compatibility).toHaveBeenCalledTimes(1);
    expect(compatibility.mock.calls[0][0].request.inputJson).toBe(original);
    expect(cache.capture).not.toHaveBeenCalled();
    expect(heartbeat).not.toHaveBeenCalled();
    await invocation.acknowledgeHandoff(true);
  });
  test('missing strike capability retains compatibility before context capture or prefix', async () => {
    const { prepareRuntimeInvocation } = require('../../dist/runtime/engine');
    delete request.guardStrikes;
    request.sessionCache = 'caws.runtime.session-cache.v1';
    const cache = { capture: jest.fn() };
    const fileContext = { capture: jest.fn(), revalidate: jest.fn() };
    const heartbeat = jest.spyOn(
      require('../../dist/runtime/agent-heartbeat'),
      'executeAgentHeartbeat'
    );
    const compatibility = jest
      .spyOn(require('../../dist/runtime/handler-executor'), 'executeCompatibilityDispatch')
      .mockResolvedValue({
        exitCode: 0,
        stdout: Buffer.alloc(0),
        stderr: Buffer.alloc(0),
        executionRecords: Buffer.alloc(0),
        offerReceipts: Buffer.alloc(0),
      });
    const git = {
      run: jest.fn(async (args) =>
        args.includes('--show-toplevel') ? lane : path.join(repo, '.git')
      ),
    };
    const invocation = await prepareRuntimeInvocation(
      request,
      context.signal,
      cache,
      git,
      undefined,
      undefined,
      async () => selection,
      undefined,
      undefined,
      undefined,
      undefined,
      fileContext
    );
    const result = await invocation.dispatch();
    expect(result.nativeResult.exitCode).toBe(0);
    expect(compatibility).toHaveBeenCalledTimes(1);
    expect(fileContext.capture).not.toHaveBeenCalled();
    expect(fileContext.revalidate).not.toHaveBeenCalled();
    expect(cache.capture).not.toHaveBeenCalled();
    expect(heartbeat).not.toHaveBeenCalled();
    expect(qualificationChildren).toHaveLength(0);
    expect(count()).toBe(0);
    await invocation.acknowledgeHandoff(true);
  });
  test('engine keeps completed prefix and heartbeat when fresh ownership observation fails', async () => {
    const { prepareRuntimeInvocation } = require('../../dist/runtime/engine');
    request.sessionCache = 'caws.runtime.session-cache.v1';
    const cache = {
      capture: jest.fn(async () => ({
        status: 'captured',
        envelopePublished: true,
        diagnostic: null,
      })),
    };
    const fileContext = {
      capture: jest.fn(async () => observation()),
      revalidate: jest.fn(async () => {
        throw new Error('fresh native observation failed');
      }),
    };
    const compatibility = jest.spyOn(
      require('../../dist/runtime/handler-executor'),
      'executeCompatibilityDispatch'
    );
    const git = {
      run: jest.fn(async (args) =>
        args.includes('--show-toplevel') ? lane : path.join(repo, '.git')
      ),
    };
    const invocation = await prepareRuntimeInvocation(
      request,
      context.signal,
      cache,
      git,
      undefined,
      undefined,
      async () => selection,
      undefined,
      undefined,
      undefined,
      undefined,
      fileContext,
      fixtureStrikePort()
    );
    const result = await invocation.dispatch();
    expect(result.nativeResult.exitCode).toBe(2);
    expect(Buffer.from(result.nativeResult.stdout).toString()).toContain(
      'fresh native observation failed'
    );
    expect(cache.capture).toHaveBeenCalledTimes(1);
    expect(fileContext.capture).toHaveBeenCalledTimes(1);
    expect(fileContext.revalidate).toHaveBeenCalledTimes(1);
    expect(compatibility).not.toHaveBeenCalled();
    expect(fs.existsSync(path.join(repo, '.caws/leases/file-tools-fixture.json'))).toBe(true);
    await invocation.acknowledgeHandoff(true);
  });
});
