# Commit Message Conventions

This repository uses [Conventional Commits](https://conventionalcommits.org/) for automated versioning and changelog generation.

## Format

```
<type>[optional scope]: <description>

[optional body]

[optional footer(s)]
```

## Types

- **feat**: A new feature
- **fix**: A bug fix
- **docs**: Documentation only changes
- **style**: Changes that do not affect the meaning of the code (white-space, formatting, missing semi-colons, etc)
- **refactor**: A code change that neither fixes a bug nor adds a feature
- **perf**: A code change that improves performance
- **test**: Adding missing tests or correcting existing tests
- **build**: Changes that affect the build system or external dependencies
- **ci**: Changes to our CI configuration files and scripts
- **chore**: Other changes that don't modify src or test files

## Examples

### Feature
```
feat: add user authentication system
```

### Bug Fix
```
fix: resolve memory leak in data processing
```

### Documentation
```
docs: update API documentation for new endpoints
```

### Refactoring
```
refactor: extract user validation logic into separate module
```

### Breaking Change
```
feat!: change API response format for user data

BREAKING CHANGE: The user object now returns additional fields and the format has changed
```

## Scope

The scope should be the name of the package or module affected by the change:

```
feat(auth): add OAuth2 authentication
fix(api): resolve endpoint timeout issue
docs(cli): update installation instructions
```

## Releases are tag-driven, not commit-driven

Commit types do **not** trigger releases or bump versions. Pushing to `main` never
publishes. Releases are tag-driven (`CAWS-RELEASE-TAG-DRIVEN-001`): the maintainer
manually bumps `packages/caws-cli/package.json`, authors the matching
`packages/caws-cli/CHANGELOG.md` section, commits, and pushes a canonical
`caws-cli-vX.Y.Z` tag. CI publishes that tagged content verbatim.

Commit types still matter — for changelog authoring, PR review, and the release
guard's commit-scope check (e.g. `fix(cli):` / `feat(cli):` signal a publishable
change) — but they are advisory inputs, not the publish trigger.

## CI/CD Integration

The tag-driven release workflow (`.github/workflows/release.yml`):
- Validates the tag matches `packages/caws-cli/package.json` version
- Validates a `CHANGELOG.md` section exists for the version
- Builds and runs the prepublish fresh-install smoke
- Publishes to npm via `NPM_TOKEN` with `npm publish --provenance` (OIDC trusted
  publishing is a planned follow-up, not the current mechanism)
- Verifies the registry and creates a GitHub Release from the CHANGELOG section

The maintainer authors the CHANGELOG and creates the tag manually. CI does not
generate changelogs, bump versions, or modify any branch. See
[`docs/release-procedure.md`](docs/release-procedure.md).
- ✅ Release notes generation
