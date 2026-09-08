'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { extractMachineHandlers } = require('../../dist/init/machine-handler-policy');

test.each(['pre_tool_use', 'post_tool_use', 'session_start', 'stop', 'pre_compact'])(
  'accepts the shipped pre-Bash-3.2-fix %s dispatcher while preserving handlers', event => {
    const reference = fs.readFileSync(path.resolve(__dirname, '../../templates/hook-packs/shared/dispatch', `${event}.sh`), 'utf8');
    const tail = reference.lastIndexOf('if (( ${#HANDLERS[@]} > 0 )); then');
    expect(tail).toBeGreaterThan(0);
    const previous = reference.slice(0, tail) + `run_handlers${event === 'pre_tool_use' ? ' --short-circuit-on-block' : ''} "${'${HANDLERS[@]}'}"\n`;
    expect(extractMachineHandlers(previous, reference)).toEqual(extractMachineHandlers(reference, reference));
    // Added commands, even around a known old scaffold, still require review.
    expect(() => extractMachineHandlers(previous + '\necho unreviewed-custom-command\n', reference)).toThrow(/Custom dispatcher logic/);
    expect(() => extractMachineHandlers(previous.replace('run_handlers ', 'run_custom_handlers '), reference)).toThrow(/Custom dispatcher logic/);
  }
);
