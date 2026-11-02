import * as fs from 'fs';
import * as path from 'path';
import { err, ok, type Result } from '../kernel';
import { runGit, storeDiagnostic } from './repo-root';
import { STORE_RULES } from './rules';

// Resolve missing checkouts through their existing ancestors as well, including
// macOS's /var -> /private/var alias. Git retains their original absolute paths.
function pathIdentity(value: string): string {
  try {
    return fs.realpathSync(value);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    const parent = path.dirname(value);
    if (parent === value) throw error;
    return path.join(pathIdentity(parent), path.basename(value));
  }
}

/** Read Git's inventory, preserving spaces and newlines in checkout paths. */
export function worktreeIsRegistered(repoRoot: string, wtPath: string): boolean {
  const inventory = runGit(['worktree', 'list', '--porcelain', '-z'], repoRoot);
  if (!inventory.ok) throw new Error(inventory.reason);
  if (!inventory.stdout.endsWith('\0\0')) throw new Error('Incomplete Git worktree inventory');
  const target = pathIdentity(wtPath);
  return inventory.stdout
    .slice(0, -2)
    .split('\0\0')
    .some((record) => {
      const first = record.split('\0')[0];
      if (!first?.startsWith('worktree ')) throw new Error('Malformed Git worktree inventory');
      return pathIdentity(first.slice(9)) === target;
    });
}

// Exercise actual creates AND deletes: access(W_OK) can succeed even when a
// native sandbox denies writes. Never touch Git-owned files or recurse on cleanup.
function probeDirectory(directory: string): void {
  const probe = fs.mkdtempSync(path.join(directory, 'caws-remove-probe-'));
  const file = path.join(probe, 'write-delete');
  let failure: unknown;
  try {
    fs.writeFileSync(file, '', { flag: 'wx' });
    fs.unlinkSync(file);
  } catch (error) {
    failure = error;
  } finally {
    try {
      if (fs.existsSync(file)) fs.unlinkSync(file);
    } catch (error) {
      failure ??= error;
    }
    try {
      fs.rmdirSync(probe);
    } catch (error) {
      failure ??= error;
    }
  }
  if (failure !== undefined)
    throw new Error(`Git metadata write/delete probe failed at ${probe}: ${String(failure)}`);
}

/** Refuse known metadata write failures before deleting any checkout content.
 * Probes do not make recursive Git removal atomic or prevent later ACL changes.
 * A missing checkout can still have a Git record requiring targeted removal.
 */
export function preflightWorktreeRemoval(
  repoRoot: string,
  wtPath: string,
  name: string
): Result<{ readonly registered: boolean }> {
  try {
    const registered = worktreeIsRegistered(repoRoot, wtPath);
    if (!registered) {
      if (fs.existsSync(wtPath))
        throw new Error('Checkout exists but is absent from Git inventory');
      return ok({ registered: false });
    }
    const common = runGit(['rev-parse', '--path-format=absolute', '--git-common-dir'], repoRoot);
    if (!common.ok) throw new Error(common.reason);
    // Git adds one newline; retain any newline belonging to the path itself.
    const commonDir = path.resolve(repoRoot, common.stdout.replace(/\n$/, ''));
    const adminParent = path.join(commonDir, 'worktrees');
    const target = pathIdentity(path.join(wtPath, '.git'));
    const matches = fs.readdirSync(adminParent, { withFileTypes: true }).filter((entry) => {
      if (!entry.isDirectory()) return false;
      const pointer = path.join(adminParent, entry.name, 'gitdir');
      const value = fs.readFileSync(pointer, 'utf8').replace(/\n$/, '');
      return pathIdentity(path.resolve(path.dirname(pointer), value)) === target;
    });
    if (matches.length !== 1)
      throw new Error('Cannot identify one matching linked-worktree Git directory');
    const admin = path.join(adminParent, matches[0]!.name);
    const shared = fs.readFileSync(path.join(admin, 'commondir'), 'utf8').replace(/\n$/, '');
    if (pathIdentity(path.resolve(admin, shared)) !== pathIdentity(commonDir))
      throw new Error('Linked-worktree common directory does not match this repository');
    if (fs.existsSync(path.join(admin, 'locked'))) throw new Error('Git worktree is locked');
    if (fs.existsSync(wtPath)) {
      const actual = runGit(['rev-parse', '--absolute-git-dir'], wtPath);
      if (!actual.ok) throw new Error(actual.reason);
      if (pathIdentity(actual.stdout.replace(/\n$/, '')) !== pathIdentity(admin))
        throw new Error('Checkout Git directory does not match its inventory record');
    }
    probeDirectory(adminParent);
    probeDirectory(admin);
    return ok({ registered: true });
  } catch (error) {
    return err(
      storeDiagnostic(
        STORE_RULES.LIFECYCLE_PLAN_REJECTED,
        `Worktree removal preflight failed for "${name}" before checkout deletion: ${String(error)}`,
        {
          subject: name,
          narrowRepair: `Retain the checkout and binding. Resolve Git metadata permissions in the execution environment, then retry caws worktree destroy ${name}. No checkout files or artifact links were removed by this preflight.`,
        }
      )
    );
  }
}
