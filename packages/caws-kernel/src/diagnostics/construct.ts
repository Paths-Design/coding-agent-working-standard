import type { Diagnostic, Severity } from './types';

/** Construct a Diagnostic with a default severity of 'error'. */
export function diagnostic(d: Omit<Diagnostic, 'severity'> & { severity?: Severity }): Diagnostic {
  const severity: Severity = d.severity ?? 'error';
  return { ...d, severity };
}

/** Type guard. */
export function isDiagnostic(value: unknown): value is Diagnostic {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return typeof v['rule'] === 'string' && typeof v['authority'] === 'string' && typeof v['message'] === 'string';
}
