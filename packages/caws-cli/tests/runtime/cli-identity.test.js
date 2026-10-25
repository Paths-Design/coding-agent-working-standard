'use strict';
// Miniature domains test comparison semantics without granting native review
// authority. Real installer qualification retains separate package/source proof.
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { AbortController } = globalThis;
// Comparison and revalidation share the original 30-second request budget.
// Let that contract settle before the runner ends a slow filesystem test.
const ORIGINAL_BUDGET_MS = 30000;
jest.setTimeout(ORIGINAL_BUDGET_MS + 5000);
const {
  compareCliIdentity,
  assertMatchedCliIdentityReceipt,
  cliClosureDigest,
  CLI_IDENTITY_LIMITS,
} = require('../../dist/runtime/cli-identity');
const CLI = 'node_modules/@paths.design/caws-cli';
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
const pin = (file) => ({
  sha256: sha(fs.readFileSync(file)),
  sizeBytes: fs.statSync(file).size,
  mode: fs.statSync(file).mode & 0o777,
});
const json = (file, data) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(data, null, 2) + '\n');
};
let root, reference, selected, bin, input, controller, nodePin;
beforeAll(() => {
  nodePin = { ...pin(fs.realpathSync(process.execPath)), path: fs.realpathSync(process.execPath) };
});
beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'caws-cli-identity-')));
  reference = path.join(root, 'reference');
  selected = path.join(root, 'selected');
  bin = path.join(root, 'bin');
  fs.mkdirSync(bin, { recursive: true });
  const files = {};
  const contents = {
    [CLI + '/package.json']: JSON.stringify({
      name: '@paths.design/caws-cli',
      version: '1.0.0',
      bin: { caws: 'dist/index.js' },
      dependencies: { 'example-dep': '1.0.0' },
    }),
    [CLI + '/dist/index.js']: "#!/usr/bin/env node\nrequire('./application');\n",
    [CLI + '/dist/application.js']: "module.exports = require('example-dep');\n",
    'node_modules/example-dep/package.json': JSON.stringify({
      name: 'example-dep',
      version: '1.0.0',
      main: 'index.js',
      type: 'commonjs',
    }),
    'node_modules/example-dep/index.js': "module.exports = 'stock';\n",
  };
  for (const [relative, text] of Object.entries(contents)) {
    for (const prefix of [reference, selected]) {
      const file = path.join(prefix, relative);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, text, { mode: relative.endsWith('/dist/index.js') ? 0o755 : 0o644 });
    }
    files[relative] = pin(path.join(reference, relative));
  }
  for (const prefix of [reference, selected])
    json(path.join(prefix, 'package.json'), {
      private: true,
      dependencies: { '@paths.design/caws-cli': '1.0.0' },
    });
  fs.symlinkSync(path.join(selected, CLI, 'dist/index.js'), path.join(bin, 'caws'));
  fs.symlinkSync(nodePin.path, path.join(bin, 'node'));
  const reviewed = {
    prefixRoot: reference,
    files,
    packages: {
      [CLI]: { name: '@paths.design/caws-cli', version: '1.0.0' },
      'node_modules/example-dep': { name: 'example-dep', version: '1.0.0' },
    },
    omissions: {},
    node: nodePin,
  };
  const domain = {
    schema: 'caws.cli.agents-stop-domain.v1',
    operation: 'agents-stop-explicit-session-opencode',
    closureSha256: cliClosureDigest(reviewed),
    importers: [
      {
        path: CLI + '/dist/index.js',
        sha256: files[CLI + '/dist/index.js'].sha256,
        requests: [{ line: 2, request: './application', target: CLI + '/dist/application.js' }],
      },
      {
        path: CLI + '/dist/application.js',
        sha256: files[CLI + '/dist/application.js'].sha256,
        requests: [
          { line: 1, request: 'example-dep', target: 'node_modules/example-dep/index.js' },
        ],
      },
      {
        path: 'node_modules/example-dep/index.js',
        sha256: files['node_modules/example-dep/index.js'].sha256,
        requests: [],
      },
    ],
    dormantSites: [],
  };
  const domainFile = path.join(root, 'reviewed-domain.json');
  json(domainFile, domain);
  reviewed.domain = { ...pin(domainFile), path: domainFile };
  controller = new AbortController();
  input = {
    reviewed,
    request: {
      schema: 'caws.runtime.request.v1',
      id: 'identity-original',
      runtimeDigest: 'a'.repeat(64),
      surface: 'opencode',
      event: 'stop',
      configuration: 'system',
      caller: {
        environment: { PATH: bin, HOME: path.join(root, 'home') },
        cwd: root,
        processId: process.pid,
      },
      deadlineEpochMs: Date.now() + ORIGINAL_BUDGET_MS,
      inputJson: '{"session_id":"identity-original"}',
      payload: { session_id: 'identity-original' },
    },
    signal: controller.signal,
  };
});
afterEach(() => {
  jest.restoreAllMocks();
  fs.rmSync(root, { recursive: true, force: true });
});
const decline = async () => {
  const result = await compareCliIdentity(input);
  expect(result.status).toBe('declined');
  return result;
};
describe('component content and binding controls', () => {
  test('receipt owner is the exact original request and signal, not a copied shape', async () => {
    const result = await compareCliIdentity(input);
    expect(result.status).toBe('matched');
    expect(() =>
      assertMatchedCliIdentityReceipt(result.receipt, input.request, input.signal)
    ).not.toThrow();
    expect(() => result.receipt.assertOwner(input.request, input.signal)).not.toThrow();
    expect(() => result.receipt.assertOwner({ ...input.request }, input.signal)).toThrow(
      /another original/
    );
    expect(() => result.receipt.assertOwner(input.request, new AbortController().signal)).toThrow(
      /another original/
    );
    expect(() =>
      assertMatchedCliIdentityReceipt(
        { assertOwner() {}, async revalidate() {} },
        input.request,
        input.signal
      )
    ).toThrow(/provenance/);
    const copied = { ...result.receipt };
    expect(() => assertMatchedCliIdentityReceipt(copied, input.request, input.signal)).toThrow(
      /provenance/
    );
    expect(() => result.receipt.assertOwner.call(copied, input.request, input.signal)).toThrow(
      /provenance/
    );
    await expect(result.receipt.revalidate.call(copied)).rejects.toThrow(/provenance/);
  });
  test.each(['id', 'runtimeDigest', 'inputJson'])(
    'changed original %s revokes the receipt',
    async (field) => {
      const result = await compareCliIdentity(input);
      expect(result.status).toBe('matched');
      input.request[field] = field === 'runtimeDigest' ? 'b'.repeat(64) : 'changed';
      expect(() => result.receipt.assertOwner(input.request, input.signal)).toThrow(
        /original request/
      );
      await expect(result.receipt.revalidate()).rejects.toThrow(/original request/);
      expect((await compareCliIdentity(input)).status).toBe('declined');
    }
  );
  test('changing reviewed source identity or replacing its object cannot renew the original', async () => {
    const result = await compareCliIdentity(input);
    expect(result.status).toBe('matched');
    expect((await compareCliIdentity({ ...input, reviewed: { ...input.reviewed } })).status).toBe(
      'declined'
    );
    input.reviewed.domain = { ...input.reviewed.domain, sha256: '0'.repeat(64) };
    expect(() => result.receipt.assertOwner(input.request, input.signal)).toThrow(
      /reviewed generation/
    );
    await expect(result.receipt.revalidate()).rejects.toThrow(/reviewed generation/);
  });
  test('cancelled receipt cannot be revived with a fresh signal', async () => {
    const result = await compareCliIdentity(input);
    expect(result.status).toBe('matched');
    controller.abort();
    expect(() => result.receipt.assertOwner(input.request, input.signal)).toThrow(/cancelled/);
    await expect(result.receipt.revalidate()).rejects.toThrow(/cancelled/);
    expect(
      (await compareCliIdentity({ ...input, signal: new AbortController().signal })).status
    ).toBe('declined');
  });
  test('backward wall clock cannot extend the original monotonic budget', async () => {
    const { performance } = require('node:perf_hooks');
    const start = performance.now(),
      wall = Date.now();
    const result = await compareCliIdentity(input);
    expect(result.status).toBe('matched');
    jest.spyOn(Date, 'now').mockReturnValue(wall - 60000);
    const clock = jest.spyOn(performance, 'now').mockReturnValue(start + 60000);
    expect(() => result.receipt.assertOwner(input.request, input.signal)).toThrow(/deadline/);
    await expect(result.receipt.revalidate()).rejects.toThrow(/deadline/);
    expect((await compareCliIdentity(input)).status).toBe('declined');
    clock.mockRestore();
  });
  test('genuine package-derived bin links are admitted in both installations', async () => {
    for (const prefix of [reference, selected]) {
      fs.mkdirSync(path.join(prefix, 'node_modules/.bin'));
      fs.symlinkSync(
        '../@paths.design/caws-cli/dist/index.js',
        path.join(prefix, 'node_modules/.bin/caws')
      );
    }
    const result = await compareCliIdentity(input);
    expect(result.status).toBe('matched');
    await expect(result.receipt.revalidate()).resolves.toBeUndefined();
    fs.unlinkSync(path.join(reference, 'node_modules/.bin/caws'));
    fs.symlinkSync(
      path.join(selected, CLI, 'dist/index.js'),
      path.join(reference, 'node_modules/.bin/caws')
    );
    await expect(result.receipt.revalidate()).rejects.toThrow(/Redirected bin/);
  });
  test('independent package paths match and retained receipt revalidates', async () => {
    const result = await compareCliIdentity(input);
    expect(result.status).toBe('matched');
    expect(result.receipt.selectedEntry).toBe(path.join(selected, CLI, 'dist/index.js'));
    expect(result.receipt.selectedEntry).not.toBe(path.join(reference, CLI, 'dist/index.js'));
    await expect(result.receipt.revalidate()).resolves.toBeUndefined();
  });
  test('common unused fallback modules do not reject an internal reviewed request graph', async () => {
    json(path.join(root, 'node_modules/unrelated/package.json'), {
      name: 'unrelated',
      version: '1.0.0',
    });
    const result = await compareCliIdentity(input);
    expect(result.status).toBe('matched');
    await expect(result.receipt.revalidate()).resolves.toBeUndefined();
  });
  test.each([CLI + '/dist/application.js', 'node_modules/example-dep/index.js'])(
    'changed %s declines beneath identical startup/version',
    async (relative) => {
      const file = path.join(selected, relative),
        prior = fs.readFileSync(file, 'utf8');
      fs.writeFileSync(
        file,
        prior.replace(
          relative.includes('application') ? 'example-dep' : 'stock',
          relative.includes('application') ? 'another-dep' : 'alien'
        )
      );
      expect(fs.readFileSync(path.join(selected, CLI, 'dist/index.js'))).toEqual(
        fs.readFileSync(path.join(reference, CLI, 'dist/index.js'))
      );
      expect((await decline()).reason).toMatch(/content|size/);
    }
  );
  test.each(['type', 'exports', 'imports', 'bin'])(
    'changed package %s boundary declines',
    async (field) => {
      const file = path.join(selected, 'node_modules/example-dep/package.json'),
        data = JSON.parse(fs.readFileSync(file));
      data[field] = field === 'type' ? 'module' : { '.': './other.js' };
      json(file, data);
      await decline();
    }
  );
  test.each(['shadow.js', 'node_modules/example-dep/index.js'])(
    'unexpected resolution source %s declines',
    async (name) => {
      const file = path.join(selected, CLI, name);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, 'throw Error("must never execute");\n');
      await decline();
    }
  );
  test('a dependency symlink is not an equivalent file', async () => {
    const file = path.join(selected, 'node_modules/example-dep/index.js');
    fs.unlinkSync(file);
    fs.symlinkSync(path.join(reference, 'node_modules/example-dep/index.js'), file);
    await decline();
  });
  test('hardlinks decline', async () => {
    const file = path.join(selected, 'node_modules/example-dep/index.js');
    fs.linkSync(file, path.join(root, 'second-link'));
    await decline();
  });
  test('caller table edits cannot remove a reviewed request', async () => {
    const file = input.reviewed.domain.path,
      data = JSON.parse(fs.readFileSync(file));
    data.importers[1].requests = [];
    json(file, data);
    expect((await decline()).reason).toMatch(/size|content/);
  });
  test('a separately pinned malformed graph cannot omit an importer', async () => {
    const file = input.reviewed.domain.path,
      data = JSON.parse(fs.readFileSync(file));
    data.importers.pop();
    json(file, data);
    input.reviewed.domain = { ...pin(file), path: file };
    expect((await decline()).reason).toMatch(/Incomplete reviewed importer/);
  });
  test('a separately pinned wrong expected target declines at actual resolution', async () => {
    const file = input.reviewed.domain.path,
      data = JSON.parse(fs.readFileSync(file));
    data.importers[1].requests[0].request = './application';
    json(file, data);
    input.reviewed.domain = { ...pin(file), path: file };
    expect((await decline()).reason).toMatch(/resolution diverged/);
  });
  test('unknown dynamic loader disposition refuses', async () => {
    const file = input.reviewed.domain.path,
      data = JSON.parse(fs.readFileSync(file));
    data.dormantSites = [
      { path: CLI + '/dist/application.js', line: 1, kind: 'arbitrary-loader', proof: [] },
    ];
    json(file, data);
    input.reviewed.domain = { ...pin(file), path: file };
    await decline();
  });
  test('matching code at a replacement release cannot retarget a retained receipt', async () => {
    const first = await compareCliIdentity(input);
    expect(first.status).toBe('matched');
    const replacement = path.join(root, 'replacement');
    fs.cpSync(selected, replacement, { recursive: true });
    fs.unlinkSync(path.join(bin, 'caws'));
    fs.symlinkSync(path.join(replacement, CLI, 'dist/index.js'), path.join(bin, 'caws'));
    expect((await compareCliIdentity(input)).status).toBe('matched');
    await expect(first.receipt.revalidate()).rejects.toThrow();
  });
  test('earlier executable appearance invalidates retained selection', async () => {
    const earlier = path.join(root, 'earlier');
    fs.mkdirSync(earlier);
    input.request.caller.environment.PATH = earlier + path.delimiter + bin;
    const first = await compareCliIdentity(input);
    expect(first.status).toBe('matched');
    fs.writeFileSync(path.join(earlier, 'caws'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    await expect(first.receipt.revalidate()).rejects.toThrow();
  });
  test('unused fallback-directory mutation invalidates retained observation', async () => {
    fs.mkdirSync(path.join(root, 'node_modules'));
    const first = await compareCliIdentity(input);
    expect(first.status).toBe('matched');
    json(path.join(root, 'node_modules/new-package/package.json'), {
      name: 'new-package',
      version: '1.0.0',
    });
    await expect(first.receipt.revalidate()).rejects.toThrow();
  });
  test('cancellation immediately after file open still closes its owned descriptor', async () => {
    const actual = fsp.open;
    let closed = false;
    const spy = jest.spyOn(fsp, 'open').mockImplementationOnce(async (...args) => {
      const handle = await actual(...args),
        close = handle.close.bind(handle);
      handle.close = async () => {
        closed = true;
        return close();
      };
      controller.abort();
      return handle;
    });
    expect((await decline()).reason).toMatch(/cancelled/);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(closed).toBe(true);
  });
  test('changed file between stat and descriptor capture declines', async () => {
    const actual = fsp.open,
      file = path.join(selected, CLI, 'dist/application.js');
    jest.spyOn(fsp, 'open').mockImplementation(async (name, ...args) => {
      const handle = await actual(name, ...args);
      if (name === file)
        fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace('example-dep', 'another-dep'));
      return handle;
    });
    await decline();
  });
  test('expired original deadline declines before any source IO', async () => {
    input.request.deadlineEpochMs = Date.now() - 1;
    const stat = jest.spyOn(fsp, 'lstat');
    expect((await decline()).reason).toMatch(/deadline/);
    expect(stat).not.toHaveBeenCalled();
  });
  test('retained receipt does not gain a fresh deadline', async () => {
    const first = await compareCliIdentity(input);
    expect(first.status).toBe('matched');
    jest.spyOn(Date, 'now').mockReturnValue(input.request.deadlineEpochMs + 1);
    await expect(first.receipt.revalidate()).rejects.toThrow();
  });
  test.each([undefined, '', '.:' + path.delimiter + bin, bin + path.delimiter])(
    'unsupported PATH %s declines',
    async (value) => {
      if (value === undefined) delete input.request.caller.environment.PATH;
      else input.request.caller.environment.PATH = value;
      await decline();
    }
  );
  test.each([
    'CAWS_BIN',
    'NODE_OPTIONS',
    'NODE_PATH',
    'BASH_ENV',
    'CAWS_PRIOR_BASH_ENV',
    'LD_PRELOAD',
    'DYLD_INSERT_LIBRARIES',
    'BASH_FUNC_caws%%',
  ])('custom %s declines without source IO', async (key) => {
    input.request.caller.environment[key] = 'custom';
    const stat = jest.spyOn(fsp, 'lstat');
    await decline();
    expect(stat).not.toHaveBeenCalled();
  });
  test('file inventory beyond the finite limit refuses before source IO', async () => {
    for (let n = 0; n <= CLI_IDENTITY_LIMITS.files; n++)
      input.reviewed.files['node_modules/unused/' + n + '.js'] = {
        sha256: '0'.repeat(64),
        sizeBytes: 0,
        mode: 0o644,
      };
    const stat = jest.spyOn(fsp, 'lstat');
    expect((await decline()).reason).toMatch(/inventory bound/);
    expect(stat).not.toHaveBeenCalled();
  });
  test('byte bound refuses oversized Node pin', async () => {
    input.reviewed.node = { ...nodePin, sizeBytes: CLI_IDENTITY_LIMITS.nodeBytes + 1 };
    await decline();
  });
  test('selected custom Node cannot execute', async () => {
    fs.unlinkSync(path.join(bin, 'node'));
    fs.writeFileSync(
      path.join(bin, 'node'),
      '#!/bin/sh\ntouch ' + path.join(root, 'executed') + '\n',
      { mode: 0o755 }
    );
    await decline();
    expect(fs.existsSync(path.join(root, 'executed'))).toBe(false);
  });
});
