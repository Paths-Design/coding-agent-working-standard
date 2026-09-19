'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { extractMachineHandlers } = require('../../dist/init/machine-handler-policy');

test.each(['pre_tool_use', 'post_tool_use', 'session_start', 'stop', 'pre_compact'])(
  'accepts the shipped pre-Bash-3.2-fix %s dispatcher while preserving handlers',
  (event) => {
    const reference = fs.readFileSync(
      path.resolve(__dirname, '../../templates/hook-packs/shared/dispatch', `${event}.sh`),
      'utf8'
    );
    const tail = reference.lastIndexOf('if (( ${#HANDLERS[@]} > 0 )); then');
    expect(tail).toBeGreaterThan(0);
    // Build the invocation once and mutate THAT exact string below. Replacing a
    // bare `'run_handlers '` instead would rewrite whichever occurrence comes
    // first in the file — and a dispatcher comment is free to mention
    // run_handlers (stop.sh does, to explain stdout priority). When that
    // happens the replace silently edits prose, leaves the real call intact,
    // and the assertion below stops testing anything: the dispatcher is still
    // valid, so nothing throws and the test fails for the wrong reason.
    const invocation = `run_handlers${event === 'pre_tool_use' ? ' --short-circuit-on-block' : ''} "${'${HANDLERS[@]}'}"`;
    const previous = reference.slice(0, tail) + invocation + '\n';
    expect(extractMachineHandlers(previous, reference)).toEqual(
      extractMachineHandlers(reference, reference)
    );
    // Added commands, even around a known old scaffold, still require review.
    expect(() =>
      extractMachineHandlers(previous + '\necho unreviewed-custom-command\n', reference)
    ).toThrow(/Custom dispatcher logic/);
    const customized = previous.replace(
      invocation,
      invocation.replace('run_handlers', 'run_custom_handlers')
    );
    // Guard the mutation itself: if it ever stops changing the text, the
    // assertion below would pass vacuously against an unmodified dispatcher.
    expect(customized).not.toEqual(previous);
    expect(customized).toContain('run_custom_handlers');
    expect(() => extractMachineHandlers(customized, reference)).toThrow(/Custom dispatcher logic/);
  }
);
