// Lexical POSIX path validation/normalization.
//
// Authority kernels cannot trust the caller to hand them safe paths. But
// they also cannot resolve symlinks or touch the filesystem (no I/O). This
// module sits in the middle: it accepts a raw path string from the shell
// and either returns a normalized POSIX-relative form or returns a stable
// invalid-path rule id describing why the kernel refuses it.
//
// Rejected:
//   - empty string or non-string
//   - absolute paths ('/foo', leading '/')
//   - any '..' segment (parent traversal)
//   - any backslash (Windows-style separator; we are POSIX-only)
//   - any NUL byte
//
// Normalized:
//   - leading './' stripped
//   - duplicate slashes collapsed
//   - trailing slash preserved iff present (e.g. '.caws/' stays '.caws/')
//   - empty single segments ('.') stripped
//
// We deliberately do NOT collapse '..' — any '..' is rejected, not resolved.

import { SCOPE_RULES } from './rules';

export type PathValidationFailure =
  | { rule: typeof SCOPE_RULES.INVALID_PATH_EMPTY; message: string }
  | { rule: typeof SCOPE_RULES.INVALID_PATH_NOT_STRING; message: string }
  | { rule: typeof SCOPE_RULES.INVALID_PATH_ABSOLUTE; message: string }
  | { rule: typeof SCOPE_RULES.INVALID_PATH_PARENT_TRAVERSAL; message: string }
  | { rule: typeof SCOPE_RULES.INVALID_PATH_BACKSLASH; message: string }
  | { rule: typeof SCOPE_RULES.INVALID_PATH_NUL; message: string };

export type PathValidationResult =
  | { ok: true; normalized: string }
  | { ok: false; failure: PathValidationFailure };

/**
 * Lexical-only path validator and normalizer.
 *
 * Inputs that arrive here are untrusted user/agent strings. The function
 * never throws; bad inputs become structured failures.
 *
 * Returns the normalized POSIX-relative form on success. The original
 * argument is preserved by the caller for diagnostics.
 */
export function normalizeRelativePosixPath(input: unknown): PathValidationResult {
  if (typeof input !== 'string') {
    return {
      ok: false,
      failure: {
        rule: SCOPE_RULES.INVALID_PATH_NOT_STRING,
        message: `Path must be a string; received ${typeof input}.`,
      },
    };
  }

  if (input.length === 0) {
    return {
      ok: false,
      failure: {
        rule: SCOPE_RULES.INVALID_PATH_EMPTY,
        message: 'Path is empty.',
      },
    };
  }

  if (input.includes('\0')) {
    return {
      ok: false,
      failure: {
        rule: SCOPE_RULES.INVALID_PATH_NUL,
        message: 'Path contains a NUL byte.',
      },
    };
  }

  if (input.includes('\\')) {
    return {
      ok: false,
      failure: {
        rule: SCOPE_RULES.INVALID_PATH_BACKSLASH,
        message: 'Path contains a backslash. Use POSIX forward slashes only.',
      },
    };
  }

  if (input.startsWith('/')) {
    return {
      ok: false,
      failure: {
        rule: SCOPE_RULES.INVALID_PATH_ABSOLUTE,
        message: 'Absolute paths are not permitted; use a path relative to the repo root.',
      },
    };
  }

  // Strip a leading './'
  let working = input.startsWith('./') ? input.slice(2) : input;

  // Re-check for empty after './' strip — './' alone is empty after strip.
  if (working.length === 0) {
    return {
      ok: false,
      failure: {
        rule: SCOPE_RULES.INVALID_PATH_EMPTY,
        message: 'Path is empty after stripping leading "./".',
      },
    };
  }

  // Re-check absolute after strip (defensive — './' couldn't produce a leading slash, but
  // be explicit so a future change does not silently regress).
  if (working.startsWith('/')) {
    return {
      ok: false,
      failure: {
        rule: SCOPE_RULES.INVALID_PATH_ABSOLUTE,
        message: 'Absolute paths are not permitted; use a path relative to the repo root.',
      },
    };
  }

  // Detect '..' segments lexically. We split on '/' and check each segment.
  // Trailing slash preservation: remember it, split the rest.
  const trailingSlash = working.endsWith('/');
  const stripped = trailingSlash ? working.slice(0, -1) : working;
  const rawSegments = stripped.split('/');

  const cleaned: string[] = [];
  for (const seg of rawSegments) {
    if (seg === '..') {
      return {
        ok: false,
        failure: {
          rule: SCOPE_RULES.INVALID_PATH_PARENT_TRAVERSAL,
          message: 'Parent-traversal segments ("..") are not permitted.',
        },
      };
    }
    // Collapse duplicate slashes (empty segment) and embedded '.' segments.
    if (seg === '' || seg === '.') {
      continue;
    }
    cleaned.push(seg);
  }

  if (cleaned.length === 0) {
    return {
      ok: false,
      failure: {
        rule: SCOPE_RULES.INVALID_PATH_EMPTY,
        message: 'Path has no real segments after normalization.',
      },
    };
  }

  const normalized = cleaned.join('/') + (trailingSlash ? '/' : '');
  return { ok: true, normalized };
}

/** True iff `normalized` is a root-level path (no path separator). */
export function isRootLevel(normalized: string): boolean {
  // We only call this on already-normalized non-trailing-slash paths,
  // but defend against the trailing-slash case explicitly.
  const stripped = normalized.endsWith('/') ? normalized.slice(0, -1) : normalized;
  return !stripped.includes('/');
}
