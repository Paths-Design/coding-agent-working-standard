import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { TextDecoder } from 'node:util';
import { parseRepoHookPolicy, type GuardConfig } from '../init/repo-hook-policy';
import { assertMachinePath } from '../init/machine-paths';
import type { ActiveInvocationSelection } from './selection';
import { parseJsonSource, objectMemberSource } from './json-custody';

export type GuardConfiguration =
  | { status: 'ok'; guards: Record<string, GuardConfig> }
  | { status: 'absent' | 'invalid' | 'unsupported'; guards: Record<string, never> };

const object = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** Retains the optional guard loader's null-as-absent spelling, using the owning validator. */
export function parseGuardConfiguration(text: string | null): GuardConfiguration {
  if (text === null) return { status: 'absent', guards: {} };
  let document: unknown;
  try {
    document = JSON.parse(text);
  } catch {
    return { status: 'invalid', guards: {} };
  }
  // Unrelated metadata must not route unsafe guard data back through lossy
  // compatibility transport when source indexing exceeds its envelope.
  if (object(document) && object(document.guards)) {
    for (const entry of Object.values(document.guards)) {
      if (!object(entry) || !Array.isArray(entry.additional_allow_prefixes)) continue;
      for (const prefix of entry.additional_allow_prefixes) {
        if (
          object(prefix) &&
          typeof prefix.prefix === 'string' &&
          (/[\0\u001c-\u001f\u0085]/.test(prefix.prefix) ||
            Buffer.from(prefix.prefix, 'utf8').toString('utf8') !== prefix.prefix)
        )
          return { status: 'invalid', guards: {} };
      }
    }
  }
  try {
    // Python's parser admits int thresholds, not floats that round to an int.
    const guardSource = objectMemberSource(parseJsonSource(text), 'guards');
    if (guardSource?.root.kind === 'object') {
      for (const guard of guardSource.root.entries.values()) {
        if (guard.kind !== 'object') continue;
        const thresholds = guard.entries.get('thresholds');
        if (thresholds?.kind !== 'object') continue;
        for (const value of thresholds.entries.values()) {
          if (
            value.kind === 'number' &&
            !/^-?(?:0|[1-9][0-9]*)$/.test(text.slice(value.start, value.end))
          )
            return { status: 'invalid', guards: {} };
        }
      }
    }
  } catch {
    // Indexing has a smaller resource envelope than the selected Python parser.
    // An unindexed document cannot establish a typed verdict about that parser.
    return { status: 'unsupported', guards: {} };
  }
  if (!object(document)) return { status: 'invalid', guards: {} };
  let guards = document.guards;
  if (guards === null) guards = undefined;
  if (object(guards)) {
    for (const entry of Object.values(guards)) {
      if (!object(entry) || !Array.isArray(entry.additional_allow_prefixes)) continue;
      for (const prefix of entry.additional_allow_prefixes) {
        if (
          object(prefix) &&
          typeof prefix.prefix === 'string' &&
          /[\u001c-\u001f\u0085]/.test(prefix.prefix)
        )
          return { status: 'invalid', guards: {} };
        if (
          object(prefix) &&
          typeof prefix.reason === 'string' &&
          Array.from(
            prefix.reason.replace(/^[\s\u001c-\u001f\u0085]+|[\s\u001c-\u001f\u0085]+$/g, '')
          ).length < 12
        )
          return { status: 'invalid', guards: {} };
      }
    }
    guards = Object.fromEntries(
      Object.entries(guards).map(([name, entry]) => {
        if (!object(entry)) return [name, entry];
        return [
          name,
          Object.fromEntries(
            Object.entries(entry).filter(
              ([key, value]) =>
                value !== null || (key !== 'additional_allow_prefixes' && key !== 'thresholds')
            )
          ),
        ];
      })
    );
  }
  const parsed = parseRepoHookPolicy(JSON.stringify({ version: 1, guards }));
  return parsed.ok
    ? { status: 'ok', guards: parsed.policy.guards }
    : { status: 'invalid', guards: {} };
}

