const {
  evaluateNativeShortcutLanguage,
  NativeShortcutLanguageError,
  MAX_SHORTCUT_IMAGE_BYTES,
  MAX_SHORTCUT_IMAGE_LINES,
} = require('../../dist/runtime/file-tools/shortcut-language');

function write(content, preimage = null, relativePath = 'src/main.ts', checkpoint = () => {}) {
  return evaluateNativeShortcutLanguage(
    { originalTool: 'Write', relativePath, content, preimage },
    checkpoint
  );
}

describe('native Claude pre-tool shortcut language', () => {
  test.each([
    'const markers = /\\b(?:TODO|FIXME|XXX|HACK|TBD)\\b/gi;',
    'const marker = /TODO\\/path/;',
    'const marker = /[T/ODO]+/u;',
    'function f() { return /TODO/; }',
    'match(/TODO/);',
    'if(ready) /TODO/.test(value);',
    'while(ready) /FIXME/.test(value);',
    'if (\n  ready\n)\n  /TODO/.test(value);',
    'const text = `TODO ${`FIXME ${1}`}`;',
    'const text = `TODO ${/FIXME/.test(value)}`;',
    'const text = "throw new Error(\'not implemented\')";',
    'const text = `throw new Error("not implemented")`;',
    'const text = `not implemented ${1}`;',
    'const status = "not implemented";',
    'const status = "coming soon";',
    'const status = "implement later";',
  ])('treats a closed expression regex as data: %s', (content) => {
    expect(write(content)).toEqual({ kind: 'clean' });
  });

  test.each([
    'const ratio = count / TODO / total;',
    'const ratio=count++ / TODO / total;',
    'const ratio=count-- / HACK / total;',
    'obj.return / FIXME / total;',
    'obj.throw / TBD / total;',
    'const ratio = obj<T> / TODO / total;',
    'const marker = /clean/; // TODO: complete',
    'const marker = /TODO/; const pending = FIXME;',
    'const text = `${/*TODO*/1}`;',
    'const text = `TODO ${`FIXME ${/*hack*/1}`}`;',
    'const text = `TODO ${`FIXME ${TBD}`}`;',
    'if(ready) /TODO/.test(value); // fixme: complete',
    'const text = `TODO`; // hack: complete',
    'const text = "TODO"; // tbd: complete',
  ])('does not hide executable or real comment markers: %s', (content) => {
    expect(write(content)).toMatchObject({ kind: 'hit', rule: 'incomplete-work', line: 1 });
  });

  test.each([
    'const marker = /TODO/gg;',
    'const marker = /TODO/uv;',
    'const marker = /TODO/unknown;',
    'const marker = /TODO;',
    'const marker = /(/;',
    'const text = "unterminated TODO',
    'const text = `TODO ${1;',
    'const node = <Input title="TODO";',
  ])('refuses unresolved or invalid JS-family data rather than returning clean: %s', (content) => {
    expect(() => write(content, null, 'src/main.tsx')).toThrow(NativeShortcutLanguageError);
  });

  test.each([
    ['const n = 1;', 'const n = 1;'],
    ['const s = "TODO: describe";', null],
    ["const s = 'FIXME: describe';", null],
    ['const s = `HACK: describe`;', null],
    ['const s = "name: x # TODO: describe";', null],
    ['const s = "a \\" TODO: describe";', null],
    ['const mask = "XXX-XXX-XXXX";', null],
    ['type Todo = { title: string; done: boolean };', null],
    ['const todo = 1;', null],
    ['const label = XXX;', null],
    ['const glob = "src/*.ts";\nconst todo = 1;', null],
    ['const glob = "src/**/*.ts";\nconst todo = 1;', null],
    ['const url = "https://example.com/placeholder"; // ok', null],
    ['// avoid leaving a TODO behind in generated code', null],
    ['// load the data', null],
    ['// the TODO; our FIXME; without HACK', null],
    ['// see CAWS-DEFECT-SPECS-CREATE-TODO-SCAFFOLD-01', null],
    ['// TODO-123; TODO_SCAFFOLD; SCAFFOLD-TODO', null],
    ['const ticket = TODO_123;', null],
    ['// The skeleton is a placeholder shown while content loads.', null],
    ['// map placeholder to the native attribute', null],
    ['// The placeholder is shown until the user types.', null],
    ['// Renders a placeholder while the image loads', null],
    ['// set aria-placeholder later, once the label is known', null],
    ['/* ::placeholder until focus, then the label floats */', null],
    ['<!-- placeholder slot for the hint text -->', null, 'src/main.html'],
    ['interface Props {\n/** Placeholder */\nplaceholder?: string;\n}', null],
    ['interface Props {\n/**\n * placeholder\n */\nplaceholder?: string;\n}', null],
    ['const Input = () => <input placeholder="Name" />;', null, 'src/main.tsx'],
    ['const props = { placeholderTextColor: "grey" };', null],
    ['.input::placeholder { color: grey; }', null, 'src/main.css'],
    ['.input:placeholder-shown { color: grey; }', null, 'src/main.css'],
    ['// no coming soon message is shown', null],
  ])('leaves authored data or descriptive language clean: %s', (...values) => {
    const [content, preimage, relativePath] = values;
    expect(write(content, preimage, relativePath)).toEqual({ kind: 'clean' });
  });

  test.each([
    ['// todo: finish', 'incomplete-work', 1, '// todo: finish'],
    ['// load the data TODO', 'incomplete-work', 1, '// load the data TODO'],
    ['// XXX: replace', 'incomplete-work', 1, '// XXX: replace'],
    ['const label = TODO;', 'incomplete-work', 1, 'const label = TODO;'],
    ['// TODO-fix handler', 'incomplete-work', 1, '// TODO-fix handler'],
    ['// fix-TODO later', 'incomplete-work', 1, '// fix-TODO later'],
    ['const s = "ok"; // TODO: finish', 'incomplete-work', 1, 'const s = "ok"; // TODO: finish'],
    [
      'const s = "ok"; const label = TODO;',
      'incomplete-work',
      1,
      'const s = "ok"; const label = TODO;',
    ],
    [
      "echo don't panic; # TODO: finish",
      'incomplete-work',
      1,
      "echo don't panic; # TODO: finish",
      'src/main.sh',
    ],
    ['// "todo": finish', 'incomplete-work', 1, '// "todo": finish'],
    ['-- todo: finish', 'incomplete-work', 1, '-- todo: finish', 'src/main.sql'],
    ['const n = 1;\n// placeholder', 'placeholder-stub', 2, '// placeholder'],
    ['// This is just a placeholder', 'placeholder-stub', 1, '// This is just a placeholder'],
    [
      "const rows = []; // it's a placeholder",
      'placeholder-stub',
      1,
      "const rows = []; // it's a placeholder",
    ],
    [
      '// Placeholder implementation, replace with real logic',
      'placeholder-stub',
      1,
      '// Placeholder implementation, replace with real logic',
    ],
    [
      'function f() { return null; } // placeholder for now',
      'placeholder-stub',
      1,
      'function f() { return null; } // placeholder for now',
    ],
    [
      'const n = 0; /* temporary placeholder */',
      'placeholder-stub',
      1,
      'const n = 0; /* temporary placeholder */',
    ],
    [
      'x = 0 # placeholder until the service exists',
      'placeholder-stub',
      1,
      'x = 0 # placeholder until the service exists',
      'src/main.py',
    ],
    [
      '/*\n * details\n * temporary placeholder\n */',
      'placeholder-stub',
      3,
      '* temporary placeholder',
    ],
    ['// coming soon', 'deferred-work', 1, '// coming soon'],
    [
      'function f() {\n  throw new Error("not implemented");\n}',
      'explicit-not-implemented',
      2,
      'throw new Error("not implemented");',
    ],
    [
      "throw new Error('Not Implemented');",
      'explicit-not-implemented',
      1,
      "throw new Error('Not Implemented');",
    ],
    [
      'throw new Error(`not implemented`);',
      'explicit-not-implemented',
      1,
      'throw new Error(`not implemented`);',
    ],
  ])('reports the semantic rule and original line: %s', (...values) => {
    const [content, rule, line, excerpt, relativePath] = values;
    expect(write(content, null, relativePath)).toEqual({ kind: 'hit', rule, line, excerpt });
  });

  test.each([
    ['src/main.js', 'const value = obj.return / FIXME / total;'],
    ['src/main.mjs', 'const value = count++ / TODO / total;'],
    ['src/main.cjs', 'module.exports = count++ / TODO / total;'],
    ['src/main.ts', 'const value = obj<T> / TODO / total;'],
    ['src/main.mts', 'const value = obj<T> / TODO / total;'],
    ['src/main.cts', 'const value = obj<T> / TODO / total;'],
  ])('uses grammar rather than a slash prefix guess in %s', (relativePath, content) => {
    expect(write(content, null, relativePath)).toEqual({
      kind: 'hit',
      rule: 'incomplete-work',
      line: 1,
      excerpt: content,
    });
  });

  test.each(['src/main.jsx', 'src/main.tsx'])(
    'keeps JSX data separate from expression code in %s',
    (relativePath) => {
      expect(
        write(
          'const view = <Input title="TODO" note="throw new Error(\'not implemented\')">' +
            'FIXME not implemented{"HACK"}</Input>;',
          null,
          relativePath
        )
      ).toEqual({ kind: 'clean' });
      expect(write('const view = <Input value={TODO} />;', null, relativePath)).toEqual({
        kind: 'hit',
        rule: 'incomplete-work',
        line: 1,
        excerpt: 'const view = <Input value={TODO} />;',
      });
    }
  );

  test('handles typed TSX generics without treating the whole expression as data', () => {
    const prefix = 'const id = <T,>(value: T): T => value;\n';
    expect(
      write(
        prefix + 'const view = <Input<string> title="TODO" value={id("FIXME")} />;',
        null,
        'src/main.tsx'
      )
    ).toEqual({ kind: 'clean' });
    expect(
      write(
        prefix + 'const view = <Input<string> title="TODO" value={TODO} />;',
        null,
        'src/main.tsx'
      )
    ).toEqual({
      kind: 'hit',
      rule: 'incomplete-work',
      line: 2,
      excerpt: 'const view = <Input<string> title="TODO" value={TODO} />;',
    });
  });

  test('retains actual comments after JSX literals', () => {
    const content = 'const view = <Input title="TODO" />; // fixme: complete';
    expect(write(content, null, 'src/main.tsx')).toEqual({
      kind: 'hit',
      rule: 'incomplete-work',
      line: 1,
      excerpt: content,
    });
  });

  test('retains nested-template expression comments at their original line', () => {
    expect(write('const text = `TODO ${\n  `FIXME ${\n    /*hack*/1\n  }`\n}`;')).toEqual({
      kind: 'hit',
      rule: 'incomplete-work',
      line: 3,
      excerpt: '/*hack*/1',
    });
  });

  test('recognizes actual throws inside template and JSX expressions', () => {
    const expression = '(() => { throw new Error("not implemented"); })()';
    const template = 'const text = `${' + expression + '}`;';
    expect(write(template)).toEqual({
      kind: 'hit',
      rule: 'explicit-not-implemented',
      line: 1,
      excerpt: template,
    });
    const jsx = 'const view = <Input value={' + expression + '} />;';
    expect(write(jsx, null, 'src/main.tsx')).toEqual({
      kind: 'hit',
      rule: 'explicit-not-implemented',
      line: 1,
      excerpt: jsx,
    });
  });

  test.each([
    'throw (new Error("not implemented"));',
    'throw Error("not implemented");',
    'throw ((Error))(("not implemented"));',
    'throw new (Error)("not implemented");',
    'throw (new Error("not implemented") as Error);',
    'throw (<Error>new Error("not implemented"));',
    'throw new Error(("not implemented" as string));',
    'throw (new Error("not implemented")!);',
    'throw (new Error("not implemented") satisfies Error);',
    'throw new Error(`not implemented ${value}`);',
    'throw ("not implemented");',
    'throw `not implemented ${value}`;',
  ])('recognizes an actual wrapped or direct stub throw: %s', (content) => {
    expect(write(content)).toEqual({
      kind: 'hit',
      rule: 'explicit-not-implemented',
      line: 1,
      excerpt: content,
    });
  });

  test('keeps wrapped throw examples inside data clean', () => {
    expect(write(String.raw`const text = "throw (new Error(\"not implemented\"))";`)).toEqual({
      kind: 'clean',
    });
  });

  test('does not classify a commented throw example as an actual throw', () => {
    expect(write('// throw new Error("not implemented")')).toEqual({
      kind: 'hit',
      rule: 'deferred-work',
      line: 1,
      excerpt: '// throw new Error("not implemented")',
    });
  });

  test('attributes a newly authored multiline throw message to its own line', () => {
    const before = 'function f() {\n  throw new Error(\n    "available"\n  );\n}';
    const after = 'function f() {\n  throw new Error(\n    "not implemented"\n  );\n}';
    expect(write(after, before)).toEqual({
      kind: 'hit',
      rule: 'explicit-not-implemented',
      line: 3,
      excerpt: '"not implemented"',
    });
  });

  test('does not punish a retained throw when only an unrelated comment is added', () => {
    const before = 'function f() {\n  throw new Error(\n    "not implemented"\n  );\n}';
    const after =
      'function f() {\n  throw new Error(\n    // This branch rejects unavailable requests.\n    "not implemented"\n  );\n}';
    expect(write(after, before)).toEqual({ kind: 'clean' });
  });

  test('does not punish retained executable markers while checking new additions', () => {
    const before = 'const ratio = obj<T> / TODO / total;\nconst n = 0;';
    const after = 'const ratio = obj<T> / TODO / total;\nconst n = 1;';
    expect(write(after, before)).toEqual({ kind: 'clean' });
  });

  test('parses the complete postimage even when broken syntax was preexisting', () => {
    expect(() =>
      write('const text = "unterminated TODO\nconst n = 1;', 'const text = "unterminated TODO')
    ).toThrow('JS-family parse unavailable');
  });

  test('keeps the deliberately bounded non-JS string contract separate', () => {
    expect(write('status = "not implemented"', null, 'src/main.py')).toEqual({
      kind: 'hit',
      rule: 'deferred-work',
      line: 1,
      excerpt: 'status = "not implemented"',
    });
  });

  test.each([
    ['unsupported parser version', (real) => ({ ...real, version: '0.0.0' })],
    [
      'parser diagnostics unavailable',
      (real) => ({
        ...real,
        createSourceFile(...args) {
          const source = real.createSourceFile(...args);
          delete source.parseDiagnostics;
          return source;
        },
      }),
    ],
    [
      'invalid parser range',
      (real) => ({
        ...real,
        createSourceFile(...args) {
          const source = real.createSourceFile(...args);
          source.statements[0].end = source.text.length + 1;
          return source;
        },
      }),
    ],
  ])('refuses a violated pinned parser contract: %s', (message, replace) => {
    const real = jest.requireActual('typescript');
    const loader = jest.spyOn(require('node:module'), 'createRequire').mockReturnValue((name) => {
      expect(name).toBe('typescript');
      return replace(real);
    });
    try {
      jest.isolateModules(() => {
        const fresh = require('../../dist/runtime/file-tools/shortcut-language');
        expect(() =>
          fresh.evaluateNativeShortcutLanguage(
            {
              originalTool: 'Write',
              relativePath: 'src/main.ts',
              content: 'const text = "TODO";',
              preimage: null,
            },
            () => {}
          )
        ).toThrow(message);
      });
    } finally {
      loader.mockRestore();
    }
  });
  test('does not let a referenced marker hide a separate active occurrence', () => {
    expect(write('// the TODO; TODO: implement')).toEqual({
      kind: 'hit',
      rule: 'incomplete-work',
      line: 1,
      excerpt: '// the TODO; TODO: implement',
    });
  });

  test.each([
    ['src/Input.test.tsx'],
    ['src/Input.spec.tsx'],
    ['tests/main.ts'],
    ['src/__tests__/main.ts'],
    ['src/test/main.ts'],
    ['fixtures/main.ts'],
    ['node_modules/main.ts'],
    ['src/dist/main.ts'],
    ['build/main.ts'],
    ['coverage/main.ts'],
    ['.next/main.ts'],
    ['out/main.ts'],
    ['vendor/main.ts'],
    ['docs/guide.md'],
    ['guide.markdown'],
    ['guide.txt'],
    ['dependency.lock'],
    ['bundle.map'],
    ['package-lock.json'],
    ['other-lock.json'],
    ['main.min.js'],
    ['main.bundle.js'],
  ])('exempts the declared path %s', (relativePath) => {
    expect(write('// TODO: finish', null, relativePath)).toEqual({
      kind: 'inactive',
      reason: 'exempt',
    });
  });

  test.each(['docs/example.ts', 'src/tests-helper.ts', 'guide.MD', 'src/Input.tsx'])(
    'does not broaden an exemption to %s',
    (relativePath) => {
      expect(write('// TODO: finish', null, relativePath)).toEqual({
        kind: 'hit',
        rule: 'incomplete-work',
        line: 1,
        excerpt: '// TODO: finish',
      });
    }
  );

  test('does not publish a pre-tool shortcut decision for original Edit', () => {
    expect(
      evaluateNativeShortcutLanguage(
        { originalTool: 'Edit', relativePath: 'src/main.ts' },
        () => {}
      )
    ).toEqual({ kind: 'inactive', reason: 'edit' });
  });

  test('ignores removed, retained and moved marker lines', () => {
    expect(write('const n = 1;', '// TODO: old\nconst n = 1;')).toEqual({ kind: 'clean' });
    expect(write('const n = 2;\n// TODO: old', '// TODO: old\nconst n = 1;')).toEqual({
      kind: 'clean',
    });
    expect(write('// TODO: old\nconst n = 2;', '// TODO: old\nconst n = 1;')).toEqual({
      kind: 'clean',
    });
  });

  test('treats only excess identical copies as authored', () => {
    expect(write('// TODO: old\n// TODO: old', '// TODO: old')).toEqual({
      kind: 'hit',
      rule: 'incomplete-work',
      line: 2,
      excerpt: '// TODO: old',
    });
  });

  test('attributes a new marker to its complete postimage line', () => {
    expect(
      write('// TODO: retained\nconst n = 1;\n  // FIXME: new', '// TODO: retained\nconst n = 0;')
    ).toEqual({
      kind: 'hit',
      rule: 'incomplete-work',
      line: 3,
      excerpt: '// FIXME: new',
    });
  });

  test('uses exact lines rather than silently normalizing changed whitespace', () => {
    expect(write(' // TODO: old', '// TODO: old')).toEqual({
      kind: 'hit',
      rule: 'incomplete-work',
      line: 1,
      excerpt: '// TODO: old',
    });
  });

  test('keeps unchanged opening context for newly authored block-comment text', () => {
    expect(write('/*\ntodo: finish\n*/', '/*\n*/')).toEqual({
      kind: 'hit',
      rule: 'incomplete-work',
      line: 2,
      excerpt: 'todo: finish',
    });
  });

  test('resumes string handling after a multiline comment closes', () => {
    expect(write('/*\n*/ const s = "// todo: data";\nconst n = 1;', '/*\n*/')).toEqual({
      kind: 'clean',
    });
  });

  test('gives explicit throws priority over earlier marker lines', () => {
    expect(write('// TODO: finish\nthrow new Error("not implemented");')).toEqual({
      kind: 'hit',
      rule: 'explicit-not-implemented',
      line: 2,
      excerpt: 'throw new Error("not implemented");',
    });
  });

  test('gives comment markers priority over earlier code markers', () => {
    expect(write('const x = TODO;\n// fixme: finish')).toEqual({
      kind: 'hit',
      rule: 'incomplete-work',
      line: 2,
      excerpt: '// fixme: finish',
    });
  });

  test('chooses the first placeholder line across its different stub cues', () => {
    expect(write('// placeholder, fill in later\n// placeholder implementation')).toEqual({
      kind: 'hit',
      rule: 'placeholder-stub',
      line: 1,
      excerpt: '// placeholder, fill in later',
    });
  });

  test('bounds excerpts by Unicode characters without splitting a surrogate pair', () => {
    expect(write(' \t// TODO: ' + '😀'.repeat(130))).toEqual({
      kind: 'hit',
      rule: 'incomplete-work',
      line: 1,
      excerpt: '// TODO: ' + '😀'.repeat(111),
    });
  });

  test.each([
    '/src/main.ts',
    '../src/main.ts',
    'tests/../src/main.ts',
    './tests/main.ts',
    'src//main.ts',
    'src/main.ts/',
    'src\\main.ts',
    '',
  ])('refuses noncanonical paths before applying exemptions: %s', (relativePath) => {
    expect(() => write('// TODO: finish', null, relativePath)).toThrow(NativeShortcutLanguageError);
  });

  test.each([
    { originalTool: 'Write', relativePath: 'src/main.ts', content: '// TODO' },
    { originalTool: 'Write', relativePath: 'src/main.ts', content: 3, preimage: null },
    { originalTool: 'Write', relativePath: 'src/main.ts', content: '', preimage: 3 },
    { originalTool: 'Write', relativePath: 'src/main.ts', content: '\0', preimage: null },
    { originalTool: 'Write', relativePath: 'src/main.ts', content: '\ud800', preimage: null },
    { originalTool: 'Write', relativePath: 'src/main.ts', content: '', preimage: '\ud800' },
    {
      originalTool: 'apply_patch',
      relativePath: 'src/main.ts',
      content: '// TODO',
      preimage: null,
    },
    null,
  ])('refuses unavailable or malformed semantic inputs: %p', (input) => {
    expect(() => evaluateNativeShortcutLanguage(input, () => {})).toThrow(
      NativeShortcutLanguageError
    );
  });

  test('does not disguise malformed exempt-file content as inactive', () => {
    expect(() => write('\ud800', null, 'tests/main.ts')).toThrow('invalid content');
  });

  test('bounds both images in UTF-8 bytes', () => {
    expect(() => write('x'.repeat(MAX_SHORTCUT_IMAGE_BYTES + 1))).toThrow('invalid content');
    expect(() => write('é'.repeat(MAX_SHORTCUT_IMAGE_BYTES / 2 + 1))).toThrow('invalid content');
    expect(() => write('', 'x'.repeat(MAX_SHORTCUT_IMAGE_BYTES + 1))).toThrow('invalid preimage');
  });

  test('refuses excessive line inventories rather than declaring clean', () => {
    expect(() => write('\n'.repeat(MAX_SHORTCUT_IMAGE_LINES))).toThrow('image line limit exceeded');
    expect(() => write('', '\n'.repeat(MAX_SHORTCUT_IMAGE_LINES))).toThrow(
      'image line limit exceeded'
    );
  });

  test('requires a checkpoint and propagates expiration after entry', () => {
    expect(() =>
      evaluateNativeShortcutLanguage({
        originalTool: 'Write',
        relativePath: 'src/main.ts',
        content: '',
        preimage: null,
      })
    ).toThrow('checkpoint required');
    const expired = new Error('original root deadline expired');
    let entered = false;
    expect(() =>
      write('// TODO: finish', null, 'src/main.ts', () => {
        if (entered) throw expired;
        entered = true;
      })
    ).toThrow(expired);
  });
});
