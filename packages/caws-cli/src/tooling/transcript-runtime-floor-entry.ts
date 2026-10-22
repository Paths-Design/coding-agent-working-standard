/** Actual runtime guard precedes loading the ordinary emitted qualifier modules. */
export function main(): void {
  if (process.versions.node !== '18.0.0')
    throw new Error(
      `Transcript floor qualification requires actual Node 18.0.0; observed ${process.versions.node}`
    );
  // A missing module is fatal; no registration wrapper or alternate runtime exists.
  const qualifier: typeof import('./transcript-runtime-floor') = require('./transcript-runtime-floor');
  const output = qualifier.parseTranscriptFloorArguments(process.argv.slice(2));
  const receipt = qualifier.captureTranscriptFloor(output);
  process.stdout.write(
    JSON.stringify({
      status: 'bounded_floor_component_passed',
      receipt,
      publication: 'not_attempted',
    }) + '\n'
  );
}
if (require.main === module) {
  try {
    main();
  } catch (error: unknown) {
    process.stderr.write((error instanceof Error ? error.message : String(error)) + '\n');
    process.exitCode = 1;
  }
}
