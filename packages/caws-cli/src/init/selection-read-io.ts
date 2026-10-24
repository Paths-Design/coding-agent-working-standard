/** Selection read boundary; observations confer no write or publication authority. */
import * as fs from 'node:fs';
import { createHash } from 'node:crypto';
import { types } from 'node:util';

export interface SelectionFileInfo {
  readonly kind: 'file' | 'directory' | 'symlink' | 'other';
  readonly dev: string;
  readonly ino: string;
  readonly size: number;
  readonly mode: number;
  readonly nlink: number;
  readonly mtimeMs: number;
  readonly ctimeMs: number;
}
/** Identity consumed by path confinement; no directory inventory metadata. */
export interface SelectionPathIdentity {
  readonly kind: SelectionFileInfo['kind'];
  readonly dev: string;
  readonly ino: string;
  readonly mode: number;
}
export interface SelectionRuntimeFile {
  readonly bytes: Buffer;
  readonly stat: SelectionFileInfo;
}
export type SelectionRuntimeVerifier = (
  home: string,
  digest: string,
  io: SelectionReadIo
) => Record<string, string>;
export interface SelectionReadIo {
  lstat(file: string): SelectionFileInfo;
  pathIdentity?(file: string): SelectionPathIdentity;
  stat(file: string): SelectionFileInfo;
  exists(file: string): boolean;
  readFile(file: string): Buffer;
  readDirectory(file: string): readonly string[];
  requireExecutable(file: string): void;
  readRuntimeFile(file: string, singleLink?: boolean): SelectionRuntimeFile;
  /** Optional compact digest observation. Its coherence with byte reads is owned
   * by the native capture/admission boundary, not this data interface. */
  runtimeFileDigest?(file: string): string;
  /** Verify the same runtime dependencies without requesting a mutable manifest copy. */
  ensureRuntimeVerified?(home: string, digest: string, verify: SelectionRuntimeVerifier): void;
  verifyRuntime?(
    home: string,
    digest: string,
    verify: SelectionRuntimeVerifier
  ): Record<string, string>;
}
export type SelectionReadOperation = Readonly<{
  kind:
    | 'lstat'
    | 'path-identity'
    | 'stat'
    | 'exists'
    | 'read'
    | 'list'
    | 'executable'
    | 'runtime-file'
    | 'runtime-digest'
    | 'runtime-generation';
  path: string;
  singleLink?: boolean;
}>;
export type SelectionReadResult =
  | Readonly<{ kind: 'info'; value: SelectionFileInfo }>
  | Readonly<{ kind: 'path-identity'; value: SelectionPathIdentity }>
  | Readonly<{ kind: 'exists'; value: boolean }>
  | Readonly<{ kind: 'bytes'; base64: string }>
  | Readonly<{ kind: 'listing'; entries: readonly string[] }>
  | Readonly<{ kind: 'executable' }>
  | Readonly<{ kind: 'runtime-file'; base64: string; stat: SelectionFileInfo }>
  | Readonly<{ kind: 'runtime-digest'; sha256: string; stat: SelectionFileInfo }>
  | Readonly<{
      kind: 'runtime-generation';
      digest: string;
      manifest: Readonly<Record<string, string>>;
    }>
  | Readonly<{ kind: 'error'; name: string; message: string; code?: string }>;

