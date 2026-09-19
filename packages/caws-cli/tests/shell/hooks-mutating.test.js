'use strict';

/**
 * `caws hooks add | disable | replace | restore | compile`
 * (CAWS-HOOKS-MUTATING-VERBS-01).
 *
 * These verbs write the file that decides which guards run in a repo, so the
 * suite weights three hostile properties over feature coverage:
 *
 *  - **A refusal writes NOTHING.** Every refusal arm hashes `.caws/` before and
 *    after. A verb that refuses loudly while leaving a half-applied document is
 *    worse than one that fails outright, because the repo then believes a
 *    policy is in force that nothing agrees on.
 *
 *  - **The floor holds through every route.** disable, replace, and add --path
 *    are three different ways to stop a floor handler from running. All three
 *    are asserted, because gating one leaves the bypass one flag away.
 *
 *  - **Everything runs against the BUILT dist CLI.** Handler-level tests bypass
 *    Commander, and this repo has shipped defects that such tests stayed green
 *    over — a flag declared but never forwarded, a parent option shadowing a
 *    leaf's. Only spawning the real binary catches that class.
 */

const { execFileSync, spawnSync } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const CLI = path.resolve(__dirname, '..', '..', 'dist', 'index.js');
const TEMPLATES = path.resolve(__dirname, '..', '..', 'templates/hook-packs/shared');
const POLICY = '.caws/hooks/hook-policy.json';
const REASON = 'this repo keeps its guards in native/ instead of src/';

/** A throwaway git repo with a real dispatch tree copied from the templates. */
function makeRepo({ policy, events = ['pre_tool_use', 'stop'] } = {}) {
  const real = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'caws-hooks-write-')));
  execFileSync('git', ['init', '-q'], { cwd: real });
  const dispatch = path.join(real, '.caws', 'hooks', 'dispatch');
  fs.mkdirSync(dispatch, { recursive: true });
  for (const event of events) {
    fs.copyFileSync(
      path.join(TEMPLATES, 'dispatch', `${event}.sh`),
      path.join(dispatch, `${event}.sh`)
    );
  }
  if (policy !== undefined) {
    fs.writeFileSync(
      path.join(real, POLICY),
      typeof policy === 'string' ? policy : JSON.stringify(policy, null, 2)
    );
  }
  return real;
}

function runCli(args, { cwd } = {}) {
  const result = spawnSync(process.execPath, [CLI, ...args], { cwd, encoding: 'utf8' });
  return { status: result.status, out: `${result.stdout}${result.stderr}` };
}

/** Recursive content hash of a directory — the "nothing was written" oracle. */
function treeHash(root) {
  const entries = [];
  const walk = (dir) => {
    for (const name of fs.readdirSync(dir).sort()) {
      const full = path.join(dir, name);
      if (fs.lstatSync(full).isDirectory()) walk(full);
      else entries.push(`${path.relative(root, full)}:${fs.readFileSync(full).toString('base64')}`);
    }
  };
  walk(root);
  return crypto.createHash('sha256').update(entries.join('\n')).digest('hex');
}

function readPolicy(repo) {
  return JSON.parse(fs.readFileSync(path.join(repo, POLICY), 'utf8'));
}

/** Run a command and assert `.caws/` came out byte-identical. */
function expectNoWrite(repo, args) {
  const before = treeHash(path.join(repo, '.caws'));
  const result = runCli(args, { cwd: repo });
  expect(treeHash(path.join(repo, '.caws'))).toBe(before);
  return result;
}

// ─── A1: add ───────────────────────────────────────────────────────────────

