function assertPredecessorSettled(unsettled) {
  if (unsettled)
    throw new Error(
      'Earlier fixture lifetime is unproven; no new fixture admitted: ' + unsettled.root
    );
}

async function runCaseLifetime(owner, stage, body) {
  let failed = false;
  let failure, result;
  try {
    stage('body-start');
    result = await body(stage);
  } catch (error) {
    failed = true;
    failure = error;
  }
  owner.pending = false;
  try {
    stage('body-settled');
  } catch (error) {
    owner.retentionFailure = String(error);
    // A receipt failure cannot replace the consumer's original failure.
    if (!failed) {
      failed = true;
      failure = error;
    }
  }
  if (failed) throw failure;
  return result;
}

function closeCaseLifetime(owner, latch) {
  const pending = owner.pending !== false;
  // Establish ownership preservation before any diagnostic filesystem work.
  if (pending) latch(owner);
  owner.closed = true;
  owner.stage('teardown');
  if (pending)
    throw new Error('Async case is unfinished; fixture retained in place: ' + owner.root);
}

module.exports = { assertPredecessorSettled, runCaseLifetime, closeCaseLifetime };
