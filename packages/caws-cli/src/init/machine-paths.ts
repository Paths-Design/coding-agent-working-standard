import * as fs from 'node:fs';
import * as path from 'node:path';

/** Refuse redirected installation/read paths. The caller may use a resolved
 * temporary root, but no component below that root may be a symlink. */
export function assertMachinePath(root: string, file: string): void {
  const relative = path.relative(root, file);
  if (relative.startsWith('..') || path.isAbsolute(relative))
    throw new Error(`Path escapes root: ${file}`);
  let cursor = root;
  for (const part of ['', ...relative.split(path.sep).filter(Boolean)]) {
    if (part) cursor = path.join(cursor, part);
    try {
      if (fs.lstatSync(cursor).isSymbolicLink()) throw new Error(`Refusing symlink: ${cursor}`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
}
