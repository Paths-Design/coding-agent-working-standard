/**
 * Rendering and staleness-checking for the compiled chain sidecar
 * `.caws/hooks/dispatch/<event>.chain` read by
 * `templates/hook-packs/shared/lib/local-chain.sh`.
 *
 * The load-bearing invariant is that this renderer must never emit a file its
 * own parser would refuse. The parser is fail-CLOSED: a malformed sidecar
 * blocks the call with exit 2. So a renderer that could emit an illegal line
 * would not produce a bad config — it would produce an outage, on every tool
 * call, for every project-wired surface in the repo, from a file the agent
 * cannot edit. Every grammar rule below is therefore duplicated from the
 * parser deliberately, and `renderChainFile` throws rather than emitting
 * anything that would trip it.
 */

import { createHash } from 'node:crypto';

/** Mirrors the parser's header test: `'# caws hook chain v1 '*`. */
export const CHAIN_HEADER_PREFIX = '# caws hook chain v1 ';

/**
 * Mirrors the parser's entry grammar exactly:
 *   ^[A-Za-z0-9_.-]+\.sh( [A-Za-z0-9_.:/-]+)*$
 * A handler may carry simple arguments (`session-log.sh stop`).
 */
export const CHAIN_ENTRY_RE = /^[A-Za-z0-9_.-]+\.sh( [A-Za-z0-9_.:/-]+)*$/;

export interface ChainHeader {
  surface: string;
  event: string;
  policySha256: string;
  pack: number;
}

export interface ChainRenderInput extends ChainHeader {
  /** Effective handler sequence, in execution order. Entries may carry args. */
  handlers: readonly string[];
  /** Handler basename -> repo-relative override target. */
  overrides: Readonly<Record<string, string>>;
}

/** Why a target is inadmissible, or null when it is fine. */
export function chainTargetViolation(target: string): string | null {
  if (target === '') return 'override target is empty';
  if (target.includes('\t') || target.includes('\n'))
    return 'override target may not contain a tab or newline';
  if (target.startsWith('/'))
    return `override target must be repo-relative, not absolute: ${target}`;
  if (target === '..' || target.endsWith('/..') || target.includes('../'))
    return `override target may not traverse with ..: ${target}`;
  if (/[*?[]/.test(target)) return `override target may not contain glob metacharacters: ${target}`;
  return null;
}

/** Why an entry is inadmissible, or null when it is fine. */
export function chainEntryViolation(entry: string): string | null {
  if (!CHAIN_ENTRY_RE.test(entry)) return `malformed handler entry: ${entry}`;
  return null;
}

/**
 * The digest recorded in the header. Bytes of the policy file, or a stable
 * marker for a repo with no policy — so "absent" and "empty object" are
 * distinguishable, and a repo that later adds an empty policy still compiles
 * to a visibly different header.
 */
export function policyDigest(policyText: string | null): string {
  if (policyText === null) return 'absent';
  return createHash('sha256').update(policyText, 'utf8').digest('hex');
}

export function renderChainHeader(header: ChainHeader): string {
  return (
    `${CHAIN_HEADER_PREFIX}surface=${header.surface} event=${header.event} ` +
    `policy-sha256=${header.policySha256} pack=${header.pack}`
  );
}

/**
 * Render the whole sidecar. Throws on anything the parser would refuse; the
 * caller is compiling from a validated policy, so a throw here means the
 * validator and this grammar have drifted apart, which is a defect and not a
 * user error.
 */
export function renderChainFile(input: ChainRenderInput): string {
  const lines: string[] = [renderChainHeader(input)];
  for (const entry of input.handlers) {
    const bad = chainEntryViolation(entry);
    if (bad) throw new Error(`refusing to compile an unparseable chain: ${bad}`);
    const target = input.overrides[entry.split(' ')[0] ?? entry];
    if (target === undefined) {
      lines.push(entry);
      continue;
    }
    const badTarget = chainTargetViolation(target);
    if (badTarget) throw new Error(`refusing to compile an unparseable chain: ${badTarget}`);
    lines.push(`${entry}\t${target}`);
  }
  return `${lines.join('\n')}\n`;
}

/** Parse a header line back out, for staleness reporting. Null when absent. */
export function parseChainHeader(text: string): ChainHeader | null {
  const first = text.split('\n').find((line) => line.startsWith(CHAIN_HEADER_PREFIX));
  if (first === undefined) return null;
  const fields = new Map<string, string>();
  for (const token of first.slice(CHAIN_HEADER_PREFIX.length).trim().split(/\s+/)) {
    const eq = token.indexOf('=');
    if (eq > 0) fields.set(token.slice(0, eq), token.slice(eq + 1));
  }
  const surface = fields.get('surface');
  const event = fields.get('event');
  const policySha256 = fields.get('policy-sha256');
  const pack = Number(fields.get('pack'));
  if (!surface || !event || !policySha256 || !Number.isInteger(pack)) return null;
  return { surface, event, policySha256, pack };
}

export type ChainStaleness = { stale: false } | { stale: true; reason: string };

/**
 * Compare what is on disk against what would be compiled now.
 *
 * Byte comparison, not header comparison. A header match with a differing body
 * is precisely the dangerous case: the policy digest is unchanged because the
 * policy did not change, while the STOCK chain moved underneath it in a pack
 * upgrade. Comparing bodies catches that; comparing digests would not.
 */
export function chainStaleness(onDisk: string | null, expected: string): ChainStaleness {
  if (onDisk === null) return { stale: true, reason: 'no compiled chain on disk' };
  if (onDisk === expected) return { stale: false };
  const diskHeader = parseChainHeader(onDisk);
  const wantHeader = parseChainHeader(expected);
  if (diskHeader && wantHeader) {
    if (diskHeader.pack !== wantHeader.pack)
      return {
        stale: true,
        reason: `compiled against pack ${diskHeader.pack}, shipping ${wantHeader.pack}`,
      };
    if (diskHeader.policySha256 !== wantHeader.policySha256)
      return { stale: true, reason: 'compiled against a different hook-policy.json' };
  }
  if (!diskHeader) return { stale: true, reason: 'compiled chain has no recognizable header' };
  return { stale: true, reason: 'compiled chain body differs from the current policy' };
}
