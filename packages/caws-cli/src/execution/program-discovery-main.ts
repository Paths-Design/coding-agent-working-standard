/** Private draft metadata entry. Its output cannot replace an authorizer reply. */
import { readAuthorizerInput } from './authorizer-main';
import { decodeAuthorizerRequest } from './protocol';
import { discoverExecutionPrograms, encodeProgramDiscoveryReply } from './program-discovery';

async function main(): Promise<void> {
  const { request, record } = decodeAuthorizerRequest(await readAuthorizerInput(process.stdin));
  process.stdout.write(
    encodeProgramDiscoveryReply(await discoverExecutionPrograms(record, request))
  );
}

if (require.main === module)
  main().catch(() => {
    process.stderr.write('Execution program discovery input or infrastructure failure\n');
    process.exitCode = 2;
    process.stdin.destroy();
  });
