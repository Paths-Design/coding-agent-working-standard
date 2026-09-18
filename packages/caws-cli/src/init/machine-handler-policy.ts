const normalize = (text: string): string =>
  text
    .replace(/\r\n/g, '\n')
    .split('\n')
    .filter((line) => !/^\s*#/.test(line))
    .map((line) => line.trim())
    .filter(Boolean)
    .join('\n');

/**
 * The compiled-chain trailer added to every shared dispatcher in pack v83
 * (CAWS-REPO-HOOK-POLICY-PROJECT-WIRED-01), as it appears AFTER `normalize`
 * has stripped comments. Matched so the same template minus this block stays
 * admitted: consumers upgrade the CLI before they re-install the pack, so the
 * dispatcher on disk routinely predates the template by one version.
 */
const LOCAL_CHAIN_TRAILER =
  /if \[\[ -f "\$HOOKS_DIR\/lib\/local-chain\.sh" \]\]; then\nsource "\$HOOKS_DIR\/lib\/local-chain\.sh"\nfi\nif declare -F caws_local_chain >\/dev\/null 2>&1 && caws_local_chain [a-z_]+; then\nHANDLERS=\(\$\{CAWS_LOCAL_CHAIN\[@\]\+"\$\{CAWS_LOCAL_CHAIN\[@\]\}"\}\)\nfi\n/;

/** Read a literal handler array, never source/eval project shell during a plan.
 * Only known dispatcher scaffolding is admitted. Custom shell logic outside the
 * array must be reconciled explicitly using --from <surface-policy.json>. */
export function extractMachineHandlers(text: string, reference: string): string[] {
  const array = /^(HANDLERS|_ALL_HANDLERS)=\(\s*\n([\s\S]*?)^\)/m;
  const match = array.exec(text);
  if (!match)
    throw new Error('Dispatcher has no literal handler array; use --from with reviewed policy');
  const skeleton = (body: string): string => normalize(body.replace(array, '$1=(\n)'));
  const currentSkeleton = skeleton(reference);
  // The published 12.1.0 dispatchers predate the Bash 3.2 empty-array guard.
  // Admit that exact shipped trailer as well as the current one. Do not use a
  // project's mutable pristine file as a reference for arbitrary shell logic.
  // Every shape a project may legitimately be on. A dispatcher installed before
  // a given upstream addition is NOT custom logic, and treating it as such would
  // demand `--from` from repos that changed nothing — turning a routine pack
  // bump into a migration for every consumer.
  const admitted = new Set<string>();
  for (const base of [currentSkeleton, currentSkeleton.replace(LOCAL_CHAIN_TRAILER, '')]) {
    admitted.add(base);
    // The published 12.1.0 dispatchers predate the Bash 3.2 empty-array guard.
    // Admit that exact shipped trailer as well as the current one. Do not use a
    // project's mutable pristine file as a reference for arbitrary shell logic.
    for (const flags of ['', ' --short-circuit-on-block']) {
      const invocation = `run_handlers${flags} "\${HANDLERS[@]}"`;
      const guarded = [
        'if (( ${#HANDLERS[@]} > 0 )); then',
        invocation,
        'else',
        `run_handlers${flags}`,
        'fi',
      ].join('\n');
      if (base.endsWith(guarded)) admitted.add(base.slice(0, -guarded.length) + invocation);
    }
  }
  const legacy = normalize(`set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "\${BASH_SOURCE[0]}")" && pwd)"
HOOKS_DIR="$(dirname "$SCRIPT_DIR")"
source "$HOOKS_DIR/lib/parse-input.sh" 2>/dev/null || exit 0
parse_hook_input || exit 0
source "$HOOKS_DIR/lib/run-handlers.sh" 2>/dev/null || exit 0
HANDLERS=(
)
run_handlers \"\${HANDLERS[@]}\"`);
  admitted.add(legacy);
  admitted.add(legacy.replace('run_handlers ', 'run_handlers --short-circuit-on-block '));
  const actual = skeleton(text);
  if (!admitted.has(actual)) {
    throw new Error(
      'Custom dispatcher logic requires review; use --from with an explicit surface policy'
    );
  }
  const handlers: string[] = [];
  for (const raw of (match[2] as string).split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const value = /^(?:"([^"$`\\]+)"|'([^'$`\\]+)'|([A-Za-z0-9_.-]+))(?:\s+#.*)?$/.exec(line);
    const entry = value && (value[1] ?? value[2] ?? value[3]);
    if (!entry || !/^[A-Za-z0-9_.-]+\.sh(?: [A-Za-z0-9_.:/-]+)*$/.test(entry)) {
      throw new Error(`Nonliteral handler requires review: ${line}`);
    }
    handlers.push(entry);
  }
  return handlers;
}
