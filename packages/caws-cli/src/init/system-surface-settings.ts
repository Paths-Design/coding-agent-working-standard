import * as fs from 'node:fs';
import * as path from 'node:path';
import { assertMachinePath } from './machine-paths';

export interface SystemSurfaceSettings {
  version: 1;
  enabled: boolean;
  native_config_target?: string;
}

export function readSystemSurfaceSettings(
  home: string,
  surface: string
): SystemSurfaceSettings | undefined {
  const file = path.join(home, 'surfaces', surface, 'settings.json');
  assertMachinePath(home, file);
  if (!fs.existsSync(file)) return undefined;
  const value = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (
    !value ||
    value.version !== 1 ||
    typeof value.enabled !== 'boolean' ||
    Object.keys(value).some((k) => !['version', 'enabled', 'native_config_target'].includes(k)) ||
    (value.native_config_target !== undefined &&
      (typeof value.native_config_target !== 'string' ||
        !path.isAbsolute(value.native_config_target)))
  )
    throw new Error('Malformed system surface settings');
  return value;
}

/** Follow a user-managed native-config symlink only through its explicit,
 * persisted target. Never replace the link or accept a subsequently moved one. */
export function nativeConfigPath(
  user: string,
  vendor: string,
  name: string,
  target?: string
): string {
  const native = path.join(user, vendor, name);
  if (target !== undefined) {
    assertMachinePath(user, target);
    if (
      !fs.existsSync(native) ||
      fs.realpathSync(native) !== fs.realpathSync(target) ||
      !fs.statSync(target).isFile()
    )
      throw new Error(`Native configuration target changed or does not match: ${native}`);
    return target;
  }
  assertMachinePath(user, native);
  return native;
}
