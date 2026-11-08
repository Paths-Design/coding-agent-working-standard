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
    'return /TODO/;',
    'match(/TODO/);',
  ])('treats a closed expression regex as data: %s', (content) => {
    expect(write(content)).toEqual({ kind: 'clean' });
  });

  test.each([
    'const ratio = count / TODO / total;',
    'const marker = /TODO/gg;',
    'const marker = /TODO/uv;',
    'const marker = /TODO/unknown;',
    'const marker = /TODO;',
    'const marker = /clean/; // TODO: complete',
    'const marker = /TODO/; const pending = FIXME;',
  ])('does not hide actual markers or malformed regex data: %s', (content) => {
    expect(write(content)).toMatchObject({ kind: 'hit', rule: 'incomplete-work', line: 1 });
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
    ['<!-- placeholder slot for the hint text -->', null],
    ['/** Placeholder */\nplaceholder?: string;', null],
    ['/**\n * placeholder\n */\nplaceholder?: string;', null],
    ['const Input = () => <input placeholder="Name" />;', null],
    ['const props = { placeholderTextColor: "grey" };', null],
    ['.input::placeholder { color: grey; }', null],
    ['.input:placeholder-shown { color: grey; }', null],
    ['// no coming soon message is shown', null],
  ])('leaves authored data or descriptive language clean: %s', (content, preimage) => {
    expect(write(content, preimage)).toEqual({ kind: 'clean' });
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
    ['const s = "unterminated TODO', 'incomplete-work', 1, 'const s = "unterminated TODO'],
    ["echo don't panic; # TODO: finish", 'incomplete-work', 1, "echo don't panic; # TODO: finish"],
    ['// "todo": finish', 'incomplete-work', 1, '// "todo": finish'],
    ['-- todo: finish', 'incomplete-work', 1, '-- todo: finish'],
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
      'return null; // placeholder for now',
      'placeholder-stub',
      1,
      'return null; // placeholder for now',
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
    ],
    [
      '/*\n * details\n * temporary placeholder\n */',
      'placeholder-stub',
      3,
      '* temporary placeholder',
    ],
    ['// coming soon', 'deferred-work', 1, '// coming soon'],
    ['const status = "not implemented";', 'deferred-work', 1, 'const status = "not implemented";'],
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
  ])('reports the semantic rule and original line: %s', (content, rule, line, excerpt) => {
    expect(write(content)).toEqual({ kind: 'hit', rule, line, excerpt });
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
