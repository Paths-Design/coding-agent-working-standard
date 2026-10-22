/** Selection inspection for the installed entry. It never prepares or dispatches handlers. */
import * as path from 'node:path';
import { invocationCaller, resolveRuntimeProject } from './context';
import { resolveInvocationSelection } from './selection';
import { MACHINE_EVENTS } from '../init/native-hook-identification';
import { IMPLEMENTED_SURFACES } from '../init/hook-packs/register';
import type { AgentSurface } from '../init/hook-packs/types';
import type { HookEvent } from './types';

export async function runDescribeEntry(
  args: readonly string[] = process.argv.slice(2)
): Promise<void> {
  const options = new Map<string, string>();
  if (args.length !== 8) throw new Error('Describe requires four explicit option/value pairs');
  for (let i = 0; i < args.length; i += 2) {
    const key = args[i]!,
      value = args[i + 1]!;
    if (
      !['--surface', '--event', '--runtime-digest', '--configuration'].includes(key) ||
      options.has(key)
    )
      throw new Error('Invalid describe arguments');
    options.set(key, value);
  }
  const surface = options.get('--surface') as AgentSurface;
  const event = options.get('--event') as HookEvent;
  const runtimeDigest = options.get('--runtime-digest')!;
  const configuration = options.get('--configuration');
  if (
    !IMPLEMENTED_SURFACES.includes(surface) ||
    !Object.hasOwn(MACHINE_EVENTS, event) ||
    !/^[a-f0-9]{64}$/.test(runtimeDigest) ||
    !['system', 'project'].includes(configuration!)
  )
    throw new Error('Invalid describe selection coordinates');
  // This reserved channel is overwritten by the installed Rust entry before it
  // sanitizes Node loader inputs. It is ephemeral context, never a stored receipt.
  const value: unknown = JSON.parse(process.env.CAWS_NATIVE_DESCRIBE_CONTEXT ?? 'null');
  delete process.env.CAWS_NATIVE_DESCRIBE_CONTEXT;
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Describe context is absent');
  const context = value as { cwd?: unknown; environment?: unknown };
  if (
    typeof context.cwd !== 'string' ||
    !context.environment ||
    typeof context.environment !== 'object' ||
    Array.isArray(context.environment) ||
    Object.values(context.environment).some((v) => typeof v !== 'string')
  )
    throw new Error('Invalid describe caller context');
  const caller = invocationCaller(context.cwd, context.environment as Record<string, string>);
  const home =
    caller.environment.CAWS_HOME ||
    (caller.environment.HOME ? path.join(caller.environment.HOME, '.caws') : '');
  if (!path.isAbsolute(home)) throw new Error('Describe requires an absolute caller machine home');
  const project = await resolveRuntimeProject({}, caller, Date.now() + 5000);
  const selection =
    project.status === 'resolved'
      ? resolveInvocationSelection({
          ...project,
          home,
          runtimeDigest,
          surface,
          event,
          system: configuration === 'system',
        })
      : { status: 'inactive' as const, reason: project.reason };
  const result =
    selection.status === 'inactive'
      ? {
          schema: 'caws.hook_selection.v1',
          status: 'inactive',
          surface,
          event,
          reason: selection.reason,
          handlers: [],
        }
      : {
          schema: 'caws.hook_selection.v1',
          runtime_digest: selection.runtimeDigest,
          project: selection.canonical,
          surface,
          event,
          configuration: selection.configuration,
          handlers: selection.handlers.map((handler) => ({
            entry: handler.entry,
            arguments: handler.args,
            path: handler.path,
            sha256: handler.sha256,
            kind: handler.kind,
            tier: handler.tier,
          })),
          library_resolution: selection.libraries,
          project_libraries: Object.fromEntries(
            Object.entries(selection.libraries).filter(([, lib]) => lib.kind === 'project')
          ),
          transcript_adapter: selection.transcriptAdapter,
          limits: [
            'Selection is not execution.',
            'Project scripts may source further dependencies.',
            'Library resolution describes caws_source_lib lookups, not observed imports.',
            'Reprieves and runtime disable lists can skip selected handlers.',
            'Unselected local-file differences are not inspected by this native description.',
          ],
        };
  process.stdout.write(JSON.stringify(result) + '\n');
}
if (require.main === module)
  void runDescribeEntry().catch((error: unknown) => {
    const message = '[caws native describe] ' + String(error);
    process.stderr.write(message + '\n');
    // Native description follows the configuration-fault policy and dispatches nothing.
    if (process.argv.includes('pre_tool_use')) {
      process.stdout.write(JSON.stringify({ decision: 'block', reason: message }) + '\n');
      process.exitCode = 2;
    }
  });
