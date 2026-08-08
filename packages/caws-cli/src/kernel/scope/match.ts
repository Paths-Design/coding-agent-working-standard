// Pattern matching helpers for scope evaluation.
//
// Three matchers, each with a distinct contract:
//
//  1. matchGlob(path, patterns) — picomatch with dot:true. Used for
//     spec.scope.in and policy.non_governed_zones (both glob-allowed).
//     Plain entries without glob characters are treated as exact-or-descendant
//     directory matches (so `scope.in: ["src"]` admits 'src' and 'src/foo.ts'
//     but not 'srcx/foo.ts').
//
//  2. matchPrefix(path, prefixes) — exact-or-descendant prefix matching.
//     Used for spec.scope.out (which the schema disallows globs for) and
//     for infrastructure exemption (.caws, .claude). Boundary-safe:
//     '.caws' matches '.caws' and '.caws/foo' but NOT '.caws-old/foo'.
//
//  3. matchExactRoot(path, names) — exact root-filename match. Used for
//     policy.root_passthrough. The schema guarantees no slashes in entries.
//     'package.json' admits exactly 'package.json', NOT 'vendor/package.json'
//     and NOT 'package.json.bak'.

import picomatch from 'picomatch';

/** Characters whose presence in a pattern means "actual glob, use picomatch". */
const GLOB_CHARS_RE = /[*?[\](){}!@+|]/;

function isGlob(pattern: string): boolean {
  return GLOB_CHARS_RE.test(pattern);
}

/**
 * Boundary-safe prefix match.
 *
 * Returns true iff `path` is exactly equal to `prefix` OR starts with
 * `prefix + "/"`. So `'src'` matches `'src'` and `'src/foo'`, but not
 * `'srcx/foo'` or `'sources/foo'`.
 *
 * Both inputs must be normalized (no leading './', no trailing '/' on the
 * prefix). Trailing slashes on the prefix are stripped here as a defense.
 */
export function matchPrefix(path: string, prefixes: readonly string[]): string | null {
  const target = trimTrailingSlash(path);
  for (const raw of prefixes) {
    const pfx = trimTrailingSlash(raw);
    if (pfx.length === 0) continue;
    if (target === pfx) return raw;
    if (target.startsWith(pfx + '/')) return raw;
  }
  return null;
}

/**
 * Glob match with dot:true semantics.
 *
 * For each pattern in `patterns`:
 *   - If the pattern contains glob characters, picomatch decides.
 *   - Otherwise the pattern is treated as a boundary-safe directory prefix
 *     (so plain entries like 'src' or 'docs' work as users expect).
 *
 * Returns the first matching pattern (so callers can record which rule
 * fired) or null.
 */
export function matchGlob(path: string, patterns: readonly string[]): string | null {
  const target = trimTrailingSlash(path);
  for (const pattern of patterns) {
    if (pattern.length === 0) continue;
    if (isGlob(pattern)) {
      const isMatch = picomatch(pattern, { dot: true });
      if (isMatch(target)) return pattern;
    } else {
      // Plain entry → boundary-safe prefix match.
      const pfx = trimTrailingSlash(pattern);
      if (pfx.length === 0) continue;
      if (target === pfx || target.startsWith(pfx + '/')) {
        return pattern;
      }
    }
  }
  return null;
}

/**
 * Exact root filename match.
 *
 * Returns the matching name iff `path` equals one of the `names` exactly.
 * Used only for policy.root_passthrough where the schema rejects entries
 * containing '/' so each name is guaranteed to be a single filename.
 */
export function matchExactRoot(path: string, names: readonly string[]): string | null {
  const target = trimTrailingSlash(path);
  for (const name of names) {
    if (name.length === 0) continue;
    if (target === name) return name;
  }
  return null;
}

function trimTrailingSlash(s: string): string {
  return s.endsWith('/') ? s.slice(0, -1) : s;
}
