import { buildNativeSqliteCandidate, readNativeSqliteBuildRequest } from './native-sqlite-build';

/** Qualification entry point. No implicit profile or conventional target fallback. */
async function main(): Promise<void> {
  const selected = process.env.CAWS_NATIVE_BUILD_REQUEST;
  if (!selected || process.argv.length !== 2) {
    throw new Error(
      'Set CAWS_NATIVE_BUILD_REQUEST to the explicit absolute request file; no arguments are accepted'
    );
  }
  const { request } = readNativeSqliteBuildRequest(selected);
  const controller = new AbortController();
  const abort = (): void => controller.abort();
  process.once('SIGINT', abort);
  process.once('SIGTERM', abort);
  try {
    const result = await buildNativeSqliteCandidate(request, { signal: controller.signal });
    process.stdout.write(
      JSON.stringify({
        status: result.status,
        adoption: result.adoption,
        requestDigest: result.requestDigest,
        receipt: result.status === 'completed' ? result.markerPath : result.failureReceiptPath,
        ...(result.status === 'failed' ? { phase: result.phase, reason: result.reason } : {}),
      }) + '\n'
    );
    process.exitCode = result.status === 'completed' ? 0 : 1;
  } finally {
    process.removeListener('SIGINT', abort);
    process.removeListener('SIGTERM', abort);
  }
}

if (require.main === module) {
  main().catch((error: unknown) => {
    process.stderr.write((error instanceof Error ? error.message : String(error)) + '\n');
    process.exitCode = 2;
  });
}
