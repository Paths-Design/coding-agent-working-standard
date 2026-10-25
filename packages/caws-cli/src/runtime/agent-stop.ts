import { assertMatchedCliIdentityReceipt } from './cli-identity';
import { stopAgentActivity } from '../application/agent-stop';
import { repoRootFromGitCommonDir } from '../store/repo-root';
import { safeLeaseFilename } from '../store/leases-store';
import type { HandlerResult } from './composer';
import type { StockHandlerContext } from './stock-handlers';
import type { NativeStopLeaseContextPort } from './stop-lease-context';

export interface AgentStopRuntimePorts {
  readonly stop: typeof stopAgentActivity;
  readonly now: () => Date;
}
const productionPorts: AgentStopRuntimePorts = { stop: stopAgentActivity, now: () => new Date() };
const silent = (): HandlerResult => ({
  exitCode: 0,
  stdout: new Uint8Array(),
  stderr: new Uint8Array(),
});

/** Late requesting-consumer Git is awaited before any lease read/write. Query
 * cancellation, identity invalidation and unknown cleanup remain fatal; only
 * native-settled nonzero Git preserves the ordinary silent no-lease behavior.
 */
export async function executeAgentStop(
  context: StockHandlerContext,
  git: NativeStopLeaseContextPort,
  assertSelection: () => void,
  ports: AgentStopRuntimePorts = productionPorts
): Promise<HandlerResult> {
  const checkpoint = (): void => {
    if (context.signal.aborted) throw context.signal.reason;
    if (ports.now().getTime() >= context.request.deadlineEpochMs)
      throw new Error('Original Stop handler deadline expired');
  };
  checkpoint();
  assertSelection();
  const sessionId = context.request.payload.session_id;
  if (typeof sessionId !== 'string' || !safeLeaseFilename(sessionId).ok) return silent();
  const observed = await git.observe(); // never caught or replayed as a shell handler
  checkpoint();
  assertSelection();
  if (observed.status === 'git_failed') return silent();
  // Production stock entry requires this actual owner. Direct operation tests
  // can exercise the shared factual consumer without inventing CLI receipts.
  if (context.nativeStopCliIdentity) {
    assertMatchedCliIdentityReceipt(context.nativeStopCliIdentity, context.request, context.signal);
    await context.nativeStopCliIdentity.revalidate();
    checkpoint();
    assertSelection();
  }
  const root = repoRootFromGitCommonDir(observed.commonDir);
  if (root.repoRoot !== context.selection.canonical)
    throw new Error('Late Stop Git root differs from admitted selection');
  // The shared application catches no exception from beforeApply. Keep the
  // invocation barrier immediately after load/transition and before store write.
  let barrierError: unknown;
  const beforeApply = (): void => {
    try {
      checkpoint();
      assertSelection();
    } catch (error) {
      barrierError = error;
      throw error;
    }
  };
  let result: ReturnType<typeof stopAgentActivity>;
  try {
    result = ports.stop({
      cawsDir: root.cawsDir,
      identity: { session_id: sessionId, platform: 'opencode' },
      now: ports.now,
      beforeApply,
    });
  } catch {
    checkpoint();
    if (barrierError !== undefined) throw barrierError;
    // Ordinary CLI transaction errors are best effort. Never replay or retry.
    return silent();
  }
  checkpoint();
  if (!result.ok) return silent();
  return {
    ...silent(),
    stderr: Buffer.from(
      result.value.wrote
        ? 'stopped ' + result.value.session_id + '\n'
        : 'no prior lease for ' + result.value.session_id + ' (no-op)\n'
    ),
  };
}