describe('A1: add splices a handler at its declared position', () => {
  test('a repo with no policy gets one, and the handler lands before its anchor', () => {
    const repo = makeRepo();
    expect(fs.existsSync(path.join(repo, POLICY))).toBe(false);

    const { status, out } = runCli(
      [
        'hooks',
        'add',
        'marker.sh',
        '--event',
        'pre_tool_use',
        '--before',
        'scope-guard.sh',
        '--path',
        '.caws/hooks/ext/marker.sh',
        '--reason',
        REASON,
      ],
      { cwd: repo }
    );
    expect(status).toBe(0);
    expect(out).toContain('marker.sh before scope-guard.sh');

    expect(readPolicy(repo)).toEqual({
      version: 1,
      surfaces: {
        default: {
          extensions: {
            pre_tool_use: [{ handler: 'marker.sh', before: 'scope-guard.sh', reason: REASON }],
          },
          handlers: { 'marker.sh': '.caws/hooks/ext/marker.sh' },
        },
      },
    });

    // The written document must satisfy the reader that governs execution, not
    // merely be well-formed JSON.
    expect(runCli(['hooks', 'validate'], { cwd: repo }).status).toBe(0);
  });

  test('the compiled chain puts the handler immediately before its anchor', () => {
    // Position, not membership: a guard spliced into the wrong place
    // adjudicates against different state than the one it must precede.
    const repo = makeRepo();
    runCli(
      [
        'hooks',
        'add',
        'marker.sh',
        '--event',
        'pre_tool_use',
        '--before',
        'scope-guard.sh',
        '--path',
        '.caws/hooks/ext/marker.sh',
        '--reason',
        REASON,
      ],
      { cwd: repo }
    );
    expect(runCli(['hooks', 'compile'], { cwd: repo }).status).toBe(0);

    const chain = fs
      .readFileSync(path.join(repo, '.caws/hooks/dispatch/pre_tool_use.chain'), 'utf8')
      .trim()
      .split('\n');
    const names = chain.slice(1).map((line) => line.split('\t')[0]);
    expect(names).toContain('marker.sh');
    expect(names[names.indexOf('marker.sh') + 1]).toBe('scope-guard.sh');
    // The override rides the same line as a tab-separated target.
    expect(chain.find((l) => l.startsWith('marker.sh'))).toBe(
      'marker.sh\t.caws/hooks/ext/marker.sh'
    );
  });

  test('--before naming a handler that is not in the chain is refused', () => {
    const repo = makeRepo();
    runCli(
      [
        'hooks',
        'add',
        'marker.sh',
        '--event',
        'pre_tool_use',
        '--before',
        'no-such-guard.sh',
        '--path',
        '.caws/hooks/ext/marker.sh',
        '--reason',
        REASON,
      ],
      { cwd: repo }
    );
    // The policy write itself succeeds (the anchor is resolved at chain time),
    // but compiling must refuse rather than emit a chain missing the handler.
    const { status, out } = expectNoWrite(repo, ['hooks', 'compile']);
    expect(status).toBe(1);
    expect(out).toContain('anchor is absent');
    expect(out).toContain('Nothing was written');
  });

  test('--event is required: a chain belongs to one event', () => {
    const repo = makeRepo();
    const { status, out } = expectNoWrite(repo, ['hooks', 'add', 'marker.sh', '--reason', REASON]);
    expect(status).toBe(1);
    expect(out).toContain('--event');
  });
});

// ─── A2: a reason is mandatory and is persisted ────────────────────────────

