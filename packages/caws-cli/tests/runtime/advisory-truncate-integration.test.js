const fs = require('node:fs');
const path = require('node:path');
const { installMachineRuntime } = require('../../dist/init/machine-adapters');
const { scenario, temporaryRoot, invoke, succeeds } = require('./runtime-asset-fixture')();
const cli = path.resolve(__dirname, '../..');
const templates = path.join(cli, 'templates/hook-packs');
const quote = (text) => "'" + text.replace(/'/g, "'\\''") + "'";
function put(file, bytes, mode = 0o644) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, bytes, { mode });
}
function fixture(selectedTemplates = templates, root = temporaryRoot()) {
  const home = path.join(root, 'machine'),
    project = path.join(root, 'project');
  const bin = path.join(root, 'bin'),
    hooks = path.join(project, '.caws/hooks');
  fs.mkdirSync(hooks, { recursive: true });
  fs.mkdirSync(bin);
  const env = {
    HOME: root,
    PATH: bin + ':' + process.env.PATH,
    CAWS_HOME: home,
    CAWS_PROJECT_DIR: project,
    CLAUDE_CODE_SESSION_ID: 'advisory-fixture',
    CAWS_TRAP_KILL: '0',
    CAWS_HOOK_ADVISORY_DEDUP: '0',
    CAWS_HOOK_ADVISORY_BUDGET_BYTES: '600',
  };
  succeeds(invoke(root, '/usr/bin/git', ['init', '-q', project], undefined, { env }));
  const installed = installMachineRuntime({ home, templatesRoot: selectedTemplates });
  const runtime = path.join(home, 'lib/runtimes', installed.digest);
  put(path.join(root, 'installation.json'), JSON.stringify(installed, null, 2));
  const helper = path.join(runtime, 'advisory_truncate.cjs');
  expect(fs.existsSync(helper)).toBe(true);
  expect(fs.existsSync(path.join(runtime, 'advisory_truncate.py'))).toBe(false);
  const pythonLookup = invoke(root, '/bin/bash', ['-p', '-c', 'command -v python3'], undefined, {
    env,
  });
  succeeds(pythonLookup);
  const python = pythonLookup.stdout.toString().trim();
  // Ignore BASH_ENV in interpreter witnesses: startup recursion would invalidate
  // the observation and can create an unbounded fixture process tree.
  put(
    path.join(bin, 'node'),
    '#!/bin/bash -p\ncase "$1" in */advisory_truncate.cjs) printf "called\\n" >> ' +
      quote(path.join(root, 'node-helper-called')) +
      ';; esac\nexec ' +
      quote(process.execPath) +
      ' "$@"\n',
    0o755
  );
  put(
    path.join(bin, 'python3'),
    '#!/bin/bash -p\ncase "$1" in */advisory_truncate.py) printf "forbidden\\n" >> ' +
      quote(path.join(root, 'python-helper-called')) +
      '; exit 97;; esac\nexec ' +
      quote(python) +
      ' "$@"\n',
    0o755
  );
  const handler = (name, value) => {
    const bytes = JSON.stringify(value);
    put(
      path.join(hooks, name),
      "#!/bin/bash\ncat >/dev/null\nprintf '%s\\n' " + quote(bytes) + '\n',
      0o755
    );
    return bytes;
  };
  const input = Buffer.from(
    JSON.stringify({
      cwd: project,
      session_id: 'advisory-fixture',
      tool_name: 'Read',
      tool_input: { file_path: path.join(project, 'ordinary.txt') },
    })
  );
  const dispatch = (...names) =>
    invoke(
      root,
      '/bin/bash',
      [path.join(runtime, 'dispatch.sh'), 'claude-code', 'pre_tool_use', hooks, ...names],
      input,
      { env, cwd: project }
    );
  return { root, env, runtime, helper, handler, dispatch };
}
const advisory = (text) => ({
  hookSpecificOutput: { hookEventName: 'PreToolUse', additionalContext: text },
});

