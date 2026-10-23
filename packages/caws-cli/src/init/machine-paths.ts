import { liveSelectionReadIo, type SelectionReadIo } from './selection-read-io';
import * as path from 'node:path';

/** Refuse redirected installation/read paths. The caller may use a resolved
 * temporary root, but no component below that root may be a symlink. */
export function assertMachinePath(
  root: string,
  file: string,
  io: SelectionReadIo = liveSelectionReadIo
): void {
  const relative = path.relative(root, file);
  if (relative.startsWith('..') || path.isAbsolute(relative))
    throw new Error(`Path escapes root: ${file}`);
  let cursor = root;
  for (const part of ['', ...relative.split(path.sep).filter(Boolean)]) {
    if (part) cursor = path.join(cursor, part);
    try {
      if (io.lstat(cursor).kind === 'symlink') throw new Error(`Refusing symlink: ${cursor}`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
}