describe('A2: the enforcement-reducing verbs demand a recorded justification', () => {
  test.each([
    ['disable', ['hooks', 'disable', 'cwd-guard.sh', '--event', 'pre_tool_use']],
    [
      'replace',
      [
        'hooks',
        'replace',
        'scope-guard.sh',
        '--with',
        '.caws/hooks/ext/sg.sh',
        '--approver',
        '@maintainer',
      ],
    ],
  ])('%s without --reason refuses and writes nothing', (_verb, args) => {
    const repo = makeRepo();
    const { status, out } = expectNoWrite(repo, args);
    expect(status).toBe(1);
    expect(out).toContain('--reason');
    expect(out).toContain('Nothing was written');
    expect(fs.existsSync(path.join(repo, POLICY))).toBe(false);
  });

  test('replace without --approver refuses: a fork needs someone who accepted it', () => {
    const repo = makeRepo();
    const { status, out } = expectNoWrite(repo, [
      'hooks',
      'replace',
      'scope-guard.sh',
      '--with',
      '.caws/hooks/ext/sg.sh',
      '--reason',
      REASON,
    ]);
    expect(status).toBe(1);
    expect(out).toContain('--approver');
  });

  test('a supplied reason is persisted in the document and echoed by list', () => {
    const repo = makeRepo();
    expect(
      runCli(['hooks', 'disable', 'cwd-guard.sh', '--event', 'pre_tool_use', '--reason', REASON], {
        cwd: repo,
      }).status
    ).toBe(0);

    expect(readPolicy(repo).surfaces.default.disabled.pre_tool_use).toEqual([
      { handler: 'cwd-guard.sh', reason: REASON },
    ]);

    // A disabled handler is ABSENT from the resolved chain, so the reason is
    // the only way `list` can answer why it is not there.
    const listed = runCli(['hooks', 'list', '--surface', 'default'], { cwd: repo });
    expect(listed.out).toContain('disabled pre_tool_use: cwd-guard.sh');
    expect(listed.out).toContain(REASON);

    const json = JSON.parse(
      runCli(['hooks', 'list', '--surface', 'default', '--json'], { cwd: repo }).out.trim()
    );
    expect(json.declared.disabled.pre_tool_use).toEqual([
      { handler: 'cwd-guard.sh', reason: REASON },
    ]);
  });

  test('a reason too short to say anything is refused', () => {
    const repo = makeRepo();
    const { status, out } = expectNoWrite(repo, [
      'hooks',
      'disable',
      'cwd-guard.sh',
      '--event',
      'pre_tool_use',
      '--reason',
      'wip',
    ]);
    expect(status).toBe(1);
    expect(out).toContain('12 characters');
  });

  test('replace records the forked pack version and digest without being asked', () => {
    const repo = makeRepo();
    const { status } = runCli(
      [
        'hooks',
        'replace',
        'scope-guard.sh',
        '--with',
        '.caws/hooks/ext/scope-guard.local.sh',
        '--reason',
        REASON,
        '--approver',
        '@maintainer',
      ],
      { cwd: repo }
    );
    expect(status).toBe(0);

    const fork = readPolicy(repo).surfaces.default.forks['scope-guard.sh'];
    expect(fork.approver).toBe('@maintainer');
    expect(fork.reason).toBe(REASON);
    expect(fork.forked_from.pack).toBe('shared');
    // The digest must be OF THE SHIPPED FILE — a recorded constant would make
    // every future drift comparison silently wrong.
    const shipped = crypto
      .createHash('sha256')
      .update(fs.readFileSync(path.join(TEMPLATES, 'scope-guard.sh')))
      .digest('hex');
    expect(fork.forked_from.sha256).toBe(shipped);
    expect(readPolicy(repo).surfaces.default.handlers['scope-guard.sh']).toBe(
      '.caws/hooks/ext/scope-guard.local.sh'
    );
  });

  test('replacing a handler the pack does not ship is refused, not recorded blind', () => {
    const repo = makeRepo();
    const { status, out } = expectNoWrite(repo, [
      'hooks',
      'replace',
      'invented-guard.sh',
      '--with',
      '.caws/hooks/ext/x.sh',
      '--reason',
      REASON,
      '--approver',
      '@maintainer',
    ]);
    expect(status).toBe(1);
    expect(out).toContain('nothing to fork from');
    expect(out).toContain('caws hooks add');
  });
});

// ─── A3: the floor, through every route ────────────────────────────────────

describe('A3: no verb can stop a floor handler from running', () => {
  const FLOOR = ['protected-paths.sh', 'block-dangerous.sh', 'agent-register.sh'];

  test.each(FLOOR)('disable %s is refused even with a reason', (handler) => {
    const repo = makeRepo();
    const { status, out } = expectNoWrite(repo, [
      'hooks',
      'disable',
      handler,
      '--event',
      'pre_tool_use',
      '--reason',
      REASON,
    ]);
    expect(status).toBe(1);
    expect(out).toContain('repo-policy floor');
  });

  test.each(FLOOR)('replace %s is refused even with a reason and an approver', (handler) => {
    // Replace-with-a-no-op is observationally identical to disable, so gating
    // only `disable` would leave the bypass one verb away.
    const repo = makeRepo();
    const { status, out } = expectNoWrite(repo, [
      'hooks',
      'replace',
      handler,
      '--with',
      '.caws/hooks/ext/noop.sh',
      '--reason',
      REASON,
      '--approver',
      '@maintainer',
    ]);
    expect(status).toBe(1);
    expect(out).toContain('repo-policy floor');
  });

  test('add --path may not install a floor NAME as a repo-local file', () => {
    // The third route: never mention `disabled` or `replace`, just point the
    // floor handler's basename at a stub through the additive verb.
    const repo = makeRepo();
    const { status, out } = expectNoWrite(repo, [
      'hooks',
      'add',
      'protected-paths.sh',
      '--event',
      'pre_tool_use',
      '--path',
      '.caws/hooks/ext/noop.sh',
      '--reason',
      REASON,
    ]);
    expect(status).toBe(1);
    expect(out).toContain('repo-policy floor');
  });

  test('a NON-floor guard is still disablable — the refusals above discriminate', () => {
    // Without this control, every A3 arm would pass against a build that
    // refused every disable.
    const repo = makeRepo();
    const { status } = runCli(
      ['hooks', 'disable', 'cwd-guard.sh', '--event', 'pre_tool_use', '--reason', REASON],
      { cwd: repo }
    );
    expect(status).toBe(0);
    expect(readPolicy(repo).surfaces.default.disabled.pre_tool_use[0].handler).toBe('cwd-guard.sh');
  });
});

// ─── A4: compile writes what the dispatcher parser accepts ─────────────────