/** Legacy transport normalization only; this does not adjudicate kernel scope. */
export function parseNonGovernedZones(text: string | null): string[] {
  if (text === null) return [];
  const zones: string[] = [];
  let inside = false;
  for (const line of text.split('\n')) {
    if (/^non_governed_zones:[ \t]*(?![\s\S])/.test(line)) {
      inside = true;
      continue;
    }
    if (inside && /^[^ \t#-]/.test(line)) inside = false;
    if (!inside) continue;
    const match = /^[ \t]+-[ \t]+([\s\S]*)/.exec(line);
    if (!match) continue;
    let zone = (match[1] ?? '').replace(/[ \t]+#[\s\S]*$/, '');
    if (!zone) continue;
    for (const quote of ['"', "'"]) {
      if (zone.endsWith(quote)) zone = zone.slice(0, -1);
      if (zone.startsWith(quote)) zone = zone.slice(1);
    }
    zone = zone.replace(/\/\*\*?(?![\s\S])/, '');
    if (zone) zones.push(zone.endsWith('/') ? zone : `${zone}/`);
  }
  return zones;
}

export function mangleGuardName(name: string): string {
  return name.replace(/[^A-Za-z0-9]/g, '_').toUpperCase();
}

/** One request's assignment table; never mutates the process environment. */
export function guardConfigurationEnvironment(
  policy: string | null,
  yaml: string | null
): Record<string, string> {
  const zones = parseNonGovernedZones(yaml);
  const parsed = parseGuardConfiguration(policy);
  const output: Record<string, string> = { CAWS_GUARD_ZONE_COUNT: String(zones.length) };
  zones.forEach((zone, index) => {
    output[`CAWS_GUARD_ZONE_${index}`] = zone;
  });
  output.CAWS_GUARD_CONFIG_STATUS = parsed.status;
  if (parsed.status === 'ok') {
    for (const [name, entry] of Object.entries(parsed.guards)) {
      const key = mangleGuardName(name);
      output[`CAWS_GUARD_PREFIX_COUNT_${key}`] = String(entry.additional_allow_prefixes.length);
      entry.additional_allow_prefixes.forEach(({ prefix }, index) => {
        output[`CAWS_GUARD_PREFIX_${key}_${index}`] = prefix;
      });
      for (const [threshold, value] of Object.entries(entry.thresholds)) {
        output[`CAWS_GUARD_THRESHOLD_${key}_${mangleGuardName(threshold)}`] = String(value);
      }
    }
  }
  return output;
}

export function serializeGuardEnvironment(environment: Readonly<Record<string, string>>): string {
  return Object.entries(environment)
    .filter(([name, value]) => /^CAWS_GUARD_[A-Z0-9_]+$/.test(name) && !value.includes('\n'))
    .map(([name, value]) => `${name}=${value}\n`)
    .join('');
}

/** Filesystem failures retain the shipped defaults, matching the optional loader. */
export function loadGuardConfigurationEnvironment(
  projectDirectory: string
): Record<string, string> {
  const read = (
    relative: string
  ): { status: 'ok'; text: string } | { status: 'absent' | 'encoding' } => {
    let bytes: Buffer;
    try {
      bytes = readFileSync(join(projectDirectory, relative));
    } catch {
      return { status: 'absent' };
    }
    try {
      return {
        status: 'ok',
        text: new TextDecoder('utf-8', { fatal: true, ignoreBOM: true })
          .decode(bytes)
          .replace(/\r\n?/g, '\n'),
      };
    } catch {
      return { status: 'encoding' };
    }
  };
  // The shell parser emits YAML zones before reading guard JSON. Preserve both
  // that partial diagnostic transport and Python text-mode newline handling.
  const yaml = read('.caws/policy.yaml');
  if (yaml.status === 'encoding')
    return { CAWS_GUARD_ZONE_COUNT: '0', CAWS_GUARD_CONFIG_STATUS: 'unavailable' };
  const policy = read('.caws/hooks/hook-policy.json');
  const result = guardConfigurationEnvironment(
    policy.status === 'ok' ? policy.text : null,
    yaml.status === 'ok' ? yaml.text : null
  );
  if (policy.status === 'encoding') result.CAWS_GUARD_CONFIG_STATUS = 'unavailable';
  return result;
}

const STOCK_CONFIGURATION_SOURCES: Readonly<Record<string, string>> = Object.freeze({
  'guard-config.sh': '934d60a8a56068caf2129a5705f207bf4b1203f2164dd385a057e510505cbd55',
  'guard-config.py': '55496bed9393fd458c3fda326973067dffa309553eb915018cc462ce963ba7e0',
});

/** Indexed assignments are private transport, not a caller policy API.
 * The explicit parser and public guard threshold overrides remain separate.
 */
export function clearGuardConfigurationTransport(environment: Record<string, string>): void {
  for (const name of Object.keys(environment))
    if (name.startsWith('CAWS_GUARD_') && name !== 'CAWS_GUARD_CONFIG_PY') delete environment[name];
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
  // Reject unrepresentable stock data. Bash removing NUL could transform a
  // repo-relative prefix into an absolute grant; compatibility cannot license it.
  if (
    Object.values(assignments).some(
      (value) => value.includes('\0') || Buffer.from(value, 'utf8').toString('utf8') !== value
    )
  )
    return Object.freeze({
      ...result,
      CAWS_GUARD_CONFIG_STATUS: 'invalid',
      CAWS_GUARD_ZONE_COUNT: '0',
    });
  if (assignments.CAWS_GUARD_CONFIG_STATUS === 'unsupported') return Object.freeze(result);
  Object.assign(result, assignments);
  return Object.freeze(result);
}
