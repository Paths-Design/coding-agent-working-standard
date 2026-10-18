import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseRepoHookPolicy, type GuardConfig } from '../init/repo-hook-policy';

export type GuardConfiguration =
  | { status: 'ok'; guards: Record<string, GuardConfig> }
  | { status: 'absent' | 'invalid'; guards: Record<string, never> };

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
  if (!object(document)) return { status: 'invalid', guards: {} };
  let guards = document.guards;
  if (guards === null) guards = undefined;
  if (object(guards)) {
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
    if (/^non_governed_zones:[ \t]*$/.test(line)) {
      inside = true;
      continue;
    }
    if (inside && /^[^ \t#-]/.test(line)) inside = false;
    if (!inside) continue;
    const match = /^[ \t]+-[ \t]+(.*)$/.exec(line);
    if (!match) continue;
    let zone = (match[1] ?? '').replace(/[ \t]+#.*$/, '');
    if (!zone) continue;
    for (const quote of ['"', "'"]) {
      if (zone.endsWith(quote)) zone = zone.slice(0, -1);
      if (zone.startsWith(quote)) zone = zone.slice(1);
    }
    zone = zone.replace(/\/\*\*?$/, '');
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
  const read = (relative: string): string | null => {
    try {
      return readFileSync(join(projectDirectory, relative), 'utf8');
    } catch {
      return null;
    }
  };
  return guardConfigurationEnvironment(
    read('.caws/hooks/hook-policy.json'),
    read('.caws/policy.yaml')
  );
}