describe('A4: compile produces a sidecar that --check calls fresh', () => {
  test('compile then --check is a fixed point', () => {
    const repo = makeRepo();
    runCli(['hooks', 'disable', 'cwd-guard.sh', '--event', 'pre_tool_use', '--reason', REASON], {
      cwd: repo,
    });
    expect(runCli(['hooks', 'compile', '--check'], { cwd: repo }).status).toBe(1);
    expect(runCli(['hooks', 'compile'], { cwd: repo }).status).toBe(0);
    const { status, out } = runCli(['hooks', 'compile', '--check'], { cwd: repo });
    expect(status).toBe(0);
    expect(out).toContain('current');
    // Idempotent: a second compile must not perturb the bytes.
    const after = treeHash(path.join(repo, '.caws'));
    expect(runCli(['hooks', 'compile'], { cwd: repo }).status).toBe(0);
    expect(treeHash(path.join(repo, '.caws'))).toBe(after);
  });

  test('the compiled chain parses under the REAL local-chain.sh', () => {
    // The invariant that matters: a sidecar `local-chain.sh` would refuse
    // blocks every tool call on five surfaces, from a file under .caws/hooks/
    // the agent is not permitted to repair. Asserting against the shipped bash
    // parser — not a re-implementation — is what makes that claim mean anything.
    const repo = makeRepo();
    runCli(
      [
        'hooks',
        'add',
        'marker.sh',
        '--event',
        'pre_tool_use',
        '--before',
        'scope-guard.sh',
        '--path',
        '.caws/hooks/ext/marker.sh',
        '--reason',
        REASON,
      ],
      { cwd: repo }
    );
    expect(runCli(['hooks', 'compile'], { cwd: repo }).status).toBe(0);

    fs.copyFileSync(
      path.join(TEMPLATES, 'lib', 'local-chain.sh'),
      path.join(repo, '.caws/hooks/local-chain.sh')
    );
    const script = [
      'set -uo pipefail',
      `HOOKS_DIR="${repo}/.caws/hooks"`,
      `source "${repo}/.caws/hooks/local-chain.sh"`,
      'if caws_local_chain pre_tool_use; then',
      '  printf "CHAIN:%s\\n" "${CAWS_LOCAL_CHAIN[*]}"',
      'else',
      '  echo NOCHAIN',
      'fi',
    ].join('\n');
    const parsed = spawnSync('bash', ['-c', script], { cwd: repo, encoding: 'utf8' });
    expect(parsed.status).toBe(0);
    expect(parsed.stdout).toContain('CHAIN:');
    expect(parsed.stdout).toContain('marker.sh');
  });

  test('a repo whose policy is unreadable gets a refusal, not a recompiled chain', () => {
    const repo = makeRepo({ policy: '{ not json' });
    const { status, out } = expectNoWrite(repo, ['hooks', 'compile']);
    expect(status).toBe(1);
    expect(out).toContain('Nothing was written');
    expect(out).toContain(POLICY);
  });

  test('a mutating verb refuses to amend a document it cannot read', () => {
    // Starting from the identity policy here would discard whatever the file
    // declares, and the agent running the verb is the party least able to
    // notice what was lost.
    const repo = makeRepo({ policy: '{ not json' });
    const { status, out } = expectNoWrite(repo, [
      'hooks',
      'disable',
      'cwd-guard.sh',
      '--event',
      'pre_tool_use',
      '--reason',
      REASON,
    ]);
    expect(status).toBe(1);
    expect(out).toContain('Repair the file');
  });
});

// ─── A5 / A6: refusals write nothing; restore reverses ─────────────────────

