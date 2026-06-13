// Pure formatter for `caws gates run` output.
//
// Renders one line per policy gate disposition, plus an unmatched-violations
// section when report gates that policy doesn't declare have violations.
// Rule ids are not shown here (this is a command summary, not a Diagnostic
// stream); each disposition carries enough text for an agent to triage.

import type { DispositionResult } from '../gates/disposition';

function outcomeLabel(o: 'pass' | 'fail' | 'skipped'): string {
  switch (o) {
    case 'pass':
      return 'PASS   ';
    case 'fail':
      return 'FAIL   ';
    case 'skipped':
      return 'SKIPPED';
  }
}

export function renderGatesRun(result: DispositionResult): string {
  const lines: string[] = [];
  lines.push('Gate dispositions (policy-derived):');
  if (result.dispositions.length === 0) {
    lines.push('  (no gates declared in policy)');
  } else {
    for (const d of result.dispositions) {
      const blockTag = d.outcome === 'fail' ? (d.blocks ? ' [BLOCKS]' : ' [warn]') : '';
      lines.push(
        `  ${outcomeLabel(d.outcome)}  ${d.gate_id} (mode=${d.mode}, ${d.violations.length} violations)${blockTag}`
      );
      // Show first violation message per failing gate as a hint.
      const first = d.violations[0];
      if (first !== undefined && first.message !== undefined) {
        lines.push(`              → ${first.message}`);
        if (d.violations.length > 1) {
          lines.push(`              … and ${d.violations.length - 1} more`);
        }
      }
    }
  }

  if (result.unmatchedViolations.length > 0) {
    lines.push('');
    lines.push(
      `Unmatched violations (report gates not declared in policy): ${result.unmatchedViolations.length}`
    );
    // Group by gate for the rendered tally
    const byGate = new Map<string, number>();
    for (const v of result.unmatchedViolations) {
      byGate.set(v.gate, (byGate.get(v.gate) ?? 0) + 1);
    }
    for (const [gate, count] of byGate) {
      lines.push(`  ${gate}: ${count}`);
    }
  }

  lines.push('');
  lines.push(`Overall: ${result.anyBlocks ? 'BLOCKED by policy' : 'OK'}`);
  return lines.join('\n');
}
