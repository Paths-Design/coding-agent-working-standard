import * as fs from 'node:fs';
import * as path from 'node:path';
import { MACHINE_EVENTS } from './native-hook-identification';
import { assertMachinePath } from './machine-paths';
type Event = keyof typeof MACHINE_EVENTS;
export interface SystemSurfacePolicy {
  disabled: Partial<Record<Event, string[]>>;
  extensions: Partial<Record<Event, { handler: string; before: string | null }[]>>;
  handlers: Record<string, string>;
  libraries: Record<string, string>;
}
export function validateSystemPolicy(repo: string, policy: SystemSurfacePolicy, runtime?: { files: string[]; defaults: Record<Event, string[]> }): void {
  if (
    !policy ||
    Object.keys(policy).sort().join(',') !== 'disabled,extensions,handlers,libraries' ||
    Object.values(policy).some((v) => !v || typeof v !== 'object' || Array.isArray(v))
  )
    throw new Error('Malformed system project surface');
  for (const [event, names] of Object.entries(policy.disabled))
    if (
      !(event in MACHINE_EVENTS) ||
      !Array.isArray(names) ||
      names.some((n) => typeof n !== 'string' || !/^[A-Za-z0-9_.-]+\.sh$/.test(n))
    )
      throw new Error('Malformed disabled handlers');
  for (const [event, additions] of Object.entries(policy.extensions)) {
    if (!(event in MACHINE_EVENTS) || !Array.isArray(additions))
      throw new Error('Malformed extensions');
    for (const addition of additions)
      if (
        !addition ||
        Object.keys(addition).sort().join(',') !== 'before,handler' ||
        typeof addition.handler !== 'string' ||
        !/^[A-Za-z0-9_.-]+\.sh(?: [A-Za-z0-9_.:/-]+)*$/.test(addition.handler) ||
        (addition.before !== null &&
          (typeof addition.before !== 'string' || !/^[A-Za-z0-9_.-]+\.sh$/.test(addition.before)))
      )
        throw new Error('Malformed extension');
  }
  for (const [kind, paths] of [
    ['handlers', policy.handlers],
    ['libraries', policy.libraries],
  ] as const) {
    for (const [name, relative] of Object.entries(paths)) {
      if (
        !/^[A-Za-z0-9_.-]+$/.test(name) ||
        typeof relative !== 'string' ||
        path.isAbsolute(relative) ||
        relative.split('/').includes('..')
      )
        throw new Error('Invalid extension path');
      if (kind === 'handlers' && !name.endsWith('.sh'))
        throw new Error('Handler override must name a shell handler');
      if (kind === 'libraries' && ['agent-surface.sh', 'runtime-paths.sh'].includes(name))
        throw new Error(`Bootstrap library cannot be overridden: ${name}`);
      const target = path.join(repo, relative);
      assertMachinePath(repo, target);
      if (!fs.statSync(target).isFile()) throw new Error(`Extension is not a file: ${relative}`);
      if (kind === 'handlers') fs.accessSync(target, fs.constants.X_OK);
    }
  }
  if (runtime) {
    for (const event of Object.keys(MACHINE_EVENTS) as Event[]) {
      const names = runtime.defaults[event].map(h => h.split(' ')[0] as string)
        .filter(name => !policy.disabled[event]?.includes(name));
      for (const extension of policy.extensions[event] ?? []) {
        const name = extension.handler.split(' ')[0] as string;
        if ((!policy.handlers[name] && !runtime.files.includes(name)) || names.includes(name))
          throw new Error(`Missing or duplicate system extension: ${name}`);
        const index = extension.before === null ? names.length : names.indexOf(extension.before);
        if (index < 0) throw new Error(`System extension anchor is absent: ${extension.before}`);
        names.splice(index, 0, name);
      }
    }
  }
}