describe('A6: restore returns the chain to its prior state', () => {
  test('a disable then a restore is a round trip on the resolved chain', () => {
    const repo = makeRepo();
    runCli(['hooks', 'compile'], { cwd: repo });
    const stock = fs.readFileSync(
      path.join(repo, '.caws/hooks/dispatch/pre_tool_use.chain'),
      'utf8'
    );

    runCli(['hooks', 'disable', 'cwd-guard.sh', '--event', 'pre_tool_use', '--reason', REASON], {
      cwd: repo,
    });
    runCli(['hooks', 'compile'], { cwd: repo });
    const disabled = fs.readFileSync(
      path.join(repo, '.caws/hooks/dispatch/pre_tool_use.chain'),
      'utf8'
    );
    expect(disabled).not.toContain('cwd-guard.sh');

    expect(
      runCli(['hooks', 'restore', 'cwd-guard.sh', '--event', 'pre_tool_use'], { cwd: repo }).status
    ).toBe(0);
    runCli(['hooks', 'compile'], { cwd: repo });
    const restored = fs.readFileSync(
      path.join(repo, '.caws/hooks/dispatch/pre_tool_use.chain'),
      'utf8'
    );
    // Not merely "contains cwd-guard.sh again": the whole BODY must be the one
    // that was there before, order included. The header legitimately differs —
    // its digest tracks the policy DOCUMENT, which now exists and declares
    // nothing, where before it was absent. Asserting the body separately is
    // what keeps this arm about the chain rather than about the digest.
    const body = (text) => text.split('\n').slice(1).join('\n');
    expect(body(restored)).toBe(body(stock));
    expect(restored.split('\n')[0]).toContain('policy-sha256=');
    expect(restored.split('\n')[0]).not.toBe(stock.split('\n')[0]);
  });

  test('restore sweeps the extension and its override in one move', () => {
    const repo = makeRepo();
    runCli(
      [
        'hooks',
        'add',
        'marker.sh',
        '--event',
        'pre_tool_use',
        '--path',
        '.caws/hooks/ext/marker.sh',
        '--reason',
        REASON,
      ],
      { cwd: repo }
    );
    expect(runCli(['hooks', 'restore', 'marker.sh'], { cwd: repo }).status).toBe(0);
    expect(readPolicy(repo)).toEqual({ version: 1 });
  });

  test('restoring a handler the document never named is refused, not confirmed', () => {
    // The "reports success while doing nothing" class, applied to the verb
    // whose entire job is undoing. A success here would tell a caller a guard
    // came back when the name they typed was never in the file.
    const repo = makeRepo();
    runCli(['hooks', 'disable', 'cwd-guard.sh', '--event', 'pre_tool_use', '--reason', REASON], {
      cwd: repo,
    });
    const { status, out } = expectNoWrite(repo, ['hooks', 'restore', 'never-mentioned.sh']);
    expect(status).toBe(1);
    expect(out).toContain('nothing to restore');
  });
});

describe('A5: every refusal leaves .caws/ byte-identical', () => {
  test('a populated repo survives a burst of refused invocations unchanged', () => {
    // expectNoWrite already hashes per arm; this one proves the property holds
    // over a NON-empty document, where a partial write has something to damage.
    const repo = makeRepo();
    runCli(
      [
        'hooks',
        'add',
        'marker.sh',
        '--event',
        'pre_tool_use',
        '--path',
        '.caws/hooks/ext/marker.sh',
        '--reason',
        REASON,
      ],
      { cwd: repo }
    );
    runCli(['hooks', 'compile'], { cwd: repo });
    const before = treeHash(path.join(repo, '.caws'));

    for (const args of [
      ['hooks', 'disable', 'protected-paths.sh', '--event', 'pre_tool_use', '--reason', REASON],
      ['hooks', 'disable', 'cwd-guard.sh', '--event', 'pre_tool_use', '--reason', 'no'],
      ['hooks', 'disable', 'cwd-guard.sh', '--event', 'on_tuesday', '--reason', REASON],
      ['hooks', 'add', 'marker.sh', '--event', 'pre_tool_use', '--reason', REASON],
      [
        'hooks',
        'add',
        'other.sh',
        '--event',
        'pre_tool_use',
        '--reason',
        REASON,
        '--path',
        '../escape.sh',
      ],
      [
        'hooks',
        'replace',
        'scope-guard.sh',
        '--with',
        '/abs/path.sh',
        '--reason',
        REASON,
        '--approver',
        '@x',
      ],
      ['hooks', 'restore', 'never-mentioned.sh'],
    ]) {
      const { status } = runCli(args, { cwd: repo });
      expect([args.join(' '), status]).toEqual([args.join(' '), 1]);
    }
    expect(treeHash(path.join(repo, '.caws'))).toBe(before);
  });

  test('the tree hash can actually observe a change', () => {
    // Control: without it every arm above would pass against a hash that
    // always returned the same value.
    const repo = makeRepo();
    const before = treeHash(path.join(repo, '.caws'));
    fs.writeFileSync(path.join(repo, '.caws', 'hooks', 'canary'), 'x');
    expect(treeHash(path.join(repo, '.caws'))).not.toBe(before);
  });
});

// ─── wiring ────────────────────────────────────────────────────────────────

