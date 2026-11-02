import { createHash } from 'node:crypto';
import type { ReviewedCliIdentity } from './cli-identity';

/** Pure closure encoding for external source review and identity comparison.
 * Computing a digest binds bytes; it does not approve the import domain.
 */
export function cliClosureDigest(
  reviewed: Omit<ReviewedCliIdentity, 'prefixRoot' | 'domain'>
): string {
  const encoded = Buffer.from(
    JSON.stringify({
      files: Object.entries(reviewed.files)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([path, pin]) => [
          path,
          { sha256: pin.sha256, sizeBytes: pin.sizeBytes, mode: pin.mode },
        ]),
      packages: Object.entries(reviewed.packages)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([path, pkg]) => [path, { name: pkg.name, version: pkg.version }]),
      omissions: Object.entries(reviewed.omissions).sort(([a], [b]) => a.localeCompare(b)),
      node: {
        sha256: reviewed.node.sha256,
        sizeBytes: reviewed.node.sizeBytes,
        mode: reviewed.node.mode,
      },
    })
  );
  return createHash('sha256').update(encoded).digest('hex');
}
