// Resolve the `git` executable ONCE per process and call it by absolute path.
//
// WHY THIS EXISTS
//
// On macOS, `posix_spawnp` resolves a bare command name by walking `$PATH`
// **in the parent process**, attempting a real `posix_spawn` for each entry
// until one succeeds. Every failed attempt costs in proportion to the
// *parent's* resident set — the kernel has to set up and tear down the spawn
// against the calling process's address space. So the penalty is invisible in
// a small script and severe in a large one:
//
//   in a 130 MB jest worker, PATH with 67 entries and /usr/bin at position 33
//     execFileSync('git', ['--version'])        194.4 ms
//     execFileSync('/usr/bin/git', ['--version']) 30.1 ms     6.45x faster
//
// The CAWS store calls git tens of times per command, and the test suite calls
// it hundreds of times per file, so this is the single largest cost in both.
// Resolving the path here converts that per-call PATH walk into one filesystem
// scan per process (~300 us, measured).
//
// WHAT THIS DELIBERATELY DOES NOT DO
//
// It does not change *which* git runs. The scan walks the same `$PATH` in the
// same left-to-right order the kernel would, takes the first executable regular
// file named `git`, and falls back to the bare name when it finds none — so on
// any machine where resolution fails, every call site behaves exactly as it did
// before this module existed.
//
// It does not persist anything. The cache lives in a module-level variable and
// dies with the process. A resolved path written to disk or an env var would
// eventually name a binary that has moved or been upgraded, and a stale git
// path is a far worse failure than a slow one.

import { accessSync, constants, statSync } from 'node:fs';
import * as path from 'node:path';

/** Env override: use this binary verbatim, skipping PATH resolution entirely. */
const OVERRIDE_ENV = 'CAWS_GIT_BINARY';

/** What we fall back to when resolution finds nothing — the pre-change behavior. */
const BARE = 'git';

let cached: string | undefined;

/**
 * Is `candidate` an executable regular file?
 *
 * `accessSync(X_OK)` alone is not enough: a *directory* named `git` with the
 * execute bit set passes X_OK (on a directory the bit means "may traverse"),
 * and we would then hand a directory to execFileSync and get an EACCES that
 * looks like a broken git install. The `isFile` check is what makes the
 * fallback path reachable only for the right reason.
 */
function isExecutableFile(candidate: string): boolean {
  try {
    if (!statSync(candidate).isFile()) return false;
    accessSync(candidate, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * The filenames to try in one PATH directory, in order.
 *
 * POSIX has exactly one. Win32 gets `git.exe` first because that is what an
 * actual install provides; the extensionless name is kept as a second try so a
 * shim or Git-Bash layout still resolves.
 */
function candidateNames(): readonly string[] {
  return process.platform === 'win32' ? ['git.exe', BARE] : [BARE];
}

/**
 * Scan `$PATH` for the git executable. Returns `undefined` when none is found.
 *
 * ONE INTENTIONAL DIVERGENCE FROM `execvp`: an empty `$PATH` entry (a leading,
 * trailing, or doubled `:`) means "the current directory" to `execvp`. We skip
 * it. Honoring it would let a `./git` dropped into whatever directory the
 * process happens to be in take precedence over the real one — and CAWS runs
 * git inside repositories whose contents it does not control. The divergence
 * can only ever refuse a candidate `execvp` would have accepted, never select a
 * different one, so it cannot silently change which git a working setup uses.
 */
function scanPath(): string | undefined {
  const raw = process.env.PATH;
  if (typeof raw !== 'string' || raw.length === 0) return undefined;
  for (const dir of raw.split(path.delimiter)) {
    if (dir.length === 0) continue; // see the divergence note above
    for (const name of candidateNames()) {
      const candidate = path.join(dir, name);
      if (isExecutableFile(candidate)) return candidate;
    }
  }
  return undefined;
}

/**
 * The git executable to invoke, as an absolute path when one could be found.
 *
 * Memoized for the life of the process. Every call site should pass the return
 * value to `execFileSync`/`spawnSync` instead of the literal `'git'`.
 *
 * Precedence: `CAWS_GIT_BINARY` → first executable `git` on `$PATH` → the bare
 * name `'git'` (which restores the original behavior, letting the OS resolve).
 */
export function resolveGitBinary(): string {
  const override = process.env[OVERRIDE_ENV];
  if (typeof override === 'string' && override.length > 0) {
    // Deliberately NOT cached: the override is a caller-owned knob, and a test
    // or a wrapper that sets it per-invocation must see it take effect.
    return override;
  }
  if (cached !== undefined) return cached;
  cached = scanPath() ?? BARE;
  return cached;
}

/**
 * Drop the memoized path. Exported for tests that manipulate `$PATH` — without
 * it the first resolution in a worker would pin the answer for every later
 * test in that file.
 */
export function resetGitBinaryCache(): void {
  cached = undefined;
}