describe('the mutating leaves are reachable through Commander on the built CLI', () => {
  test.each([
    ['add', ['--event', '--before', '--path', '--reason', '--surface', '--json']],
    ['disable', ['--event', '--reason', '--surface', '--json']],
    ['replace', ['--with', '--reason', '--approver', '--surface', '--json']],
    ['restore', ['--event', '--surface', '--json']],
    ['import', ['--from-machine', '--plan', '--json']],
  ])('caws hooks %s --help declares its flags', (leaf, flags) => {
    const { status, out } = runCli(['hooks', leaf, '--help']);
    expect(status).toBe(0);
    for (const flag of flags) expect(out).toContain(flag);
  });

  test('an undeclared flag is REJECTED, so the --help assertions are not vacuous', () => {
    const { status, out } = runCli([
      'hooks',
      'disable',
      'x.sh',
      '--event',
      'pre_tool_use',
      '--reason',
      REASON,
      '--expires-at',
      '2030-01-01',
    ]);
    expect(status).not.toBe(0);
    expect(out).toContain('unknown option');
  });

  test('--surface is forwarded, not accepted and discarded', () => {
    // The defect class this repo has shipped before: a flag declared in
    // metadata, destructured in the action, and never reaching the handler.
    const repo = makeRepo();
    expect(
      runCli(
        [
          'hooks',
          'disable',
          'cwd-guard.sh',
          '--event',
          'pre_tool_use',
          '--reason',
          REASON,
          '--surface',
          'codex',
        ],
        { cwd: repo }
      ).status
    ).toBe(0);
    const written = readPolicy(repo).surfaces;
    expect(Object.keys(written)).toEqual(['codex']);
    expect(written.default).toBeUndefined();
  });

  test('--json emits a machine-readable verdict for both outcomes', () => {
    const repo = makeRepo();
    const ok = JSON.parse(
      runCli(
        [
          'hooks',
          'disable',
          'cwd-guard.sh',
          '--event',
          'pre_tool_use',
          '--reason',
          REASON,
          '--json',
        ],
        { cwd: repo }
      ).out.trim()
    );
    expect(ok).toMatchObject({ schema: 'caws.hooks_mutation.v1', verb: 'disable', wrote: true });
    expect(ok.changed.join(' ')).toContain('cwd-guard.sh');

    const refused = JSON.parse(
      runCli(
        [
          'hooks',
          'disable',
          'protected-paths.sh',
          '--event',
          'pre_tool_use',
          '--reason',
          REASON,
          '--json',
        ],
        { cwd: repo }
      ).out.trim()
    );
    expect(refused).toMatchObject({ verb: 'disable', wrote: false });
    expect(refused.error).toContain('repo-policy floor');
  });
});

// ─── import --from-machine (CAWS-HOOKS-POLICY-IMPORT-FROM-MACHINE-01) ──────
//
// The migration verb, and the only one that writes two stores. The arms below
// weight the seam between them over feature coverage, because that seam is
// where the failure modes are: a half-migrated repo, or a "faithful" import
// that quietly dropped the one entry the repo tier cannot express.

/** An isolated machine home plus this project's state file inside it. */
function machineState(repo, surfaces) {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'caws-hooks-home-')));
  const dir = path.join(home, 'state', 'projects');
  fs.mkdirSync(dir, { recursive: true });
  const key = crypto.createHash('sha256').update(fs.realpathSync(repo)).digest('hex');
  const file = path.join(dir, `${key}.json`);
  fs.writeFileSync(file, JSON.stringify({ version: 1, root: repo, surfaces }, null, 2) + '\n');
  return { home, file };
}

function runCliWithHome(args, { cwd, home }) {
  const result = spawnSync(process.execPath, [CLI, ...args], {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, CAWS_HOME: home },
  });
  return { status: result.status, out: `${result.stdout}${result.stderr}` };
}

/** The shape sterling actually carries: two surfaces, identical policy. */
const TWO_IDENTICAL_SURFACES = {
  'claude-code': {
    disabled: {},
    extensions: { pre_tool_use: [{ handler: 'rg-replace-guard.sh', before: 'scope-guard.sh' }] },
    handlers: { 'rg-replace-guard.sh': '.caws/hooks/ext/rg-replace-guard.sh' },
    libraries: {},
  },
  codex: {
    disabled: {},
    extensions: { pre_tool_use: [{ handler: 'rg-replace-guard.sh', before: 'scope-guard.sh' }] },
    handlers: { 'rg-replace-guard.sh': '.caws/hooks/ext/rg-replace-guard.sh' },
    libraries: {},
  },
};

