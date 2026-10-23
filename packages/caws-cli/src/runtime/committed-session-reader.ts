/** Independent ordinary read of a native-admitted selection. This grants no writer authority. */
import * as fs from 'node:fs';
import { isAbsolute, join, normalize, parse } from 'node:path';
import { createHash } from 'node:crypto';
import { TextDecoder } from 'node:util';
import { RuntimeProtocolError } from './protocol';
import { parseJsonSource } from './json-custody';
import {
  MAX_PUBLICATION_ARTIFACT_BYTES,
  MAX_PUBLICATION_TOTAL_BYTES,
  MAX_PUBLICATION_ARTIFACTS,
  MAX_PUBLICATION_MARKER_BYTES,
  SESSION_PUBLICATION_MARKER_NAME,
  sessionPublicationMarkerBytes,
  sessionPublicationTerminalDigest,
  sessionPublicationRole,
  type CommittedSessionSelection,
} from './session-publication-wire';

export interface CommittedSession extends CommittedSessionSelection {
  readonly markerSha256: string;
  /** Owned copies of the current validated generation, never another filesystem read. */
  bytes(name: string): Uint8Array;
}
const issued = new WeakSet<object>();
export function isCommittedSession(value: unknown): value is CommittedSession {
  return value !== null && typeof value === 'object' && issued.has(value);
}
function requireValue(value: unknown, message: string): asserts value {
  if (!value) throw new RuntimeProtocolError(message);
}
const digest = (value: unknown): value is string =>
  typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const nativeText = (value: unknown, bound: number): value is string =>
  typeof value === 'string' &&
  value.length > 0 &&
  !value.includes('\0') &&
  Buffer.byteLength(value) <= bound &&
  Buffer.from(value).toString('utf8') === value;
const stamp = (stat: fs.BigIntStats): string =>
  [
    stat.dev,
    stat.ino,
    stat.size,
    stat.mtimeNs,
    stat.ctimeNs,
    stat.birthtimeNs,
    stat.mode,
    stat.uid,
    stat.nlink,
  ].join(':');
const sameDirectory = (left: fs.BigIntStats, right: fs.BigIntStats): boolean =>
  left.dev === right.dev && left.ino === right.ino;
const hash = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');

/** Bound waiting for publication preparation/consumption, not callback side effects.
 * Late completion/rejection is observed but cannot resume this operation. Native
 * custody separately owns process termination and unsettled writer resources.
 */
export function awaitSessionPublicationCallback<T>(
  options: { readonly signal: AbortSignal; readonly deadlineEpochMs: number },
  consume: () => T | PromiseLike<T>
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const cleanup = (): void => {
      if (timer !== undefined) clearTimeout(timer);
      options.signal.removeEventListener('abort', aborted);
    };
    const fail = (error: unknown): void => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    };
    const aborted = (): void => fail(options.signal.reason);
    const check = (): void => {
      if (options.signal.aborted) throw options.signal.reason;
      requireValue(
        Date.now() < options.deadlineEpochMs,
        'Session publication callback deadline expired'
      );
    };
    const arm = (): void => {
      const remaining = options.deadlineEpochMs - Date.now();
      if (remaining <= 0) {
        fail(new RuntimeProtocolError('Session publication callback deadline expired'));
        return;
      }
      // Long public-reader deadlines must not overflow Node's timer interval.
      timer = setTimeout(
        () => {
          timer = undefined;
          try {
            check();
            arm();
          } catch (error) {
            fail(error);
          }
        },
        Math.min(remaining, 2_147_483_647)
      );
    };
    try {
      requireValue(
        Number.isSafeInteger(options.deadlineEpochMs) &&
          options.deadlineEpochMs > 0 &&
          typeof consume === 'function',
        'Invalid session publication callback contract'
      );
      check();
      options.signal.addEventListener('abort', aborted, { once: true });
      check();
      arm();
    } catch (error) {
      fail(error);
      return;
    }
    // Both handlers stay attached after cancellation. An abandoned callback
    // rejection is observed without granting a late acknowledgement or retry.
    void Promise.resolve()
      .then(() => {
        if (settled)
          throw new RuntimeProtocolError('Session publication callback is no longer active');
        check();
        return consume();
      })
      .then((value) => {
        if (settled) return;
        try {
          check();
        } catch (error) {
          fail(error);
          return;
        }
        settled = true;
        cleanup();
        resolve(value);
      }, fail);
  });
}

/** Hold anchors through actual consumer use, then check the current generation again.
 * Node has no openat API: paths are opened nofollow/nonblocking, compared with held
 * descriptors before/after reads, and revalidated before consumption and return.
 * The native owner independently revalidates its openat-held generation at CONSUMED.
 */
