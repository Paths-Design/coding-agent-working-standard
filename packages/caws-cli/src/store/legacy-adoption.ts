import * as fs from 'node:fs';
import * as path from 'node:path';
import * as yaml from 'js-yaml';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { isOk, parseAndValidatePolicy, parseAndValidateSpec } from '../kernel';
import { assertMachinePath } from '../init/machine-paths';
import { writeFileAtomic } from './atomic-write';

interface Replacement {
  path: string;
  beforeSha256: string | null;
  contents: string | null;
}
export interface LegacyAdoptionPlan {
  version: 1;
  reason: string;
  requirementNotes: string[];
  changes: Replacement[];
}
const sha = (text: string): string => createHash('sha256').update(text).digest('hex');
const legacy = ['.caws/working-spec.yaml', '.caws/working-spec.schema.json'];
const specPath = /^\.caws\/specs\/[A-Z0-9][A-Z0-9_-]*\.ya?ml$/;
const waiverPath = /^\.caws\/waivers\/[A-Za-z0-9_-]+\.ya?ml$/;

function inertWaiver(value: unknown): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  if (Object.keys(record).join(',') === 'waivers') {
    const entries = record.waivers;
    if (entries === null) return true;
    if (!entries || typeof entries !== 'object') return false;
    return Object.values(entries).every(inertWaiver);
  }
  if (record.status === 'revoked') return true;
  if (typeof record.expires_at !== 'string') return false;
  const expiry = record.expires_at;
  // Old date-only expiry means end of that UTC day; never infer an early expiry.
  const normalized = /^\d{4}-\d{2}-\d{2}$/.test(expiry) ? expiry + 'T23:59:59.999Z' : expiry;
  if (!/^\d{4}-\d{2}-\d{2}T.*(?:Z|[+-]\d{2}:\d{2})$/.test(normalized)) return false;
  const day = normalized.slice(0, 10);
  const dayTime = Date.parse(day + 'T00:00:00Z');
  if (!Number.isFinite(dayTime) || new Date(dayTime).toISOString().slice(0, 10) !== day) return false;
  const time = Date.parse(normalized);
  return Number.isFinite(time) && time < Date.now();
}


/** Apply a reviewed conversion without inventing evidence or dropping original
 * source bytes. Preview is pure. A lock serializes this command; input hashes
 * reject stale plans. Originals are archived before any replacement, and the
 * legacy singleton is retired last so an interrupted conversion fails closed.
 * This does not infer policy equivalence, grant claims, initialize hooks, or
 * commit files. Requirement notes must explain external or deferred obligations.
 */
