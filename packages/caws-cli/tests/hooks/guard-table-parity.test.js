'use strict';

/**
 * The two shipped allow tables stand in a DECLARED relationship
 * (CAWS-HOOKS-GUARD-CONFIG-VISIBILITY-PARITY-01).
 *
 * `scope-guard.sh` carries `ALLOW_PREFIXES`; `lib/write-allowlist.sh` carries
 * a `case` of admitted paths. They overlap heavily and diverge deliberately,
 * and until now the divergence was undeclared — so a consumer meeting it had
 * no way to tell "these tables differ because they answer different
 * questions" from "these tables have drifted apart".
 *
 * That ambiguity is what the repo-local hook policy exists to push back on.
 * The anti-abuse rule is: *would this entry be correct in a repo with a
 * different layout?* If yes, it is an UPSTREAM defect and a config entry is a
 * workaround that will rot. A silent divergence between these two tables is
 * the single most likely source of such an entry — a path scope-guard exempts
 * but write-allowlist does not (or vice versa) looks exactly like "the guard
 * is broken, configure around it."
 *
 * So the relationship is asserted here, in CAWS's own CI, rather than
 * discovered downstream one refusal at a time.
 *
 * **Equality would be the WRONG invariant.** The tables answer different
 * questions:
 *
 *   - `scope-guard.sh` asks *is this path exempt from SPEC SCOPE?* — may I
 *     edit it without it being in my spec's `scope.in`?
 *   - `write-allowlist.sh` asks *may I write here at all from outside my
 *     worktree?* — it gates WRITE AUTHORITY, and feeds both bash-write-guard
 *     and worktree-write-guard.
 *
 * A path can be scope-exempt but not write-authorized (`tests/`: everyone
 * edits tests without declaring each one, but writing them from a foreign
 * worktree is still an ownership question), and write-authorized but
 * scope-governed (`.github/`: a workflow change is legitimate from the
 * canonical checkout, and it absolutely should appear in a spec's scope).
 *
 * Asserting equality would encode a false invariant and drive someone to
 * "fix" a difference that is correct. So each asymmetry is declared WITH its
 * reason, and the test fails when a table gains or loses anything the
 * declaration does not account for.
 */

const fs = require('node:fs');
const path = require('node:path');

const SHARED = path.resolve(__dirname, '..', '..', 'templates/hook-packs/shared');
const SCOPE_GUARD = path.join(SHARED, 'scope-guard.sh');
const WRITE_ALLOWLIST = path.join(SHARED, 'lib/write-allowlist.sh');

/**
 * Parse `ALLOW_PREFIXES=( … )` out of scope-guard.sh.
 *
 * Reads only the literal array. The conditional `$HOME/$CAWS_VENDOR_DIR/`
 * append below it is deliberately excluded: it is absolute and
 * home-tier-conditional, so it is not a repo-relative prefix and has no
 * counterpart in the write allowlist's repo-relative case.
 */
function scopeGuardPrefixes() {
  const body = fs.readFileSync(SCOPE_GUARD, 'utf8');
  const match = body.match(/^ALLOW_PREFIXES=\(([\s\S]*?)^\)/m);
  if (match === null) throw new Error('ALLOW_PREFIXES array not found in scope-guard.sh');
  return match[1]
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith('#'))
    .map((line) => line.replace(/^"(.*)"$/, '$1'))
    .map((entry) => entry.replace('${CAWS_VENDOR_DIR}', '<vendor>'));
}

/**
 * Parse the repo-relative arms of write-allowlist.sh's admit `case`.
 *
 * Each arm is `"$project_dir"/X|X) return 0 ;;` — the bare alternative is the
 * repo-relative form, which is what compares against scope-guard's table.
 * Only `return 0` (admit) arms count: `.caws/worktrees/*` returns 1 and is an
 * EXCLUSION, not an entry.
 */
function writeAllowlistPrefixes() {
  const body = fs.readFileSync(WRITE_ALLOWLIST, 'utf8');
  // There are THREE `case "$file_path" in` blocks: one normalizes the path,
  // one EXCLUDES worktree payload with `return 1`, and one is the admit
  // table. Taking the first would silently read the normalizer and report an
  // empty table, so the admit block is selected by the only property unique
  // to it — it contains `return 0` arms — and the selection is asserted
  // unambiguous rather than assumed.
  const blocks = [];
  let cursor = body.indexOf('case "$file_path" in');
  while (cursor !== -1) {
    const end = body.indexOf('esac', cursor);
    if (end === -1) break;
    blocks.push(body.slice(cursor, end));
    cursor = body.indexOf('case "$file_path" in', end);
  }
  const admit = blocks.filter((b) => b.includes('return 0'));
  if (admit.length !== 1) {
    throw new Error(
      `expected exactly one admit case in write-allowlist.sh, found ${admit.length} ` +
        `(of ${blocks.length} case blocks) — the parser can no longer identify the table`
    );
  }
  const block = admit[0];
  const found = [];
  for (const line of block.split('\n')) {
    const arm = line.trim();
    if (!arm.includes('return 0')) continue;
    const patterns = (arm.split(')')[0] ?? '').split('|');
    for (const pattern of patterns) {
      if (pattern.includes('$project_dir')) continue;
      const cleaned = pattern.trim().replace(/\*$/, '');
      if (cleaned.length > 0) found.push(cleaned);
    }
  }
  // The vendor dir is matched by [[ ]] below the case (a case pattern cannot
  // expand a variable), so it is added here to compare like with like.
  if (body.includes('"$file_path" == "$project_dir/${CAWS_VENDOR_DIR}/"*')) found.push('<vendor>/');
  return found;
}

