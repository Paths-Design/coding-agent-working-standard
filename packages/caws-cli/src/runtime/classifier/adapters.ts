import * as data from './data';
import type { ClassifierPorts, CommandFact } from './types';
import { join } from 'node:path';

export interface AdapterFacets {
  kind: CommandFact['kind'];
  domain?: CommandFact['domain'];
  reversibility?: CommandFact['reversibility'];
  blast_radius?: CommandFact['blastRadius'];
  trace_label?: string;
}
export interface CommandAdapter {
  subcommands: { path: string[]; facets: AdapterFacets }[];
  resource_aliases: Record<string, string>;
  unknown_subcommand: 'no_escalation' | 'intent_fallback';
}
export type AdapterState =
  | { ok: true; adapters: Record<string, CommandAdapter> }
  | { ok: false; error: string };
const object = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const includes = (values: readonly string[], value: unknown): boolean =>
  typeof value === 'string' && values.includes(value);

/** Validate data assignments only. Malformed present sidecars remain observable, distinct from absence. */
export function parseCommandAdapters(text: string | null): AdapterState {
  if (text === null) return { ok: true, adapters: {} };
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { ok: false, error: 'invalid JSON' };
  }
  const bad = (error: string): AdapterState => ({ ok: false, error });
  if (!object(raw) || raw.version !== 1) return bad('missing or unsupported version (expected 1)');
  if (!object(raw.adapters)) return bad('adapters must be an object');
  const adapters: Record<string, CommandAdapter> = Object.create(null) as Record<
    string,
    CommandAdapter
  >;
  for (const [tool, spec] of Object.entries(raw.adapters)) {
    if (!object(spec)) return bad(`adapter '${tool}' must be an object`);
    if (!Array.isArray(spec.subcommands))
      return bad(`adapter '${tool}'.subcommands must be a list`);
    const rows: CommandAdapter['subcommands'] = [];
    for (const row of spec.subcommands) {
      if (!object(row) || Object.keys(row).some((key) => !['path', 'facets'].includes(key)))
        return bad(`adapter '${tool}' row has unexpected keys`);
      if (!object(row.facets) || !Array.isArray(row.path))
        return bad(`adapter '${tool}' row path/facets malformed`);
      const facets = row.facets;
      if (
        ['decision', 'allow', 'deny', 'ask', 'policy', 'outcome', 'severity', 'override'].some(
          (key) => Object.hasOwn(facets, key)
        )
      )
        return bad(`adapter '${tool}' facets attempt a policy override (forbidden)`);
      if (!includes(data.FACET_KINDS, facets.kind))
        return bad(`adapter '${tool}' facets.kind is not a valid capability kind`);
      if (facets.domain !== undefined && !includes(data.FACET_DOMAINS, facets.domain))
        return bad(`adapter '${tool}' facets.domain invalid`);
      if (
        facets.reversibility !== undefined &&
        !includes(data.FACET_REVERSIBILITY, facets.reversibility)
      )
        return bad(`adapter '${tool}' facets.reversibility invalid`);
      if (facets.blast_radius !== undefined && !includes(data.FACET_BLAST, facets.blast_radius))
        return bad(`adapter '${tool}' facets.blast_radius invalid`);
      // The schema's typed fields cannot become crash paths in the consuming engine.
      if (
        !row.path.every((token): token is string => typeof token === 'string') ||
        (facets.trace_label !== undefined && typeof facets.trace_label !== 'string')
      )
        return bad(`adapter '${tool}' row path/facets malformed`);
      rows.push({ path: row.path, facets: facets as unknown as AdapterFacets });
    }
    const unknown =
      spec.unknown_subcommand === undefined ? 'no_escalation' : spec.unknown_subcommand;
    if (unknown !== 'no_escalation' && unknown !== 'intent_fallback')
      return bad(`adapter '${tool}'.unknown_subcommand invalid`);
    const aliases = spec.resource_aliases === undefined ? {} : spec.resource_aliases;
    if (!object(aliases) || Object.values(aliases).some((value) => typeof value !== 'string'))
      return bad(`adapter '${tool}'.resource_aliases malformed`);
    adapters[tool] = {
      subcommands: rows,
      resource_aliases: aliases as Record<string, string>,
      unknown_subcommand: unknown,
    };
  }
  return { ok: true, adapters };
}

export function loadCommandAdapters(root: string, ports: ClassifierPorts): AdapterState {
  const path = join(root, '.caws/command-adapters.json');
  if (!ports.isFile(path)) return parseCommandAdapters(null);
  let text: string | null;
  try {
    text = ports.read(path);
  } catch {
    return { ok: false, error: 'command-adapters sidecar could not be decoded as UTF-8' };
  }
  if (text === null) return { ok: false, error: 'command-adapters sidecar is unreadable' };
  return parseCommandAdapters(text);
}
