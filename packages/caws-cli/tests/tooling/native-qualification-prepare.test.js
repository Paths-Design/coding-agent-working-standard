const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const yaml = require('js-yaml');
const fixtures = require('../helpers/git-repo-factory');
const { initProject } = require('../../dist/store/init-store');
const { loadSpecs } = require('../../dist/store/specs-store');
const {
  decodePreparationGitBatch,
  preparationCommitTree,
  decodePreparationGitTree,
  planPreparationGitExport,
  inspectPreparationWriteAuthority,
  preparationSourceDisposition,
} = require('../../dist/tooling/native-qualification-prepare');

describe('native preparation closed production input profile', () => {
  test.each([
    'package-lock.json',
    'packages/caws-cli/src/store/specs-store.ts',
    'packages/caws-cli/src/kernel/schemas/spec.v1.json',
    'packages/caws-cli/scripts/build-cli.js',
    'packages/caws-cli/templates/hook-packs/claude-code/settings.json',
    'packages/caws-cli/templates/hook-packs/shared/AGENTS.md',
    'packages/caws-native/src/installed_entry.rs',
    'packages/caws-native/examples/process-comm-vis-oracle.c',
    'packages/caws-native/examples/service-observer.rs',
    'packages/caws-native/examples/service-custody-observer.rs',
    'docs/guides/worktree-isolation.md',
    'docs/new-consumer-guide.md',
    'docs/architecture/maintainer-input.md',
  ])('selects traced production input %s', (file) => {
    expect(preparationSourceDisposition(file)).toBe('include');
  });

  test.each([
    '.caws/policy.yaml',
    '.codex/hooks.json',
    '.claude/settings.json',
    'packages/caws-cli/src/runtime/.env.example',
    'packages/caws-cli/src/runtime/.caws/state.json',
    'packages/caws-cli/src/runtime/.codex/hooks.json',
    'docs/.env/local.md',
    'docs/.aws/credentials.md',
    'packages/caws-cli/templates/hook-packs/shared/.env.fixture',
    'packages/caws-cli/templates/hook-packs/shared/credentials.json',
    'packages/caws-cli/templates/hook-packs/shared/private.key',
    'packages/caws-cli/templates/hook-packs/claude-code/tmp/session.json',
    'packages/caws-cli/templates/hook-packs/shared/state/pointer.json',
    'packages/caws-cli/node_modules/example/index.js',
    'packages/caws-native/target/release/caws',
    '.npmrc',
    '.cargo/config.toml',
  ])('refuses protected source name before any blob selection: %s', (file) => {
    expect(preparationSourceDisposition(file)).toBe('protected');
  });

  test.each([
    'README.md',
    'docs/diagram.svg',
    'packages/caws-cli/tests/unit.test.js',
    'packages/caws-native/src/tests.rs',
    'packages/caws-native/src/worker/tests/example.rs',
    'packages/caws-native/examples/unrelated.c',
    'packages/caws-native/src/service_protocol/fixtures.json',
    'packages/another-workspace/src/main.ts',
  ])('does not broaden the fixed profile to %s', (file) => {
    expect(preparationSourceDisposition(file)).toBe('unselected');
  });

  test.each([
    '../package.json',
    '/package.json',
    'packages/caws-cli/src/../state.ts',
    'a\\b',
    'a//b',
  ])('refuses malformed profile path %s', (file) => {
    expect(() => preparationSourceDisposition(file)).toThrow('Unsafe source profile path');
  });
});

