'use strict';

const yaml = require('js-yaml');
const { patchEvidenceBlock, deleteEvidenceEntry } = require('../../dist/store/specs-writer');

const entry = (id, text = 'new evidence') => ({
  criterion_id: id,
  status: 'pass',
  evidence_ref: text,
  recorded_at: '2026-10-03T00:00:00.000Z',
});

// Repo-authored reduced specimen of Sterling A19: valid YAML quoted content
// starts at column zero and includes lines indistinguishable from item syntax
// to the old scanner. The oracle is parsed meaning AND preserved source bytes.
const history = `  - criterion_id: A19
    evidence_ref: "first line
evidence:
  - criterion_id: FAKE
status: fail
last line"
    status: pass
    recorded_at: "2026-10-02T18:48:11.371Z"
`;
const prefix = '# retain header\ntitle: "text\nevidence:\ninside title"\nevidence:\n';
const suffix = '# retain separator\nother: unchanged\n';
const specimen = prefix + history + suffix;

describe('YAML evidence structural boundaries', () => {
  test('appending to an unterminated last line preserves every original byte before the required separator', () => {
    const source = 'evidence:\n  - criterion_id: A19\n    status: pass\n    evidence_ref: old';
    const patched = patchEvidenceBlock(source, entry('A20'));
    expect(patched.startsWith(source + '\n')).toBe(true);
    expect(yaml.load(patched).evidence).toEqual([...yaml.load(source).evidence, entry('A20')]);
    expect(deleteEvidenceEntry(patched, 'A20').bytes).toBe(source + '\n');
  });
  test('append preserves every historical byte and puts the actual new row after A19', () => {
    const patched = patchEvidenceBlock(specimen, entry('A20'));
    expect(patched).not.toBeNull();
    expect(patched.startsWith(prefix + history)).toBe(true);
    expect(patched.endsWith(suffix)).toBe(true);
    expect(yaml.load(patched)).toEqual({
      ...yaml.load(specimen),
      evidence: [...yaml.load(specimen).evidence, entry('A20')],
    });
  });

  test('upsert replaces the complete real item, not scalar content resembling an item', () => {
    const appended = patchEvidenceBlock(specimen, entry('A20'));
    const patched = patchEvidenceBlock(appended, entry('A20', 'replacement'));
    expect(patched.startsWith(prefix + history)).toBe(true);
    expect(patched.endsWith(suffix)).toBe(true);
    expect(yaml.load(patched).evidence).toEqual([
      yaml.load(specimen).evidence[0],
      entry('A20', 'replacement'),
    ]);
    const replacedHistory = patchEvidenceBlock(appended, entry('A19', 'new history'));
    expect(yaml.load(replacedHistory).evidence).toEqual([
      entry('A19', 'new history'),
      entry('A20'),
    ]);
    expect(replacedHistory.slice(replacedHistory.indexOf('  - criterion_id: A20'))).toBe(
      appended.slice(appended.indexOf('  - criterion_id: A20'))
    );
  });

  test('deletion ignores fake scalar items and removes only the real requested entry', () => {
    expect(deleteEvidenceEntry(specimen, 'FAKE')).toEqual({ bytes: specimen, removed: false });
    const appended = patchEvidenceBlock(specimen, entry('A20'));
    const removed = deleteEvidenceEntry(appended, 'A20');
    expect(removed).toEqual({ bytes: specimen, removed: true });
    const only = deleteEvidenceEntry(specimen, 'A19');
    expect(only.removed).toBe(true);
    expect(yaml.load(only.bytes)).toEqual({ ...yaml.load(specimen), evidence: [] });
    expect(only.bytes.endsWith(suffix)).toBe(true);
    expect(only.bytes).not.toContain('FAKE');
  });

  test.each([
    "'single quoted\n  - criterion_id: FAKE\nwith ''quote'''",
    '"double quoted\\"\n  - criterion_id: FAKE\ncontinued"',
    '|-\n      evidence:\n        - criterion_id: FAKE\n      literal',
    '>-\n      evidence:\n        - criterion_id: FAKE\n      folded',
    '|+\n      keep trailing newlines\n\n\n',
    '>+\n      keep folded trailing newlines\n\n\n',
  ])('append, upsert and delete preserve neighboring scalar %s', (scalar) => {
    const old = `evidence:\n  - status: pass\n    criterion_id: A19\n    recorded_at: "old"\n    evidence_ref: ${scalar}\n`;
    const source = old + suffix;
    const appended = patchEvidenceBlock(source, entry('A20'));
    expect(appended.startsWith(old)).toBe(true);
    expect(yaml.load(appended).evidence).toEqual([...yaml.load(source).evidence, entry('A20')]);
    expect(deleteEvidenceEntry(appended, 'A20').bytes).toBe(source);
    const updated = patchEvidenceBlock(appended, entry('A19'));
    expect(yaml.load(updated).evidence).toEqual([entry('A19'), entry('A20')]);
    expect(updated.endsWith(suffix)).toBe(true);
  });

  test.each(['', 'evidence: [] # keep\n', '"evidence": []\n', 'title: plain\n...\n'])(
    'creates evidence without dropping comments or document markers: %s',
    (body) => {
      const source = body || 'title: plain\n';
      const patched = patchEvidenceBlock(source, entry('A1'));
      expect(patched).not.toBeNull();
      expect(yaml.load(patched)).toEqual({ ...yaml.load(source), evidence: [entry('A1')] });
      if (body.includes('# keep')) expect(patched).toContain('# keep');
      if (body.includes('...')) expect(patched.endsWith('...\n')).toBe(true);
    }
  );

  test.each([0, 2, 4])('preserves sequence indentation %s and CRLF bytes', (indent) => {
    const pad = ' '.repeat(indent);
    const source = `evidence:\r\n${pad}- criterion_id: A1\r\n${pad}  status: pass\r\n${pad}  evidence_ref: old\r\n${pad}  recorded_at: old\r\n# keep\r\n`;
    const patched = patchEvidenceBlock(source, entry('A2'));
    expect(patched.startsWith(source.slice(0, source.indexOf('# keep')))).toBe(true);
    expect(patched).toContain(`${pad}- criterion_id: A2\r\n`);
    expect(yaml.load(patched).evidence).toEqual([...yaml.load(source).evidence, entry('A2')]);
    expect(deleteEvidenceEntry(patched, 'A2').bytes).toBe(source);
  });

  test.each([
    'line one\nline two',
    'colon: value\r\nnext\tline',
    '.inf',
    '~',
    'null',
    'true',
    '123',
    'nul\u0000tab\tend',
    'NEL\u0085LS\u2028PS\u2029end',
  ])('preserves the exact string value %j', (value) => {
    const input = { ...entry('A1', value), command: value, waiver_reason: value };
    expect(yaml.load(patchEvidenceBlock('evidence: []\n', input)).evidence).toEqual([input]);
  });

  test.each([
    'evidence: [{criterion_id: A1, status: pass}]\n',
    'evidence:\n  - {criterion_id: A1, status: pass}\n',
    'evidence: []\nevidence: []\n',
    'evidence: [\n',
    'other: &history []\nevidence: *history\n',
  ])('refuses ambiguous or unsupported edits without guessing: %s', (source) => {
    expect(patchEvidenceBlock(source, entry('A1'))).toBeNull();
    expect(deleteEvidenceEntry(source, 'A1')).toEqual({ bytes: source, removed: false });
  });
});
