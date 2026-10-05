import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { assertMachinePath } from './machine-paths';

export interface RuntimePointer {
  version: 1;
  digest: string;
  previous_digest: string | null;
}

export const sha = (bytes: Buffer | string): string =>
  createHash('sha256').update(bytes).digest('hex');
const validDigest = (value: unknown): value is string =>
  typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
export const pointerPath = (home: string): string => path.join(home, 'state/adapter-runtime.json');

export function readPointer(home: string): RuntimePointer | null {
  const file = pointerPath(home);
  assertMachinePath(home, file);
  if (!fs.existsSync(file)) return null;
  const value = JSON.parse(fs.readFileSync(file, 'utf8')) as RuntimePointer;
  if (
    !value ||
    typeof value !== 'object' ||
    value.version !== 1 ||
    !validDigest(value.digest) ||
    (value.previous_digest !== null && !validDigest(value.previous_digest))
  ) {
    throw new Error('Malformed machine adapter runtime pointer');
  }
  return value;
}

export function readManifest(home: string, digest: string): Record<string, string> {
  if (!validDigest(digest)) throw new Error('Invalid runtime digest');
  const root = path.join(home, 'lib/runtimes', digest);
  assertMachinePath(home, path.join(root, 'manifest.json'));
  const manifest = fs.readFileSync(path.join(root, 'manifest.json'), 'utf8');
  if (sha(manifest) !== digest) throw new Error(`Runtime manifest integrity failure: ${digest}`);
  const files = JSON.parse(manifest) as Record<string, string>;
  if (
    !files ||
    typeof files !== 'object' ||
    Array.isArray(files) ||
    !validDigest(files['launcher.py'])
  )
    throw new Error('Malformed machine runtime manifest');
  return files;
}

export function verifyRuntime(home: string, digest: string): Record<string, string> {
  const files = readManifest(home, digest);
  const root = path.join(home, 'lib/runtimes', digest);
  for (const [relative, expected] of Object.entries(files)) {
    const file = path.join(root, relative);
    assertMachinePath(root, file);
    if (!validDigest(expected) || sha(fs.readFileSync(file)) !== expected) {
      throw new Error(
        `Machine runtime file modified: ${relative}; preserve and reconcile local growth before updating`
      );
    }
  }
  return files;
}