describe('native preparation actual worktree output authority reader', () => {
  let root;
  let lane;
  let spec;
  let registry;
  let selection;
  let caller;
  let calls;
  const owner = 'preparation-fixture-owner';
  function saveSpec() {
    fs.writeFileSync(path.join(root, '.caws/specs/PREP-001.yaml'), yaml.dump(spec));
  }
  function saveRegistry() {
    fs.writeFileSync(path.join(root, '.caws/worktrees.json'), JSON.stringify(registry));
  }
  function canonicalBytes() {
    return Object.fromEntries(
      ['policy.yaml', 'worktrees.json', 'specs/PREP-001.yaml'].map((file) => [
        file,
        fs.readFileSync(path.join(root, '.caws', file)),
      ])
    );
  }
  beforeEach(() => {
    root = fs.realpathSync(fixtures.makeTempRepo());
    const initialized = initProject(root);
    if (!initialized.ok) throw new Error(JSON.stringify(initialized.errors));
    lane = path.join(root, '.caws/worktrees/prep');
    fixtures.git(root, ['worktree', 'add', '--detach', lane, 'HEAD']);
    fs.writeFileSync(path.join(lane, '.gitignore'), 'tmp/prepare/\n');
    registry = {
      prep: { path: lane, specId: 'PREP-001', owner: { session_id: owner, platform: 'codex' } },
    };
    spec = {
      id: 'PREP-001',
      title: 'Preparation authority fixture',
      mode: 'feature',
      lifecycle_state: 'active',
      worktree: 'prep',
      created_at: '2026-01-01T00:00:00.000Z',
      updated_at: '2026-01-01T00:00:00.000Z',
      blast_radius: { modules: ['fixture'], data_migration: false },
      operational_rollback_slo: '5m',
      scope: { in: ['tmp/prepare/'], out: ['tmp/prepare/run/private'] },
      invariants: ['Only owned fixture output is admitted.'],
      non_functional: { security: ['Reject foreign ownership and unscoped output.'] },
      acceptance: [
        { id: 'A1', given: 'owned fixture', when: 'read authority', then: 'actual scope decides' },
      ],
      contracts: [],
    };
    saveSpec();
    expect(loadSpecs(path.join(root, '.caws')).diagnostics).toEqual([]);
    saveRegistry();
    selection = {
      outputRoot: path.join(lane, 'tmp/prepare/run'),
      writePaths: [path.join(lane, 'tmp/prepare/run/source/file.ts')],
    };
    calls = [];
    caller = {
      cwd: lane,
      environment: { CAWS_AGENT_SURFACE: 'codex', CODEX_THREAD_ID: owner },
      git: (args, options) => {
        calls.push({ args: [...args], cwd: options.cwd });
        return fixtures.git(options.cwd, args);
      },
    };
  });
  afterEach(() => fixtures.cleanupAll());

  test('reads real linked-worktree ownership and explicit relative scope without writes', () => {
    const before = canonicalBytes();
    expect(inspectPreparationWriteAuthority(selection, caller)).toEqual({
      repoRoot: root,
      cawsDir: path.join(root, '.caws'),
      worktreeRoot: lane,
      worktreeName: 'prep',
      specId: 'PREP-001',
      sessionId: owner,
      checkedRelativePaths: ['tmp/prepare/run', 'tmp/prepare/run/source/file.ts'],
    });
    expect(canonicalBytes()).toEqual(before);
    expect(fs.existsSync(selection.outputRoot)).toBe(false);
    expect(calls).toEqual([
      { args: ['rev-parse', '--path-format=absolute', '--git-common-dir'], cwd: lane },
      { args: ['rev-parse', '--show-toplevel'], cwd: lane },
      { args: ['check-ignore', '--quiet', '--no-index', '--', 'tmp/prepare/run'], cwd: lane },
    ]);
  });

  test('refuses a different caller despite valid scope and existing owner records', () => {
    caller.environment.CODEX_THREAD_ID = 'another-fixture-owner';
    const before = canonicalBytes();
    expect(() => inspectPreparationWriteAuthority(selection, caller)).toThrow('another caller');
    expect(canonicalBytes()).toEqual(before);
    expect(fs.existsSync(selection.outputRoot)).toBe(false);
  });

  test('does not acquire an identity from the registered owner when caller identity is absent', () => {
    caller.environment = {};
    expect(() => inspectPreparationWriteAuthority(selection, caller)).toThrow(
      'identity unavailable'
    );
    expect(fs.existsSync(path.join(root, '.caws/sessions'))).toBe(false);
  });

  test.each(['draft', 'closed', 'archived'])(
    'refuses a %s spec even with matching ownership',
    (state) => {
      spec.lifecycle_state = state;
      if (state === 'closed' || state === 'archived') spec.resolution = 'completed';
      saveSpec();
      expect(loadSpecs(path.join(root, '.caws')).diagnostics).toEqual([]);
      expect(() => inspectPreparationWriteAuthority(selection, caller)).toThrow(
        'spec must be active'
      );
    }
  );

  test('refuses one-sided binding rather than borrowing another spec', () => {
    spec.worktree = 'different';
    saveSpec();
    expect(() => inspectPreparationWriteAuthority(selection, caller)).toThrow('bidirectional');
  });

  test('uses actual Git checkout rather than a claimant path or canonical infrastructure exemption', () => {
    spec.scope.in = ['elsewhere/'];
    saveSpec();
    expect(() => inspectPreparationWriteAuthority(selection, caller)).toThrow(
      'explicit scope admission: tmp/prepare/run'
    );
    caller.cwd = root;
    expect(() => inspectPreparationWriteAuthority(selection, caller)).toThrow(
      'owned linked worktree'
    );
  });

  test('refuses registry disagreement and duplicate physical checkout claims', () => {
    registry.prep.path = root;
    saveRegistry();
    expect(() => inspectPreparationWriteAuthority(selection, caller)).toThrow(
      'exactly one registry'
    );
    registry.prep.path = lane;
    registry.duplicate = { ...registry.prep };
    saveRegistry();
    expect(() => inspectPreparationWriteAuthority(selection, caller)).toThrow(
      'exactly one registry'
    );
  });

  test('refuses missing policy, output escapes and exclusions within otherwise admitted output', () => {
    selection.writePaths = [path.join(lane, 'tmp/prepare/run/private/key')];
    expect(() => inspectPreparationWriteAuthority(selection, caller)).toThrow(
      'explicit scope admission'
    );
    selection.writePaths = [path.join(root, 'foreign-output')];
    expect(() => inspectPreparationWriteAuthority(selection, caller)).toThrow(
      'escapes selected output'
    );
    selection.writePaths = [];
    fs.unlinkSync(path.join(root, '.caws/policy.yaml'));
    expect(() => inspectPreparationWriteAuthority(selection, caller)).toThrow('policy unavailable');
  });

  test('requires actual ignored output and refuses control-plane paths', () => {
    fs.writeFileSync(path.join(lane, '.gitignore'), '');
    expect(() => inspectPreparationWriteAuthority(selection, caller)).toThrow('must be ignored');
    selection = { outputRoot: path.join(lane, '.caws/prepared'), writePaths: [] };
    expect(() => inspectPreparationWriteAuthority(selection, caller)).toThrow('control-plane');
  });
});

