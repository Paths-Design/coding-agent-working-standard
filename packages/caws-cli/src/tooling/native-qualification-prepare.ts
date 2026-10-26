import { createHash } from 'node:crypto';

/** Object identities are storage-format identities, never revision expressions. */
export type PreparationObjectFormat = 'sha1' | 'sha256';
export type PreparationObjectKind = 'commit' | 'tree' | 'blob';
export interface PreparationObjectSelection {
  oid: string;
  kind: PreparationObjectKind;
}
export interface PreparationGitObject extends PreparationObjectSelection {
  bytes: Buffer;
}
export interface PreparationTreeEntry {
  name: string;
  oid: string;
  mode: '40000' | '100644' | '100755';
}
export interface PreparationExportFile {
  relativePath: string;
  oid: string;
  mode: '100644' | '100755';
  bytes: Buffer;
}
export interface PreparationExportPlan {
  commit: string;
  tree: string;
  directories: string[];
  files: PreparationExportFile[];
}

const MAX_OBJECT_BYTES = 16 * 1024 * 1024;
const MAX_BATCH_BYTES = 512 * 1024 * 1024;
const MAX_OBJECTS = 50000;

function requireCondition(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message);
}

function oidWidth(format: PreparationObjectFormat): number {
  requireCondition(format === 'sha1' || format === 'sha256', 'Unsupported Git object format');
  return format === 'sha1' ? 40 : 64;
}

function requireOid(oid: string, format: PreparationObjectFormat): void {
  requireCondition(
    typeof oid === 'string' && oid.length === oidWidth(format) && /^[0-9a-f]+$/.test(oid),
    'Expected a full lowercase Git object identity'
  );
}

/**
 * Decode fixed cat-file --batch output. Every returned byte belongs to an
 * explicitly selected, independently rehashed object; surplus output refuses.
 * This establishes object identity, not permission to export or write it.
 */
export function decodePreparationGitBatch(
  output: Buffer,
  selections: readonly PreparationObjectSelection[],
  format: PreparationObjectFormat
): PreparationGitObject[] {
  oidWidth(format);
  requireCondition(
    Buffer.isBuffer(output) && output.length <= MAX_BATCH_BYTES,
    'Git batch exceeds bound'
  );
  requireCondition(
    Array.isArray(selections) && selections.length > 0 && selections.length <= MAX_OBJECTS,
    'Invalid Git object selection count'
  );
  let offset = 0;
  const result: PreparationGitObject[] = [];
  for (const selection of selections) {
    requireOid(selection.oid, format);
    requireCondition(
      selection.kind === 'commit' || selection.kind === 'tree' || selection.kind === 'blob',
      'Unsupported Git object kind'
    );
    const end = output.indexOf(10, offset);
    requireCondition(end >= offset && end - offset <= 128, 'Missing or oversized Git batch header');
    const header = output.subarray(offset, end).toString('utf8');
    const match = /^([0-9a-f]+) (commit|tree|blob) (0|[1-9][0-9]*)$/.exec(header);
    requireCondition(match, 'Malformed or missing Git batch object');
    requireCondition(
      match[1] === selection.oid && match[2] === selection.kind,
      'Git batch selection mismatch'
    );
    const size = Number(match[3]);
    requireCondition(
      Number.isSafeInteger(size) && size <= MAX_OBJECT_BYTES,
      'Git object exceeds bound'
    );
    offset = end + 1;
    requireCondition(
      offset + size < output.length && output[offset + size] === 10,
      'Truncated Git object'
    );
    const bytes = Buffer.from(output.subarray(offset, offset + size));
    const actual = createHash(format)
      .update(Buffer.from(`${selection.kind} ${size}\0`, 'ascii'))
      .update(bytes)
      .digest('hex');
    requireCondition(actual === selection.oid, 'Git object content identity mismatch');
    result.push({ oid: selection.oid, kind: selection.kind, bytes });
    offset += size + 1;
  }
  requireCondition(offset === output.length, 'Surplus Git batch output');
  return result;
}

/** Extract the sole root tree header without interpreting commit messages. */
export function preparationCommitTree(bytes: Buffer, format: PreparationObjectFormat): string {
  oidWidth(format);
  requireCondition(
    Buffer.isBuffer(bytes) && bytes.length <= MAX_OBJECT_BYTES,
    'Commit exceeds bound'
  );
  const headerEnd = bytes.indexOf(Buffer.from('\n\n'));
  requireCondition(headerEnd >= 0, 'Commit header terminator missing');
  const header = bytes.subarray(0, headerEnd).toString('utf8');
  requireCondition(!header.includes('\0') && !header.includes('\r'), 'Malformed commit headers');
  const lines = header.split('\n');
  const treeLines = lines.filter((line) => line.startsWith('tree '));
  requireCondition(
    lines[0]?.startsWith('tree ') && treeLines.length === 1,
    'Commit must select one root tree'
  );
  const tree = treeLines[0]!.slice(5);
  requireOid(tree, format);
  return tree;
}

/**
 * Qualification accepts portable ASCII names and regular source files only.
 * The closed domain avoids filesystem case/normalization aliases. Links and
 * submodules require a different explicit contract; no generic following.
 */
