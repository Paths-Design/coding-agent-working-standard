'use strict';

/**
 * `caws hooks list | validate | compile --check` (CAWS-HOOKS-READONLY-VERBS-01).
 *
 * Two deliberate choices about how this suite proves things:
 *
 *  - **Wiring is proven on the BUILT dist CLI, not by calling the handlers.**
 *    Handler-level tests bypass Commander entirely, and this repo has twice
 *    shipped defects that such tests stayed green over: a flag declared in
 *    metadata but never forwarded to its handler, and a parent option
 *    shadowing a leaf option so the leaf's value was silently discarded. Only
 *    spawning the real binary can catch that class.
 *
 *  - **`list` is exercised against a real launcher process**, a stub placed at
 *    `$CAWS_HOME/bin/caws-hook`. `machineHome()` already reads `CAWS_HOME`, so
 *    the production path runs unmodified — no test-only seam was added to the
 *    command to make it observable.
 */

const { execFileSync, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const CLI = path.resolve(__dirname, '..', '..', 'dist', 'index.js');
const TEMPLATES = path.resolve(__dirname, '..', '..', 'templates/hook-packs/shared');

/** A throwaway git repo with a real dispatch tree copied from the templates. */
function makeRepo({ policy, chains = {}, events = ['pre_tool_use', 'stop'] } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'caws-hooks-'));
  const real = fs.realpathSync(dir);
  execFileSync('git', ['init', '-q'], { cwd: real });
  const dispatch = path.join(real, '.caws', 'hooks', 'dispatch');
  fs.mkdirSync(dispatch, { recursive: true });
  for (const event of events) {
    fs.copyFileSync(
      path.join(TEMPLATES, 'dispatch', `${event}.sh`),
      path.join(dispatch, `${event}.sh`)
    );
  }
  for (const [event, content] of Object.entries(chains)) {
    fs.writeFileSync(path.join(dispatch, `${event}.chain`), content);
  }
  if (policy !== undefined) {
    fs.writeFileSync(
      path.join(real, '.caws', 'hooks', 'hook-policy.json'),
      typeof policy === 'string' ? policy : JSON.stringify(policy, null, 2)
    );
  }
  return real;
}

/**
 * A stub machine runtime whose launcher emits a canned selection document.
 * `handlers` entries are `[entry, tier|null]`.
 */
function makeMachineHome(handlers) {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'caws-home-')));
  fs.mkdirSync(path.join(home, 'bin'), { recursive: true });
  const document = {
    schema: 'caws.hook_selection.v1',
    handlers: handlers.map(([entry, tier]) => ({
      entry,
      path: `/stub/${entry}`,
      kind: 'stock',
      ...(tier === null ? {} : { tier }),
    })),
  };
  fs.writeFileSync(
    path.join(home, 'bin', 'caws-hook'),
    `import json,sys\nprint(json.dumps(${JSON.stringify(document)}))\n`
  );
  return home;
}

function runCli(args, { cwd, env = {} } = {}) {
  const result = spawnSync(process.execPath, [CLI, ...args], {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, ...env },
  });
  return { status: result.status, out: `${result.stdout}${result.stderr}` };
}

/** Recursive content hash of a directory — the read-only oracle. */
function treeHash(root) {
  const entries = [];
  const walk = (dir) => {
    for (const name of fs.readdirSync(dir).sort()) {
      const full = path.join(dir, name);
      const stat = fs.lstatSync(full);
      if (stat.isDirectory()) walk(full);
      else entries.push(`${path.relative(root, full)}:${fs.readFileSync(full).toString('base64')}`);
    }
  };
  walk(root);
  return require('node:crypto').createHash('sha256').update(entries.join('\n')).digest('hex');
}

