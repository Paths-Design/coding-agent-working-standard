/** Legacy byte truncation: uncut input is opaque; cut input drops invalid UTF-8 bytes.
 * Retains valid sequences byte-for-byte, including BOM and literal replacement characters.
 */
export function truncateUtf8Prefix(data: Uint8Array, limit: number): Buffer {
  if (!Number.isSafeInteger(limit) || limit < 0)
    throw new RangeError('byte limit must be a non-negative safe integer');
  if (data.byteLength <= limit) return Buffer.from(data);
  const prefix = data.subarray(0, limit);
  const bytes: number[] = [];
  for (let index = 0; index < prefix.length; ) {
    const first = prefix[index] ?? 0;
    const width =
      first <= 0x7f
        ? 1
        : first >= 0xc2 && first <= 0xdf
          ? 2
          : first >= 0xe0 && first <= 0xef
            ? 3
            : first >= 0xf0 && first <= 0xf4
              ? 4
              : 0;
    let valid = width > 0 && index + width <= prefix.length;
    for (let offset = 1; valid && offset < width; offset++) {
      const next = prefix[index + offset] ?? 0;
      valid = next >= 0x80 && next <= 0xbf;
      if (offset === 1) {
        if (first === 0xe0) valid = valid && next >= 0xa0;
        if (first === 0xed) valid = valid && next <= 0x9f;
        if (first === 0xf0) valid = valid && next >= 0x90;
        if (first === 0xf4) valid = valid && next <= 0x8f;
      }
    }
    if (valid) {
      for (let offset = 0; offset < width; offset++) bytes.push(prefix[index + offset] ?? 0);
      index += width;
    } else index++;
  }
  return Buffer.from(bytes);
}