describe('import: machine overrides become committed repo policy', () => {
  test('two surfaces with identical policy collapse to one default entry', () => {
    const repo = makeRepo();
    const { home, file } = machineState(repo, TWO_IDENTICAL_SURFACES);

    const { status, out } = runCliWithHome(['hooks', 'import', '--from-machine'], {
      cwd: repo,
      home,
    });
    expect(status).toBe(0);
    expect(out).toContain('collapsed 2 identical surfaces');

    const policy = readPolicy(repo);
    // The collapse is the point: carrying two byte-identical copies into a
    // reviewed file would import the duplication along with the policy.
    expect(Object.keys(policy.surfaces)).toEqual(['default']);
    expect(policy.surfaces.default.extensions.pre_tool_use[0].handler).toBe('rg-replace-guard.sh');
    expect(policy.surfaces.default.extensions.pre_tool_use[0].before).toBe('scope-guard.sh');
    expect(policy.surfaces.default.handlers['rg-replace-guard.sh']).toBe(
      '.caws/hooks/ext/rg-replace-guard.sh'
    );

    // And the machine keys are emptied, or the handler splices twice.
    const cleared = JSON.parse(fs.readFileSync(file, 'utf8'));
    for (const surface of ['claude-code', 'codex']) {
      expect(cleared.surfaces[surface].extensions).toEqual({});
      expect(cleared.surfaces[surface].handlers).toEqual({});
    }
    // The surface itself survives: emptying its keys is not de-registering the
    // project from the machine runtime.
    expect(Object.keys(cleared.surfaces).sort()).toEqual(['claude-code', 'codex']);
    expect(cleared.root).toBe(repo);
  });

  test('surfaces that DIFFER are kept apart rather than collapsed onto one', () => {
    // The control for the arm above. Collapsing unlike surfaces would silently
    // apply one surface's policy to another.
    const repo = makeRepo();
    const { home } = machineState(repo, {
      'claude-code': {
        disabled: {},
        extensions: { pre_tool_use: [{ handler: 'a.sh', before: null }] },
        handlers: { 'a.sh': '.caws/hooks/ext/a.sh' },
        libraries: {},
      },
      codex: {
        disabled: {},
        extensions: { pre_tool_use: [{ handler: 'b.sh', before: null }] },
        handlers: { 'b.sh': '.caws/hooks/ext/b.sh' },
        libraries: {},
      },
    });

    expect(runCliWithHome(['hooks', 'import', '--from-machine'], { cwd: repo, home }).status).toBe(
      0
    );
    const policy = readPolicy(repo);
    expect(Object.keys(policy.surfaces).sort()).toEqual(['claude-code', 'codex']);
    expect(policy.surfaces).not.toHaveProperty('default');
  });

  test('an imported extension records that machine state captured no reason', () => {
    // PolicyExtension requires a reason; machine state has no such field. The
    // text must read as the absence it is — a synthesized justification would
    // be indistinguishable from one a human wrote.
    const repo = makeRepo();
    const { home } = machineState(repo, TWO_IDENTICAL_SURFACES);
    runCliWithHome(['hooks', 'import', '--from-machine'], { cwd: repo, home });

    const reason = readPolicy(repo).surfaces.default.extensions.pre_tool_use[0].reason;
    expect(reason).toContain('Imported from machine state');
    expect(reason).toContain('no justification was recorded');
  });

  test('a disabled entry imports WITHOUT inventing a reason (bare spelling)', () => {
    const repo = makeRepo();
    const { home } = machineState(repo, {
      'claude-code': {
        disabled: { pre_tool_use: ['god-object-check.sh'] },
        extensions: {},
        handlers: {},
        libraries: {},
      },
    });
    expect(runCliWithHome(['hooks', 'import', '--from-machine'], { cwd: repo, home }).status).toBe(
      0
    );
    // The bare string, not {handler, reason: "..."} — machine state recorded
    // no rationale and the import must not manufacture one.
    expect(readPolicy(repo).surfaces.default.disabled.pre_tool_use).toEqual([
      'god-object-check.sh',
    ]);
  });
});

