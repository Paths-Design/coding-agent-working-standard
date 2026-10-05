---
doc_id: command-reference
authority: reference
status: active
title: CAWS command reference
owner: CAWS maintainers
updated: 2026-09-07
audience: consumer
---

# CAWS command reference

The installed CLI is the reference for its own command and flag surface:

```bash
caws --help
caws init --help
caws init adapters install --help
caws init adapters configure --help
caws init adapters migrate --help
caws init adapters rollback --help
caws init migrate apply --help
```

During packaging, this landing page is replaced in the transport artifact by
an exhaustive reference generated from
`packages/caws-cli/src/shell/command-metadata.ts`. The same typed command tree
registers the live parser and help. Maintainers build the CLI and run
`npm run docs:stage --workspace @paths.design/caws-cli`; the resulting
`packages/caws-cli/docs/command-reference.md` is ignored and never committed.
`npm run docs:check --workspace @paths.design/caws-cli` checks that artifact and
the authored guidance markers. See [CLI workflows](api/cli.md) for the distinctions
between installation, configuration, adoption, and governance.
