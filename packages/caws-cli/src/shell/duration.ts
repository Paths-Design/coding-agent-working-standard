/**
 * Human-readable durations for CLI flags (CAWS-CLI-HUMAN-DURATION-FLAGS-01).
 *
 * One grammar serves `reprieve grant --for` and every age / TTL flag
 * (`--older-than`, `--stale-ttl`), so what one command accepts another
 * accepts too. The `-ms` integer flags stay as the exact, scriptable form;
 * the duration flags sit beside them and are mutually exclusive with them.
 */

/**
 * Accepted duration units. Longer aliases first so that "hr" is matched
 * before "h" — otherwise "1hr30m" parses "h" and then chokes on "r".
 */
const DURATION_UNITS: ReadonlyArray<readonly [string, number]> = [
  ['d', 86400],
  ['hr', 3600],
  ['h', 3600],
  ['m', 60],
  ['s', 1],
];

/** Human-facing list of the accepted units; used in every refusal message. */
export const DURATION_UNITS_HELP = 's (seconds), m (minutes), h/hr (hours), d (days)';

/**
 * Parse a relative duration like "30m", "1h30m", "1hr30m", "120s", "2d" into
 * whole seconds. Returns null for anything unparseable.
 *
 * CAWS-REPRIEVE-RELATIVE-EXPIRY-001 A2: components may be concatenated and are
 * summed. A bare number ("30") is REFUSED rather than assumed to be minutes —
 * guessing the unit on an expiry is the "silently does something other than
 * what was asked" class, and the caller gets the unit list instead.
 */
export function parseDurationToSeconds(raw: string): number | null {
  const text = raw.trim().toLowerCase();
  if (text.length === 0) return null;

  let rest = text;
  let total = 0;
  let matched = 0;

  while (rest.length > 0) {
    const num = /^(\d+)/.exec(rest);
    if (num === null) return null;
    const value = Number.parseInt(num[1] as string, 10);
    rest = rest.slice((num[1] as string).length);

    const unit = DURATION_UNITS.find(([suffix]) => rest.startsWith(suffix));
    if (unit === undefined) return null;
    rest = rest.slice(unit[0].length);

    total += value * unit[1];
    matched += 1;
  }

  if (matched === 0) return null;
  return total;
}

/**
 * Render a millisecond count as the shortest duration string that
 * `parseDurationToSeconds` reads back to the same value ("10m", "1h30m",
 * "7d", "0s"). Returns null when the value is not a whole number of seconds,
 * because no duration string can express it — callers then echo the `-ms`
 * form instead of a rounded one.
 */
export function formatDurationMs(ms: number): string | null {
  if (!Number.isSafeInteger(ms) || ms < 0 || ms % 1000 !== 0) return null;
  let seconds = ms / 1000;
  if (seconds === 0) return '0s';
  let out = '';
  for (const [suffix, size] of DURATION_UNITS) {
    if (suffix === 'hr') continue;
    const count = Math.floor(seconds / size);
    if (count > 0) {
      out += `${count}${suffix}`;
      seconds -= count * size;
    }
  }
  return out;
}

/** A flag pair: the human duration form and the exact millisecond form. */
export interface DurationFlagPair {
  /** e.g. "--older-than" */
  readonly durationFlag: string;
  /** e.g. "--older-than-ms" */
  readonly msFlag: string;
}

export type DurationOptionResult =
  | { readonly ok: true; readonly ms: number | undefined }
  | { readonly ok: false; readonly error: string };

/**
 * Resolve one age / TTL option from its two spellings into milliseconds.
 *
 * - neither supplied → `{ ok: true, ms: undefined }` (the command's default applies)
 * - both supplied → refused; picking one would silently discard the other
 * - duration form → parsed with the shared grammar; bare numbers refused
 * - ms form → must be a non-negative integer; anything else is refused rather
 *   than silently replaced by the default
 */
export function resolveDurationOption(
  flags: DurationFlagPair,
  duration: string | undefined,
  ms: string | number | undefined
): DurationOptionResult {
  const { durationFlag, msFlag } = flags;
  if (duration !== undefined && ms !== undefined) {
    return {
      ok: false,
      error: `pass ${durationFlag} <duration> or ${msFlag} <ms>, not both (got ${durationFlag} ${JSON.stringify(duration)} and ${msFlag} ${JSON.stringify(String(ms))}).`,
    };
  }

  if (duration !== undefined) {
    const seconds = parseDurationToSeconds(duration);
    if (seconds === null || !Number.isSafeInteger(seconds * 1000)) {
      const bare = duration.trim();
      const hint = /^\d+$/.test(bare)
        ? ` A bare number has no unit; write ${bare}m, ${bare}h, etc., or pass ${msFlag} ${bare} for milliseconds.`
        : '';
      return {
        ok: false,
        error: `${durationFlag} ${JSON.stringify(duration)} is not a valid duration. Accepted units: ${DURATION_UNITS_HELP}. Examples: 10m, 2h, 1h30m, 7d.${hint}`,
      };
    }
    return { ok: true, ms: seconds * 1000 };
  }

  if (ms !== undefined) {
    const parsed = typeof ms === 'number' ? ms : ms.trim() === '' ? Number.NaN : Number(ms);
    if (!Number.isSafeInteger(parsed) || parsed < 0) {
      return {
        ok: false,
        error: `${msFlag} must be a non-negative integer number of milliseconds (got ${JSON.stringify(String(ms))}). For a human duration use ${durationFlag} <duration>, e.g. ${durationFlag} 10m.`,
      };
    }
    return { ok: true, ms: parsed };
  }

  return { ok: true, ms: undefined };
}

/** `--older-than <duration>` / `--older-than-ms <ms>`. */
export const OLDER_THAN_FLAGS: DurationFlagPair = {
  durationFlag: '--older-than',
  msFlag: '--older-than-ms',
};

/** `--stale-ttl <duration>` / `--stale-ttl-ms <ms>`. */
export const STALE_TTL_FLAGS: DurationFlagPair = {
  durationFlag: '--stale-ttl',
  msFlag: '--stale-ttl-ms',
};
