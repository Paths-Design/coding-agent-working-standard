/** Private Node child entry; no public CLI command, permits, or USER launch. */
import {
  decodeAuthorizerRequest,
  encodeAuthorizerReply,
  MAX_AUTHORIZER_REQUEST_BYTES,
} from './protocol';
import { evaluatePreparedExecution } from './authorizer';

async function main(): Promise<void> {
  const chunks: Buffer[] = [];
  let length = 0;
  // Local I/O cap only. Rust's original remaining monotonic budget includes
  // child startup/imports and independently kills/reaps this process on expiry.
  const timer = setTimeout(() => {
    process.stdin.destroy(new Error('Authorizer input deadline'));
  }, 5000);
  try {
    for await (const chunk of process.stdin) {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string);
      length += bytes.length;
      if (length > MAX_AUTHORIZER_REQUEST_BYTES + 4) throw new Error('Authorizer input limit');
      chunks.push(bytes);
    }
    const { request, record } = decodeAuthorizerRequest(Buffer.concat(chunks));
    const reply = await evaluatePreparedExecution(record, request);
    process.stdout.write(encodeAuthorizerReply(reply));
  } finally {
    clearTimeout(timer);
  }
}

if (require.main === module)
  main().catch(() => {
    process.stderr.write('Execution authorizer input or infrastructure failure\n');
    process.exitCode = 2;
    process.stdin.destroy();
  });
