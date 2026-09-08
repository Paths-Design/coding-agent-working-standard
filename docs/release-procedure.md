# Release procedure (CAWS-RELEASE-TAG-DRIVEN-001 v1)

This is the canonical release procedure for `@paths.design/caws-cli` as of
`v11.1.4+1` (the first release under tag-driven CI).

## Summary

Releases are **deterministic and human-explicit**. CI does NOT decide when to
publish, what version to publish, or what to put in the CHANGELOG. The human
maintainer makes all three decisions, commits them, then pushes a tag. CI
publishes the tagged content verbatim.

The previous semantic-release-driven pipeline (branch-push trigger, commit-
message version inference, version-bump commits pushed back to main) is
retired. It was the structural cause of three "ghost releases" in the v11.1.x
cascade. See `CAWS-RELEASE-TAG-DRIVEN-001` for the full incident trail.

## What CI does

Pushing a tag matching `caws-cli-v*` triggers the Release workflow. Its publish
job depends on the reusable **Release Qualification** workflow at the same
tagged commit. Qualification runs the complete Jest suite, lint, typechecking,
documentation checks, Bats and Python hook tests, plus packaged upgrades on
Linux/macOS with Node 18, 20 and 22. The macOS lane also runs the Bash 3.2
regression suite. A failed qualification prevents the publish job from starting
and preserves the tag for investigation.

Once qualification succeeds, the publish job:

1. Checks out the tag SHA (not a branch)
2. Validates `packages/caws-cli/package.json` version equals the tag version
3. Validates `packages/caws-cli/CHANGELOG.md` has a section for the version
4. Builds caws-cli via Turbo
5. Runs prepublish fresh-install smoke (`npm run smoke:fresh-install -w @paths.design/caws-cli`)
6. Runs `npm publish --access public --provenance --tag <channel>` (`next` for
   prereleases such as `12.2.0-rc.1`, `latest` for stable versions)
7. Polls `npm view @paths.design/caws-cli@<version>` to confirm registry has it
8. Creates a GitHub Release with the CHANGELOG section as body, marking
   prereleases with `--prerelease`

Qualification also runs on pull requests and pushes to `main`. The existing
post-publication platform matrix is additional consumer observation; it cannot
substitute for qualification before publication.

## Machine runtime qualification

Run the installed-artifact upgrade check locally after building:

```bash
npm run build -w @paths.design/caws-cli
node packages/caws-cli/scripts/runtime-upgrade-smoke.mjs --report /tmp/caws-upgrade-report.json
```

The runner installs the actual npm `12.1.0` baseline, creates stock and custom
Codex/Claude projects, replaces the package with a packed candidate, then tests
machine installation, registration and project migration. It verifies preview
purity, repeat operation stability, exact governance preservation, retained
custom behavior, mixed migrated/unmigrated projects, linked worktrees, lifecycle
rendering, delivery of one shared guard/renderer update to two projects, corrupt
snapshot refusal and verified rollback. It uses disposable HOME, CAWS_HOME,
Git configuration and npm configuration, with no inherited agent identity.
The report records the platform, Node version, baseline version, candidate
tarball SHA-256 and runtime digest. It also audits the detached upgraded
consumer with `npm audit --omit=dev --audit-level=low`, requires zero findings,
and records that consumer lockfile's hash. This checks the dependency graph
actually installed by users, without workspace overrides. CI retains the report under a commit-named artifact;
generated reports are not committed to the source ledger.

These are subprocess fixtures. Before a runtime release, retain separate fresh
native traces from the intended harnesses proving trust, SessionStart, an
expected guarded-write refusal, Stop and the rendered user/tool record.
For Sterling, also prove its retained custom behavior and reconcile its local
handler/library pins using the
[Sterling migration guide](guides/sterling-machine-runtime-migration.md).
Successful Codex migration does not establish Claude adoption, and installed
configuration does not prove native execution. The release qualification matrix
covers native runtime subprocesses on Linux/macOS; it makes no Windows native
harness claim.

