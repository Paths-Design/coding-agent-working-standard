const { truncateUtf8Prefix } = require('../../dist/runtime/utf8');
describe('UTF-8 advisory byte budgets', () => {
  test('returns the longest complete prefix for every multibyte boundary', () => {
    const data = Buffer.from('Aé€😀Z');
    const expected = [
      '',
      'A',
      'A',
      'Aé',
      'Aé',
      'Aé',
      'Aé€',
      'Aé€',
      'Aé€',
      'Aé€',
      'Aé€😀',
      'Aé€😀Z',
    ];
    expected.forEach((value, limit) =>
      expect(truncateUtf8Prefix(data, limit)).toEqual(Buffer.from(value))
    );
  });
  test('preserves opaque uncut invalid bytes but ignores malformed cut sequences', () => {
    const data = Buffer.from([0x61, 0xff, 0xc0, 0xaf, 0x62, 0xe2, 0x82]);
    expect(truncateUtf8Prefix(data, 7)).toEqual(data);
    expect(truncateUtf8Prefix(data, 99)).toEqual(data);
    expect(truncateUtf8Prefix(data, 6)).toEqual(Buffer.from('ab'));
    expect(
      truncateUtf8Prefix(Buffer.from([0xed, 0xa0, 0x80, 0xf4, 0x90, 0x80, 0x80, 0x41, 0x42]), 8)
    ).toEqual(Buffer.from('A'));
  });
  test('preserves BOM and literal replacement characters as original bytes', () => {
    const data = Buffer.from('\ufeff�x');
    expect(truncateUtf8Prefix(data, 6)).toEqual(data.subarray(0, 6));
  });
  test('handles empty input and rejects invalid byte budgets', () => {
    expect(truncateUtf8Prefix(Buffer.alloc(0), 0)).toEqual(Buffer.alloc(0));
    expect(truncateUtf8Prefix(Buffer.from('x'), 0)).toEqual(Buffer.alloc(0));
    for (const limit of [-1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
      expect(() => truncateUtf8Prefix(Buffer.from('x'), limit)).toThrow(RangeError);
    }
  });
});