function fileInfo(stat: fs.Stats): SelectionFileInfo {
  return Object.freeze({
    kind: stat.isFile()
      ? 'file'
      : stat.isDirectory()
        ? 'directory'
        : stat.isSymbolicLink()
          ? 'symlink'
          : 'other',
    dev: String(stat.dev),
    ino: String(stat.ino),
    size: stat.size,
    mode: stat.mode,
    nlink: stat.nlink,
    mtimeMs: stat.mtimeMs,
    ctimeMs: stat.ctimeMs,
  });
}
function projectPathIdentity(info: SelectionPathIdentity): SelectionPathIdentity {
  return Object.freeze({ kind: info.kind, dev: info.dev, ino: info.ino, mode: info.mode });
}
function same(a: SelectionFileInfo, b: SelectionFileInfo, singleLink: boolean): boolean {
  return (
    a.kind === 'file' &&
    b.kind === 'file' &&
    a.dev === b.dev &&
    a.ino === b.ino &&
    a.size === b.size &&
    a.mode === b.mode &&
    a.mtimeMs === b.mtimeMs &&
    a.ctimeMs === b.ctimeMs &&
    (!singleLink || (a.nlink === 1 && b.nlink === 1))
  );
}
function captureRuntimeFile(file: string, singleLink = false): SelectionRuntimeFile {
  const before = fileInfo(fs.lstatSync(file));
  if (before.kind !== 'file') throw new Error(`Runtime member is not a regular file: ${file}`);
  if (singleLink && before.nlink !== 1)
    throw new Error(`Native entry member is not single-link: ${file}`);
  const fd = fs.openSync(
    file,
    fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK
  );
  try {
    const opened = fileInfo(fs.fstatSync(fd));
    if (!same(before, opened, singleLink)) throw new Error(`Runtime member replaced: ${file}`);
    const bytes = fs.readFileSync(fd);
    if (
      !same(opened, fileInfo(fs.fstatSync(fd)), singleLink) ||
      !same(opened, fileInfo(fs.lstatSync(file)), singleLink) ||
      bytes.length !== opened.size
    )
      throw new Error(`Runtime member changed: ${file}`);
    return { bytes, stat: opened };
  } finally {
    fs.closeSync(fd);
  }
}
export const liveSelectionReadIo: SelectionReadIo = Object.freeze({
  lstat: (file: string) => fileInfo(fs.lstatSync(file)),
  pathIdentity: (file: string) => projectPathIdentity(fileInfo(fs.lstatSync(file))),
  stat: (file: string) => fileInfo(fs.statSync(file)),
  exists: (file: string) => fs.existsSync(file),
  readFile: (file: string) => fs.readFileSync(file),
  readDirectory: (file: string) => fs.readdirSync(file),
  requireExecutable: (file: string) => fs.accessSync(file, fs.constants.X_OK),
  readRuntimeFile: captureRuntimeFile,
});

// Recognition uses private identity; a matching public error message is not a sentinel.
const missing = new WeakMap<object, SelectionReadOperation>();
export function needSelectionObservation(operation: SelectionReadOperation): never {
  const error = new Error('Selection requires a captured read observation');
  missing.set(error, operation);
  throw error;
}
export function missingSelectionObservation(error: unknown): SelectionReadOperation | undefined {
  return error !== null && typeof error === 'object' ? missing.get(error) : undefined;
}

/** Tooling adapter only; production native capture supplies its own observation port. */
export function captureSelectionRead(
  operation: SelectionReadOperation,
  io: SelectionReadIo = liveSelectionReadIo
): SelectionReadResult {
  try {
    switch (operation.kind) {
      case 'path-identity':
        return {
          kind: 'path-identity',
          value: io.pathIdentity
            ? io.pathIdentity(operation.path)
            : projectPathIdentity(io.lstat(operation.path)),
        };
      case 'lstat':
        return { kind: 'info', value: io.lstat(operation.path) };
      case 'stat':
        return { kind: 'info', value: io.stat(operation.path) };
      case 'exists':
        return { kind: 'exists', value: io.exists(operation.path) };
      case 'read':
        return { kind: 'bytes', base64: io.readFile(operation.path).toString('base64') };
      case 'list':
        return { kind: 'listing', entries: io.readDirectory(operation.path) };
      case 'executable':
        io.requireExecutable(operation.path);
        return { kind: 'executable' };
      case 'runtime-generation':
        // This summary can be produced only by the original native generation
        // owner. Tooling retains its ordinary complete filesystem verifier.
        throw new Error('Runtime generation summary requires the original native owner');
      case 'runtime-digest': {
        // Tooling captures guarded bytes synchronously. Production native
        // capture supplies its independently admitted compact observation.
        const captured = io.readRuntimeFile(operation.path, operation.singleLink);
        return {
          kind: 'runtime-digest',
          sha256: createHash('sha256').update(captured.bytes).digest('hex'),
          stat: captured.stat,
        };
      }
      case 'runtime-file': {
        const captured = io.readRuntimeFile(operation.path, operation.singleLink);
        return {
          kind: 'runtime-file',
          base64: captured.bytes.toString('base64'),
          stat: captured.stat,
        };
      }
    }
  } catch (error) {
    if (missingSelectionObservation(error)) throw error;
    if (!types.isNativeError(error)) throw error;
    const code = (error as NodeJS.ErrnoException).code;
    return {
      kind: 'error',
      name: error.name,
      message: error.message,
      ...(code === undefined ? {} : { code }),
    };
  }
}