function object(kind, body, format = 'sha1') {
  const bytes = Buffer.from(body);
  const oid = crypto
    .createHash(format)
    .update(`${kind} ${bytes.length}\0`)
    .update(bytes)
    .digest('hex');
  return { oid, kind, bytes };
}
function framed(value) {
  return Buffer.concat([
    Buffer.from(`${value.oid} ${value.kind} ${value.bytes.length}\n`),
    value.bytes,
    Buffer.from('\n'),
  ]);
}
function treeRecord(mode, name, oid) {
  return Buffer.concat([Buffer.from(`${mode} ${name}\0`), Buffer.from(oid, 'hex')]);
}

describe('native preparation raw Git object identities', () => {
  test.each(['sha1', 'sha256'])(
    'preserves exact binary and empty blob bytes in %s framing',
    (format) => {
      const binary = object('blob', Buffer.from([0, 255, 10, 32, 13]), format);
      const empty = object('blob', Buffer.alloc(0), format);
      const source = Buffer.concat([framed(binary), framed(empty)]);
      const result = decodePreparationGitBatch(source, [binary, empty], format);
      expect(result).toEqual([binary, empty]);
      source.fill(0);
      expect(result[0].bytes).toEqual(Buffer.from([0, 255, 10, 32, 13]));
    }
  );

  test('rejects changed bytes even when framing and byte count match', () => {
    const value = object('blob', 'known');
    const changed = framed({ ...value, bytes: Buffer.from('other') });
    expect(() => decodePreparationGitBatch(changed, [value], 'sha1')).toThrow(
      'content identity mismatch'
    );
  });

  test('rejects wrong object kind instead of treating its bytes as source', () => {
    const value = object('tree', Buffer.alloc(0));
    expect(() =>
      decodePreparationGitBatch(framed(value), [{ ...value, kind: 'blob' }], 'sha1')
    ).toThrow('selection mismatch');
  });

  test.each(['HEAD', 'a'.repeat(39), 'A'.repeat(40), 'a'.repeat(64)])(
    'refuses non-SHA1 selection %s',
    (oid) => {
      expect(() =>
        decodePreparationGitBatch(Buffer.alloc(0), [{ oid, kind: 'blob' }], 'sha1')
      ).toThrow('full lowercase');
    }
  );

  test.each(['missing', 'ambiguous'])('rejects Git %s output', (status) => {
    const value = object('blob', 'known');
    expect(() =>
      decodePreparationGitBatch(Buffer.from(`${value.oid} ${status}\n`), [value], 'sha1')
    ).toThrow('Malformed or missing');
  });

  test('rejects truncated bodies, surplus frames and noncanonical size', () => {
    const value = object('blob', 'known');
    expect(() => decodePreparationGitBatch(framed(value).subarray(0, -1), [value], 'sha1')).toThrow(
      'Truncated'
    );
    expect(() =>
      decodePreparationGitBatch(Buffer.concat([framed(value), framed(value)]), [value], 'sha1')
    ).toThrow('Surplus');
    expect(() =>
      decodePreparationGitBatch(Buffer.from(`${value.oid} blob 05\nknown\n`), [value], 'sha1')
    ).toThrow('Malformed');
  });

  test('rejects oversized bodies before reading or allocating their declared content', () => {
    const value = object('blob', 'known');
    expect(() =>
      decodePreparationGitBatch(Buffer.from(`${value.oid} blob 16777217\n`), [value], 'sha1')
    ).toThrow('exceeds bound');
  });
});

