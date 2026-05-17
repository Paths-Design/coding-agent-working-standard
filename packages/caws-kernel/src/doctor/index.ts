// Public surface of the doctor kernel.

export type {
  DoctorFinding,
  DoctorInput,
  DoctorReport,
  FindingSeverity,
  TemplateCheck,
} from './types';

export { DOCTOR_RULES, DOCTOR_RULE_PREFIXES } from './rules';
export type { DoctorRule } from './rules';

export { inspectProjectState } from './inspect';
