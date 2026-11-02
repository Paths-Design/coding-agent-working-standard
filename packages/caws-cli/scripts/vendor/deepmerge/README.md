# CAWS deepmerge patch

This private development dependency retains the deepmerge 4.3.1 CommonJS function,
`.all`, and merge options. CAWS maintains it for Jest configuration merging.

The source derives from the published `deepmerge@4.3.1` bundle at upstream commit
`5b87756a5671635679001cbac72aa42f23472c81`. Original bundle SHA256:
`2e5160f84a1141bd927264afe4d15766f1e6cf07daef182b37ff53fea121de7d`.
Original license SHA256:
`6cfc4687cb2f2d86f4a77e6b526290d3878e5e512f3fec2f4cb36a9cb36f798b`.

The security change rejects `__proto__` before reading or assigning keys in both
object-copy loops. It addresses [GHSA-gcqx-w48m-w2h4](https://github.com/advisories/GHSA-gcqx-w48m-w2h4)
using the approach in [upstream PR 274](https://github.com/TehShrike/deepmerge/pull/274).
Formatting follows the repository formatter. The MIT license and original copyright
are retained in `LICENSE`.

This package is a maintained local patch, not an upstream release. Its name and
version identify that distinction. Removal requires a reviewed upstream or replacement
implementation passing the hostile merge controls, real Jest configuration tests,
and the complete release qualification. Keep this package outside the CLI tarball.

The root development dependency named `deepmerge` creates the local link before
Jest's scoped `$deepmerge` override resolves it. npm resolves relative directory
overrides differently during fetching and validation; the root reference supplies
one existing, valid target. Fresh `npm ci`, `npm ls`, and installed-byte checks are
required to preserve this dependency contract.