describe('native preparation complete Git export inventory', () => {
  function graph(format = 'sha1') {
    const blob = object('blob', 'exact source\n', format);
    const inner = object('tree', treeRecord('100755', 'run.sh', blob.oid), format);
    const root = object(
      'tree',
      Buffer.concat([
        treeRecord('100644', 'README', blob.oid),
        treeRecord('40000', 'src', inner.oid),
      ]),
      format
    );
    const commit = object(
      'commit',
      `tree ${root.oid}\nauthor Test <test@example.invalid> 1 +0000\n\nmessage\n`,
      format
    );
    return { blob, inner, root, commit, objects: [blob, inner, root, commit] };
  }

  test.each(['sha1', 'sha256'])(
    'derives the exact %s graph, modes and reused blob bytes',
    (format) => {
      const fixture = graph(format);
      expect(
        planPreparationGitExport(fixture.objects, fixture.commit.oid, fixture.root.oid, format)
      ).toEqual({
        commit: fixture.commit.oid,
        tree: fixture.root.oid,
        directories: ['src'],
        files: [
          {
            relativePath: 'README',
            mode: '100644',
            oid: fixture.blob.oid,
            bytes: Buffer.from('exact source\n'),
          },
          {
            relativePath: 'src/run.sh',
            mode: '100755',
            oid: fixture.blob.oid,
            bytes: Buffer.from('exact source\n'),
          },
        ],
      });
    }
  );

  test('refuses a different root, missing child and unrelated extra object', () => {
    const fixture = graph();
    expect(() =>
      planPreparationGitExport(fixture.objects, fixture.commit.oid, fixture.inner.oid, 'sha1')
    ).toThrow('Pinned root tree');
    expect(() =>
      planPreparationGitExport(
        [fixture.inner, fixture.root, fixture.commit],
        fixture.commit.oid,
        fixture.root.oid,
        'sha1'
      )
    ).toThrow('Missing object');
    expect(() =>
      planPreparationGitExport(
        [...fixture.objects, object('blob', 'unreachable')],
        fixture.commit.oid,
        fixture.root.oid,
        'sha1'
      )
    ).toThrow('Unreachable');
  });

  test('rehashes graph input instead of trusting a caller-created object record', () => {
    const fixture = graph();
    fixture.blob.bytes[0] ^= 1;
    expect(() =>
      planPreparationGitExport(fixture.objects, fixture.commit.oid, fixture.root.oid, 'sha1')
    ).toThrow('content identity');
  });

  test('refuses an object of the wrong type referenced as a source directory', () => {
    const blob = object('blob', 'not a tree');
    const root = object('tree', treeRecord('40000', 'src', blob.oid));
    const commit = object('commit', `tree ${root.oid}\n\nmessage`);
    expect(() =>
      planPreparationGitExport([blob, root, commit], commit.oid, root.oid, 'sha1')
    ).toThrow('incorrect graph edge type');
  });

  function nestedGraph(depth, name) {
    let root = object('tree', Buffer.alloc(0));
    const objects = [root];
    for (let i = 0; i < depth; i++) {
      root = object('tree', treeRecord('40000', name, root.oid));
      objects.push(root);
    }
    const commit = object('commit', `tree ${root.oid}\n\nmessage`);
    return { objects: [...objects, commit], commit, root };
  }

  test('refuses a valid rehashed graph deeper than the source recursion bound', () => {
    const fixture = nestedGraph(65, 'd');
    expect(() =>
      planPreparationGitExport(fixture.objects, fixture.commit.oid, fixture.root.oid, 'sha1')
    ).toThrow('depth exceeds bound');
  });

  test('refuses an overlong materialized path even when every component is valid', () => {
    const fixture = nestedGraph(21, 'd'.repeat(200));
    expect(() =>
      planPreparationGitExport(fixture.objects, fixture.commit.oid, fixture.root.oid, 'sha1')
    ).toThrow('path inventory exceeds bound');
  });

  test('bounds materialized entries when a small graph reuses an empty subtree', () => {
    const empty = object('tree', Buffer.alloc(0));
    const wide = object(
      'tree',
      Buffer.concat(
        Array.from({ length: 1000 }, (_, i) =>
          treeRecord('40000', `d${String(i).padStart(4, '0')}`, empty.oid)
        )
      )
    );
    const root = object(
      'tree',
      Buffer.concat(
        Array.from({ length: 51 }, (_, i) =>
          treeRecord('40000', `p${String(i).padStart(2, '0')}`, wide.oid)
        )
      )
    );
    const commit = object('commit', `tree ${root.oid}\n\nmessage`);
    expect(() =>
      planPreparationGitExport([empty, wide, root, commit], commit.oid, root.oid, 'sha1')
    ).toThrow('path inventory exceeds bound');
  });
});