describe('A5: the group is reachable through Commander on the built CLI', () => {
  test('caws hooks --help lists all three leaves', () => {
    const { status, out } = runCli(['hooks', '--help']);
    expect(status).toBe(0);
    for (const leaf of ['list', 'validate', 'compile']) expect(out).toContain(leaf);
  });

  test.each([
    ['list', ['--event', '--surface', '--json', '--data']],
    ['validate', ['--json', '--data']],
    ['compile', ['--check', '--event', '--json', '--data']],
  ])('caws hooks %s --help declares its flags', (leaf, flags) => {
    const { status, out } = runCli(['hooks', leaf, '--help']);
    expect(status).toBe(0);
    for (const flag of flags) expect(out).toContain(flag);
  });

  test('an undeclared flag is REJECTED, so the --help assertions are not vacuous', () => {
    // Control for the arms above: without it they would pass against a CLI
    // that accepted every flag and forwarded none.
    const { status } = runCli(['hooks', 'validate', '--not-a-real-flag']);
    expect(status).not.toBe(0);
  });

  test('compile does not ACCEPT a --surface it could not honor', () => {
    // A declared-but-unforwarded flag is the accept-and-discard defect this
    // suite exists for, and the first draft of this group shipped one:
    // `compile --surface` was declared in metadata and destructured in the
    // action, then never used. It cannot be honored — every project-wired
    // surface execs the same dispatcher, so there is one chain per event —
    // so the flag must not be accepted at all rather than silently ignored.
    const { status, out } = runCli(['hooks', 'compile', '--check', '--surface', 'opencode']);
    expect(status).not.toBe(0);
    expect(out).toMatch(/unknown option/i);
  });
});

describe('A2: validate', () => {
  test('an ABSENT policy is valid, not an error', () => {
    const repo = makeRepo();
    const { status, out } = runCli(['hooks', 'validate'], { cwd: repo });
    expect(status).toBe(0);
    expect(out).toContain('absent');
  });

  test('a well-formed policy is accepted', () => {
    const repo = makeRepo({
      policy: { version: 1, surfaces: { default: { extensions: {} } }, guards: {} },
    });
    const { status, out } = runCli(['hooks', 'validate'], { cwd: repo });
    expect(status).toBe(0);
    expect(out).toContain('valid');
  });

  test('malformed JSON is REJECTED with exit 1 and nothing is applied', () => {
    const repo = makeRepo({ policy: '{ not json' });
    const { status, out } = runCli(['hooks', 'validate'], { cwd: repo });
    expect(status).toBe(1);
    expect(out).toContain('REJECTED');
    expect(out).toContain('Nothing was applied');
  });

  test('disabling a REPO_POLICY_FLOOR handler is REJECTED', () => {
    // The floor exists so a policy cannot remove the mechanism that makes the
    // policy reviewable. A policy that can authorize its own amendment is not
    // a policy.
    const repo = makeRepo({
      policy: {
        version: 1,
        surfaces: { default: { disabled: { pre_tool_use: ['protected-paths.sh'] } } },
        guards: {},
      },
    });
    const { status, out } = runCli(['hooks', 'validate'], { cwd: repo });
    expect(status).toBe(1);
    expect(out).toContain('protected-paths.sh');
  });

  test('a NON-floor handler may be disabled — the floor is narrow, not a blanket ban', () => {
    // Discrimination control for the arm above: without it, a validator that
    // rejected every `disabled` entry would look correct.
    const repo = makeRepo({
      policy: {
        version: 1,
        surfaces: { default: { disabled: { pre_tool_use: ['quiet-merge.sh'] } } },
        guards: {},
      },
    });
    expect(runCli(['hooks', 'validate'], { cwd: repo }).status).toBe(0);
  });

  test('a project-wired named surface is WARNED, not rejected', () => {
    // Every project-wired surface execs the same dispatcher, so only
    // surfaces.default can reach the compiled chain. The document is legal;
    // the expectation behind it is not, and silence would let it look
    // effective.
    const repo = makeRepo({
      policy: { version: 1, surfaces: { opencode: { extensions: {} } }, guards: {} },
    });
    const { status, out } = runCli(['hooks', 'validate'], { cwd: repo });
    expect(status).toBe(0);
    expect(out).toContain('warning');
    expect(out).toContain('surfaces.default');
  });

  test('--json carries the same verdict as the exit code', () => {
    const repo = makeRepo({ policy: '{ not json' });
    const { status, out } = runCli(['hooks', 'validate', '--json'], { cwd: repo });
    expect(status).toBe(1);
    const parsed = JSON.parse(out.trim());
    expect(parsed).toMatchObject({ schema: 'caws.hooks_validate.v1', valid: false, present: true });
    expect(typeof parsed.error).toBe('string');
  });
});

