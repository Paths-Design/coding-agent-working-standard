# Manual Release

Releases are automated via `scripts/multi-package-release.mjs` triggered by the GitHub Release workflow on push to main.

## Packages released
- `@paths.design/caws-cli` — CLI tool
- `@paths.design/caws-types` — Type definitions
- `@paths.design/quality-gates` — Quality gate scripts

## Manual override
If the automated release fails, run:
```bash
node scripts/multi-package-release.mjs
```

This requires `GITHUB_TOKEN` and `NPM_TOKEN` environment variables.
