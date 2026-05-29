// scope-match — path-vs-scope.in matching for the push-range classifier.
//
// These two pure functions are intentionally duplicated from
// `../binding/resolve-binding.ts` (where `scopeEntryMatches`/`normalizeRel`
// are module-private). The push-range classifier needs the identical
// matching semantics to attribute a commit's touched files to a spec's
// scope.in, but resolve-binding does not export them and is owned by a
// separate (now-closed) slice. Keeping a small local copy avoids widening
// this slice's scope into the binding subsystem for a 20-line helper.
//
// INVARIANT: this must stay semantically identical to resolve-binding's
// copy. Both implement the same scope.in admission rule (exact match, or
// directory-prefix on a path boundary, or anchored `*`/`?` glob). If the
// canonical copy changes its matching rule, update this one to match.
// (MULTI-AGENT-PUSH-RANGE-GUARD-001)

/**
 * Normalize a repo-root-relative path to POSIX separators with no leading
 * "./" or trailing slash, for stable matching against scope.in entries.
 */
export function normalizeRel(p: string): string {
  return p.replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '');
}

/**
 * Anchored glob match supporting `*` and `?`. A bare directory entry (no
 * glob meta) matches the entry itself OR any descendant (prefix match on a
 * path boundary) — mirroring how scope.in directory entries admit files
 * beneath them. No dependency on minimatch.
 */
export function scopeEntryMatches(entry: string, target: string): boolean {
  const e = normalizeRel(entry);
  const t = normalizeRel(target);
  if (e === t) return true;
  if (!/[*?]/.test(e)) {
    return t.startsWith(e + '/');
  }
  const rx = e
    .split('')
    .map((ch) => {
      if (ch === '*') return '.*';
      if (ch === '?') return '.';
      return ch.replace(/[.+^${}()|[\]\\]/g, '\\$&');
    })
    .join('');
  return new RegExp(`^${rx}$`).test(t);
}
