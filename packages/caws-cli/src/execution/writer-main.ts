import {
  ExecutionEvidencePublicationFailure,
  runExecutionEvidenceWriter,
  type ExecutionEvidenceResult,
} from './writer';
import { ExecutionAuthorityUnavailable } from './authority';

let completed: ExecutionEvidenceResult | undefined;
try {
  completed = runExecutionEvidenceWriter(process.argv.slice(2));
  process.stdout.write(JSON.stringify(completed) + '\n');
} catch (error) {
  const publication =
    error instanceof ExecutionEvidencePublicationFailure
      ? error
      : completed !== undefined
        ? ExecutionEvidencePublicationFailure.unconfirmed(completed.specId, completed.criterionId)
        : undefined;
  if (publication !== undefined) {
    try {
      process.stdout.write(JSON.stringify(publication.outcome) + '\n');
    } catch {
      // A failed output channel cannot turn known publication into refusal.
    }
    process.stderr.write(
      `caws execution evidence publication requires inspection: ${publication.outcome.disposition}/${publication.outcome.reason}\n`
    );
  } else {
    const reason =
      error instanceof ExecutionAuthorityUnavailable ? error.reason : 'infrastructure_unavailable';
    process.stderr.write(`caws execution evidence refused: ${reason}\n`);
  }
  process.exitCode = 1;
}
