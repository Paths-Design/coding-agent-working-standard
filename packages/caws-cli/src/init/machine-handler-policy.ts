const normalize = (text: string): string =>
  text
    .replace(/\r\n/g, '\n')
    .split('\n')
    .filter((line) => !/^\s*#/.test(line))
    .map((line) => line.trim())
    .filter(Boolean)
    .join('\n');

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
  let previousSkeleton = currentSkeleton;
  for (const flags of ['', ' --short-circuit-on-block']) {
    const invocation = `run_handlers${flags} "\${HANDLERS[@]}"`;
    const guarded = [
      'if (( ${#HANDLERS[@]} > 0 )); then', invocation,
      'else', `run_handlers${flags}`, 'fi',
    ].join('\n');
    if (currentSkeleton.endsWith(guarded))
      previousSkeleton = currentSkeleton.slice(0, -guarded.length) + invocation;
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
  const actual = skeleton(text);
  if (
    actual !== currentSkeleton &&
    actual !== previousSkeleton &&
    actual !== legacy &&
    actual !== legacy.replace('run_handlers ', 'run_handlers --short-circuit-on-block ')
  ) {
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
