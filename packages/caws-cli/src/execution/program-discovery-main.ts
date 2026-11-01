/** Private draft metadata entry. Its output cannot replace an authorizer reply. */
import { readAuthorizerInput } from './authorizer-main';
import { decodeAuthorizerRequest } from './protocol';
import { discoverExecutionPrograms, encodeProgramDiscoveryReply } from './program-discovery';
import { EXECUTION_GIT_HOOK_POLICY_ENV } from './lifecycle';

async function main(): Promise<void> {
  const { request, record } = decodeAuthorizerRequest(await readAuthorizerInput(process.stdin));
  // This process is launched by Native with startup-owned context. None of
  // these values is accepted from the submitted source or framed draft record.
  const lifecycleEnvironment = ['HOME', 'CAWS_HOME', 'CODEX_HOME', ...EXECUTION_GIT_HOOK_POLICY_ENV]
    .filter((name) => process.env[name] !== undefined)
    .map((name) => ({ name, value: process.env[name]! }));
  process.stdout.write(
    encodeProgramDiscoveryReply(
      await discoverExecutionPrograms(record, request, lifecycleEnvironment)
    )
  );
}

if (require.main === module)
  main().catch(() => {
    process.stderr.write('Execution program discovery input or infrastructure failure\n');
    process.exitCode = 2;
    process.stdin.destroy();
  });
