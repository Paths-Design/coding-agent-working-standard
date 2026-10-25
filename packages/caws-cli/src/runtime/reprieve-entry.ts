import { readFileSync, writeFileSync } from 'node:fs';
import { readReprieve, serializeReprieveMatch } from './reprieve-reader';

// Context crosses one byte-preserving channel. Node argv decoding must not
// alias invalid OS bytes onto another session or path through U+FFFD.
const args = process.argv.slice(2);
process.exitCode = 1;
if (args.length === 1 && args[0] === '--stdin0') {
  try {
    const bytes = readFileSync(0);
    const fields: string[] = [];
    let start = 0;
    for (let index = 0; index < 4; index++) {
      const end = bytes.indexOf(0, start);
      if (end < 0) throw new Error('Incomplete context');
      const raw = bytes.subarray(start, end);
      const value = raw.toString('utf8');
      if (!Buffer.from(value, 'utf8').equals(raw)) throw new Error('Invalid context encoding');
      fields.push(value);
      start = end + 1;
    }
    if (start !== bytes.length) throw new Error('Extra context');
    const match = readReprieve(fields[0]!, fields[1]!, fields[2]!, fields[3]!);
    const output = match ? serializeReprieveMatch(match) : undefined;
    if (output) {
      writeFileSync(1, output);
      process.exitCode = 0;
    }
  } catch {
    /* An unreadable context or record leaves the guard running. */
  }
}