Before selecting a release candidate, require current mutation topology,
successful baseline/discovery, and per-file mutation results for kernel, store
and shell on the candidate commit. A setup/import failure is inconclusive,
not a killed mutant. Release Qualification currently does not run that mutation
pipeline: dispatch the Mutation Gate for the candidate branch and check its
retained reports separately before publication. A green qualification run alone
is not release approval.

## Dependency, coverage and fixture gates

`npm run audit:dependencies` audits the committed lockfile, including development
tools, and fails on any reported severity or registry error. Both PR CI and
Release Qualification require it. The installed-package audit above is separate:
a clean workspace lockfile does not establish a clean consumer installation.

The combined Jest run owns coverage selection and thresholds at the top level
of `packages/caws-cli/jest.config.js`. It collects the compiled runtime and
directly tested kernel source, includes unexecuted files, and excludes test
helpers. Source maps combine kernel unit and compiled integration execution.
Both PR CI and Release Qualification request coverage and retain the JSON and
LCOV reports in a commit-named artifact, including when a threshold fails.
The init/machine-runtime surface requires 85% statements, 70% branches, 90%
functions and 85% lines. After subtracting that group, the remaining runtime
requires 60% statements, 50% branches, 60% functions and 60% lines. These are
regression floors, not correctness proof; the 18 per-file mutation targets keep
their separate 80% floors. CLI entry points exercised only in child processes
remain zero in Jest's in-process report; installed-artifact fixtures supply
their behavioral evidence rather than manufacturing coverage hits.

Git fixtures discard inherited Git storage/config overrides. An interrupted
copy is never retried or accepted: it removes its owned partial destination and
throws with the original cause, process/worker identity, source/destination
paths and observed filesystem state. If the earlier intermittent ENOENT recurs,
retain this diagnostic with the CI run. Its historical cause is unconfirmed;
passing stress runs do not establish that cause or prove it fixed.

## What CI does NOT do

- ❌ Modify `package.json` (no version bumps)
- ❌ Modify `CHANGELOG.md` (no auto-generation)
- ❌ Commit anything back to `main`
- ❌ `git push` from CI to any branch
- ❌ Trigger on `push: branches: [main]` (there is no such trigger)
- ❌ Invoke `semantic-release` on the publish path
- ❌ Decide what version to publish (the maintainer encoded that in the tag)

## V1 scope

V1 publishes **only `@paths.design/caws-cli`**. The workflow triggers on three
tag patterns (`caws-cli-v*`, `caws-kernel-v*`, `v*`) so it can observe and
explicitly refuse the non-accepted ones; silent non-trigger would leave refused
tags as false release evidence on origin, which is the ambiguity class this
slice eliminates.

Refused tags are **DELETED from origin** via `gh api`:

- **Bare `v*` tags** (legacy convention from v11.0–v11.1.4): NEW pushes are
  refused and the tag is deleted with a pointer to the new convention.
  **Existing historical `v*` tags on origin are NOT rewritten** — they
  pre-date this slice and remain as audit record. Only newly-pushed bare-v
  tags trigger refusal-and-deletion.
