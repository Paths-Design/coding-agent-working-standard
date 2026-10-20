/** Binary wire adapter for the stock shell composer's ASCII decimal budgets.
 * Broader Python int() argument spellings are outside this private wire contract.
 * Byte interpretation belongs exclusively to utf8.ts.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { truncateUtf8Prefix } from './utf8';

const args = process.argv.slice(2);
const rawLimit = args[0];
if (args.length !== 1 || rawLimit === undefined || !/^[0-9]+$/.test(rawLimit)) {
  process.exitCode = 3;
} else {
  const limit = BigInt(rawLimit);
  const data = readFileSync(0);
  // A huge successful budget need not fit the algorithm's numeric API. If a
  // cut is needed, the actual Buffer length bounds conversion to a safe number.
  const output = limit >= BigInt(data.length) ? data : truncateUtf8Prefix(data, Number(limit));
  writeFileSync(1, output);
}
