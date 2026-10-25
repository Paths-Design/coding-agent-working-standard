import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { TextDecoder } from 'node:util';
import {
  GUARD_CONFIG_SURFACE,
  parseRepoHookPolicy,
  type GuardConfig,
} from '../init/repo-hook-policy';
import { parseJsonSource } from './json-custody';

export type GuardConfiguration =
  | { status: 'ok'; guards: Record<string, GuardConfig> }
  | { status: 'absent' | 'invalid' | 'unsupported'; guards: Record<string, never> };

const object = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** Whole-document grammar is checked first. Index only the final root guards
 * value, so unrelated metadata cannot exhaust the custody index. String escapes
 * and duplicate keys retain JSON.parse's last-member semantics.
 */
function lastRootGuardSource(text: string): string | null {
  let cursor = 0;
  let selected: string | null = null;
  const space = (): void => {
    while (cursor < text.length && /[ \t\r\n]/.test(text[cursor]!)) cursor++;
  };
  const stringEnd = (): void => {
    cursor++;
    while (cursor < text.length) {
      const char = text[cursor++];
      if (char === '\\') cursor++;
      else if (char === '"') return;
    }
    throw new Error('Unterminated JSON string');
  };
  const skip = (): void => {
    if (text[cursor] === '"') return stringEnd();
    if (text[cursor] !== '{' && text[cursor] !== '[') {
      while (cursor < text.length && !/[ \t\r\n,}\]]/.test(text[cursor]!)) cursor++;
      return;
    }
    let depth = 0;
    do {
      const char = text[cursor];
      if (char === '"') {
        stringEnd();
        continue;
      }
      if (char === '{' || char === '[') depth++;
      else if (char === '}' || char === ']') depth--;
      cursor++;
    } while (depth > 0 && cursor < text.length);
  };
  space();
  cursor++; // The already validated root object opener.
  space();
  while (cursor < text.length && text[cursor] !== '}') {
    const keyStart = cursor;
    stringEnd();
    const key: unknown = JSON.parse(text.slice(keyStart, cursor));
    space();
    cursor++; // The already validated colon.
    space();
    const valueStart = cursor;
    skip();
    if (key === 'guards') selected = text.slice(valueStart, cursor);
    space();
    if (text[cursor] !== ',') break;
    cursor++;
    space();
  }
  return selected;
}

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
        const schema = Object.hasOwn(GUARD_CONFIG_SURFACE, name)
          ? GUARD_CONFIG_SURFACE[name]
          : undefined;
        return [
          name,
          Object.fromEntries(
            Object.entries(entry).filter(
              ([key, value]) =>
                value !== null ||
                !(
                  (key === 'additional_allow_prefixes' && schema?.prefixes) ||
                  (key === 'thresholds' && schema && Object.keys(schema.thresholds).length > 0)
                )
            )
          ),
        ];
      })
    );
  }
  let parsed: ReturnType<typeof parseRepoHookPolicy>;
  try {
    parsed = parseRepoHookPolicy(JSON.stringify({ version: 1, guards }));
  } catch {
    return { status: 'invalid', guards: {} };
  }
  if (!parsed.ok) return { status: 'invalid', guards: {} };
  try {
    const source = lastRootGuardSource(text);
    const guardSource = parseJsonSource(source ?? 'null');
    if (guardSource.root.kind === 'object') {
      for (const guard of guardSource.root.entries.values()) {
        if (guard.kind !== 'object') continue;
        const thresholds = guard.entries.get('thresholds');
        if (thresholds?.kind !== 'object') continue;
        for (const value of thresholds.entries.values()) {
          if (
            value.kind === 'number' &&
            !/^-?(?:0|[1-9][0-9]*)$/.test(source!.slice(value.start, value.end))
          )
            return { status: 'invalid', guards: {} };
        }
      }
    }
  } catch {
    return { status: 'invalid', guards: {} };
  }
  return { status: 'ok', guards: parsed.policy.guards };
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
  // Shell transport must not truncate NULs or replace unencodable text into a
  // different authored grant. Apply the native preload boundary to the shared
  // loader before either consumer can export an assignment.
  if (
    Object.values(result).some(
      (value) => value.includes('\0') || Buffer.from(value, 'utf8').toString('utf8') !== value
    )
  )
    return { CAWS_GUARD_ZONE_COUNT: '0', CAWS_GUARD_CONFIG_STATUS: 'invalid' };
  return result;
}