export async function consumeCommittedSession<T>(
  expected: CommittedSessionSelection,
  options: { readonly signal: AbortSignal; readonly deadlineEpochMs: number },
  consume: (session: CommittedSession) => T | Promise<T>
): Promise<T> {
  requireValue(
    Number.isSafeInteger(options.deadlineEpochMs) &&
      options.deadlineEpochMs > 0 &&
      typeof consume === 'function',
    'Invalid committed session read contract'
  );
  const check = (): void => {
    if (options.signal.aborted) throw options.signal.reason;
    requireValue(Date.now() < options.deadlineEpochMs, 'Committed session read deadline expired');
  };
  check();
  requireValue(
    nativeText(expected.canonicalRoot, 4096) &&
      isAbsolute(expected.canonicalRoot) &&
      normalize(expected.canonicalRoot) === expected.canonicalRoot &&
      nativeText(expected.sessionId, 128) &&
      /^[A-Za-z0-9_.@:-]+$/.test(expected.sessionId) &&
      expected.sessionId !== '.' &&
      expected.sessionId !== '..',
    'Invalid admitted session location'
  );
  const correlation = expected.correlation;
  requireValue(
    correlation &&
      nativeText(correlation.id, 256) &&
      digest(correlation.runtimeDigest) &&
      nativeText(correlation.token, 128) &&
      nativeText(correlation.attempt, 128) &&
      digest(expected.terminalDigest),
    'Invalid committed session correlation'
  );
  requireValue(
    Array.isArray(expected.artifacts) && expected.artifacts.length <= MAX_PUBLICATION_ARTIFACTS,
    'Invalid committed session inventory'
  );
  let total = 0,
    prior = '';
  const artifacts = expected.artifacts.map((item) => {
    requireValue(
      item &&
        typeof item.name === 'string' &&
        item.name.length <= 255 &&
        typeof item.role === 'string' &&
        sessionPublicationRole(item.name) === item.role &&
        item.name > prior &&
        Number.isSafeInteger(item.byteLength) &&
        item.byteLength >= 0 &&
        item.byteLength <= MAX_PUBLICATION_ARTIFACT_BYTES &&
        digest(item.sha256),
      'Invalid or unsorted committed session descriptor'
    );
    prior = item.name;
    total += item.byteLength;
    requireValue(
      total <= MAX_PUBLICATION_TOTAL_BYTES,
      'Committed session inventory exceeds byte bound'
    );
    return Object.freeze({
      name: item.name,
      role: item.role,
      byteLength: item.byteLength,
      sha256: item.sha256,
    });
  });
  const selected = Object.freeze({
    canonicalRoot: expected.canonicalRoot,
    sessionId: expected.sessionId,
    correlation: Object.freeze({
      id: correlation.id,
      runtimeDigest: correlation.runtimeDigest,
      token: correlation.token,
      attempt: correlation.attempt,
    }),
    terminalDigest: expected.terminalDigest,
    artifacts: Object.freeze(artifacts),
  });
  requireValue(
    selected.terminalDigest ===
      sessionPublicationTerminalDigest(selected.correlation, 'published', artifacts),
    'Committed session terminal digest differs from original correlation and inventory'
  );
  const markerBytes = sessionPublicationMarkerBytes(selected);
  requireValue(
    markerBytes.length <= MAX_PUBLICATION_MARKER_BYTES,
    'Committed session marker exceeds byte bound'
  );
  requireValue(
    typeof process.geteuid === 'function',
    'Committed session POSIX reader is unavailable'
  );
  const uid = BigInt(process.geteuid());
  const safe = (stat: fs.BigIntStats, directory: boolean): void => {
    requireValue(
      (directory ? stat.isDirectory() : stat.isFile() && stat.nlink === 1n) &&
        stat.uid === uid &&
        (stat.mode & 0o022n) === 0n,
      'Unsafe committed session anchor or artifact'
    );
  };
  const ancestors = (file: string): void => {
    let current = parse(file).root;
    for (const part of file.slice(current.length).split('/').filter(Boolean)) {
      current = join(current, part);
      const stat = fs.lstatSync(current, { bigint: true });
      requireValue(
        stat.isDirectory() && !stat.isSymbolicLink(),
        'Committed session symlink or invalid directory'
      );
    }
  };
  const held: { path: string; fd: number; stat: fs.BigIntStats }[] = [];
  const revalidateDirectories = (): void => {
    check();
    ancestors(selected.canonicalRoot);
    requireValue(
      fs.realpathSync(selected.canonicalRoot) === selected.canonicalRoot,
      'Committed session canonical root changed'
    );
    for (const directory of held) {
      const current = fs.lstatSync(directory.path, { bigint: true });
      safe(current, true);
      const opened = fs.fstatSync(directory.fd, { bigint: true });
      safe(opened, true);
      requireValue(
        !current.isSymbolicLink() &&
          sameDirectory(current, directory.stat) &&
          sameDirectory(opened, directory.stat),
        'Committed session directory replaced'
      );
    }
  };
  const openDirectory = (path: string): void => {
    revalidateDirectories();
    const before = fs.lstatSync(path, { bigint: true });
    safe(before, true);
    const fd = fs.openSync(
      path,
      fs.constants.O_RDONLY |
        fs.constants.O_NOFOLLOW |
        fs.constants.O_NONBLOCK |
        fs.constants.O_DIRECTORY
    );
    held.push({ path, fd, stat: before });
    revalidateDirectories();
  };
  let markerFd: number | undefined;
  let failure: unknown;
  try {
    openDirectory(selected.canonicalRoot);
    openDirectory(join(selected.canonicalRoot, '.caws'));
    openDirectory(join(selected.canonicalRoot, '.caws/sessions'));
    const directory = join(selected.canonicalRoot, '.caws/sessions', selected.sessionId);
    openDirectory(directory);
    const read = (name: string, maximum: number): { bytes: Buffer; stamp: string } => {
      revalidateDirectories();
      const file = join(directory, name);
      const before = fs.lstatSync(file, { bigint: true });
      safe(before, false);
      requireValue(
        !before.isSymbolicLink() && before.size <= BigInt(maximum),
        'Committed session file exceeds byte bound'
      );
      const fd = fs.openSync(
        file,
        fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK
      );
      try {
        requireValue(
          stamp(fs.fstatSync(fd, { bigint: true })) === stamp(before),
          'Committed session file replaced while opening'
        );
        const bytes = Buffer.alloc(Number(before.size));
        let offset = 0;
        while (offset < bytes.length) {
          check();
          const count = fs.readSync(
            fd,
            bytes,
            offset,
            Math.min(64 * 1024, bytes.length - offset),
            offset
          );
          requireValue(count > 0, 'Committed session artifact shortened');
          offset += count;
        }
        requireValue(
          stamp(fs.fstatSync(fd, { bigint: true })) === stamp(before) &&
            stamp(fs.lstatSync(file, { bigint: true })) === stamp(before),
          'Committed session file changed while reading'
        );
        revalidateDirectories();
        return { bytes, stamp: stamp(before) };
      } finally {
        fs.closeSync(fd);
      }
    };
    const marker = read(SESSION_PUBLICATION_MARKER_NAME, MAX_PUBLICATION_MARKER_BYTES);
    const markerPath = join(directory, SESSION_PUBLICATION_MARKER_NAME);
    markerFd = fs.openSync(
      markerPath,
      fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK
    );
    requireValue(
      stamp(fs.fstatSync(markerFd, { bigint: true })) === marker.stamp,
      'Committed session marker replaced while opening'
    );
    try {
      const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(marker.bytes);
      parseJsonSource(text, 8, 100_000, true);
    } catch {
      throw new RuntimeProtocolError(
        'Invalid committed session marker encoding or duplicate member'
      );
    }
    requireValue(
      marker.bytes.equals(markerBytes),
      'Committed session marker differs from admitted current selection'
    );
    const inventory = (): readonly string[] => {
      revalidateDirectories();
      const names: string[] = [];
      const iterator = fs.opendirSync(directory);
      let count = 0;
      try {
        for (let entry = iterator.readSync(); entry !== null; entry = iterator.readSync()) {
          check();
          requireValue(++count <= 16_384, 'Committed session directory enumeration bound');
          if (sessionPublicationRole(entry.name) !== undefined) names.push(entry.name);
        }
      } finally {
        iterator.closeSync();
      }
      names.sort();
      requireValue(
        names.length === artifacts.length &&
          names.every((name, index) => name === artifacts[index]!.name),
        'Committed session current inventory differs'
      );
      return names;
    };
    inventory();
    const files = new Map<string, { bytes: Buffer; stamp: string }>();
    for (const artifact of artifacts) {
      const current = read(artifact.name, artifact.byteLength);
      requireValue(
        current.bytes.length === artifact.byteLength && hash(current.bytes) === artifact.sha256,
        'Committed session artifact bytes differ'
      );
      files.set(artifact.name, current);
    }
    const revalidate = (): void => {
      inventory();
      for (const artifact of artifacts) {
        const current = read(artifact.name, artifact.byteLength);
        requireValue(
          current.stamp === files.get(artifact.name)!.stamp &&
            hash(current.bytes) === artifact.sha256,
          'Committed session artifact replaced or changed'
        );
      }
      const current = read(SESSION_PUBLICATION_MARKER_NAME, MAX_PUBLICATION_MARKER_BYTES);
      requireValue(
        current.stamp === marker.stamp &&
          current.bytes.equals(marker.bytes) &&
          stamp(fs.fstatSync(markerFd!, { bigint: true })) === marker.stamp,
        'Committed session current marker replaced or changed'
      );
      revalidateDirectories();
    };
    revalidate();
    const session: CommittedSession = Object.freeze({
      ...selected,
      markerSha256: hash(marker.bytes),
      bytes(name: string): Uint8Array {
        const file = files.get(name);
        requireValue(file !== undefined, 'Unknown committed session artifact');
        return Uint8Array.from(file.bytes);
      },
    });
    issued.add(session);
    const result = await awaitSessionPublicationCallback(options, () => consume(session));
    revalidate();
    return result;
  } catch (error) {
    failure = error;
    throw error;
  } finally {
    const errors: unknown[] = [];
    for (const fd of [
      ...(markerFd === undefined ? [] : [markerFd]),
      ...held.map((item) => item.fd).reverse(),
    ]) {
      try {
        fs.closeSync(fd);
      } catch (error) {
        errors.push(error);
      }
    }
    if (errors.length)
      throw new AggregateError(
        failure === undefined ? errors : [failure, ...errors],
        'Committed session descriptor cleanup failed'
      );
  }
}
