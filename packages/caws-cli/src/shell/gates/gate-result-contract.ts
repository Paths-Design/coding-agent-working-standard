// Runtime validator for `caws-quality-gates --json` output.
//
// The subprocess emits a SINGLE aggregated JSON payload describing the full
// gate run. We do NOT trust the shape — TypeScript types do not survive
// `JSON.parse`. The validator below enforces the minimal contract the
// vNext command needs to make a policy-derived decision.
//
// Accepted shape (narrowed; the real payload may carry more fields, which
// we ignore):
//
//   {
//     timestamp:    string  (ISO-8601)
//     context:      string  (e.g. 'cli', 'commit', 'ci')
//     files_scoped: number
//     warnings:     Array<{ gate?: string; ... }>
//     violations:   Array<{ gate: string; ... }>
//     waivers?:     { active: number; applied: number; details: ... }
//     performance?: { total_execution_time_ms?: number; ... }
//   }
//
// Anything else is rejected. The contract is intentionally tighter than the
// subprocess's actual payload — the command should only consume fields it
// has validated.

import { err, ok, type Diagnostic, type Result } from '@paths.design/caws-kernel';

import { SHELL_RULES } from '../rules';

export interface GatesViolation {
  /** The gate that detected this violation. May be any string. */
  readonly gate: string;
  /** Optional violation type id (e.g. 'banned_modifier', 'timeout'). */
  readonly type?: string;
  readonly message?: string;
  readonly file?: string;
  readonly line?: number;
  readonly rule?: string;
  /** Subprocess-reported severity. NOT trusted for blocking — policy decides. */
  readonly severity?: string;
}

export interface GatesWarning {
  readonly gate?: string;
  readonly type?: string;
  readonly message?: string;
}

export interface GatesReport {
  readonly timestamp: string;
  readonly context: string;
  readonly files_scoped: number;
  readonly warnings: readonly GatesWarning[];
  readonly violations: readonly GatesViolation[];
  readonly waivers?: {
    readonly active: number;
    readonly applied: number;
  };
  readonly performance?: {
    readonly total_execution_time_ms?: number;
  };
}

function diag(rule: string, message: string, data?: Record<string, unknown>): Diagnostic {
  const base: Diagnostic = {
    rule,
    authority: 'kernel/diagnostics',
    severity: 'error',
    message,
  };
  return data !== undefined ? { ...base, data } : base;
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function validateViolation(value: unknown, idx: number): Result<GatesViolation> {
  if (!isObject(value)) {
    return err(
      diag(
        SHELL_RULES.GATES_REPORT_INVALID_SHAPE,
        `violations[${idx}] is not an object.`,
        { index: idx }
      )
    );
  }
  if (typeof value['gate'] !== 'string' || value['gate'].length === 0) {
    return err(
      diag(
        SHELL_RULES.GATES_REPORT_INVALID_SHAPE,
        `violations[${idx}] is missing required string field 'gate'.`,
        { index: idx }
      )
    );
  }
  const out: GatesViolation = { gate: value['gate'] };
  if (typeof value['type'] === 'string') (out as { type?: string }).type = value['type'];
  if (typeof value['message'] === 'string')
    (out as { message?: string }).message = value['message'];
  if (typeof value['file'] === 'string') (out as { file?: string }).file = value['file'];
  if (typeof value['line'] === 'number') (out as { line?: number }).line = value['line'];
  if (typeof value['rule'] === 'string') (out as { rule?: string }).rule = value['rule'];
  if (typeof value['severity'] === 'string')
    (out as { severity?: string }).severity = value['severity'];
  return ok(out);
}

function validateWarning(value: unknown, idx: number): Result<GatesWarning> {
  if (!isObject(value)) {
    return err(
      diag(
        SHELL_RULES.GATES_REPORT_INVALID_SHAPE,
        `warnings[${idx}] is not an object.`,
        { index: idx }
      )
    );
  }
  const out: GatesWarning = {};
  if (typeof value['gate'] === 'string') (out as { gate?: string }).gate = value['gate'];
  if (typeof value['type'] === 'string') (out as { type?: string }).type = value['type'];
  if (typeof value['message'] === 'string')
    (out as { message?: string }).message = value['message'];
  return ok(out);
}

/**
 * Parse + validate the subprocess JSON. Returns Ok(GatesReport) only when
 * EVERY required field is present and well-typed. Returns Err with a
 * specific shell.gates.* rule otherwise. Never throws on bad input.
 */
export function validateGatesReport(raw: string): Result<GatesReport> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    return err(
      diag(
        SHELL_RULES.GATES_REPORT_NOT_JSON,
        `quality-gates output is not valid JSON: ${(e as Error).message}`
      )
    );
  }
  if (!isObject(parsed)) {
    return err(
      diag(
        SHELL_RULES.GATES_REPORT_INVALID_SHAPE,
        'quality-gates output is not a JSON object.'
      )
    );
  }

  if (typeof parsed['timestamp'] !== 'string') {
    return err(
      diag(
        SHELL_RULES.GATES_REPORT_INVALID_SHAPE,
        'quality-gates output missing required string field `timestamp`.'
      )
    );
  }
  if (typeof parsed['context'] !== 'string') {
    return err(
      diag(
        SHELL_RULES.GATES_REPORT_INVALID_SHAPE,
        'quality-gates output missing required string field `context`.'
      )
    );
  }
  if (typeof parsed['files_scoped'] !== 'number') {
    return err(
      diag(
        SHELL_RULES.GATES_REPORT_INVALID_SHAPE,
        'quality-gates output missing required number field `files_scoped`.'
      )
    );
  }

  const rawViolations = parsed['violations'];
  if (!Array.isArray(rawViolations)) {
    return err(
      diag(
        SHELL_RULES.GATES_REPORT_INVALID_SHAPE,
        'quality-gates output missing required array field `violations`.'
      )
    );
  }
  const violations: GatesViolation[] = [];
  for (let i = 0; i < rawViolations.length; i++) {
    const r = validateViolation(rawViolations[i], i);
    if (!r.ok) return r;
    violations.push(r.value);
  }

  const rawWarnings = parsed['warnings'];
  if (!Array.isArray(rawWarnings)) {
    return err(
      diag(
        SHELL_RULES.GATES_REPORT_INVALID_SHAPE,
        'quality-gates output missing required array field `warnings`.'
      )
    );
  }
  const warnings: GatesWarning[] = [];
  for (let i = 0; i < rawWarnings.length; i++) {
    const r = validateWarning(rawWarnings[i], i);
    if (!r.ok) return r;
    warnings.push(r.value);
  }

  const out: GatesReport = {
    timestamp: parsed['timestamp'],
    context: parsed['context'],
    files_scoped: parsed['files_scoped'],
    warnings,
    violations,
  };

  // Optional fields — defensive: accept if shaped right, ignore otherwise.
  if (isObject(parsed['waivers'])) {
    const w = parsed['waivers'] as Record<string, unknown>;
    if (typeof w['active'] === 'number' && typeof w['applied'] === 'number') {
      (out as { waivers?: { active: number; applied: number } }).waivers = {
        active: w['active'],
        applied: w['applied'],
      };
    }
  }
  if (isObject(parsed['performance'])) {
    const p = parsed['performance'] as Record<string, unknown>;
    if (typeof p['total_execution_time_ms'] === 'number') {
      (out as { performance?: { total_execution_time_ms?: number } }).performance = {
        total_execution_time_ms: p['total_execution_time_ms'],
      };
    }
  }

  return ok(out);
}
