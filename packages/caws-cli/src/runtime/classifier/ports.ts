import { spawnSync } from 'node:child_process';
import { lstatSync, readFileSync, readlinkSync, statSync, unlinkSync } from 'node:fs';
import { dirname, join, isAbsolute } from 'node:path';
import { TextDecoder } from 'node:util';
import type { ClassifierPorts } from './types';
import { resolveGitBinaryForEnvironment } from '../../store/git-binary';

/** Resolve the existing ancestor before appending absent leaves, matching Python strict=False. */
export function resolveExistingPrefix(path: string): string {
  if (!isAbsolute(path)) throw new TypeError('classifier paths must be absolute');
  let current = '/';
  const pending = path.split('/');
  let followed = 0;
  while (pending.length) {
    const component = pending.shift() ?? '';
    if (!component || component === '.') continue;
    if (component === '..') {
      current = dirname(current);
      continue;
    }
    const candidate = join(current, component);
    let symbolic = false;
    try {
      symbolic = lstatSync(candidate).isSymbolicLink();
    } catch (error) {
      if (
        (error as NodeJS.ErrnoException).code !== 'ENOENT' &&
        (error as NodeJS.ErrnoException).code !== 'ENOTDIR'
      )
        throw error;
    }
    if (symbolic) {
      if (++followed > 40) throw new Error('symbolic link resolution budget exceeded');
      const target = readlinkSync(candidate);
      if (isAbsolute(target)) current = '/';
      pending.unshift(...target.split('/'));
    } else current = candidate;
  }
  return current;
}

export function createClassifierPorts(
  environment: Readonly<Record<string, string>>,
  deadlineUnixMs?: number
): ClassifierPorts {
  const snapshot = { ...environment, GIT_OPTIONAL_LOCKS: '0' };
  return {
    git(args, cwd) {
      const remaining =
        deadlineUnixMs === undefined ? 5000 : Math.min(5000, deadlineUnixMs - Date.now());
      if (remaining <= 0) return { status: -1, stdout: '' };
      const binary = resolveGitBinaryForEnvironment(snapshot, cwd);
      if (binary === undefined) return { status: -1, stdout: '' };
      const result = spawnSync(binary, [...args], {
        cwd,
        encoding: 'utf8',
        timeout: remaining,
        maxBuffer: 8 * 1024 * 1024,
        env: snapshot,
      });
      return { status: result.status ?? -1, stdout: result.stdout ?? '' };
    },
    read(path) {
      let bytes: Buffer;
      try {
        bytes = readFileSync(path);
      } catch {
        return null;
      }
      // Preserve a BOM for the JSON parser to reject; never substitute invalid bytes.
      return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
    },
    isFile(path) {
      try {
        return statSync(path).isFile();
      } catch {
        return false;
      }
    },
    realpath: resolveExistingPrefix,
    consumeFile(path) {
      try {
        if (!statSync(path).isFile()) return false;
        unlinkSync(path);
        return true;
      } catch {
        return false;
      }
    },
  };
}
