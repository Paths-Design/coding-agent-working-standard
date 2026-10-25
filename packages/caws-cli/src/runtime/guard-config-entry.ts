import { writeFileSync } from 'node:fs';
import {
  loadGuardConfigurationEnvironment,
  serializeGuardEnvironment,
} from './guard-config-loader';

const args = process.argv.slice(2);
if (args.length !== 1 || !args[0]) {
  process.exitCode = 3;
} else {
  writeFileSync(1, serializeGuardEnvironment(loadGuardConfigurationEnvironment(args[0])));
}
