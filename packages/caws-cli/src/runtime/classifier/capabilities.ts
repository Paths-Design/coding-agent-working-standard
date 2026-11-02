import { basename } from 'node:path';
import * as data from './data';
import type { AdapterState } from './adapters';
import { shellTokens } from './lexer';
import { isAssignmentToken } from './wrappers';
import type { CommandFact, Finding } from './types';

const member = (values: readonly string[], value: string): boolean => values.includes(value);
type Base = {
  kind: CommandFact['kind'];
  domain: CommandFact['domain'];
  reversibility: CommandFact['reversibility'];
  blast: CommandFact['blastRadius'];
  trace: string;
};
const builtins = data.DEFAULT_ADAPTERS as unknown as Readonly<
  Record<string, readonly (readonly [readonly string[], Base])[]>
>;

export function buildCommandFact(segment: string, adapters: AdapterState): CommandFact {
  const fact: CommandFact = {
    executable: '',
    executablePath: '',
    argv: [],
    wrappers: [],
    subcommandPath: [],
    flags: new Set(),
    targets: [],
    payload: '',
    parseConfidence: 'high',
    kind: 'NONE',
    domain: 'unknown',
    scope: 'narrow',
    reversibility: 'unknown',
    opacity: 'none',
    blastRadius: 'single',
    traceLabel: '',
  };
  const tokens = shellTokens(segment);
  if (!tokens?.length) {
    fact.parseConfidence = 'low';
    return fact;
  }
  let index = 0;
  while (index < tokens.length) {
    const token = tokens[index] ?? '';
    const base = basename(token);
    if (isAssignmentToken(token)) {
      fact.wrappers.push(token);
      index++;
      continue;
    }
    if (['env', 'command', 'nohup', 'builtin', 'time', 'sudo', 'doas'].includes(base)) {
      fact.wrappers.push(base);
      index++;
      while ((tokens[index] ?? '').startsWith('-')) index++;
      continue;
    }
    break;
  }
  if (index >= tokens.length) {
    fact.parseConfidence = 'partial';
    return fact;
  }
  fact.executablePath = tokens[index] ?? '';
  fact.executable = basename(fact.executablePath);
  fact.argv = tokens.slice(index + 1);
  fact.flags = new Set(fact.argv.filter((token) => token.startsWith('-')));
  fact.targets = fact.argv.filter((token) => !token.startsWith('-'));
  fact.subcommandPath = fact.targets.slice(0, 2);
  if (
    fact.wrappers.includes('sudo') ||
    fact.wrappers.includes('doas') ||
    ['su', 'sudo', 'doas'].includes(fact.executable)
  ) {
    fact.kind = 'PRIV_ESC';
    fact.domain = 'local';
    fact.traceLabel = 'PRIV_ESC';
  }
  if ([...fact.flags].some((flag) => member(data.BROAD_SCOPE_INDICATORS, flag)))
    fact.scope = 'broad';
  if (fact.targets.some((target) => member(data.PROD_SCOPE_INDICATORS, target)))
    fact.scope = 'prod';
  if (member(data.OPAQUE_EXEC_EXECUTABLES, fact.executable)) {
    if (
      ['sh', 'bash', 'zsh', 'dash', 'python', 'python3', 'node', 'ruby', 'perl'].includes(
        fact.executable
      )
    ) {
      const flags = ['sh', 'bash', 'zsh', 'dash'].includes(fact.executable) ? ['-c'] : ['-c', '-e'];
      const payloadIndex = fact.argv.findIndex((token) => flags.includes(token));
      fact.payload = payloadIndex < 0 ? '' : (fact.argv[payloadIndex + 1] ?? '');
    } else fact.payload = fact.targets.join(' ');
    fact.opacity = !fact.payload
      ? 'none'
      : /\$\(|\$\{|\$[A-Za-z_]|`/.test(fact.payload)
        ? 'opaque'
        : 'literal';
  }
  if (fact.kind === 'NONE' && !member(data.OPAQUE_EXEC_EXECUTABLES, fact.executable))
    deriveFacets(fact, adapters);
  return fact;
}

export function deriveFacets(fact: CommandFact, adapters: AdapterState): void {
  let base: Base | undefined;
  const executable = fact.executable;
  if (['curl', 'http', 'wget'].includes(executable)) {
    let method = '';
    for (let index = 0; index < fact.argv.length; index++) {
      const token = fact.argv[index] ?? '';
      if (['-X', '--request'].includes(token) && index + 1 < fact.argv.length) {
        method = (fact.argv[index + 1] ?? '').toUpperCase();
        break;
      }
      if (token.startsWith('-X') && token.length > 2) {
        method = token.slice(2).toUpperCase();
        break;
      }
    }
    const hasData = [...fact.flags].some(
      (flag) => flag.startsWith('--data') || flag.startsWith('-d')
    );
    if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(method) || (!method && hasData))
      base = {
        kind: 'MUTATE',
        domain: 'http',
        reversibility: 'unknown',
        blast: 'single',
        trace: 'HTTP_MUTATE',
      };
  }
  if (!base && member(data.CLOUD_CLIS, executable)) {
    const verbs = fact.targets.flatMap((target) => [target, target.split('-')[0] ?? '']);
    if (verbs.some((verb) => member(data.DESTROY_VERBS, verb)))
      base = {
        kind: 'DESTROY',
        domain: 'cloud',
        reversibility: 'partial',
        blast: 'single',
        trace: 'CLOUD_DELETE',
      };
    else if (verbs.some((verb) => member(data.MUTATE_VERBS, verb)))
      base = {
        kind: 'MUTATE',
        domain: 'cloud',
        reversibility: 'partial',
        blast: 'single',
        trace: 'CLOUD_MUTATE',
      };
  }
  if (
    !base &&
    executable === 'sysctl' &&
    (fact.flags.has('-w') || fact.targets.some((target) => target.includes('=')))
  )
    base = {
      kind: 'MUTATE',
      domain: 'local',
      reversibility: 'partial',
      blast: 'host',
      trace: 'KERNEL_MUTATE',
    };
  if (
    executable === 'ansible-playbook' &&
    [...fact.flags].some((flag) =>
      [
        '--version',
        '--help',
        '-h',
        '--check',
        '-C',
        '--syntax-check',
        '--list-tasks',
        '--list-hosts',
        '--list-tags',
      ].includes(flag)
    )
  )
    return;
  if (!base && Object.hasOwn(builtins, executable)) {
    let best = -1;
    for (const [prefix, facets] of builtins[executable] ?? []) {
      if (
        prefix.every((token, index) => fact.subcommandPath[index] === token) &&
        prefix.length > best
      ) {
        base = facets;
        best = prefix.length;
      }
    }
  }
  if (!base && adapters.ok && Object.hasOwn(adapters.adapters, executable)) {
    const adapter = adapters.adapters[executable];
    if (adapter) {
      const subcommands = fact.subcommandPath.map((token) =>
        Object.hasOwn(adapter.resource_aliases, token)
          ? (adapter.resource_aliases[token] ?? token)
          : token
      );
      let best = -1;
      for (const row of adapter.subcommands) {
        if (
          subcommands.length >= row.path.length &&
          row.path.every((token, index) => token === '*' || token === subcommands[index]) &&
          row.path.length > best
        ) {
          best = row.path.length;
          base = {
            kind: row.facets.kind,
            domain: row.facets.domain ?? 'unknown',
            reversibility: row.facets.reversibility ?? 'unknown',
            blast: row.facets.blast_radius ?? 'single',
            trace: row.facets.trace_label ?? '',
          };
        }
      }
    }
  }
  if (!base) return;
  fact.kind = base.kind;
  fact.domain = base.domain;
  fact.reversibility = base.reversibility;
  fact.blastRadius = base.blast;
  fact.traceLabel = base.trace;
  if (fact.kind !== 'MUTATE' && fact.kind !== 'DESTROY') return;
  if (fact.kind === 'MUTATE' && (fact.flags.has('--destroy') || fact.flags.has('-destroy'))) {
    fact.kind = 'DESTROY';
    fact.reversibility = 'irreversible';
    fact.traceLabel = fact.traceLabel ? `${fact.traceLabel}_DESTROY` : 'DESTROY';
  }
  const amplified = [...fact.flags].filter((flag) => member(data.MUTATION_AMPLIFIER_FLAGS, flag));
  if (
    amplified.some((flag) =>
      ['--recursive', '--volumes', '--prune', '--delete', '--destroy', '--force'].includes(flag)
    ) &&
    fact.domain !== 'process' &&
    executable !== 'helm'
  )
    fact.reversibility = 'irreversible';
  if (amplified.some((flag) => flag === '--all' || flag === '-A') && fact.scope !== 'prod')
    fact.scope = 'broad';
}

export function latticeDecision(fact: Readonly<CommandFact>): Finding | null {
  const label = fact.traceLabel || fact.kind;
  if (fact.kind === 'PRIV_ESC') return ['deny', `privilege escalation (${label})`];
  if (fact.kind === 'SECRETS_READ') return ['deny', `secret/credential read (${label})`];
  if (fact.kind === 'DESTROY' && fact.reversibility === 'irreversible')
    return ['deny', `irreversible destruction (${label})`];
  if (
    fact.kind === 'DESTROY' &&
    (['prod', 'broad'].includes(fact.scope) || fact.blastRadius === 'cluster')
  )
    return ['deny', `broad/prod destruction (${label})`];
  if (fact.kind === 'EXEC' && fact.opacity === 'opaque')
    return ['ask', `opaque execution — cannot prove payload (${label})`];
  if (fact.kind === 'DESTROY') return ['ask', `destructive operation (${label})`];
  if (fact.kind === 'MUTATE' && ['prod', 'broad'].includes(fact.scope))
    return ['deny', `broad/prod mutation (${label})`];
  if (fact.kind === 'MUTATE') return ['ask', `state mutation (${label})`];
  return null;
}
