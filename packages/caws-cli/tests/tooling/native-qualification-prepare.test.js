const crypto = require('node:crypto');
const {
  decodePreparationGitBatch,
  preparationCommitTree,
  decodePreparationGitTree,
  planPreparationGitExport,
} = require('../../dist/tooling/native-qualification-prepare');

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
