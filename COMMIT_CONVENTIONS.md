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

## Automated Publishing

Commits following these conventions will automatically:

1. **Trigger releases** when pushed to `main`
2. **Generate changelogs** based on commit messages
3. **Bump versions** according to semantic versioning:
   - `fix:` → patch release (1.0.0 → 1.0.1)
   - `feat:` → minor release (1.0.0 → 1.1.0)
   - `feat!:` → major release (1.0.0 → 2.0.0)

## CI/CD Integration

The automated release process includes:
- ✅ Linting and testing
- ✅ Package building
- ✅ NPM publishing with OIDC authentication
- ✅ Changelog generation
- ✅ Git tag creation
- ✅ Release notes generation
