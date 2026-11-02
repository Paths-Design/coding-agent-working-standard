# ESLint minimatch adapter

This private development adapter exports the real `minimatch` function and attached
`Minimatch` class from `minimatch@11.0.4` through a CommonJS default. The npm alias
keeps its patched implementation separate from the legacy dependency edge.

Use it only for the pinned ESLint, `@eslint/config-array`, and `@eslint/eslintrc`
consumers whose executable contracts construct `Minimatch`, call `match`, and read
`pattern`. It does not recreate removed matching APIs or carry the legacy matcher.
Parent upgrades require rechecking those call sites and the CJS/ESM contracts.

Development qualification uses Node 22. This adapter does not establish Node 18
support for development tools. The CLI's Node 18 consumer contract is verified
separately against a packed installation with development dependencies omitted.

Matching compatibility requires exact file-selection comparisons, hostile glob
controls, the real ESLint entry points, and full Jest, coverage and mutation
qualification. An audit result alone does not establish these properties.

The root development dependency named `minimatch` seeds the local link for the
three scoped legacy `$minimatch` overrides. Modern consumers have separate pinned
registry overrides. Verify their actual resolved edges: root and the three legacy
consumers use this adapter; glob, Stryker, TypeScript ESLint, and both test-exclude
instances use the patched upstream module. Dependency updates require rechecking
this complete consumer set and fresh installation, rather than copying a lockfile
whose links only appear valid.
