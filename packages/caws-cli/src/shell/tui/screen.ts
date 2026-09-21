// Screen/refresh runtime for the `caws tui` dashboard (CAWS-TUI-DASHBOARD-001).
//
// Owns the ONLY ANSI control sequences in the TUI (alt-screen enter/exit and
// cursor home) and the repaint interval. Everything terminal-shaped is
// injected (write, size, timers), so tests drive the loop with fake timers
// and a capture sink — no TTY required (spec AC A5).
//
// Refresh failures degrade: a thrown gather paints an error line and the
// loop keeps running at the next interval. A dashboard that dies on a
// transient read error is a dashboard that trains users to restart it blind.

import { renderFrame, type FrameDimensions } from './frame';
import type { DashboardModel } from './panels';

export const ALT_SCREEN_ENTER = '\x1b[?1049h\x1b[?25l\x1b[2J';
export const ALT_SCREEN_EXIT = '\x1b[?25h\x1b[?1049l';
export const CURSOR_HOME = '\x1b[H';

export interface DashboardTimers {
  set(fn: () => void, ms: number): unknown;
  clear(handle: unknown): void;
}

const defaultTimers: DashboardTimers = {
  set: (fn, ms) => {
    const handle = setInterval(fn, ms);
    // A dashboard must not hold the process open on its own — the user's
    // keypress (or an explicit stop) ends the session.
    handle.unref?.();
    return handle;
  },
  clear: (handle) => clearInterval(handle as NodeJS.Timeout),
};

export interface DashboardSession {
  /** Repaint immediately (used on resize and by tests). */
  repaintNow(): void;
  /** Classify a keypress sequence; 'exit' on q / Ctrl-C. Exposed for tests
   *  and reused by the command's key listener. */
  handleKeypress(sequence: string): 'exit' | 'continue';
  /** Stop the loop, restore the screen, return the process exit code. */
  stop(): number;
}

export function startDashboardSession(deps: {
  readonly gather: () => DashboardModel;
  readonly size: () => FrameDimensions;
  readonly write: (s: string) => void;
  readonly intervalMs: number;
  readonly timers?: DashboardTimers;
}): DashboardSession {
  const timers = deps.timers ?? defaultTimers;
  let stopped = false;

  // Every paint attempts a fresh gather — a failing refresh paints the error
  // banner, and the NEXT tick retries it (no error latching).
  function paint(): void {
    let frame: string;
    try {
      frame = renderFrame(deps.gather(), deps.size());
    } catch (e) {
      frame = `dashboard refresh failed: ${(e as Error).message}\n(will retry next interval)`;
    }
    deps.write(CURSOR_HOME + frame);
  }

  const repaintNow = paint;

  deps.write(ALT_SCREEN_ENTER);
  repaintNow();
  const handle = timers.set(repaintNow, deps.intervalMs);

  return {
    repaintNow,
    handleKeypress(sequence: string): 'exit' | 'continue' {
      if (sequence === 'q' || sequence === '\u0003') return 'exit';
      return 'continue';
    },
    stop(): number {
      if (stopped) return 0;
      stopped = true;
      timers.clear(handle);
      deps.write(ALT_SCREEN_EXIT);
      return 0;
    },
  };
}