/** Entries both tables carry. A change here means a shared posture moved. */
const SHARED_ENTRIES = ['.caws/', '<vendor>/', 'docs/', 'tmp/', '.archive/'];

/**
 * Scope-exempt but NOT write-authorized, each with the reason it is correct.
 * A new entry here must come with an argument; an unexplained one is drift.
 */
const SCOPE_GUARD_ONLY = {
  'tests/':
    'Tests are edited constantly and declaring each file in scope.in would make ' +
    'scope.in a changelog. Writing them from a FOREIGN worktree is still an ' +
    'ownership question, so the write guard must keep asking it.',
  'scripts/':
    'Same posture as tests/: routine to edit under a slice, but not a path any ' +
    'session may write into from outside its own worktree.',
};

/**
 * Write-authorized but NOT scope-exempt, each with the reason it is correct.
 */
const WRITE_ALLOWLIST_ONLY = {
  '.gitignore':
    'A single well-known file, legitimately touched by governed tooling. A CHANGE ' +
    'to it is still a reviewable decision that belongs in a spec.',
  '.tmp/':
    'Scratch output. scope-guard exempts tmp/ but not .tmp/; both are write-allowed ' +
    'because neither holds reviewable product.',
  '.githooks/':
    'Git hook wiring — write-allowed so governed install paths work, scope-governed ' +
    'because changing an enforcement hook is exactly what a spec should record.',
  '.github/':
    'Workflow and CI config. Legitimately written by tooling from canonical, and a ' +
    'change to a release workflow is high-blast-radius: it must appear in a scope.',
};

describe('the shipped allow tables stand in a declared relationship', () => {
  test('scope-guard.sh carries exactly the shared set plus its declared extras', () => {
    const actual = scopeGuardPrefixes().sort();
    const expected = [...SHARED_ENTRIES, ...Object.keys(SCOPE_GUARD_ONLY)].sort();
    // The failure message is the point: a diff here means either a real
    // upstream change (update the declaration WITH a reason) or drift.
    expect(actual).toEqual(expected);
  });

  test('write-allowlist.sh carries exactly the shared set plus its declared extras', () => {
    const actual = [...new Set(writeAllowlistPrefixes())].sort();
    const expected = [...SHARED_ENTRIES, ...Object.keys(WRITE_ALLOWLIST_ONLY)].sort();
    expect(actual).toEqual(expected);
  });

  test('every asymmetry carries a reason long enough to be an argument', () => {
    // The declaration is only useful if the "why" is real. Mirrors the 12-char
    // floor the policy parser imposes on a repo-declared reason: the standard
    // CAWS holds consumers to, applied to CAWS's own asymmetries.
    for (const [entry, reason] of [
      ...Object.entries(SCOPE_GUARD_ONLY),
      ...Object.entries(WRITE_ALLOWLIST_ONLY),
    ]) {
      expect(reason.length).toBeGreaterThanOrEqual(12);
      expect(entry.length).toBeGreaterThan(0);
    }
  });

  test('the two declared-extras sets are DISJOINT', () => {
    // An entry claimed by both sides would mean the declaration contradicts
    // itself, and both table assertions above could still pass.
    const overlap = Object.keys(SCOPE_GUARD_ONLY).filter((entry) => entry in WRITE_ALLOWLIST_ONLY);
    expect(overlap).toEqual([]);
  });

  test('the parsers are not vacuous: each finds a table with real entries', () => {
    // Both parsers return [] on a regex miss, which would make the equality
    // assertions above pass only if the expectation were also empty. These
    // bound them from below so a silently-broken parser fails HERE, naming
    // the parser, instead of looking like a table that lost every entry.
    expect(scopeGuardPrefixes().length).toBeGreaterThanOrEqual(5);
    expect(writeAllowlistPrefixes().length).toBeGreaterThanOrEqual(5);
    expect(scopeGuardPrefixes()).toContain('.caws/');
    expect(writeAllowlistPrefixes()).toContain('.caws/');
  });

  test('the write allowlist EXCLUDES worktree payload, and that is not read as an entry', () => {
    // `.caws/worktrees/*` returns 1 ahead of the `.caws/*` admit arm. Parsing
    // it as an entry would silently claim the write guard admits foreign
    // worktree payload — the exact inversion the exclusion exists to prevent.
    const body = fs.readFileSync(WRITE_ALLOWLIST, 'utf8');
    expect(body).toContain('.caws/worktrees/*) return 1');
    expect(writeAllowlistPrefixes()).not.toContain('.caws/worktrees/');
  });
});
