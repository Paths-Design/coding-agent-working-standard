import { ExecutionAuthorityUnavailable } from './authority';
import { ExecutionLifecyclePublicationFailure, runExecutionLifecycleConsumer } from './lifecycle';

try {
  const result = runExecutionLifecycleConsumer(process.argv.slice(2));
  try {
    process.stdout.write(JSON.stringify(result) + '\n');
  } catch {
    throw new ExecutionLifecyclePublicationFailure({ operation: result.action }, result.specId);
  }
} catch (error) {
  if (error instanceof ExecutionLifecyclePublicationFailure) {
    try {
      process.stdout.write(JSON.stringify(error.outcome) + '\n');
    } catch {
      /* publication remains uncertain */
    }
    process.stderr.write('caws lifecycle publication requires inspection\n');
  } else {
    process.stderr.write(
      `caws lifecycle refused: ${error instanceof ExecutionAuthorityUnavailable ? error.reason : 'infrastructure_unavailable'}\n`
    );
  }
  process.exitCode = 1;
}