export function adoptLegacyProject(cwd: string, input: unknown, apply: boolean) {
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([k]) => !k.startsWith('GIT_'))
  );
  const git = (...args: string[]) =>
    execFileSync('git', args, { cwd, env, encoding: 'utf8' }).trim();
  const root = fs.realpathSync(cwd);
  const common = git('rev-parse', '--path-format=absolute', '--git-common-dir');
  if (path.dirname(common) !== root)
    throw new Error('Legacy adoption requires the canonical project root');
  const plan = input as LegacyAdoptionPlan;
  if (
    !plan ||
    Object.keys(plan).sort().join(',') !== 'changes,reason,requirementNotes,version' ||
    plan.version !== 1 ||
    typeof plan.reason !== 'string' ||
    !plan.reason.trim() ||
    !Array.isArray(plan.requirementNotes) ||
    !plan.requirementNotes.length ||
    plan.requirementNotes.some((n) => typeof n !== 'string' || !n.trim()) ||
    !Array.isArray(plan.changes) ||
    !plan.changes.length
  )
    throw new Error('Malformed legacy adoption plan');
  const names = new Set<string>();
  const originals = new Map<string, string | null>();
  for (const change of plan.changes) {
    if (
      !change ||
      Object.keys(change).sort().join(',') !== 'beforeSha256,contents,path' ||
      typeof change.path !== 'string' ||
      names.has(change.path) ||
      (!legacy.includes(change.path) &&
        change.path !== '.caws/policy.yaml' &&
        !specPath.test(change.path) &&
        !waiverPath.test(change.path)) ||
      (change.beforeSha256 !== null && !/^[a-f0-9]{64}$/.test(change.beforeSha256)) ||
      (change.contents !== null && typeof change.contents !== 'string')
    )
      throw new Error('Invalid or duplicate migration path');
    names.add(change.path);
    const target = path.join(root, change.path);
    assertMachinePath(root, target);
    const original = fs.existsSync(target) ? fs.readFileSync(target, 'utf8') : null;
    if (original !== null && !Buffer.from(original, 'utf8').equals(fs.readFileSync(target)))
      throw new Error(`Legacy source is not UTF-8: ${change.path}`);
    originals.set(change.path, original);
    if ((original === null ? null : sha(original)) !== change.beforeSha256)
      throw new Error(`Stale migration input: ${change.path}`);
    if (original === null && change.contents === null)
      throw new Error(`Missing archive source: ${change.path}`);
    if (legacy.includes(change.path)) {
      if (change.contents !== null)
        throw new Error('Legacy singleton paths must be archived, never rewritten');
    } else if (waiverPath.test(change.path)) {
      if (original === null || change.contents !== null || !inertWaiver(yaml.load(original, { schema: yaml.JSON_SCHEMA })))
        throw new Error(`Waiver must be provably expired or revoked for archival: ${change.path}`);
    } else if (change.path === '.caws/policy.yaml') {
      if (original !== null && isOk(parseAndValidatePolicy(original)))
        throw new Error('Existing modern policy must use its governance workflow');
      if (change.contents === null || !isOk(parseAndValidatePolicy(change.contents)))
        throw new Error('Replacement policy is invalid');
    } else {
      if (original !== null && isOk(parseAndValidateSpec(original)))
        throw new Error(`Modern spec cannot be replaced by adoption: ${change.path}`);
      if (change.contents !== null) {
        const parsed = parseAndValidateSpec(change.contents);
        if (
          !isOk(parsed) ||
          parsed.value.lifecycle_state !== 'draft' ||
          parsed.value.evidence ||
          parsed.value.worktree ||
          parsed.value.resolution ||
          path.basename(change.path).replace(/\.ya?ml$/, '') !== parsed.value.id
        )
          throw new Error(
            `Replacement spec must be a valid unbound draft without evidence: ${change.path}`
          );
      }
    }
  }
  for (const name of legacy) {
    assertMachinePath(root, path.join(root, name));
    if (fs.existsSync(path.join(root, name)) && !names.has(name))
      throw new Error(`Unreviewed legacy residue: ${name}`);
  }
  const policy = plan.changes.find((c) => c.path === '.caws/policy.yaml')?.contents;
  if (!policy) {
    const file = path.join(root, '.caws/policy.yaml');
    assertMachinePath(root, file);
    if (!fs.existsSync(file) || !isOk(parseAndValidatePolicy(fs.readFileSync(file, 'utf8'))))
      throw new Error('A validated modern policy is required');
  }
  const specs = path.join(root, '.caws/specs');
  assertMachinePath(root, specs);
  for (const name of fs.existsSync(specs) ? fs.readdirSync(specs) : []) {
    if (!/\.ya?ml$/.test(name)) continue;
    const relative = `.caws/specs/${name}`;
    assertMachinePath(root, path.join(root, relative));
    if (
      !names.has(relative) &&
      !isOk(parseAndValidateSpec(fs.readFileSync(path.join(root, relative), 'utf8')))
    )
      throw new Error(`Unreviewed legacy spec: ${relative}`);
  }
  const identity = sha(JSON.stringify(plan));
  const archive = `.caws/legacy/${identity}`;
  for (const [name, original] of originals) {
    if (original === null) continue;
    const target = path.join(root, archive, name.slice('.caws/'.length));
    assertMachinePath(root, target);
    if (fs.existsSync(target) && fs.readFileSync(target, 'utf8') !== original)
      throw new Error(`Conflicting archive: ${target}`);
  }
  const result = {
    readOnly: !apply,
    archive,
    requirementNotes: plan.requirementNotes,
    changes: plan.changes.map((c) => ({
      path: c.path,
      action: c.contents === null ? 'archive' : 'replace',
      beforeSha256: c.beforeSha256,
    })),
  };
  if (!apply) return result;
  const lock = path.join(common, 'caws-legacy-adoption.lock');
  const fd = fs.openSync(lock, 'wx');
  const write = (target: string, contents: string) => {
    assertMachinePath(root, target);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    const written = writeFileAtomic(target, contents, { preserveMode: true });
    if (!isOk(written)) throw new Error(`Migration write failed: ${target}`);
  };
  try {
    // Recheck the entire input set after obtaining the lock and before writes.
    for (const [name, original] of originals) {
      const target = path.join(root, name);
      assertMachinePath(root, target);
      if ((fs.existsSync(target) ? fs.readFileSync(target, 'utf8') : null) !== original)
        throw new Error(`Stale migration input: ${name}`);
    }
    for (const [name, original] of originals)
      if (original !== null) write(path.join(root, archive, name.slice('.caws/'.length)), original);
    // The review is operational evidence; archived original source stays versionable.
    const receipt = path.join(common, `caws-legacy-adoption-${identity}.json`);
    const recorded = writeFileAtomic(receipt, JSON.stringify({ plan, result }, null, 2) + '\n');
    if (!isOk(recorded)) throw new Error('Failed to preserve migration review');
    for (const change of plan.changes.filter((c) => c.contents !== null))
      write(path.join(root, change.path), change.contents!);
    for (const change of plan.changes
      .filter((c) => c.contents === null)
      .sort((a, b) => Number(legacy.includes(a.path)) - Number(legacy.includes(b.path)))) {
      const target = path.join(root, change.path);
      assertMachinePath(root, target);
      if (fs.readFileSync(target, 'utf8') !== originals.get(change.path))
        throw new Error(`Archive source changed: ${change.path}`);
      fs.unlinkSync(target);
    }
    fs.mkdirSync(specs, { recursive: true });
    return result;
  } finally {
    fs.closeSync(fd);
    fs.unlinkSync(lock);
  }
}
