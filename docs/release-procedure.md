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

Pushing a tag matching `caws-cli-v*` triggers exactly one Release workflow
run:

1. Checks out the tag SHA (not a branch)
2. Validates `packages/caws-cli/package.json` version equals the tag version
3. Validates `packages/caws-cli/CHANGELOG.md` has a section for the version
4. Builds caws-cli via Turbo
5. Runs prepublish fresh-install smoke (`npm run smoke:fresh-install -w @paths.design/caws-cli`)
6. Runs `npm publish --access public --provenance`
7. Polls `npm view @paths.design/caws-cli@<version>` to confirm registry has it
8. Creates a GitHub Release with the CHANGELOG section as body

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
| Tag refusal (any refused pattern) | DELETED via `gh api` | Untouched |
| Pre-publish validation (steps 1–3) | DELETED via `gh api` | Untouched |
| Build / smoke (steps 4–5) | DELETED | Untouched |
| `npm publish` non-zero exit (step 6) | DELETED | Untouched (publish did not succeed) |
| Registry verify / GitHub Release (steps 7–8) | **PRESERVED** | Registry has the version |

The asymmetric rule:

> Once `npm publish` succeeds, the registry is authoritative and the tag is
> the provenance anchor. We do NOT delete the tag just to restore symmetry.
> Post-publish ancillary failures emit a precise repair command and exit
> non-zero, but the tag and registry state remain.

## Procedure: releasing caws-cli

### 1. Verify your PR is happy

Before merging the PR whose content you'll release, verify CI is green on it.
There is no separate release-guard advisory under the tag-driven flow — the
human decides what to tag and when.

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

### 3. Bump `package.json`

In the same commit (or a separate one, doesn't matter — only the tag SHA's
content matters):

```bash
# In packages/caws-cli/package.json:
"version": "11.1.5"
```

### 4. Commit and push

```bash
git add packages/caws-cli/CHANGELOG.md packages/caws-cli/package.json
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