- **`caws-kernel-v*` tags**: refused and deleted. The kernel is absorbed into
  the CLI (CAWS-ABSORB-KERNEL-01) and ships inside the caws-cli tarball at
  `dist/kernel/`; there is no separate kernel package to publish, so this
  prefix has nothing to trigger (see
  [The absorbed kernel](#the-absorbed-kernel)).
- **Malformed `caws-cli-v*` tags** (e.g., `caws-cli-vabc`): refused and
  deleted with a version-format error.

## Asymmetric failure invariant

Failure handling depends on **when** the failure happens:

| Failure stage | Tag handling | Registry handling |
|---|---|---|
| Qualification or mutation dependency | **PRESERVED**; publish job never starts | Untouched by this workflow |
| Release-job step before the publish script (checkout, `npm ci`, `gh` ref read) | DELETED by the failure handler | Untouched |
| Tag refusal (any refused pattern) | DELETED via `gh api` | Untouched |
| Pre-publish validation (steps 1–3) | DELETED via `gh api` | Untouched |
| Build / smoke (steps 4–5) | DELETED | Untouched |
| `npm publish` non-zero exit (step 6) | **PRESERVED** | Unknown; inspect registry and artifact identity before retrying |
| Registry verify / GitHub Release (steps 7–8) | **PRESERVED** | Registry has the version |

Row 2 is handled by the `Roll back the tag when the publish script never ran`
step. `scripts/release-tag-publish.mjs` writes a marker
(`CAWS_RELEASE_SCRIPT_MARKER`) as soon as it starts, claiming tag-disposition
authority; the handler deletes the tag only when that marker is **absent**, so
it can never override a decision the script made — including exit 12, which
deliberately leaves an unrecognised tag alone. The most likely way to reach
this row is a lockfile desync failing `npm ci` (see step 3 below).

**Known asymmetry:** row 1 still preserves the tag, because the rollback step
lives inside the release job and a failed dependency skips that job entirely.
A qualification or mutation failure therefore leaves a tag with nothing
published, and re-tagging the same version requires deleting it first:
`gh api -X DELETE repos/<owner>/<repo>/git/refs/tags/<tag>`. Closing this would
mean promoting the handler to its own job keyed on a release-job output; it is
a deliberate open choice, not an oversight.

The asymmetric rule:

> Once `npm publish` is attempted, the registry may have accepted the package
> even if the client exits nonzero. The tag is
> the provenance anchor. We do NOT delete the tag just to restore symmetry.
> Post-publish ancillary failures emit a precise repair command and exit
> non-zero, but the tag and registry state remain.

## Procedure: releasing caws-cli

### 1. Verify the candidate commit

Before tagging, verify Release Qualification and the separate mutation evidence
on the exact candidate commit. Retain the native runtime acceptance traces and
review migration/customization notes. The maintainer decides when to publish;
the tag workflow repeats qualification before granting publication access.

Use a prerelease such as `12.2.0-rc.1` for the first machine-runtime candidate.
Its npm channel is `next`, so it does not replace the stable `latest` install.
Keep the version in package.json and the workspace lockfile synchronized, and
give the candidate an explicit matching CHANGELOG section. Do not push a release
tag until the remaining qualification and migration findings are resolved.

### 2. Author the CHANGELOG section

On a non-shipping commit on `main` (or in the PR itself), add a section to
`packages/caws-cli/CHANGELOG.md` for the target version. Any of these formats
work (the parser accepts all four):

```markdown
## [11.1.5] - YYYY-MM-DD

### Bug Fixes
- ...

### Features
- ...
```

```markdown
## 11.1.5 (YYYY-MM-DD)
...
```

The script extracts the section between this header and the next same-or-higher
header. That text becomes the GitHub Release body.

**Retitle `## [Unreleased]`; do not add a second header above it.** The
CHANGELOG accumulates work under `## [Unreleased]` between releases, and that
is the content the release is made of. Rename that header to the target
version — `## [12.2.0-rc.1] (YYYY-MM-DD)` — rather than inserting a new
version header and leaving the entries under `[Unreleased]`. Validation only
checks that a header for the version *exists*, so the second shape passes
while shipping an empty GitHub Release body. Start the next `## [Unreleased]`
section when the next change lands, not as part of this commit.

### 3. Bump `package.json`

In the same commit (or a separate one, doesn't matter — only the tag SHA's
content matters):

```bash
# In packages/caws-cli/package.json:
"version": "11.1.5"
```

**Then run `npm install` to resynchronise `package-lock.json`.** The lockfile
records the workspace package's version too. `npm ci` refuses an out-of-sync
lockfile, so forgetting this fails the release job at the install step —
before `release-tag-publish.mjs` runs, which is precisely the orphaned-tag row
in the failure table above. The tag is deleted for you, but the run is wasted.

### 4. Commit and push

```bash
git add packages/caws-cli/CHANGELOG.md packages/caws-cli/package.json package-lock.json
git commit -m "chore(release): caws-cli 11.1.5"
git push origin main
```

**Important**: this commit does NOT trigger a release. The release trigger
is the tag push, NOT the branch push — nothing publishes until you push the
matching tag.

### 5. Tag and push the tag

```bash
git tag caws-cli-v11.1.5 -m "Release caws-cli 11.1.5"
git push origin caws-cli-v11.1.5
```

This triggers the Release workflow.

### 6. Watch the workflow

```bash
gh run watch
```

The workflow logs are structured JSON for grep-ability. Look for:
- `release.start` — workflow received the tag
- `tag.parsed` — tag passed parsing
- `validation.ok` — package.json + CHANGELOG passed
- `step.end ... step=npm_publish ... ok=true` — npm publish succeeded
- `registry.verify.ok` — registry confirms the version
- `release.success` — full success

### 7. Verify outcomes

```bash
npm view @paths.design/caws-cli@11.1.5 version
# Should print: 11.1.5

gh release view caws-cli-v11.1.5
# Should show the GitHub Release with your CHANGELOG section.
```

## Failure recovery

### Tag refused-and-deleted (exit code 10)

The tag matched a release trigger pattern but is not an accepted publish
target in v1 (bare `v*`, `caws-kernel-v*`, malformed). The workflow has
already deleted the tag from origin via `gh api`. The registry is untouched.
To recover, fix the underlying cause and re-tag with the canonical convention:

```bash
git tag caws-cli-v11.1.5 -m "Release caws-cli 11.1.5"
git push origin caws-cli-v11.1.5
```

### Tag refused-but-not-deleted (exit code 11)

The refusal logic ran but the tag-deletion API call failed (unusual — e.g.,
transient gh api outage). The workflow surfaces the manual repair command:

```bash
gh api -X DELETE repos/Paths-Design/coding-agent-working-standard/git/refs/tags/<tag>
```

Run it, then re-tag with the canonical convention if appropriate.

### Defensive refusal (exit code 12)

The tag didn't match any release trigger pattern — the workflow shouldn't
have observed it. The tag is left untouched. This branch exists for defense
in depth; you should never see it in practice.

### Pre-publish failure (exit code 20)

Validation or build failed. The workflow deleted the tag via `gh api`. The
registry is untouched. Fix the underlying issue, commit a new fix, re-tag.

### Pre-publish failure with tag-deletion failure (exit code 21)

The validation/build failed AND the tag-deletion API call also failed
(unusual, e.g., transient gh api outage). The workflow surfaces a manual
repair command:

```bash
gh api -X DELETE repos/Paths-Design/coding-agent-working-standard/git/refs/tags/caws-cli-v11.1.5
```

Run it, then fix the underlying issue and re-tag.

### Post-publish ancillary failure (exit code 30)

A nonzero `npm publish` result also exits 30 with
`publish.outcome_uncertain`. The tag is preserved and no GitHub Release is
created by that run. Inspect `npm view <package>@<version> version
dist.integrity dist-tags --json` and compare the registry artifact with the
intended candidate before deciding whether to retry or repair ancillary state.
The client exit code alone does not establish that publication failed.

`npm publish` succeeded; one or both of (registry-verification poll,
GitHub Release creation) failed. The tag is preserved. The registry has
the version. The workflow output names the failed step and a repair
command. Run the repair command to complete ancillary state:

```bash
# Example: GitHub Release creation failed
gh release create caws-cli-v11.1.5 \
  --title caws-cli-v11.1.5 \
  --notes-file <path-to-CHANGELOG-section> \
  --verify-tag
```

## The absorbed kernel

`@paths.design/caws-kernel` is no longer a separate package
(CAWS-ABSORB-KERNEL-01). The kernel ships inside the CLI tarball at
`dist/kernel/`; the CLI declares no kernel dependency, and the standalone
npm package is frozen at its last release. There is nothing to publish,
no coupled-release ordering, and no cross-package version-skew footgun —
the failure class where `npm install <cli-tarball>` resolved a
registry-stale kernel missing newly-coupled symbols is structurally gone,
because one tarball carries both surfaces.

What remains of that old discipline is the single-tarball smoke: the
`fresh-install-smoke.mjs` chain (run as release step 5) packs the CLI,
asserts the absorbed kernel's load-bearing files are in the tarball
(`dist/kernel/index.js`, `dist/kernel/schemas/events/`,
`dist/kernel/spec/`), installs into a scratch project, and probe-asserts
the installed kernel entry exports the symbols the CLI imports. Installed
artifacts are the proof surface — source tests can pass while installed
users crash.

## Publish authentication: OIDC trusted publishing

Publishing authenticates via **npm trusted publishing (OIDC)** — no npm
token exists in the pipeline. First release on this path: `12.0.0`
(auth_mode `oidc-trusted-publisher`, signed provenance). Three things make
it work, and all three must hold:

1. **The trusted publisher configured on npmjs.com** (package →
   Settings → Trusted publisher) must match this repo exactly; every
   field is case-sensitive: organization/user `Paths-Design`, repository
   `coding-agent-working-standard`, workflow filename `release.yml` (the
   filename with `.yml`, not the display name), environment blank or
   exactly `Release` (the job runs in `environment: Release`).
2. **`permissions: id-token: write`** in the workflow (also used by
   provenance signing).
3. **npm ≥ 11.5.1 on the runner.** Node 22 bundles npm 10.x, which
   silently never attempts the OIDC exchange — the workflow upgrades npm
   explicitly before installing.

Two failure shapes worth knowing (both observed live in the 12.0.0
release):

- **A configured auth token preempts the OIDC exchange** — even an
  invalid one. That includes `NPM_TOKEN`/`NODE_AUTH_TOKEN` env vars and
  the `.npmrc` authToken line that `actions/setup-node`'s `registry-url`
  input writes. The workflow intentionally sets none of these. npm is
  also restricting bypass-2FA tokens for direct publishing, so the token
  path is being sunset registry-wide.
- **A rejected exchange surfaces as a misleading generic `E404`/
  `ENEEDAUTH`** rather than a trusted-publishing diagnostic
  (npm/cli#9088). If publish fails with either, check the trusted
  publisher's match fields before suspecting the pipeline.

`scripts/release-tag-publish.mjs` resolves the auth mode explicitly and
logs it (`publish.auth_mode`): a provided `NPM_TOKEN` is honored (local /
emergency use — it preempts OIDC), the OIDC path engages when
`ACTIONS_ID_TOKEN_REQUEST_URL` is present, and with neither the publish
refuses (`publish.no_auth`) and rolls the tag back.

## Related specs

- `CAWS-RELEASE-TAG-DRIVEN-001` — this slice
- `V11-DOCTRINE-HYGIENE-001` — tarball-truth hard-block (now invoked as a
  prepublishOnly smoke step, not a release.yml step)

> The retired semantic-release release-guard scripts (`release-guard-dry-run`,
> `release-guard-commit-analyzer-check`, `release-guard-scope-audit`,
> `multi-package-release`) and the `RELEASE-AUTOMATION-GUARD-NONPUBLISH-COMMITS-001`
> advisory model they backed were removed when this flow became tag-driven. They
> described a commit-push-publish model that no longer exists.

## Migration note

Tags created before 2026-05-21 (`v11.0.0` through `v11.1.4`) follow the
legacy bare `v*` convention. They remain on origin as historical record. They
are NOT a valid publish path; pushing a new `v*` tag will be refused. Use the
canonical `caws-cli-vX.Y.Z` convention going forward.