describe('import: refusals write nothing to either store', () => {
  test('a machine entry disabling a FLOOR handler refuses and names it', () => {
    // Machine tier may disable protected-paths.sh; the repo tier may not.
    // Dropping it silently would increase enforcement — safe, but it would
    // make the import a lie about equivalence.
    const repo = makeRepo();
    const { home, file } = machineState(repo, {
      'claude-code': {
        disabled: { pre_tool_use: ['protected-paths.sh'] },
        extensions: {},
        handlers: {},
        libraries: {},
      },
    });
    const machineBefore = fs.readFileSync(file, 'utf8');
    const cawsBefore = treeHash(path.join(repo, '.caws'));

    const { status, out } = runCliWithHome(['hooks', 'import', '--from-machine'], {
      cwd: repo,
      home,
    });
    expect(status).toBe(1);
    expect(out).toContain('protected-paths.sh');
    expect(out).toContain('Nothing was written');
    expect(treeHash(path.join(repo, '.caws'))).toBe(cawsBefore);
    expect(fs.readFileSync(file, 'utf8')).toBe(machineBefore);
  });

  test('REPLACING a floor handler refuses too — a no-op replacement is a disable', () => {
    // Gating only `disabled` would leave the bypass one key away.
    const repo = makeRepo();
    const { home } = machineState(repo, {
      'claude-code': {
        disabled: {},
        extensions: {},
        handlers: { 'block-dangerous.sh': '.caws/hooks/ext/noop.sh' },
        libraries: {},
      },
    });
    const before = treeHash(path.join(repo, '.caws'));
    const { status, out } = runCliWithHome(['hooks', 'import', '--from-machine'], {
      cwd: repo,
      home,
    });
    expect(status).toBe(1);
    expect(out).toContain('block-dangerous.sh');
    expect(treeHash(path.join(repo, '.caws'))).toBe(before);
  });

  test('a policy that already declares the destination surface is not merged into', () => {
    const repo = makeRepo({
      policy: {
        version: 1,
        surfaces: {
          default: {
            extensions: {
              pre_tool_use: [
                { handler: 'existing.sh', before: null, reason: 'a decision a human already made' },
              ],
            },
            handlers: { 'existing.sh': '.caws/hooks/ext/existing.sh' },
          },
        },
      },
    });
    const { home } = machineState(repo, TWO_IDENTICAL_SURFACES);
    const before = treeHash(path.join(repo, '.caws'));

    const { status, out } = runCliWithHome(['hooks', 'import', '--from-machine'], {
      cwd: repo,
      home,
    });
    expect(status).toBe(1);
    expect(out).toContain('already declares policy');
    expect(treeHash(path.join(repo, '.caws'))).toBe(before);
  });

  test('--from-machine is required; a bare import writes nothing', () => {
    const repo = makeRepo();
    const { home } = machineState(repo, TWO_IDENTICAL_SURFACES);
    const before = treeHash(path.join(repo, '.caws'));
    const { status, out } = runCliWithHome(['hooks', 'import'], { cwd: repo, home });
    expect(status).toBe(1);
    expect(out).toContain('--from-machine is required');
    expect(treeHash(path.join(repo, '.caws'))).toBe(before);
  });

  test('a project with no machine state says so instead of writing an empty policy', () => {
    const repo = makeRepo();
    const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'caws-hooks-home-')));
    const { status, out } = runCliWithHome(['hooks', 'import', '--from-machine'], {
      cwd: repo,
      home,
    });
    expect(status).toBe(1);
    expect(out).toContain('nothing to migrate');
    expect(fs.existsSync(path.join(repo, POLICY))).toBe(false);
  });
});

describe('import: --plan writes nothing to either store', () => {
  test('it reports what it would write AND what it would clear', () => {
    const repo = makeRepo();
    const { home, file } = machineState(repo, TWO_IDENTICAL_SURFACES);
    const machineBefore = fs.readFileSync(file, 'utf8');
    const cawsBefore = treeHash(path.join(repo, '.caws'));

    const { status, out } = runCliWithHome(['hooks', 'import', '--from-machine', '--plan'], {
      cwd: repo,
      home,
    });
    expect(status).toBe(0);
    expect(out).toContain('would write');
    expect(out).toContain('would then clear');
    // Named, so the operator can see which machine surfaces the plan touches.
    expect(out).toContain('claude-code');
    expect(out).toContain('codex');
    // Both stores byte-identical: --plan on a two-store verb has two ways to lie.
    expect(treeHash(path.join(repo, '.caws'))).toBe(cawsBefore);
    expect(fs.readFileSync(file, 'utf8')).toBe(machineBefore);
  });

  test('--plan --json names the same clear set the non-plan run performs', () => {
    // The control that keeps the preview honest: a plan naming a different set
    // than the real run is worse than no plan.
    const repo = makeRepo();
    const { home } = machineState(repo, TWO_IDENTICAL_SURFACES);
    const planned = JSON.parse(
      runCliWithHome(['hooks', 'import', '--from-machine', '--plan', '--json'], {
        cwd: repo,
        home,
      }).out.trim()
    );
    const applied = JSON.parse(
      runCliWithHome(['hooks', 'import', '--from-machine', '--json'], {
        cwd: repo,
        home,
      }).out.trim()
    );
    expect(planned.wrote).toBe(false);
    expect(applied.wrote).toBe(true);
    expect(applied.cleared).toEqual(planned.wouldClear);
    expect(applied.changed).toEqual(planned.changed);
  });
});
