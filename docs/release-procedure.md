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
- **`caws-kernel-v*` tags**: refused and deleted with "kernel CI publish is
  not enabled in v1." The prefix is RESERVED until a future kernel CI publish
  slice activates it. Kernel still publishes manually (see
  [Publishing caws-kernel](#publishing-caws-kernel)).
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

### Footgun: registry-stale kernel resolution

Any CLI release depending on **newly added kernel symbols** must prove
the matching kernel tarball is the one npm will install — not a
registry-stale kernel that happens to satisfy the semver range but
predates the new symbols. Caught live during
`MULTI-AGENT-ACTIVITY-REGISTRY-001` commit 6: the CLI's
`agents register` shell command imports `registerAgentSession` from
`@paths.design/caws-kernel`, and the CLI's dep range
(`"^1.0.0"`) is satisfied by the registry's `1.1.1` — but that
registry kernel was published **before** the lease symbols were added.
`npm install <cli-tarball>` resolved kernel from the registry and the
CLI crashed at runtime with
`(0, caws_kernel_1.registerAgentSession) is not a function`.

Two enforcement layers, in order of strength:

1. **Pre-publish (preferred):** the
   `packages/caws-cli/scripts/fresh-install-smoke.mjs` script (run by
   `prepublishOnly`) packs BOTH the local kernel tarball AND the local
   cli tarball and installs both into a scratch project. It then
   probe-asserts that the installed kernel exports the symbols the CLI
   imports (currently `registerAgentSession`; extend the probe as new
   coupled symbols land). If npm resolution picks up a registry copy
   instead of the local tarball, this assertion fails fast with a
   structured diagnostic naming the missing symbol and the version
   gap. This catches the footgun before any tag is pushed.

2. **Post-publish (release-time):** within ~5 minutes of publishing
   the kernel, run the smoke against the registry copy
   (not the local tarball) to confirm `npm install
   @paths.design/caws-cli@<new>` actually resolves
   `@paths.design/caws-kernel@<new>`. If a downstream consumer's lock
   file pins an older kernel, the same `not a function` failure
   reappears for them on `npm ci`.

The doctrinal rule: a CLI release that depends on coupled kernel
symbols is incomplete until either the prepublishOnly smoke or a
post-publish equivalent has run against installed artifacts (NOT
against source). Source tests can pass while installed users crash.

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