describe('native preparation commit and tree interpretation', () => {
  test.each(['sha1', 'sha256'])(
    'reads exact commit tree and regular modes using %s IDs',
    (format) => {
      const blob = object('blob', 'file', format);
      const tree = object(
        'tree',
        Buffer.concat([
          treeRecord('100644', 'README.md', blob.oid),
          treeRecord('100755', 'run.sh', blob.oid),
        ]),
        format
      );
      const commit = Buffer.from(
        `tree ${tree.oid}\nauthor Test <test@example.invalid> 1 +0000\n\ntree message-is-not-a-header\n`
      );
      expect(preparationCommitTree(commit, format)).toBe(tree.oid);
      expect(decodePreparationGitTree(tree.bytes, format)).toEqual([
        { name: 'README.md', mode: '100644', oid: blob.oid },
        { name: 'run.sh', mode: '100755', oid: blob.oid },
      ]);
    }
  );

  test('accepts a directory record for subsequent recursive object verification', () => {
    const tree = object('tree', Buffer.alloc(0));
    expect(decodePreparationGitTree(treeRecord('40000', 'src', tree.oid), 'sha1')).toEqual([
      { name: 'src', mode: '40000', oid: tree.oid },
    ]);
  });

  test.each(['120000', '160000', '100600'])('refuses source mode %s', (mode) => {
    expect(() =>
      decodePreparationGitTree(treeRecord(mode, 'entry', 'a'.repeat(40)), 'sha1')
    ).toThrow('Unsupported source mode');
  });

  test.each(['.', '..', '.git', '.GiT', 'a/b', 'a\\b', 'line\nbreak', 'é'])(
    'refuses unsafe or unsupported name %s',
    (name) => {
      expect(() =>
        decodePreparationGitTree(treeRecord('100644', name, 'a'.repeat(40)), 'sha1')
      ).toThrow(/source name/);
    }
  );

  test('rejects file-directory aliases and duplicate case variants', () => {
    const bytes = Buffer.concat([
      treeRecord('40000', 'src', 'a'.repeat(40)),
      treeRecord('100644', 'SRC', 'b'.repeat(40)),
    ]);
    expect(() => decodePreparationGitTree(bytes, 'sha1')).toThrow('case-colliding');
  });

  test('rejects a truncated object identity and a missing record terminator', () => {
    expect(() =>
      decodePreparationGitTree(treeRecord('100644', 'file', 'a'.repeat(38)), 'sha1')
    ).toThrow('Truncated');
    expect(() => decodePreparationGitTree(Buffer.from('100644 no-nul'), 'sha1')).toThrow(
      'Malformed'
    );
  });

  test('refuses missing, misplaced or duplicate root tree headers', () => {
    const oid = 'a'.repeat(40);
    expect(() => preparationCommitTree(Buffer.from(`tree ${oid}\n`), 'sha1')).toThrow('terminator');
    expect(() =>
      preparationCommitTree(Buffer.from(`author Test\ntree ${oid}\n\nmessage`), 'sha1')
    ).toThrow('one root tree');
    expect(() =>
      preparationCommitTree(Buffer.from(`tree ${oid}\ntree ${oid}\n\nmessage`), 'sha1')
    ).toThrow('one root tree');
  });
});
