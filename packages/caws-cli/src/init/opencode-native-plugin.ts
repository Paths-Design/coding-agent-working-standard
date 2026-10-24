import * as path from 'node:path';

/** The installed project producer must equal this selected generation member.
 * Presence/identity is only registration evidence, never native SQL admission.
 */
export const OPENCODE_NATIVE_PLUGIN_MEMBER = 'surfaces/opencode/native-plugin.ts';
const marker = 'const NATIVE_STOP_HOME: string | null = null;';

/** Render one explicit machine-home binding from the shared authoritative
 * plugin source. Ordinary project-pack installation keeps its null/legacy mode.
 * No template program is evaluated, and no harness registration is changed.
 */
export function renderOpenCodeNativePlugin(source: Buffer, home: string): Buffer {
  if (!path.isAbsolute(home) || home.includes('\0'))
    throw new Error('OpenCode native Stop requires an absolute machine home');
  const text = source.toString('utf8');
  if (!Buffer.from(text).equals(source) || text.split(marker).length !== 2)
    throw new Error('OpenCode native Stop template marker is missing or ambiguous');
  return Buffer.from(
    text.replace(marker, 'const NATIVE_STOP_HOME: string | null = ' + JSON.stringify(home) + ';')
  );
}
