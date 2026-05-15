// `caws init` — vNext bootstrap of the canonical .caws/ shape.
//
// Pipeline:
//   1. resolveRepoRoot(cwd)             — needs git, NOT .caws/
//   2. initProject(repoRoot)            — store-side adapter does the work
//   3. render result                    — short summary or "already initialized"
//
// Exit codes:
//   0 = canonical state established (created OR already_initialized)
//   1 = legacy residue refused (INIT_LEGACY_RESIDUE) — non-destructive,
//       the user must clear the listed files manually
//   2 = repo-root resolution failed, write I/O failed, or the default
//       policy itself failed kernel validation
//       (INIT_DEFAULT_POLICY_INVALID — programmer error in our seed)
//
// Discipline:
//   - No --force in 7b. Force modes turn into cleanup tools and cleanup
//     belongs to a later doctor/repair surface.
//   - The seeded policy MUST pass kernel validation BEFORE landing on
//     disk. If our default is bad, that's a programmer error and exit 2
//     is correct — we do NOT write a known-invalid policy just to keep
//     `init` succeeding.
//   - Init never overwrites existing canonical files. Idempotent rerun
//     reports "already initialized"; partial state is filled in
//     additively (a half-bootstrapped project becomes whole).

import { initProject, resolveRepoRoot } from '../../store';
import { renderDiagnostics } from '../render/diagnostic';
import { renderInit } from '../render/init';

export interface InitCommandOptions {
  readonly cwd?: string;
  readonly out?: (line: string) => void;
  readonly err?: (line: string) => void;
  readonly showData?: boolean;
}

export function runInitCommand(opts: InitCommandOptions = {}): number {
  const cwd = opts.cwd ?? process.cwd();
  const out = opts.out ?? ((s: string) => process.stdout.write(s + '\n'));
  const err = opts.err ?? ((s: string) => process.stderr.write(s + '\n'));
  const showData = opts.showData === true;

  // 1. Resolve repo root. We do NOT pass requireCawsDir — the whole
  //    point of init is to create .caws/, so failing on its absence
  //    here would be self-contradictory.
  const root = resolveRepoRoot(cwd);
  if (!root.ok) {
    err('caws init: failed to resolve repo root.');
    err(renderDiagnostics(root.errors, { showData }));
    return 2;
  }
  const { repoRoot } = root.value;

  // 2. Bootstrap.
  const result = initProject(repoRoot);
  if (!result.ok) {
    // Decide exit code from the diagnostic rule. Legacy residue is a
    // user-correctable domain error (1); everything else is a hard
    // store/programmer failure (2).
    const isLegacy = result.errors.some(
      (d) => d.rule === 'store.init.legacy_residue'
    );
    err(
      isLegacy
        ? 'caws init: refusing to overwrite legacy state.'
        : 'caws init: failed to bootstrap project.'
    );
    err(renderDiagnostics(result.errors, { showData }));
    return isLegacy ? 1 : 2;
  }

  // 3. Render and exit.
  out(renderInit({ result: result.value, repoRoot }));
  return 0;
}
