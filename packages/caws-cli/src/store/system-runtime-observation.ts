import { validateSystemPolicy } from '../init/system-project-policy';
import type { NativeConfiguration } from '../init/native-hook-identification';
import type { SystemProjectSettings } from '../init/system-runtime';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { createHash } from 'node:crypto';
import { readPointer, verifyRuntime } from '../init/machine-runtime-state';
import { assertMachinePath } from '../init/machine-paths';
import { configHasCawsHooks, systemCommand } from '../init/native-hook-identification';
import type { SystemRuntimeObservation } from '../kernel/doctor/types';

/** Observe disk configuration and verified runtime bytes without loading hooks,
 * invoking installers, or treating the observation as native activation proof. */
export function observeSystemRuntime(repo: string): SystemRuntimeObservation | undefined {
  const home = process.env.CAWS_HOME || path.join(os.homedir(), '.caws');
  const surfaces: string[] = [],
    legacySurfaces: string[] = [],
    overrides: string[] = [];
  const read = <T>(root: string, relative: string): T | undefined => {
    const file = path.join(root, relative);
    assertMachinePath(root, file);
    return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : undefined;
  };
  try {
    const key = createHash('sha256').update(fs.realpathSync(repo)).digest('hex');
    const project = read<SystemProjectSettings>(home, `state/projects/${key}.json`);
    if (
      project !== undefined &&
      (project?.version !== 1 || project.root !== fs.realpathSync(repo) || !project.surfaces)
    )
      throw new Error('Malformed system project settings');
    for (const [surface, vendor] of [
      ['codex', '.codex'],
      ['claude-code', '.claude'],
      ['qwen-code', '.qwen'],
    ]) {
      const settings = read<{ version: unknown; enabled: unknown }>(
        home,
        `surfaces/${surface}/settings.json`
      );
      const nativeName = surface === 'codex' ? 'hooks.json' : 'settings.json';
      if (configHasCawsHooks(read(repo, `${vendor}/${nativeName}`)))
        legacySurfaces.push(surface as string);
      if (settings === undefined) continue;
      if (settings?.version !== 1 || typeof settings.enabled !== 'boolean')
        throw new Error(`Malformed system surface settings: ${surface}`);
      if (!settings.enabled) continue;
      surfaces.push(surface as string);
      const native = read<NativeConfiguration>(os.homedir(), `${vendor}/${nativeName}`);
      for (const [event, name] of Object.entries({
        pre_tool_use: 'PreToolUse',
        post_tool_use: 'PostToolUse',
        session_start: 'SessionStart',
        stop: 'Stop',
        pre_compact: 'PreCompact',
      })) {
        const groups = native?.hooks?.[name];
        if (
          !Array.isArray(groups) ||
          !groups.some(
            (group) =>
              group.enabled !== false &&
              Array.isArray(group.hooks) &&
              group.hooks.some(
                (hook) =>
                  hook.enabled !== false &&
                  hook.command === systemCommand(home, surface as string, event)
              )
          )
        )
          throw new Error(
            `System native registration missing or customized for ${surface}/${name}`
          );
      }
      const selected = project?.surfaces[surface as string];
      if (!selected && fs.existsSync(path.join(repo, '.caws/hooks')))
        throw new Error(`Project requires one-time system migration for ${surface}`);
      if (selected) {
        validateSystemPolicy(repo, selected);
        if (Object.keys(selected).sort().join(',') !== 'disabled,extensions,handlers,libraries')
          throw new Error(`Malformed system project surface: ${surface}`);
        for (const [kind, entries] of Object.entries(selected))
          for (const name of Object.keys(entries as object))
            overrides.push(`${surface}:${kind}:${name}`);
      }
    }
    if (surfaces.length === 0) return undefined;
    const pointer = readPointer(home);
    if (!pointer) throw new Error('System runtime pointer missing');
    const files = verifyRuntime(home, pointer.digest);
    if (!files['system-policy.json'] || !files['session_log_renderer.py'])
      throw new Error('Runtime lacks system guards and renderers');
    return { surfaces, legacySurfaces, overrides, digest: pointer.digest };
  } catch (error) {
    return { surfaces, legacySurfaces, overrides, error: (error as Error).message };
  }
}
