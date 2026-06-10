/**
 * @fileoverview BASH-WRITE-GUARD-FD-REDIRECT-FP-001 — fd redirections are not
 * write targets.
 *
 * Failure (session 402602a8): `caws status 2>&1 | head -30` and
 * `... pytest ... -v 2>&1 | tail -50` — both pure reads — were gated by
 * bash-write-guard with ask_uncertain:worktree-payload-no-entry. Cause: the
 * redirect splitter padded `2>&1` into `2 > &1` and extracted a phantom `&1`
 * target, which the ownership oracle (in a worktree cwd) could not confirm.
 *
 * Fix: neutralize fd-redirect forms (`N>&M`, `>&N`, `&>`, `N>&-`) before the
 * `>` split, so they never tokenize as a file redirection. A real `> file`
 * write target is still extracted.
 *
 * Drives the shipped guard's extract_targets via bash to assert what it pulls.
 */

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..', '..');
const GUARD = path.join(
  REPO_ROOT, 'packages', 'caws-cli', 'templates', 'hook-packs', 'claude-code', 'bash-write-guard.sh'
);

/** Source the guard and call its extract_targets on a command; return targets[]. */
function targets(command) {
  // Source the shipped guard into a subshell, then invoke extract_targets. The
  // guard self-filters/executes on source only past the parse_hook_input gate,
  // so we extract just the function by sourcing with a guard env that no-ops the
  // main flow: simplest is to copy the function out via bash that defines it.
  const script = `
set -uo pipefail
# Pull only the extract_targets function definition from the guard file.
eval "$(awk '/^extract_targets\\(\\)/{f=1} f{print} /^}/{if(f){exit}}' ${JSON.stringify(GUARD)})"
extract_targets ${JSON.stringify(command)}
`;
  const r = spawnSync('bash', ['-c', script], { encoding: 'utf8', timeout: 10000 });
  if (r.status !== 0) throw new Error(`extract_targets failed: ${r.stderr}`);
  return r.stdout.split('\n').map((s) => s.trim()).filter(Boolean);
}

describe('BASH-WRITE-GUARD-FD-REDIRECT-FP-001', () => {
  it('caws status 2>&1 | head -30 extracts NO write target (the reported FP)', () => {
    expect(targets('caws status 2>&1 | head -30')).toEqual([]);
  });

  it('pytest ... -v 2>&1 | tail -50 extracts NO write target', () => {
    expect(targets('python -m pytest a.py b.py -v 2>&1 | tail -50')).toEqual([]);
  });

  it('a bare fd duplicate (>&2) extracts no target', () => {
    expect(targets('echo error >&2')).toEqual([]);
  });

  it('a real file redirect (> file) IS still extracted', () => {
    expect(targets('echo x > realfile.txt')).toContain('realfile.txt');
  });

  it('mixed: > out.log 2>&1 extracts only out.log, not the fd dup', () => {
    const t = targets('make build > out.log 2>&1');
    expect(t).toContain('out.log');
    expect(t).not.toContain('&1');
  });

  it('append redirect (>> file) is still extracted; fd append (&>>) is not', () => {
    expect(targets('echo x >> log.txt')).toContain('log.txt');
    expect(targets('cmd &>> /dev/null')).not.toContain('/dev/null');
  });
});
