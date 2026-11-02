/** Historical Python 3.11.13 / Unicode 14 text interpretation, independent of host ICU.
 * This provides Python literal names, not the broader unicodedata.lookup API:
 * Unicode named sequences are deliberately rejected. Runtime uses generated data only.
 */
import { CHARACTER_NAMES } from './unicode14/names.generated';
import { UNICODE_PROFILE_MANIFEST } from './unicode14/manifest.generated';
import {
  CJK_NAME_RANGES,
  DECIMAL_RANGES,
  HANGUL_JAMO,
  PRINTABLE_RANGES,
  WORD_RANGES,
} from './unicode14/tables.generated';

/** Binds Unicode inputs, generator fingerprint and Python interpretation semantics. */
export const UNICODE_PROFILE_ID = UNICODE_PROFILE_MANIFEST.profileId;

type Ranges = readonly (readonly [number, number])[];

function inRanges(cp: number, ranges: Ranges): boolean {
  if (!Number.isInteger(cp) || cp < 0 || cp > 0x10ffff) return false;
  let low = 0;
  let high = ranges.length - 1;
  while (low <= high) {
    const middle = (low + high) >>> 1;
    const [start, end] = ranges[middle]!;
    if (cp < start) high = middle - 1;
    else if (cp > end) low = middle + 1;
    else return true;
  }
  return false;
}

export function isPythonPrintableCodepoint(cp: number): boolean {
  return inRanges(cp, PRINTABLE_RANGES);
}

/** Python re's Unicode \w: letter/number categories and ASCII underscore. */
export function isPythonWordCodepoint(cp: number): boolean {
  return inRanges(cp, WORD_RANGES);
}

export function isPythonDecimalCodepoint(cp: number): boolean {
  return inRanges(cp, DECIMAL_RANGES);
}

function characterClass(ranges: Ranges): string {
  return (
    '[' +
    ranges
      .map(([start, end]) => '\\u{' + start.toString(16) + '}-\\u{' + end.toString(16) + '}')
      .join('') +
    ']'
  );
}

/** Explicit classes require the Unicode (u) flag; no host Unicode properties are used. */
export const PYTHON_WORD_PATTERN = characterClass(WORD_RANGES);
export const PYTHON_DECIMAL_PATTERN = characterClass(DECIMAL_RANGES);

function hangulName(suffix: string): number | null {
  const indices: number[] = [];
  for (const column of HANGUL_JAMO) {
    let index = -1;
    let length = -1;
    // CPython selects the longest matching Jamo short name in each column.
    for (let i = 0; i < column.length; i++) {
      const name = column[i]!;
      if (name.length > length && suffix.startsWith(name)) {
        index = i;
        length = name.length;
      }
    }
    if (index < 0) return null;
    indices.push(index);
    suffix = suffix.slice(length);
  }
  if (suffix.length !== 0) return null;
  return 0xac00 + (indices[0]! * 21 + indices[1]!) * 28 + indices[2]!;
}

/**
 * Ordinary names and aliases admit ASCII case variation. CPython's algorithmic
 * Hangul/CJK branches run before that folding and require uppercase spelling.
 * Separators, spacing, non-ASCII case mappings and named sequences are not normalized.
 */
export function lookupPythonLiteralName(name: string): number | null {
  if (name.startsWith('HANGUL SYLLABLE ')) return hangulName(name.slice(16));
  if (name.startsWith('CJK UNIFIED IDEOGRAPH-')) {
    const match = /^CJK UNIFIED IDEOGRAPH-([0-9A-F]{4,5})$/.exec(name);
    if (!match) return null;
    const cp = Number.parseInt(match[1]!, 16);
    return inRanges(cp, CJK_NAME_RANGES) ? cp : null;
  }
  if (!/^[\x20-\x7e]+$/.test(name)) return null;
  const folded = name.toUpperCase();
  return Object.hasOwn(CHARACTER_NAMES, folded) ? CHARACTER_NAMES[folded]! : null;
}
