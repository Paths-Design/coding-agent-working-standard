# Manual Release

Releases are **tag-driven** (`CAWS-RELEASE-TAG-DRIVEN-001`). Pushing a branch — including `main` — never publishes. The Release workflow (`.github/workflows/release.yml`) triggers only on tag pushes and publishes the tagged content verbatim.

**The canonical procedure is [`docs/release-procedure.md`](docs/release-procedure.md). Follow it.** This file is a pointer, not a second source of truth.

## What ships via CI

Only `@paths.design/caws-cli` is published by the Release workflow in v1. The kernel (`@paths.design/caws-kernel`) is published manually; `caws-types` and `quality-gates` are not CI release targets.

## The flow in one paragraph

The maintainer bumps `packages/caws-cli/package.json`, authors the matching `packages/caws-cli/CHANGELOG.md` section, commits, then pushes a canonical tag `caws-cli-vX.Y.Z`. CI validates that the tag matches the package version and that a CHANGELOG section exists, builds, runs the prepublish fresh-install smoke, runs `npm publish --provenance` (auth via `NPM_TOKEN`), verifies the registry, and creates a GitHub Release. Bare `v*` and `caws-kernel-v*` tags are observed, refused, and deleted from origin.

Asymmetric failure invariant: pre-publish failures delete the tag; post-publish ancillary failures preserve it and emit a repair command. See `docs/release-procedure.md` for the full step list and recovery paths.
