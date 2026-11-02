import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';
import { TextDecoder } from 'node:util';
import {
  classifyInspectionPrefix,
  INSPECTION_PREFIX_ALLOW,
  INSPECTION_PREFIX_LIMITS,
  type InspectionPrefixStatus,
} from './inspection-prefix';
import { NODE_STARTUP_CONTROLS } from './inspection-profiles';

/** Supervisor stays responsive while the synchronous parser runs in a worker.
 * The same compiled entry serves the pinned hook binding and diagnostic CLI.
 */
export function inspectPrefixBounded(input: string): Promise<InspectionPrefixStatus> {
  if (Buffer.byteLength(input, 'utf8') > INSPECTION_PREFIX_LIMITS.bytes) return Promise.resolve(2);
  return new Promise((resolve) => {
    const env = { ...process.env };
    for (const name of NODE_STARTUP_CONTROLS) delete env[name];
    let done = false,
      result: InspectionPrefixStatus | undefined;
    let worker: Worker;
    const finish = (status: InspectionPrefixStatus): void => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      if (worker) void worker.terminate();
      resolve(status);
    };
    const timer = setTimeout(() => finish(2), INSPECTION_PREFIX_LIMITS.wallMs);
    try {
      worker = new Worker(__filename, {
        workerData: input,
        env,
        execArgv: [],
        stdout: true,
        stderr: true,
        resourceLimits: { maxOldGenerationSizeMb: 64, stackSizeMb: 2 },
      });
      // Classification has no output channel other than a single numeric result.
      worker.stdout.on('data', () => finish(2));
      worker.stderr.on('data', () => finish(2));
      worker.on('message', (value: unknown) => {
        if (result !== undefined || ![0, 1, 2].includes(value as number)) finish(2);
        else result = value as InspectionPrefixStatus;
      });
      worker.on('error', () => finish(2));
      worker.on('exit', (code) => finish(code === 0 && result !== undefined ? result : 2));
    } catch {
      finish(2);
    }
  });
}

export async function runInspectionPrefixStdin(): Promise<number> {
  let chunks: Buffer[] = [],
    bytes = 0;
  const input = await new Promise<Buffer | null>((resolve) => {
    let done = false;
    const finish = (value: Buffer | null): void => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      process.stdin.destroy();
      resolve(value);
    };
    const timer = setTimeout(() => finish(null), INSPECTION_PREFIX_LIMITS.wallMs);
    process.stdin.on('data', (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > INSPECTION_PREFIX_LIMITS.bytes) {
        chunks = [];
        finish(null);
      } else chunks.push(chunk);
    });
    process.stdin.once('end', () => finish(Buffer.concat(chunks)));
    process.stdin.once('error', () => finish(null));
    process.stdin.resume();
  });
  let code: InspectionPrefixStatus = 2;
  if (input !== null) {
    // Preserve a leading BOM as source, rather than silently changing a command
    // name/gap before the structural predicate sees the submitted bytes.
    try {
      code = await inspectPrefixBounded(
        new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(input)
      );
    } catch {
      code = 2;
    }
  }
  process.stdout.write(
    code === 0
      ? INSPECTION_PREFIX_ALLOW
      : code === 1
        ? 'caws.inspection-prefix.v1:unsupported\n'
        : 'caws.inspection-prefix.v1:error\n'
  );
  return code;
}

if (!isMainThread) {
  void classifyInspectionPrefix(workerData as string)
    .then((code) => {
      parentPort!.postMessage(code);
      parentPort!.close();
    })
    .catch(() => {
      parentPort!.postMessage(2);
      parentPort!.close();
    });
} else if (require.main === module) {
  if (process.argv.length !== 2) {
    process.stdout.write('caws.inspection-prefix.v1:error\n');
    process.exitCode = 2;
  } else
    void runInspectionPrefixStdin().then((code) => {
      process.exitCode = code;
    });
}
