import { basename } from 'node:path';
import type { ClassifierContext } from './types';

export function matchesPattern(pattern: string, input: string): boolean {
  return new RegExp(pattern.replace(/^\(\?i\)/, ''), 'i').test(input);
}
export function ownerIdentityPattern(context: ClassifierContext): string {
  return [
    ...new Set(
      ['user', ...(context.ownerIdentities ?? []), basename(context.home)].filter(Boolean)
    ),
  ]
    .map((token) => token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('|');
}
export function isPipeIntoLocalScript(surface: string): boolean {
  const matches = [...surface.matchAll(/(?<!\|)\|(?!\|)\s*(?:ba)?sh\b([^|&;\n]*?)(?=[|&;\n]|$)/g)];
  return (
    matches.length > 0 &&
    matches.every((match) => {
      const first = (match[1] ?? '').trim().split(/\s+/)[0] ?? '';
      return first !== '' && !first.startsWith('-') && !/^\d*[<>]/.test(first);
    })
  );
}