export function decodePreparationGitTree(
  bytes: Buffer,
  format: PreparationObjectFormat
): PreparationTreeEntry[] {
  const objectBytes = oidWidth(format) / 2;
  requireCondition(
    Buffer.isBuffer(bytes) && bytes.length <= MAX_OBJECT_BYTES,
    'Tree exceeds bound'
  );
  const entries: PreparationTreeEntry[] = [];
  const names = new Set<string>();
  let offset = 0;
  while (offset < bytes.length) {
    requireCondition(entries.length < MAX_OBJECTS, 'Tree entry count exceeds bound');
    const space = bytes.indexOf(32, offset);
    const nul = bytes.indexOf(0, offset);
    requireCondition(
      space > offset && nul > space && space - offset <= 6,
      'Malformed Git tree record'
    );
    const mode = bytes.subarray(offset, space).toString('utf8');
    requireCondition(
      mode === '40000' || mode === '100644' || mode === '100755',
      'Unsupported source mode'
    );
    const rawName = bytes.subarray(space + 1, nul);
    requireCondition(
      rawName.length > 0 &&
        rawName.length <= 255 &&
        rawName.every((byte) => byte >= 32 && byte <= 126),
      'Unsupported source name'
    );
    const name = rawName.toString('ascii');
    requireCondition(
      name !== '.' && name !== '..' && name.toLowerCase() !== '.git' && !/[\\/]/.test(name),
      'Unsafe source name'
    );
    const folded = name.toLowerCase();
    requireCondition(!names.has(folded), 'Duplicate or case-colliding source name');
    names.add(folded);
    requireCondition(nul + 1 + objectBytes <= bytes.length, 'Truncated Git tree identity');
    entries.push({
      name,
      mode,
      oid: bytes.subarray(nul + 1, nul + 1 + objectBytes).toString('hex'),
    });
    offset = nul + 1 + objectBytes;
  }
  return entries;
}

/**
 * Derive a complete source inventory from the selected object's closed graph.
 * An inventory is data only: this function grants no filesystem write authority.
 */
export function planPreparationGitExport(
  objects: readonly PreparationGitObject[],
  commit: string,
  tree: string,
  format: PreparationObjectFormat
): PreparationExportPlan {
  requireOid(commit, format);
  requireOid(tree, format);
  requireCondition(
    Array.isArray(objects) && objects.length <= MAX_OBJECTS,
    'Object graph exceeds bound'
  );
  const index = new Map<string, PreparationGitObject>();
  let objectBytes = 0;
  for (const object of objects) {
    requireOid(object.oid, format);
    requireCondition(
      object.kind === 'commit' || object.kind === 'tree' || object.kind === 'blob',
      'Unsupported Git object kind'
    );
    requireCondition(
      Buffer.isBuffer(object.bytes) && object.bytes.length <= MAX_OBJECT_BYTES,
      'Git object exceeds bound'
    );
    objectBytes += object.bytes.length;
    requireCondition(objectBytes <= MAX_BATCH_BYTES, 'Object graph bytes exceed bound');
    requireCondition(!index.has(object.oid), 'Duplicate object graph member');
    const bytes = Buffer.from(object.bytes);
    const oid = createHash(format)
      .update(`${object.kind} ${bytes.length}\0`)
      .update(bytes)
      .digest('hex');
    requireCondition(oid === object.oid, 'Git object content identity mismatch');
    index.set(oid, { oid, kind: object.kind, bytes });
  }
  const used = new Set<string>();
  const get = (oid: string, kind: PreparationObjectKind): PreparationGitObject => {
    const object = index.get(oid);
    requireCondition(object && object.kind === kind, 'Missing object or incorrect graph edge type');
    used.add(oid);
    return object;
  };
  requireCondition(
    preparationCommitTree(get(commit, 'commit').bytes, format) === tree,
    'Pinned root tree mismatch'
  );
  const directories: string[] = [];
  const files: PreparationExportFile[] = [];
  let materializedBytes = 0;
  let entries = 0;
  const walk = (oid: string, prefix: string, depth: number): void => {
    requireCondition(depth <= 64, 'Source tree depth exceeds bound');
    for (const entry of decodePreparationGitTree(get(oid, 'tree').bytes, format)) {
      const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
      requireCondition(
        relativePath.length <= 4096 && ++entries <= MAX_OBJECTS,
        'Source path inventory exceeds bound'
      );
      if (entry.mode === '40000') {
        directories.push(relativePath);
        walk(entry.oid, relativePath, depth + 1);
      } else {
        const bytes = get(entry.oid, 'blob').bytes;
        materializedBytes += bytes.length;
        requireCondition(
          materializedBytes <= MAX_BATCH_BYTES,
          'Materialized source bytes exceed bound'
        );
        files.push({ relativePath, mode: entry.mode, oid: entry.oid, bytes: Buffer.from(bytes) });
      }
    }
  };
  walk(tree, '', 0);
  requireCondition(used.size === index.size, 'Unreachable object graph member');
  directories.sort();
  files.sort((a, b) =>
    a.relativePath < b.relativePath ? -1 : a.relativePath > b.relativePath ? 1 : 0
  );
  return { commit, tree, directories, files };
}
