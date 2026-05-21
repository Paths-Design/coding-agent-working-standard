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

V1 publishes **only `@paths.design/caws-cli`**. Other tag patterns are refused
explicitly:

- **Bare `v*` tags** (legacy convention from v11.0–v11.1.4): refused with a
  pointer to the new convention. They remain on origin as historical record
  but no new bare `v*` tag will publish.
- **`caws-kernel-v*` tags**: refused with "kernel CI publish is not enabled in
  v1." Kernel still publishes manually (see [Publishing caws-kernel](#publishing-caws-kernel)).

## Asymmetric failure invariant

Failure handling depends on **when** the failure happens:

| Failure stage | Tag handling | Registry handling |
|---|---|---|
| Tag refusal (parse) | Preserved (it's informational) | Untouched |
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

Before merging the PR whose content you'll release, verify the
release-guard PR advisory check is green. It tells you what a tag for this PR's
content would publish.

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
is the tag push, NOT the branch push. The release-guard advisory at
PR time told you nothing would publish from a branch push, and that
remains true.

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

### Tag refused (exit code 10)

The tag does not match an enabled package prefix. The tag remains; the
workflow did nothing. Either:
- Delete the tag (`git push origin :caws-cli-v11.1.5`) if it was a mistake
- Rename and re-tag with the canonical convention

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

## Publishing caws-kernel

**Manual only in v1.** Tag-driven CI publish for `caws-kernel` is a
follow-up slice. Until that lands, publish kernel by hand:

```bash
cd packages/caws-kernel
# Update package.json version and CHANGELOG.md (if maintained)
npm publish --access public --provenance
```

The `NPM_TOKEN` you used to publish v1.1.0 and v1.1.1 still works (bypass-2FA
token created during the cascade).

## Coupled-release ordering

For a coupled release where caws-cli depends on a new caws-kernel version:

1. Publish kernel manually first (see above). Verify registry.
2. Update `packages/caws-cli/package.json` to depend on the new kernel
   version (and any other necessary code changes).
3. Bump caws-cli version, update its CHANGELOG.
4. Commit. Tag `caws-cli-vX.Y.Z`. Push tag.

If the cli publish fails post-publish-of-kernel, **kernel is not rolled
back**. Coupled-release atomicity is "ordered, observable, repairable" —
not all-or-nothing. npm does not provide cross-package transactionality.

## What to do if the bypass-2FA NPM_TOKEN expires or is revoked

The token is stored as `NPM_TOKEN` in the `Release` GitHub environment.
Created 2025-10-01, last refreshed 2026-05-20.

To rotate:
1. On npmjs.com, generate a new granular token with:
   - Permission: **Read and write** for `@paths.design/caws-cli` (and `caws-kernel`)
   - **Bypass 2FA for write actions: enabled** (required for non-interactive publish)
2. In the GitHub repo settings → Environments → Release → update `NPM_TOKEN`.
3. No workflow change needed.

If you migrate to OIDC trusted-publisher (future follow-up slice), the
token can be retired entirely. That migration is out of scope for v1.

## Related specs

- `CAWS-RELEASE-TAG-DRIVEN-001` — this slice
- `RELEASE-AUTOMATION-GUARD-NONPUBLISH-COMMITS-001` — PR-time release-guard
  advisory layers (Layer 1/2/3) that survive into the new workflow
- `V11-DOCTRINE-HYGIENE-001` — tarball-truth hard-block (now invoked as a
  prepublishOnly smoke step, not a release.yml step)

## Migration note

Tags created before 2026-05-21 (`v11.0.0` through `v11.1.4`) follow the
legacy bare `v*` convention. They remain on origin as historical record. They
are NOT a valid publish path; pushing a new `v*` tag will be refused. Use the
canonical `caws-cli-vX.Y.Z` convention going forward.
