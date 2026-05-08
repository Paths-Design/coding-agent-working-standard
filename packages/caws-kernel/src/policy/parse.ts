import yaml from 'js-yaml';
import { diagnostic } from '../diagnostics';
import { err, ok } from '../result';
import type { Result } from '../result/types';
import { POLICY_RULES } from './rules';

export interface ParseOptions {
  sourcePath?: string;
}

/**
 * Parse a policy YAML string into an unknown value.
 *
 * Mirrors src/spec/parse.ts: distinct rule ids for parse failure,
 * empty document, and non-object document.
 */
export function parsePolicyYaml(source: string, options: ParseOptions = {}): Result<unknown> {
  let parsed: unknown;
  try {
    parsed = yaml.load(source, { schema: yaml.CORE_SCHEMA });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    const mark = e instanceof yaml.YAMLException ? e.mark : undefined;
    return err(
      diagnostic({
        rule: POLICY_RULES.YAML_PARSE_FAILED,
        authority: 'kernel/policy',
        message: msg.split('\n')[0] ?? 'YAML parse failed',
        ...(options.sourcePath !== undefined && { subject: options.sourcePath }),
        ...(mark && {
          location: { line: mark.line + 1, column: mark.column + 1 },
        }),
        narrowRepair: 'Fix the YAML syntax error indicated by location.',
        data: { rawMessage: msg },
      }),
    );
  }

  if (parsed === null || parsed === undefined) {
    return err(
      diagnostic({
        rule: POLICY_RULES.EMPTY_DOCUMENT,
        authority: 'kernel/policy',
        message: 'Policy document is empty.',
        ...(options.sourcePath !== undefined && { subject: options.sourcePath }),
        narrowRepair: 'Provide a non-empty YAML document.',
      }),
    );
  }

  if (typeof parsed !== 'object' || Array.isArray(parsed)) {
    return err(
      diagnostic({
        rule: POLICY_RULES.NOT_AN_OBJECT,
        authority: 'kernel/policy',
        message: `Policy document must be a YAML object, got ${Array.isArray(parsed) ? 'array' : typeof parsed}.`,
        ...(options.sourcePath !== undefined && { subject: options.sourcePath }),
        narrowRepair: 'Wrap the document as a top-level YAML mapping.',
      }),
    );
  }

  return ok(parsed);
}
