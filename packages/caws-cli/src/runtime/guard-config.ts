import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { assertMachinePath } from '../init/machine-paths';
import type { ActiveInvocationSelection } from './selection';
import { loadGuardConfigurationEnvironment } from './guard-config-loader';
export * from './guard-config-loader';

const STOCK_CONFIGURATION_SOURCES: Readonly<Record<string, string>> = Object.freeze({
  'guard-config.sh': 'c3d9d5b0f6ffb4eb6add5a3f27b2d3d2bf7f46d86b39614c351e8b5bba06c73c',
  'guard-config.cjs': '4065e9febf662dd9a3933b65926e913ecd50b3bca73a4192e44f1097cc982b11',
});

/** Indexed assignments are private transport, not a caller policy API.
 * Public controls, including ask incapability and parser selection, are not
 * configuration assignments and must survive this boundary.
 */
export function clearGuardConfigurationTransport(environment: Record<string, string>): void {
  for (const name of Object.keys(environment))
    if (
      name === 'CAWS_GUARD_CONFIG_STATUS' ||
      name.startsWith('CAWS_GUARD_ZONE_') ||
      name.startsWith('CAWS_GUARD_PREFIX_') ||
      name.startsWith('CAWS_GUARD_THRESHOLD_')
    )
      delete environment[name];
}

/** Read once at dispatch for the reviewed stock loader/parser pair.
 * Selected custom code and shell startup retain their compatibility parse.
 */
export function invocationGuardConfiguration(
  selection: ActiveInvocationSelection,
  environment: Readonly<Record<string, string>>
): Readonly<Record<string, string>> {
  const result = { ...environment };
  clearGuardConfigurationTransport(result);
  const startup = join(selection.runtimeDirectory, 'handler-env.sh');
  if (
    selection.configuration !== 'system' ||
    Object.keys(selection.libraryOverrides).length > 0 ||
    Object.values(selection.libraries).some(
      (library) => library.kind === 'project' || library.kind === 'user'
    ) ||
    environment.CAWS_GUARD_CONFIG_PY ||
    environment.CAWS_PRIOR_BASH_ENV ||
    (environment.BASH_ENV && environment.BASH_ENV !== startup) ||
    environment.ENV ||
    Object.entries(environment).some(
      ([name, value]) =>
        value && (name.startsWith('BASH_FUNC_') || name === '_CAWS_GUARD_CONFIG_SH_SOURCED')
    )
  )
    return Object.freeze(result);
  for (const [name, expected] of Object.entries(STOCK_CONFIGURATION_SOURCES)) {
    const selected = selection.libraries[name];
    const file = join(selection.runtimeDirectory, 'lib', name);
    if (
      !selected ||
      selected.kind !== 'shared' ||
      selected.path !== file ||
      selected.sha256 !== expected ||
      selection.libraryOverrides[name]
    )
      return Object.freeze(result);
  }
  try {
    for (const [name, expected] of Object.entries(STOCK_CONFIGURATION_SOURCES)) {
      const file = join(selection.runtimeDirectory, 'lib', name);
      assertMachinePath(selection.runtimeDirectory, file);
      if (createHash('sha256').update(readFileSync(file)).digest('hex') !== expected)
        throw new Error('Selected guard configuration source changed after selection');
    }
  } catch {
    throw new Error(
      'Selected guard configuration source changed or became unavailable after selection'
    );
  }
  const assignments = loadGuardConfigurationEnvironment(selection.checkout);
  if (assignments.CAWS_GUARD_CONFIG_STATUS === 'unsupported') return Object.freeze(result);
  Object.assign(result, assignments);
  return Object.freeze(result);
}
