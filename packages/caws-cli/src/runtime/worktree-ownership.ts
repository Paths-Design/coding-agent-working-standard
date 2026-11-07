import { isAbsolute } from 'node:path';

export interface WorktreeOwnershipRoot {
  readonly name: string;
  readonly root: string | null;
  readonly ownerPresent: boolean;
  readonly owner: unknown;
}
export type WorktreeOwner =
  | { readonly kind: 'confirmed'; readonly sessionId: string }
  | { readonly kind: 'unconfirmed' }
  | { readonly kind: 'malformed' };
export type WorktreeOwnershipObservation =
  | {
      readonly kind: 'foreign_owner' | 'owner_self' | 'payload_without_owner';
      readonly worktree: string;
    }
  | { readonly kind: 'unresolved' | 'outside_payload' };

const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
const inside = (root: string, file: string): boolean =>
  file === root || file.startsWith(root === '/' ? '/' : root + '/');
const supportedSession = (value: unknown): value is string =>
  typeof value === 'string' &&
  value !== '' &&
  !['unknown', '.', '..'].includes(value) &&
  Buffer.byteLength(value, 'utf8') <= 128 &&
  /^[A-Za-z0-9_.@:-]+$/.test(value);

/** Preserve absent ownership separately from malformed present values. */
export function observeWorktreeOwner(
  row: Pick<WorktreeOwnershipRoot, 'ownerPresent' | 'owner'>
): WorktreeOwner {
  if (!row.ownerPresent) return { kind: row.owner === undefined ? 'unconfirmed' : 'malformed' };
  if (row.owner === null) return { kind: 'unconfirmed' };
  if (!object(row.owner) || !Object.hasOwn(row.owner, 'session_id')) return { kind: 'malformed' };
  const sid = row.owner.session_id;
  if (sid === null || sid === '' || sid === 'unknown') return { kind: 'unconfirmed' };
  return supportedSession(sid) ? { kind: 'confirmed', sessionId: sid } : { kind: 'malformed' };
}

/** A complete physical census confers neither permission nor prompting capability. */
export function observeWorktreeOwnership(input: {
  readonly canonical: string;
  readonly sessionId: string | null;
  readonly roots: readonly WorktreeOwnershipRoot[];
  readonly targets: readonly (string | null)[];
}): readonly WorktreeOwnershipObservation[] {
  const usable: (WorktreeOwnershipRoot & { readonly root: string })[] = [];
  const knownSession = supportedSession(input.sessionId);
  let incomplete = !isAbsolute(input.canonical) || !knownSession;
  for (const row of input.roots) {
    if (
      row.root === null ||
      !isAbsolute(row.root) ||
      !row.name ||
      row.name === '.' ||
      row.name === '..' ||
      /[:,\r\n\t]/.test(row.name) ||
      inside(row.root, input.canonical)
    ) {
      incomplete = true;
      continue;
    }
    usable.push({ ...row, root: row.root });
  }
  return input.targets.map((file): WorktreeOwnershipObservation => {
    if (file === null || !isAbsolute(file)) return { kind: 'unresolved' };
    const relevant = usable.filter(({ root }) => inside(root, file) || inside(file, root));
    const containing = relevant.filter(({ root }) => inside(root, file));
    let foreign: string | undefined;
    let uncertain = incomplete;
    let unconfirmed = false;
    for (const row of relevant) {
      const owner = observeWorktreeOwner(row);
      if (owner.kind === 'malformed') uncertain = true;
      else if (owner.kind === 'unconfirmed') unconfirmed = true;
      else if (knownSession && owner.sessionId !== input.sessionId) foreign ??= row.name;
    }
    for (let left = 0; left < usable.length; left++)
      for (let right = left + 1; right < usable.length; right++) {
        const a = usable[left]!;
        const b = usable[right]!;
        if (
          (relevant.includes(a) || relevant.includes(b)) &&
          (inside(a.root, b.root) || inside(b.root, a.root))
        )
          uncertain = true;
      }
    if (foreign !== undefined) return { kind: 'foreign_owner', worktree: foreign };
    if (uncertain) return { kind: 'unresolved' };
    if (containing.length)
      return {
        kind: unconfirmed ? 'payload_without_owner' : 'owner_self',
        worktree: containing[0]!.name,
      };
    return { kind: unconfirmed ? 'unresolved' : 'outside_payload' };
  });
}
