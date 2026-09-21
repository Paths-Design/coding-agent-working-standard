// `caws tui` — read-only full-screen terminal dashboard (CAWS-TUI-DASHBOARD-001).
//
// Hard constraint (spec invariant, mirrors status): tui MUST NOT mutate
// governance state. It reads through shell/panel-data.ts selectors only and
// writes nothing to .caws/ — pinned by the mutation-negative test.
//
// Modes:
//   caws tui            full-screen session (alt screen, refresh interval,
//                       q / Ctrl-C exits). Requires a TTY on stdout; without
//                       one it prints a typed guidance notice to stderr,
//                       emits a one-shot frame to stdout, and exits 0 — the
//                       honest fallback for pipes/CI instead of escape-code
//                       soup.
//   caws tui --once     render one frame to stdout and exit 0. Deterministic
//                       text (no control sequences), safe to diff and pipe.

import readline from 'node:readline';

import { gatherDashboardState } from '../panel-data';
import { renderFrame, UNBOUNDED_HEIGHT } from '../tui/frame';
import { buildDashboardModel } from '../tui/panels';
import { startDashboardSession } from '../tui/screen';

export interface TuiCommandOptions {
  readonly once?: boolean;
  readonly intervalMs?: number;
  readonly cwd?: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly now?: () => Date;
  readonly out?: (line: string) => void;
  readonly err?: (line: string) => void;
  /** Defaults to process.stdout.isTTY. Injectable for tests. */
  readonly isTTY?: boolean;
  /** Keypress source for the interactive session; defaults to process.stdin.
   *  Null disables the key listener (session then runs until stopped
   *  externally). */
  readonly stdin?: NodeJS.ReadStream | null;
  /** Terminal size probe; defaults to process.stdout columns/rows. */
  readonly size?: () => { readonly width: number; readonly height: number };
  /** Interactive exit hook; defaults to process.exit. Injectable for tests. */
  readonly exitProcess?: (code: number) => void;
}

const DEFAULT_INTERVAL_MS = 3000;
const MIN_INTERVAL_MS = 250;
const MAX_INTERVAL_MS = 60000;

function clampInterval(raw: number | undefined): number {
  if (raw === undefined || Number.isNaN(raw)) return DEFAULT_INTERVAL_MS;
  return Math.max(MIN_INTERVAL_MS, Math.min(raw, MAX_INTERVAL_MS));
}

export function runTuiCommand(opts: TuiCommandOptions = {}): number {
  const cwd = opts.cwd ?? process.cwd();
  const env = opts.env ?? process.env;
  const now = opts.now ?? (() => new Date());
  const out = opts.out ?? ((s: string) => process.stdout.write(s + '\n'));
  const err = opts.err ?? ((s: string) => process.stderr.write(s + '\n'));
  const isTTY = opts.isTTY ?? process.stdout.isTTY === true;
  const once = opts.once === true;

  // Composition failures exit 2 with a diagnostic — mirroring `caws status`
  // (2 = composition failure), never a half-rendered dashboard.
  const gathered = gatherDashboardState({ cwd, env, now });
  if (!gathered.ok) {
    err(`caws tui: ${gathered.message}`);
    return 2;
  }
  const model = buildDashboardModel(gathered);
  const size =
    opts.size ??
    (() => ({ width: process.stdout.columns ?? 100, height: process.stdout.rows ?? 40 }));

  if (once) {
    // One-shot: unbounded height so scripted consumers get every panel;
    // renderFrame emits no control sequences, so the text is diffable.
    out(renderFrame(model, { width: size().width, height: UNBOUNDED_HEIGHT }));
    return 0;
  }

  if (!isTTY) {
    err('caws tui: stdout is not a TTY — a full-screen session needs a terminal.');
    err('            Use `caws tui --once` for one-shot output suitable for pipes/CI.');
    // The one-shot frame is still the most useful thing a non-TTY caller can
    // receive: emit it and exit 0 (an honest fallback, not a failure).
    out(renderFrame(model, { width: size().width, height: UNBOUNDED_HEIGHT }));
    return 0;
  }

  // Interactive session. Keyboard: q or Ctrl-C exits; resize repaints.
  const session = startDashboardSession({
    gather: () => {
      // Re-gather every tick from current on-disk state.
      const state = gatherDashboardState({ cwd, env, now });
      if (!state.ok) throw new Error(state.message);
      return buildDashboardModel(state);
    },
    size,
    write: (s: string) => process.stdout.write(s),
    intervalMs: clampInterval(opts.intervalMs),
  });

  const stdin = opts.stdin === undefined ? process.stdin : opts.stdin;
  if (stdin === null || !stdin.readable) {
    // No key source: the session could never be exited by the user.
    out('caws tui: no readable stdin — cannot intercept q/Ctrl-C; rendering one frame instead.');
    session.stop();
    return 0;
  }

  readline.emitKeypressEvents(stdin);
  if (stdin.isTTY === true && typeof stdin.setRawMode === 'function') {
    stdin.setRawMode(true);
  }
  const onKeypress = (_ch: string, key?: { readonly sequence?: string }): void => {
    const sequence = key?.sequence ?? '';
    if (session.handleKeypress(sequence) === 'exit') {
      stdin.removeListener('keypress', onKeypress);
      if (stdin.isTTY === true && typeof stdin.setRawMode === 'function') {
        stdin.setRawMode(false);
      }
      const code = session.stop();
      (opts.exitProcess ?? process.exit)(code);
    }
  };
  stdin.on('keypress', onKeypress);
  process.stdout.on('resize', () => session.repaintNow());

  // The session runs on its interval until a keypress exits the process.
  return 0;
}
