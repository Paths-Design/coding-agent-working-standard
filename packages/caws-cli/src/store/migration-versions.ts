/**
 * Source schema versions the migrators accept.
 *
 * `caws specs migrate --from` and `caws events migrate --from` both accept
 * exactly one value, and before this module that fact was written six times:
 * two `--from` help descriptions, two `opts.from !== 'v10'` guards, and two
 * rejection messages. Four of those six were user-facing, and all four named
 * the CAWS version the restriction was introduced in — so they went on saying
 * "in v11.2" while the package shipped 12.2.0-rc.2.
 *
 * Both halves now read this constant. The help cannot advertise a version the
 * guard refuses, the guard cannot refuse a version the help advertises, and
 * neither mentions a release number: what matters to a caller is which source
 * schema is accepted, not when that became true. The release it landed in is
 * git history's job, not the error message's.
 *
 * Adding a migratable source schema means adding it here and giving it a
 * conversion path; the help and both diagnostics follow without an edit.
 */
export const MIGRATABLE_SOURCE_VERSIONS = ['v10'] as const;

export type MigratableSourceVersion = (typeof MIGRATABLE_SOURCE_VERSIONS)[number];

/** True when `value` names a source schema the migrators can read. */
export function isMigratableSourceVersion(value: unknown): value is MigratableSourceVersion {
  return (
    typeof value === 'string' && (MIGRATABLE_SOURCE_VERSIONS as readonly string[]).includes(value)
  );
}

/**
 * The accepted set as it appears in a diagnostic, e.g. `v10` or `v10 or v11`.
 * Shared so the two rejection messages cannot describe the set differently.
 */
export function describeMigratableSourceVersions(): string {
  const versions: readonly string[] = MIGRATABLE_SOURCE_VERSIONS;
  const last = versions[versions.length - 1];
  // Total by construction rather than by assertion: an empty set would mean the
  // migrators accept nothing, and a diagnostic that says so is recoverable
  // where a non-null assertion would throw inside an error path.
  if (last === undefined) return 'no source version (none is configured)';
  if (versions.length === 1) return last;
  return `${versions.slice(0, -1).join(', ')} or ${last}`;
}