scenario(
  'unpacked package installs a standalone helper used by the real dispatcher and preserves later cards and hard refusal',
  () => {
    const root = temporaryRoot(),
      packed = path.join(root, 'packed'),
      unpacked = path.join(root, 'unpacked');
    fs.mkdirSync(packed);
    fs.mkdirSync(unpacked);
    const env = { HOME: root, PATH: process.env.PATH };
    const pack = invoke(
      root,
      'npm',
      ['pack', '--ignore-scripts', '--json', '--pack-destination', packed],
      undefined,
      { cwd: cli, env, timeoutMs: 30000 }
    );
    succeeds(pack);
    const metadata = JSON.parse(pack.stdout.toString())[0];
    succeeds(
      invoke(
        root,
        '/usr/bin/tar',
        ['-xzf', path.join(packed, path.basename(metadata.filename)), '-C', unpacked],
        undefined,
        { env }
      )
    );
    const packaged = path.join(unpacked, 'package');
    expect(fs.existsSync(path.join(packaged, 'src'))).toBe(false);
    expect(fs.existsSync(path.join(packaged, 'node_modules'))).toBe(false);
    expect(
      fs.existsSync(path.join(packaged, 'templates/hook-packs/shared/advisory_truncate.py'))
    ).toBe(false);
    const f = fixture(path.join(packaged, 'templates/hook-packs'), root);
    // Remove the unpacked template source after materialization: dispatch uses
    // only the private installed generation, not checkout or package fallbacks.
    fs.renameSync(path.join(packaged, 'templates'), path.join(packaged, 'templates-unavailable'));
    f.handler('large.sh', advisory('😀'.repeat(400)));
    f.handler('later.sh', advisory('LATER-ADVISORY'));
    const result = f.dispatch('large.sh', 'later.sh');
    succeeds(result);
    const text = JSON.parse(result.stdout).hookSpecificOutput.additionalContext;
    expect(text).toContain('LATER-ADVISORY');
    expect(Buffer.byteLength(text)).toBeLessThanOrEqual(600);
    expect(text).not.toContain('\ufffd');
    const match = text.match(/^(😀+)… \[truncated: ([0-9]+) bytes elided\]/u);
    expect(match).not.toBeNull();
    expect(Buffer.byteLength(match[1]) + Number(match[2])).toBe(1600);
    expect(fs.readFileSync(path.join(root, 'node-helper-called'), 'utf8')).toContain('called\n');
    expect(fs.existsSync(path.join(root, 'python-helper-called'))).toBe(false);
    const refusal = f.handler('block.sh', {
      decision: 'block',
      reason: 'PROTECTIVE-' + 'Z'.repeat(1500),
    });
    const blocked = f.dispatch('large.sh', 'block.sh', 'later.sh');
    expect(blocked.status).toBe(2);
    expect(blocked.stdout.toString().trim()).toBe(refusal);
    expect(blocked.stdout.toString()).not.toContain('LATER-ADVISORY');
  }
);

scenario(
  'installed shell rejects malformed helper output and omits on missing helper or Node',
  () => {
    const f = fixture();
    const library = path.join(f.runtime, 'lib/run-handlers.sh');
    const direct = (input, limit, env = f.env) => {
      const inputFile = path.join(f.root, 'direct-input.bin');
      put(inputFile, input);
      return invoke(
        f.root,
        '/bin/bash',
        [
          '-c',
          'source "$1"; text="$(cat "$2"; printf .)"; text="${text%.}"; _rh_truncate_complete_utf8 "$text" "$3"',
          '_',
          library,
          inputFile,
          String(limit),
        ],
        undefined,
        { env: { ...env, CAWS_SHARED_LIB_DIR: path.join(f.runtime, 'lib') } }
      );
    };
    for (const [name, body, input, limit] of [
      ['nonzero', 'process.exit(7)', Buffer.from('abcdef'), 3],
      ['empty', '', Buffer.from('abcdef'), 3],
      ['oversized', 'process.stdout.write("abcdef")', Buffer.from('abcdef'), 3],
      ['nonprefix', 'process.stdout.write("xyz")', Buffer.from('abcdef'), 3],
      ['split', 'process.stdout.write(Buffer.from([0xf0]))', Buffer.from('😀rest'), 3],
    ]) {
      put(f.helper, body, 0o755);
      const result = direct(input, limit);
      succeeds(result);
      expect({ name, output: result.stdout }).toEqual({ name, output: Buffer.alloc(0) });
    }
    // Restore actual generated bytes for the invalid-interior and LF controls.
    put(f.helper, fs.readFileSync(path.join(templates, 'shared/advisory_truncate.cjs')), 0o755);
    const interior = direct(Buffer.from([0x61, 0xff, 0x62, 0x63]), 3);
    succeeds(interior);
    expect(interior.stdout).toEqual(Buffer.alloc(0));
    const newline = direct(Buffer.from('abc\n\nZ'), 5);
    succeeds(newline);
    expect(newline.stdout).toEqual(Buffer.from('abc'));
    fs.renameSync(f.helper, f.helper + '.unavailable');
    const missing = direct(Buffer.from('abcdef'), 3);
    succeeds(missing);
    expect(missing.stdout).toEqual(Buffer.alloc(0));
    fs.renameSync(f.helper + '.unavailable', f.helper);
    const tools = path.join(f.root, 'without-node');
    fs.mkdirSync(tools);
    for (const [name, file] of [
      ['cat', '/bin/cat'],
      ['dirname', '/usr/bin/dirname'],
      ['wc', '/usr/bin/wc'],
      ['tr', '/usr/bin/tr'],
    ])
      fs.symlinkSync(file, path.join(tools, name));
    const absentNode = direct(Buffer.from('abcdef'), 3, { ...f.env, PATH: tools });
    succeeds(absentNode);
    expect(absentNode.stdout).toEqual(Buffer.alloc(0));
    expect(fs.existsSync(path.join(f.root, 'python-helper-called'))).toBe(false);
  }
);
