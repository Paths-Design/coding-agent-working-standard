/** Pinned CPython 3.11.13 html.unescape semantics, independent of host libraries.
 * Derived from Lib/html/__init__.py; full retained license and data provenance
 * accompany html311/. Omitted numeric profiles retain the qualified 4300-digit default.
 */
import { HTML5_ENTITIES } from './html311/entities.generated';
import { PYTHON_HTML_MANIFEST } from './html311/manifest.generated';
import { INVALID_NUMERIC_RANGES, NUMERIC_CORRECTIONS } from './html311/numeric.generated';
import {
  snapshotTranscriptJsonProfile,
  type TranscriptJsonNumericProfile,
} from './transcript-json-profile';

export const PYTHON_HTML_PROFILE_ID = PYTHON_HTML_MANIFEST.profileId;
export const PYTHON_HTML_DECIMAL_DIGIT_LIMIT = PYTHON_HTML_MANIFEST.decimalDigitLimit;

/** Historical decimal int() refusal; leading zeroes count toward the limit. */
export class PythonHtmlDecimalDigitLimitError extends RangeError {
  readonly code = 'PYTHON_HTML_DECIMAL_DIGIT_LIMIT';
  constructor(
    readonly digits: number,
    readonly limit: number = PYTHON_HTML_DECIMAL_DIGIT_LIMIT
  ) {
    super(
      `Exceeds the limit (${limit} digits) for integer string conversion: value has ${digits} digits; use sys.set_int_max_str_digits() to increase the limit`
    );
    this.name = 'PythonHtmlDecimalDigitLimitError';
  }
}

// This matches Python's explicit ASCII numeric syntax and its at-most-32
// codepoint named-reference scan. HTML named references are case-sensitive.
const CHARACTER_REFERENCE = /&(#[0-9]+;?|#[xX][0-9a-fA-F]+;?|[^\t\n\f <&#;]{1,32};?)/gu;

function replaceReference(reference: string, decimalDigitLimit: number): string {
  if (reference.startsWith('#')) {
    const hexadecimal = reference[1] === 'x' || reference[1] === 'X';
    const digits = reference.slice(hexadecimal ? 2 : 1, reference.endsWith(';') ? -1 : undefined);
    if (!hexadecimal && decimalDigitLimit !== 0 && digits.length > decimalDigitLimit) {
      throw new PythonHtmlDecimalDigitLimitError(digits.length, decimalDigitLimit);
    }
    // Every in-range result is an exactly representable integer. Overflow can
    // only mean out-of-Unicode-range, whose disposition is replacement below.
    const cp = Number.parseInt(digits, hexadecimal ? 16 : 10);
    if (Object.hasOwn(NUMERIC_CORRECTIONS, cp)) return NUMERIC_CORRECTIONS[cp]!;
    if ((cp >= 0xd800 && cp <= 0xdfff) || cp > 0x10ffff) return '\ufffd';
    for (const [start, end] of INVALID_NUMERIC_RANGES) {
      if (cp >= start && cp <= end) return '';
    }
    return String.fromCodePoint(cp);
  }
  if (Object.hasOwn(HTML5_ENTITIES, reference)) return HTML5_ENTITIES[reference]!;
  // Only ASCII keys exist in the pinned table. UTF-16 suffix cut points cannot
  // introduce a match inside a non-ASCII codepoint; the selected key is exact.
  for (let length = reference.length - 1; length > 1; length--) {
    const prefix = reference.slice(0, length);
    if (Object.hasOwn(HTML5_ENTITIES, prefix)) {
      return HTML5_ENTITIES[prefix]! + reference.slice(length);
    }
  }
  return '&' + reference;
}

/** One substitution pass, preserving unknown references and all other text. */
export function pythonHtmlUnescape(
  value: string,
  numericProfile?: TranscriptJsonNumericProfile
): string {
  const decimalDigitLimit =
    numericProfile === undefined
      ? PYTHON_HTML_DECIMAL_DIGIT_LIMIT
      : snapshotTranscriptJsonProfile(numericProfile).integerMaxDigits;
  return value.replace(CHARACTER_REFERENCE, (_whole: string, reference: string) =>
    replaceReference(reference, decimalDigitLimit)
  );
}
