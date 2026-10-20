/** Trusted-fixture ps command bytes + native identity evidence; never signal authority.
 * This does not prove a kernel executable path or defend against argv spoofing.
 */
export type ProcessInstance = {
  pid: number;
  parent: number;
  group: number;
  startSeconds: string;
  startMicros: string;
  zombie: boolean;
};
export type ProcessRow = {
  pid: number;
  parent: number;
  group: number;
  state: string;
  command: string;
};
export type RequestExpectation = {
  platform: NodeJS.Platform;
  frontendPid: number;
  frontendCommand: string;
  native: string;
  node: string;
  engine: string;
};
const DIRECT_PLATFORMS = new Set([
  'aix',
  'android',
  'freebsd',
  'linux',
  'netbsd',
  'openbsd',
  'sunos',
]);
const positive = (value: number): boolean => Number.isSafeInteger(value) && value > 0;
const live = (p: ProcessRow): boolean =>
  positive(p.pid) &&
  positive(p.parent) &&
  positive(p.group) &&
  Boolean(p.state) &&
  !p.state.startsWith('Z');

/** Select every role from one coherent inventory, never from artifact PIDs. */
export function selectRequestChain(
  rows: readonly ProcessRow[] | null,
  expected: RequestExpectation
): ProcessRow[] | null {
  if (
    !rows ||
    !positive(expected.frontendPid) ||
    (expected.platform !== 'darwin' && !DIRECT_PLATFORMS.has(expected.platform)) ||
    new Set(rows.map((p) => p.pid)).size !== rows.length
  )
    return null;
  const frontend = rows.find((p) => p.pid === expected.frontendPid);
  if (!frontend || !live(frontend) || frontend.command !== expected.frontendCommand) return null;
  const chain = [frontend];
  if (expected.platform === 'darwin') {
    const prefix = expected.native + ' engine-custodian ';
    const custodians = rows.filter((p) => {
      if (p.parent !== frontend.pid || !p.command.startsWith(prefix)) return false;
      const fd = p.command.slice(prefix.length);
      return /^[1-9]\d*$/.test(fd) && Number(fd) >= 32 && Number(fd) <= 1_048_576;
    });
    if (custodians.length !== 1) return null;
    const custodian = custodians[0]!;
    if (!live(custodian) || custodian.group !== custodian.pid) return null;
    chain.push(custodian);
  }
  const parent = chain[chain.length - 1]!;
  const engines = rows.filter(
    (p) => p.parent === parent.pid && p.command === expected.node + ' ' + expected.engine
  );
  if (engines.length !== 1) return null;
  const engine = engines[0]!;
  if (!live(engine) || engine.group !== engine.pid) return null;
  chain.push(engine);
  if (
    new Set(chain.map((p) => p.pid)).size !== chain.length ||
    new Set(chain.map((p) => p.group)).size !== chain.length
  )
    return null;
  return chain;
}
function observed(value: unknown): ProcessInstance | null {
  if (!value || typeof value !== 'object') return null;
  const observation = value as Record<string, unknown>;
  if (
    observation.state !== 'observed' ||
    !observation.process ||
    typeof observation.process !== 'object'
  )
    return null;
  const p = observation.process as Record<string, unknown>;
  if (
    !['pid', 'parent', 'group'].every(
      (key) => typeof p[key] === 'number' && positive(p[key] as number)
    ) ||
    typeof p.startSeconds !== 'string' ||
    !/^\d+$/.test(p.startSeconds) ||
    typeof p.startMicros !== 'string' ||
    !/^\d+$/.test(p.startMicros) ||
    p.zombie !== false
  )
    return null;
  return p as ProcessInstance;
}
function sameBirth(a: ProcessInstance, b: ProcessInstance): boolean {
  return a.pid === b.pid && a.startSeconds === b.startSeconds && a.startMicros === b.startMicros;
}
/** Reobserve precise instances; a new birth or moved ancestry cannot qualify. */
export function confirmRequestChain(
  chain: readonly ProcessRow[],
  originalFrontend: unknown,
  before: readonly unknown[],
  after: readonly unknown[]
): ProcessInstance[] | null {
  if (chain.length < 2 || before.length !== chain.length || after.length !== chain.length)
    return null;
  const original = observed(originalFrontend);
  if (!original) return null;
  const confirmed: ProcessInstance[] = [];
  for (const [index, row] of chain.entries()) {
    const first = observed(before[index]),
      last = observed(after[index]);
    if (
      !first ||
      !last ||
      !sameBirth(first, last) ||
      (index === 0 && !sameBirth(original, first)) ||
      [first, last].some(
        (p) => p.pid !== row.pid || p.parent !== row.parent || p.group !== row.group
      )
    )
      return null;
    confirmed.push(last);
  }
  return confirmed;
}