describe('A1: list resolves through the launcher', () => {
  test('rows carry the tier the launcher reported', () => {
    const repo = makeRepo();
    const home = makeMachineHome([
      ['block-dangerous.sh', 'stock'],
      ['rg-replace-guard.sh', 'repo-policy'],
      ['local-only.sh', 'machine-policy'],
    ]);
    const { status, out } = runCli(['hooks', 'list', '--event', 'pre_tool_use'], {
      cwd: repo,
      env: { CAWS_HOME: home },
    });
    expect(status).toBe(0);
    expect(out).toContain('rg-replace-guard.sh  (repo-policy)');
    expect(out).toContain('local-only.sh  (machine-policy)');
    // A floor handler is marked so a reader can see what may not be removed.
    expect(out).toContain('block-dangerous.sh  (stock) [floor]');
  });

  test('a launcher that omits tier renders "unknown" and names the remediation', () => {
    // The installed runtime under ~/.caws has its own lifecycle and routinely
    // predates the CLI. Rendering a missing field as `undefined` would be a
    // lie dressed as data; this pins the honest output AND the fix.
    const repo = makeRepo();
    const home = makeMachineHome([['block-dangerous.sh', null]]);
    const { status, out } = runCli(['hooks', 'list', '--event', 'pre_tool_use'], {
      cwd: repo,
      env: { CAWS_HOME: home },
    });
    expect(status).toBe(0);
    expect(out).toContain('(unknown)');
    expect(out).not.toContain('undefined');
    expect(out).toContain('caws init adapters install');
  });

  test('no machine runtime is reported as unavailable, and list still exits 0', () => {
    const repo = makeRepo();
    const empty = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'caws-empty-')));
    const { status, out } = runCli(['hooks', 'list', '--event', 'pre_tool_use'], {
      cwd: repo,
      env: { CAWS_HOME: empty },
    });
    expect(status).toBe(0);
    expect(out).toContain('unavailable');
  });

  test('--json emits the resolved chain as a parseable contract', () => {
    const repo = makeRepo();
    const home = makeMachineHome([['scope-guard.sh', 'repo-policy']]);
    const { status, out } = runCli(
      ['hooks', 'list', '--event', 'pre_tool_use', '--surface', 'codex', '--json'],
      { cwd: repo, env: { CAWS_HOME: home } }
    );
    expect(status).toBe(0);
    const parsed = JSON.parse(out.trim());
    expect(parsed.schema).toBe('caws.hooks_list.v1');
    // --surface reached the handler; a metadata-only flag would not change this.
    expect(parsed.surface).toBe('codex');
    expect(parsed.events[0].handlers[0]).toMatchObject({
      entry: 'scope-guard.sh',
      tier: 'repo-policy',
    });
  });
});

