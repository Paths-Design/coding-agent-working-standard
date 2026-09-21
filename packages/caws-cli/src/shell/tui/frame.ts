// Pure frame renderer for the `caws tui` dashboard (CAWS-TUI-DASHBOARD-001).
//
// renderFrame(model, dims) → string is a PURE function: same model and
// dimensions, same string. No ANSI control codes live here (screen.ts owns
// alt-screen/cursor sequences), so `caws tui --once` output is deterministic
// text and fully assertable without a TTY. Color is applied through chalk's
// level detection — OFF for non-TTY stdout, which keeps piped/test output
// escape-free.
//
// The model rows are plain text, so width math (truncate + pad) happens on
// plain strings and color is applied AFTER truncation — an ANSI-wrapped
// string sliced mid-escape would corrupt the frame.

import chalk from 'chalk';
import type { DashboardModel } from './panels';

export interface FrameDimensions {
  readonly width: number;
  readonly height: number;
}

/** One-shot mode renders with an effectively unbounded height so every
 *  panel prints (scripted consumers get the whole dashboard). */
export const UNBOUNDED_HEIGHT = 100000;

const MIN_WIDTH = 48;
const MAX_WIDTH = 240;

interface PanelSpec {
  readonly title: string;
  readonly rows: readonly string[];
  readonly maxRows: number;
}

function visibleTruncate(s: string, width: number): string {
  if (s.length <= width) return s;
  return width <= 1 ? '…' : s.slice(0, width - 1) + '…';
}

function colorizeSeverity(severity: string, text: string): string {
  if (chalk.level === 0) return text;
  if (severity === 'error') return chalk.red(text);
  if (severity === 'warning') return chalk.yellow(text);
  return chalk.gray(text);
}

function stateColor(state: string, text: string): string {
  if (chalk.level === 0) return text;
  if (state === 'active') return chalk.green(text);
  if (state === 'draft') return chalk.cyan(text);
  if (state === 'closed') return chalk.gray(text);
  return text;
}

function renderBox(panel: PanelSpec, width: number): string[] {
  const inner = Math.max(1, width - 4); // '│ ' + ' │'
  const title = visibleTruncate(panel.title, Math.max(1, width - 5));
  const left = `┌─ ${title} `;
  const lines = [left + '─'.repeat(Math.max(0, width - left.length - 1)) + '┐'];

  const shown = panel.rows.slice(0, panel.maxRows);
  for (const row of shown) {
    lines.push('│ ' + visibleTruncate(row, inner).padEnd(inner) + ' │');
  }
  const remaining = panel.rows.length - shown.length;
  if (remaining > 0) {
    lines.push('│ ' + `… +${remaining} more`.padEnd(inner) + ' │');
  }
  if (panel.rows.length === 0) {
    lines.push('│ ' + '(none)'.padEnd(inner) + ' │');
  }
  lines.push('└' + '─'.repeat(Math.max(0, width - 2)) + '┘');
  return lines;
}

/** Render the full dashboard frame. Panels stack top-down; if the terminal
 *  is too short, later panels are dropped with an explicit marker rather
 *  than sliced mid-box. */
export function renderFrame(model: DashboardModel, dims: FrameDimensions): string {
  const width = Math.max(MIN_WIDTH, Math.min(dims.width > 0 ? dims.width : 100, MAX_WIDTH));
  const height = dims.height > 0 ? dims.height : 40;

  const doctorCounts = model.doctor.counts;
  const headerRows = [
    `project: ${model.project}${model.policyLoaded ? '' : '  (policy.yaml NOT loaded)'}`,
    `binding: ${model.bindingLine}`,
    `session: ${model.sessionLine}`,
    `events:  ${model.eventsLine}`,
    doctorLine(model),
    ...(model.laneLine !== undefined ? [model.laneLine] : []),
  ];

  const specRows = model.specs.map(
    (s) =>
      `${stateColor(s.state, s.state.padEnd(6))} ${s.id}${s.worktree !== undefined ? ` → ${s.worktree}` : ''}`
  );
  const specSummary =
    Object.entries(model.specsByLifecycle)
      .map(([state, n]) => `${n} ${state}`)
      .join(', ') || 'no specs';
  const worktreeRows = model.worktrees.map(
    (w) =>
      `${w.name}${w.specId !== undefined ? `  spec=${w.specId}` : ''}${w.owner !== undefined ? `  owner=${w.owner}` : ''}`
  );
  const agentRows = [
    `leases: ${model.agents.total} total — ${model.agents.active} active, ${model.agents.stale} stale, ${model.agents.stopped} stopped`,
    `self:   ${model.agents.self ?? 'n/a'}`,
  ];
  const doctorRows = model.doctor.findings.map(
    (f) => `${f.severity.padEnd(7)} ${f.rule}: ${f.message}`
  );
  const gateRows = model.gates.ok
    ? model.gates.rows.map(
        (g) => `${g.gate_id}: mode=${g.mode} enabled=${g.enabled} effective_waivers=${g.waivers}`
      )
    : model.gates.reason === 'no_policy'
      ? ['policy.yaml not loaded — gate discovery requires policy']
      : ['store composition failed — gates panel unavailable'];

  const panels: PanelSpec[] = [
    { title: 'CAWS Dashboard', rows: headerRows, maxRows: 12 },
    {
      title: `Specs (${specSummary})`,
      rows: specRows,
      maxRows: 12,
    },
    { title: `Worktrees (${model.worktrees.length})`, rows: worktreeRows, maxRows: 8 },
    { title: 'Agents', rows: agentRows, maxRows: 4 },
    {
      title: `Doctor (${doctorCounts.errors}E/${doctorCounts.warnings}W/${doctorCounts.infos}I)`,
      rows: doctorRows.map((r, i) =>
        colorizeSeverity(model.doctor.findings[i]?.severity ?? 'info', r)
      ),
      maxRows: 10,
    },
    { title: 'Gates', rows: gateRows, maxRows: 12 },
  ];

  const lines: string[] = [];
  for (const panel of panels) {
    const block = renderBox(panel, width);
    if (lines.length + block.length > height && lines.length > 0) {
      lines.push(`… ${panel.title} panel hidden (terminal too short)`);
      break;
    }
    lines.push(...block, '');
  }
  return lines.join('\n');
}

function doctorLine(model: DashboardModel): string {
  return model.doctorLine;
}
