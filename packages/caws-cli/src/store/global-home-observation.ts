import * as fs from 'node:fs';
import * as path from 'node:path';
import { assertMachinePath } from '../init/machine-paths';
import { pointerPath, readPointer, verifyRuntime } from '../init/machine-runtime-state';
import type { GlobalHomeObservation } from '../kernel/doctor/types';

/** Observe only: no installation, native configuration, or state repair. */
export function observeGlobalHome(root: string): GlobalHomeObservation {
  let entries: string[];
  try {
    if (!path.isAbsolute(root))
      throw Object.assign(new Error('CAWS_HOME must be an absolute path'), { code: 'EINVAL' });
    assertMachinePath(root, root);
    entries = fs.readdirSync(root).sort();
  } catch (error) {
    const failure = error as NodeJS.ErrnoException;
    if (failure.code === 'ENOENT') return { kind: 'absent', root };
    return {
      kind: 'unreadable',
      root,
      error: { code: failure.code || 'READ_ERROR', message: failure.message },
    };
  }

  // existsSync hides read failures. Stat explicitly so an inaccessible state
  // directory cannot masquerade as an uninitialized installation.
  const hasFile = (file: string): boolean => {
    assertMachinePath(root, file);
    try {
      if (!fs.statSync(file).isFile()) throw new Error(`Expected a file: ${file}`);
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
      throw error;
    }
  };
  let stampPresent: boolean;
  try {
    stampPresent = hasFile(path.join(root, 'state/global-home.json'));
  } catch (error) {
    const failure = error as NodeJS.ErrnoException;
    return {
      kind: 'unreadable',
      root,
      error: { code: failure.code || 'READ_ERROR', message: failure.message },
    };
  }

  let runtime: Extract<GlobalHomeObservation, { kind: 'present' }>['runtime'];
  try {
    if (!hasFile(pointerPath(root))) runtime = { status: 'absent' };
    else {
      const pointer = readPointer(root);
      if (!pointer) throw new Error('Runtime pointer disappeared during observation');
      const files = verifyRuntime(root, pointer.digest);
      if (!files['system-policy.json'] || !files['session_log_renderer.py'])
        throw new Error('Runtime lacks system guards and renderers');
      runtime = { status: 'verified', digest: pointer.digest };
    }
  } catch (error) {
    runtime = { status: 'invalid', error: (error as Error).message };
  }
  return { kind: 'present', root, entries, stampPresent, runtime };
}
