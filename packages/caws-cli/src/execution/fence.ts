import * as fs from 'node:fs';
import { join } from 'node:path';
import { TextDecoder } from 'node:util';
import { parseJsonSource } from '../runtime/json-custody';
import type { FenceObservation } from './prepared';

/** Same-PID-namespace local worker protocol only. Unsupported namespaces or
 * inaccessible canonical paths refuse; no guessed owner, relock or release.
 * The Rust parent retains its own descriptor through the actual USER spawn.
 */
export function verifyInheritedFence(cawsDir: string, expected: FenceObservation, fd = 3): boolean {
  try {
    const observed = fs.fstatSync(fd, { bigint: true });
    const pathname = fs.lstatSync(join(cawsDir, 'state.lock'), { bigint: true });
    if (
      !observed.isFile() ||
      !pathname.isFile() ||
      observed.size > 4096n ||
      observed.size === 0n ||
      observed.nlink !== 1n ||
      observed.dev !== pathname.dev ||
      observed.ino !== pathname.ino ||
      observed.dev.toString() !== expected.dev ||
      observed.ino.toString() !== expected.ino
    )
      return false;
    const buffer = Buffer.alloc(4097);
    let count = 0;
    while (count < buffer.length) {
      const read = fs.readSync(fd, buffer, count, buffer.length - count, count);
      if (read === 0) break;
      count += read;
    }
    if (count === 0 || count > 4096 || BigInt(count) !== observed.size) return false;
    const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(
      buffer.subarray(0, count)
    );
    parseJsonSource(text, 2, 16, true);
    const value: unknown = JSON.parse(text);
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
    const row = value as Record<string, unknown>;
    const keys = ['pid', 'at', 'purpose', 'nonce', 'protocol'];
    if (Object.keys(row).length !== keys.length || !keys.every((key) => Object.hasOwn(row, key)))
      return false;
    if (
      row.pid !== process.ppid ||
      !Number.isSafeInteger(row.pid) ||
      (row.pid as number) <= 0 ||
      row.purpose !== 'execution-launch' ||
      row.protocol !== 'caws.execution.fence.v1' ||
      row.nonce !== expected.nonce ||
      typeof row.at !== 'string' ||
      !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(row.at) ||
      !Number.isFinite(Date.parse(row.at))
    )
      return false;
    // Reobserve after the bounded read; never trust only a pre-read pathname.
    const final = fs.fstatSync(fd, { bigint: true });
    const finalPath = fs.lstatSync(join(cawsDir, 'state.lock'), { bigint: true });
    return (
      final.dev === observed.dev &&
      final.ino === observed.ino &&
      final.size === observed.size &&
      final.mtimeNs === observed.mtimeNs &&
      final.ctimeNs === observed.ctimeNs &&
      finalPath.dev === observed.dev &&
      finalPath.ino === observed.ino
    );
  } catch {
    return false;
  }
}
