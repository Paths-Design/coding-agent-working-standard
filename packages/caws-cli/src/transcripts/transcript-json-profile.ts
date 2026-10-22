/** Selected Python JSON integer conversion policy, shared by outer and embedded decoders. */
import { parsePythonJson, type JsonNumber, type JsonValue } from './lossless-json';

export interface TranscriptJsonNumericProfile {
  readonly id: string;
  /** Zero is unlimited; positive limits follow Python's minimum configurable limit. */
  readonly integerMaxDigits: number;
}

export function snapshotTranscriptJsonProfile(
  profile: TranscriptJsonNumericProfile
): TranscriptJsonNumericProfile {
  if (
    !profile ||
    typeof profile.id !== 'string' ||
    !profile.id.trim() ||
    !Number.isSafeInteger(profile.integerMaxDigits) ||
    (profile.integerMaxDigits !== 0 && profile.integerMaxDigits < 640)
  )
    throw new TypeError(
      'Transcript JSON numeric profile requires an identity and a zero or >=640 digit limit'
    );
  return Object.freeze({ id: profile.id, integerMaxDigits: profile.integerMaxDigits });
}

export class TranscriptJsonNumericConversionError extends RangeError {}

/** Apply a snapshotted profile at decimal token conversion, during parsing or encoding. */
export function admitTranscriptJsonNumber(
  token: JsonNumber,
  profile: TranscriptJsonNumericProfile
): void {
  if (
    token.numberKind === 'integer' &&
    profile.integerMaxDigits !== 0 &&
    token.lexeme.length - (token.lexeme[0] === '-' ? 1 : 0) > profile.integerMaxDigits
  )
    throw new TranscriptJsonNumericConversionError(
      `Integer exceeds selected ${profile.integerMaxDigits}-digit limit`
    );
}

/** Omitted profiles preserve the historical unbounded lossless decoder. */
export function parseTranscriptJson(
  text: string,
  profile?: TranscriptJsonNumericProfile
): JsonValue {
  const selected = profile === undefined ? undefined : snapshotTranscriptJsonProfile(profile);
  return parsePythonJson(
    text,
    selected === undefined
      ? undefined
      : {
          admitNumberToken(token) {
            admitTranscriptJsonNumber(token, selected);
          },
        }
  );
}
