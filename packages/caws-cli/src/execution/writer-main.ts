import { runExecutionEvidenceWriter } from './writer';

try {
  process.stdout.write(JSON.stringify(runExecutionEvidenceWriter(process.argv.slice(2))) + '\n');
} catch (error) {
  const reason =
    error instanceof Error && 'reason' in error
      ? String(error.reason)
      : 'infrastructure_unavailable';
  process.stderr.write(`caws execution evidence refused: ${reason}\n`);
  process.exitCode = 1;
}
