const { createHash } = require('node:crypto');
const vm = require('node:vm');
const { inspectBsdAr, ArInspectionError } = require('../../dist/tooling/ar-archive');

const MAGIC = Buffer.from('!<arch>\n');
const LIMITS = {
  maxArchiveBytes: 4096,
  maxMembers: 16,
  maxMemberBytes: 2048,
  maxNameBytes: 256,
};
const RUST_NAME = 'libsqlite3_sys-760be48e267b1f35.libsqlite3_sys.ee723f08def17230-cgu.0.rcgu.o';

function hash(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

// Structural framing fixtures contain local literal payloads, not SQLite objects.
function member(name, payload = Buffer.from('local'), nameSize = Buffer.byteLength(name)) {
  const rawName = Buffer.alloc(nameSize);
  Buffer.from(name).copy(rawName);
  const body = Buffer.concat([rawName, payload]);
  const header = Buffer.from(
    `#1/${nameSize}`.padEnd(16) +
      '0'.padEnd(12) +
      '0'.padEnd(6) +
      '0'.padEnd(6) +
      '644'.padEnd(8) +
      String(body.length).padEnd(10) +
      '`\n'
  );
  return Buffer.concat([header, body, ...(body.length % 2 ? [Buffer.from('\n')] : [])]);
}
function archive(...parts) {
  return Buffer.concat([MAGIC, ...parts]);
}
function field(bytes, start, width, value) {
  const result = Buffer.from(bytes);
  result.fill(0x20, 8 + start, 8 + start + width);
  Buffer.from(value).copy(result, 8 + start);
  return result;
}
function reject(bytes, code, offset, limits = LIMITS) {
  let error;
  try {
    inspectBsdAr(bytes, limits);
  } catch (caught) {
    error = caught;
  }
  expect(error).toBeInstanceOf(ArInspectionError);
  expect(error).toMatchObject({ name: 'ArInspectionError', code, offset });
}

describe('bounded BSD archive inventory', () => {
  test('preserves exact ordered ranges, bytes, hashes and ordinary metadata', () => {
    const payload = Buffer.from([0, 255, 1]);
    const first = member('__.SYMDEF', payload, 12); // 15 stored bytes, one pad.
    const second = member('sqlite3.o', Buffer.from('AB'), 12);
    const bytes = archive(first, second);
    const inventory = inspectBsdAr(bytes, LIMITS);
    expect(inventory.format).toBe('bsd-extended-ar/1');
    expect(inventory.archive).toEqual({
      offset: 0,
      sizeBytes: bytes.length,
      sha256: hash(bytes),
    });
    expect(
      inventory.members.map((item) => ({
        index: item.index,
        name: item.name,
        stored: item.storedSizeBytes,
      }))
    ).toEqual([
      { index: 0, name: '__.SYMDEF', stored: 15 },
      { index: 1, name: 'sqlite3.o', stored: 14 },
    ]);
    expect(inventory.members[0].header.offset).toBe(8);
    expect(inventory.members[0].rawName.offset).toBe(68);
    expect(inventory.members[0].payload).toEqual({
      offset: 80,
      sizeBytes: 3,
      sha256: hash(payload),
    });
    expect(inventory.members[0].alignment).toEqual({
      offset: 83,
      sizeBytes: 1,
      sha256: hash(Buffer.from('\n')),
    });
    expect(inventory.members[1].header.offset).toBe(84);
    expect(inventory.members[1].payload.offset).toBe(156);
    expect(inventory.members[1].alignment.sizeBytes).toBe(0);
    for (const item of inventory.members) {
      for (const part of ['header', 'rawName', 'payload', 'alignment']) {
        const range = item[part];
        const expected = bytes.subarray(range.offset, range.offset + range.sizeBytes);
        expect(Buffer.from(inventory.copyBytes(item.index, part))).toEqual(expected);
        expect(range.sha256).toBe(hash(expected));
      }
    }
    expect(Object.isFrozen(inventory)).toBe(true);
    expect(Object.isFrozen(inventory.archive)).toBe(true);
    expect(Object.isFrozen(inventory.members)).toBe(true);
    expect(Object.isFrozen(inventory.members[0])).toBe(true);
    expect(Object.isFrozen(inventory.members[0].payload)).toBe(true);
  });

  test('accepts the exact 76-byte unterminated Rust name without classifying it', () => {
    expect(Buffer.byteLength(RUST_NAME)).toBe(76);
    const inventory = inspectBsdAr(archive(member(RUST_NAME)), LIMITS);
    expect(inventory.members[0].name).toBe(RUST_NAME);
    expect(inventory.members[0].rawName.sizeBytes).toBe(76);
    expect(Buffer.from(inventory.copyBytes(0, 'rawName'))).toEqual(Buffer.from(RUST_NAME));
    expect(Object.keys(inventory.members[0]).sort()).toEqual([
      'alignment',
      'header',
      'index',
      'name',
      'payload',
      'rawName',
      'storedSizeBytes',
    ]);
  });

  test('accepts empty archives, empty payloads and identical payloads under distinct names', () => {
    expect(inspectBsdAr(MAGIC, { ...LIMITS, maxMembers: 0 }).members).toEqual([]);
    const inventory = inspectBsdAr(
      archive(member('a', Buffer.alloc(0)), member('b', Buffer.alloc(0))),
      LIMITS
    );
    expect(inventory.members.map((item) => item.payload.sizeBytes)).toEqual([0, 0]);
    expect(inventory.members[0].payload.sha256).toBe(hash(Buffer.alloc(0)));
    expect(inventory.members[1].payload.sha256).toBe(inventory.members[0].payload.sha256);
  });

  test('owns the selected input view and returns copy-only byte access', () => {
    const original = archive(member('x', Buffer.from('payload')));
    const backing = Buffer.concat([Buffer.from('PREFIX'), original, Buffer.from('SUFFIX')]);
    const view = backing.subarray(6, 6 + original.length);
    const inventory = inspectBsdAr(view, LIMITS);
    const before = JSON.stringify(inventory);
    backing.fill(0);
    for (const part of ['header', 'rawName', 'payload', 'alignment']) {
      const first = inventory.copyBytes(0, part);
      const expected = Buffer.from(first);
      first.fill(255);
      expect(Buffer.from(inventory.copyBytes(0, part))).toEqual(expected);
    }
    expect(inventory.archive.sha256).toBe(hash(original));
    expect(JSON.stringify(inventory)).toBe(before);
    expect(Buffer.from(inventory.copyBytes(0, 'payload'))).toEqual(Buffer.from('payload'));
    const first = inventory.copyBytes(0, 'payload');
    const second = inventory.copyBytes(0, 'payload');
    expect(first.buffer).not.toBe(second.buffer);
    expect(first.byteOffset).toBe(0);
    expect(first.buffer.byteLength).toBe(first.byteLength);
    new Uint8Array(first.buffer).fill(0);
    expect(Buffer.from(second).toString('utf8')).toBe('payload');
    expect(Buffer.from(inventory.copyBytes(0, 'payload')).toString('utf8')).toBe('payload');
  });

  test('uses intrinsic view coordinates instead of subclass properties', () => {
    class SpoofedView extends Uint8Array {
      get buffer() {
        return new ArrayBuffer(0);
      }
      get byteOffset() {
        return 999;
      }
      get byteLength() {
        return 0;
      }
    }
    const raw = archive(member('x'));
    const view = new SpoofedView(raw.length + 4);
    view.set(raw, 2);
    const selected = new SpoofedView(
      Object.getOwnPropertyDescriptor(
        Object.getPrototypeOf(Uint8Array.prototype),
        'buffer'
      ).get.call(view),
      2,
      raw.length
    );
    expect(inspectBsdAr(selected, LIMITS).archive.sha256).toBe(hash(raw));
    const shared = new SpoofedView(new SharedArrayBuffer(128));
    reject(shared, 'shared_input', 0);
  });

  test('refuses shared backing across realms and invalid input types', () => {
    reject(new Uint8Array(new SharedArrayBuffer(8)), 'shared_input', 0);
    reject(vm.runInNewContext('new Uint8Array(new SharedArrayBuffer(8))'), 'shared_input', 0);
    for (const value of [null, undefined, [], 'bytes', new ArrayBuffer(8), new Uint16Array(8)])
      reject(value, 'invalid_input', 0);
  });

  test.each([
    ['header', -1],
    ['payload', 1],
    ['rawName', 0.5],
    ['alignment', NaN],
    ['payload', Number.MAX_SAFE_INTEGER + 1],
    ['payload', '0'],
  ])('refuses invalid accessor index for %s: %s', (part, index) => {
    const inventory = inspectBsdAr(archive(member('x')), LIMITS);
    expect(() => inventory.copyBytes(index, part)).toThrow(ArInspectionError);
  });

  test('refuses unknown accessor parts', () => {
    const inventory = inspectBsdAr(archive(member('x')), LIMITS);
    expect(() => inventory.copyBytes(0, '__proto__')).toThrow(ArInspectionError);
    expect(() => inventory.copyBytes(0, undefined)).toThrow(ArInspectionError);
  });
});

describe('hostile archive framing', () => {
  const valid = archive(member('x', Buffer.from('AB'), 2));

  test.each(['', '!<arch>', '!<arch>\r', '!<arch>\0'])('rejects bad magic %j', (value) => {
    reject(Buffer.from(value), 'invalid_magic', 0);
  });
  test('rejects thin archives explicitly', () => {
    reject(Buffer.from('!<thin>\n'), 'unsupported_format', 0);
  });
  test('requires a complete header and exact end consumption', () => {
    reject(Buffer.concat([MAGIC, Buffer.alloc(59)]), 'truncated_header', 8);
    reject(Buffer.concat([valid, Buffer.from('x')]), 'truncated_header', valid.length);
  });
  test.each([58, 59])('rejects changed trailer byte %i', (position) => {
    const bytes = Buffer.from(valid);
    bytes[8 + position] = 0;
    reject(bytes, 'invalid_trailer', 66);
  });
  test.each(['', '-1', '+1', '1e2', '1.5', ' 4', '4 0'])('rejects nondecimal size %j', (value) => {
    reject(field(valid, 48, 10, value), 'invalid_size', 56);
  });
  test('bounds maximum-width decimal size before slicing', () => {
    reject(field(valid, 48, 10, '9999999999'), 'truncated_member', 68, {
      ...LIMITS,
      maxMemberBytes: Number.MAX_SAFE_INTEGER,
    });
  });
  test('refuses a truncated payload', () => {
    reject(valid.subarray(0, valid.length - 1), 'truncated_member', 68);
  });
  test.each(['/', '//', '/123', '/SYM64/', 'sqlite3.o/', '#1/x', '#1/-1', '#1/1e2'])(
    'refuses unsupported name form %s',
    (value) => reject(field(valid, 0, 16, value), 'unsupported_name_form', 8)
  );
  test.each(['#1/0', '#1/9999999999999'])('rejects impossible BSD name size %s', (value) => {
    reject(field(valid, 0, 16, value), 'invalid_name_size', 8);
  });
  test.each([0, 0x1f, 0x7f, 0xff])('rejects invalid name byte %i', (value) => {
    const bytes = Buffer.from(valid);
    bytes[68] = value;
    reject(bytes, 'invalid_name', 68);
  });
  test('refuses non-NUL data after name padding starts', () => {
    const bytes = archive(member('abc', Buffer.alloc(0), 4));
    bytes[69] = 0;
    reject(bytes, 'invalid_name', 68);
  });
  test('refuses duplicate names despite different NUL padding', () => {
    const first = member('same', Buffer.from('a'), 4);
    reject(
      archive(first, member('same', Buffer.from('b'), 12)),
      'duplicate_name',
      8 + first.length + 60
    );
  });
  test('does not exempt duplicate symbol metadata', () => {
    const first = member('__.SYMDEF', Buffer.alloc(0), 12);
    reject(
      archive(first, member('__.SYMDEF', Buffer.from('other'), 20)),
      'duplicate_name',
      8 + first.length + 60
    );
  });
  test('requires newline padding for odd stored size', () => {
    const odd = archive(member('x', Buffer.from('AB'))); // Three stored bytes.
    reject(odd.subarray(0, odd.length - 1), 'invalid_alignment', odd.length - 1);
    const changed = Buffer.from(odd);
    changed[changed.length - 1] = 0;
    reject(changed, 'invalid_alignment', changed.length - 1);
  });
  test.each([
    [16, 12, '-1'],
    [28, 6, ''],
    [34, 6, 'x'],
    [40, 8, '888'],
  ])('validates numeric metadata at %i', (start, width, value) => {
    reject(field(valid, start, width, value), 'invalid_header', 8 + start);
  });
  test.each([0, 16, 28, 34, 40, 48])('rejects non-ASCII header field at %i', (start) => {
    const bytes = Buffer.from(valid);
    bytes[8 + start] = 0xff;
    reject(bytes, 'invalid_header', 8 + start);
  });

  test.each(Object.keys(LIMITS))('requires a safe nonnegative %s', (key) => {
    for (const value of [
      undefined,
      null,
      '10',
      -1,
      0.5,
      NaN,
      Infinity,
      Number.MAX_SAFE_INTEGER + 1,
    ])
      reject(valid, 'invalid_limit', 0, { ...LIMITS, [key]: value });
  });
  test('refuses absent limits', () => {
    expect(() => inspectBsdAr(valid, undefined)).toThrow(ArInspectionError);
  });
  test('enforces all budgets at their exact boundaries', () => {
    const exact = {
      maxArchiveBytes: valid.length,
      maxMembers: 1,
      maxMemberBytes: 4,
      maxNameBytes: 2,
    };
    expect(inspectBsdAr(valid, exact).members[0].name).toBe('x');
    reject(valid, 'archive_limit', 0, { ...exact, maxArchiveBytes: valid.length - 1 });
    reject(valid, 'member_count_limit', 8, { ...exact, maxMembers: 0 });
    reject(valid, 'member_byte_limit', 8, { ...exact, maxMemberBytes: 3 });
    reject(valid, 'name_byte_limit', 68, { ...exact, maxNameBytes: 1 });
  });
  test('enforces count bounds even with empty payloads', () => {
    const first = member('a', Buffer.alloc(0));
    reject(archive(first, member('b', Buffer.alloc(0))), 'member_count_limit', 8 + first.length, {
      ...LIMITS,
      maxMembers: 1,
    });
  });
});

test('returned ArrayBuffer cannot mutate the retained private snapshot', () => {
  // Isolate backing-store corruption so a failing implementation cannot alter
  // unrelated Jest buffers in the parent process.
  const source = String.raw`
    const { inspectBsdAr } = require(process.argv[1]);
    const name = Buffer.from([120, 0]);
    const payload = Buffer.from('PAYLOAD');
    const header = Buffer.from('#1/2'.padEnd(16) + '0'.padEnd(12) +
      '0'.padEnd(6) + '0'.padEnd(6) + '644'.padEnd(8) +
      '9'.padEnd(10) + String.fromCharCode(96, 10));
    const raw = Buffer.concat([Buffer.from('!<arch>\n'), header, name, payload, Buffer.from('\n')]);
    const input = Buffer.allocUnsafeSlow(raw.length);
    raw.copy(input);
    const result = inspectBsdAr(input, { maxArchiveBytes: 1024, maxMembers: 1, maxMemberBytes: 64, maxNameBytes: 8 });
    const exposed = result.copyBytes(0, 'payload');
    new Uint8Array(exposed.buffer).fill(0);
    process.stdout.write(Buffer.from(result.copyBytes(0, 'payload')).toString('hex'));
  `;
  const result = require('node:child_process').spawnSync(
    process.execPath,
    ['-e', source, require.resolve('../../dist/tooling/ar-archive')],
    { encoding: 'utf8', timeout: 5000 }
  );
  expect(result.error).toBeUndefined();
  expect(result.signal).toBeNull();
  expect(result.status).toBe(0);
  expect(result.stderr).toBe('');
  expect(result.stdout).toBe('5041594c4f4144');
});