describe('A3: compile --check', () => {
  test('a repo with no policy and no sidecar is FRESH, not stale', () => {
    // Compiling a sidecar that merely restates the dispatcher's own stock
    // array would add a file to keep in sync for no behavioral gain.
    const repo = makeRepo();
    const { status, out } = runCli(['hooks', 'compile', '--check'], { cwd: repo });
    expect(status).toBe(0);
    expect(out).toContain('current');
  });

  test('a policy with no compiled sidecar is STALE and names the event', () => {
    const repo = makeRepo({
      policy: {
        version: 1,
        surfaces: { default: { disabled: { pre_tool_use: ['quiet-merge.sh'] } } },
        guards: {},
      },
    });
    const { status, out } = runCli(['hooks', 'compile', '--check'], { cwd: repo });
    expect(status).toBe(1);
    expect(out).toContain('pre_tool_use');
    expect(out).toContain('no compiled chain on disk');
  });

  test('a sidecar compiled against an older pack is named as a pack lag', () => {
    const repo = makeRepo({
      policy: { version: 1, surfaces: { default: {} }, guards: {} },
      chains: {
        pre_tool_use:
          '# caws hook chain v1 surface=default event=pre_tool_use policy-sha256=x pack=1\n',
      },
    });
    const { status, out } = runCli(['hooks', 'compile', '--check'], { cwd: repo });
    expect(status).toBe(1);
    expect(out).toMatch(/pack 1, shipping \d+/);
  });

  test('an invalid policy fails the check rather than compiling against a partial document', () => {
    const repo = makeRepo({ policy: '{ not json' });
    const { status, out } = runCli(['hooks', 'compile', '--check'], { cwd: repo });
    expect(status).toBe(1);
    expect(out).toContain('invalid');
  });

  test('--json reports wrote:false', () => {
    const repo = makeRepo();
    const { status, out } = runCli(['hooks', 'compile', '--check', '--json'], { cwd: repo });
    expect(status).toBe(0);
    const parsed = JSON.parse(out.trim());
    expect(parsed).toMatchObject({ schema: 'caws.hooks_compile_check.v1', wrote: false, stale: 0 });
  });

  test('--check is what makes compile read-only: the bare form DOES write', () => {
    // The separability claim this whole suite rests on, asserted as a
    // difference rather than as two independent facts. One repo, one policy,
    // one flag as the only variable: `--check` must leave `.caws/` byte-
    // identical, and dropping it must not. Without the second half, every
    // read-only assertion here would also hold for a `compile` that had
    // silently stopped working.
    const policy = {
      version: 1,
      surfaces: {
        default: {
          disabled: {
            pre_tool_use: [
              { handler: 'cwd-guard.sh', reason: 'this repo has no tracked worktrees' },
            ],
          },
        },
      },
    };
    const checked = makeRepo({ policy });
    const beforeCheck = treeHash(path.join(checked, '.caws'));
    expect(runCli(['hooks', 'compile', '--check'], { cwd: checked }).status).toBe(1);
    expect(treeHash(path.join(checked, '.caws'))).toBe(beforeCheck);

    const compiled = makeRepo({ policy });
    const beforeCompile = treeHash(path.join(compiled, '.caws'));
    expect(runCli(['hooks', 'compile'], { cwd: compiled }).status).toBe(0);
    expect(treeHash(path.join(compiled, '.caws'))).not.toBe(beforeCompile);
  });
});

describe('A4: read-only is proven by observation, not by reading the code', () => {
  test.each([
    ['list', ['hooks', 'list']],
    ['validate', ['hooks', 'validate']],
    ['compile --check (fresh)', ['hooks', 'compile', '--check']],
  ])('%s leaves .caws/ byte-identical', (_label, args) => {
    const repo = makeRepo({
      policy: { version: 1, surfaces: { default: {} }, guards: {} },
    });
    const before = treeHash(path.join(repo, '.caws'));
    runCli(args, { cwd: repo });
    expect(treeHash(path.join(repo, '.caws'))).toBe(before);
  });

  test('compile --check leaves .caws/ untouched even when it reports STALE', () => {
    // The interesting case: the command has just decided a file is wrong and
    // must still not fix it.
    const repo = makeRepo({
      policy: {
        version: 1,
        surfaces: { default: { disabled: { pre_tool_use: ['quiet-merge.sh'] } } },
        guards: {},
      },
    });
    const before = treeHash(path.join(repo, '.caws'));
    expect(runCli(['hooks', 'compile', '--check'], { cwd: repo }).status).toBe(1);
    expect(treeHash(path.join(repo, '.caws'))).toBe(before);
  });

  test('the tree hash can actually observe a change', () => {
    // Discrimination control for every arm above: without it they would all
    // pass against a hash function that returned a constant.
    const repo = makeRepo();
    const before = treeHash(path.join(repo, '.caws'));
    fs.writeFileSync(path.join(repo, '.caws', 'hooks', 'dispatch', 'pre_tool_use.chain'), 'x\n');
    expect(treeHash(path.join(repo, '.caws'))).not.toBe(before);
  });
});
