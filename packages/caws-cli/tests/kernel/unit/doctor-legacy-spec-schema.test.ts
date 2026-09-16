/**
 * CAWS-SPEC-SCHEMA-AUTHORITY-UNSTATED-001 —
 * doctor.init.legacy_working_spec_schema_present
 *
 * vNext validates specs through the kernel, so a project-local
 * `working-spec.schema.json` is dead authority. It is dead wherever it sits:
 * the previous observation looked ONLY at `.caws/working-spec.schema.json`,
 * so moving the same file one directory down into `.caws/schemas/` silently
 * escaped the error — the variant an operator is most likely to produce
 * while tidying the root. A dead schema doctor tolerates is worse than one
 * it flags, because a reader reconciling spec shapes against it has no
 * signal that it governs nothing.
 *
 * DIAGNOSE ONLY. inspectProjectState is a pure function over an in-memory
 * DoctorInput; the input is deep-frozen so a write would throw.
 */

import { inspectProjectState } from '../../../src/kernel/doctor/inspect';
import { DOCTOR_RULES } from '../../../src/kernel/doctor/rules';
import type { DoctorInput } from '../../../src/kernel/doctor/types';

const NOW = new Date('2026-06-15T12:00:00.000Z');
const RULE = 'doctor.init.legacy_working_spec_schema_present';
const ROOT_PATH = '.caws/working-spec.schema.json';
const NESTED_PATH = '.caws/schemas/working-spec.schema.json';

type Residue = NonNullable<DoctorInput['initResidue']>;

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    for (const key of Object.keys(value as Record<string, unknown>)) {
      deepFreeze((value as Record<string, unknown>)[key]);
    }
    Object.freeze(value);
  }
  return value;
}

function input(residue: Record<string, unknown>): DoctorInput {
  return deepFreeze({
    now: NOW,
    specs: [],
    initResidue: residue as unknown as Residue,
  }) as DoctorInput;
}

function schemaFindings(report: ReturnType<typeof inspectProjectState>) {
  return report.findings.filter((f) => f.rule === RULE);
}

describe('doctor.init.legacy_working_spec_schema_present (CAWS-SPEC-SCHEMA-AUTHORITY-UNSTATED-001)', () => {
  test('rule id is the stable string remediation text and docs name', () => {
    expect(DOCTOR_RULES.INIT_LEGACY_WORKING_SPEC_SCHEMA_PRESENT).toBe(RULE);
  });

  test('A1: the schemas/ copy fires the error and is named by path', () => {
    const report = inspectProjectState(
      input({ workingSpecSchemaJson: false, legacySpecSchemaPaths: [NESTED_PATH] })
    );
    const found = schemaFindings(report);
    expect(found).toHaveLength(1);
    expect(found[0].severity).toBe('error');
    // The finding must name the file that actually exists: a message or
    // repair pointing at the root path would tell the operator to remove a
    // file that is not there.
    expect(found[0].subject).toBe(NESTED_PATH);
    expect(found[0].message).toContain(NESTED_PATH);
    expect(found[0].narrowRepair).toContain(NESTED_PATH);
    expect(found[0].narrowRepair).not.toContain(`Remove or archive ${ROOT_PATH}`);
  });

  test('A2: the root path still fires exactly one unchanged error', () => {
    const report = inspectProjectState(
      input({ workingSpecSchemaJson: true, legacySpecSchemaPaths: [ROOT_PATH] })
    );
    const found = schemaFindings(report);
    // Exactly one: widening detection must not double-report the path that
    // is now visible through both the boolean and the list.
    expect(found).toHaveLength(1);
    expect(found[0].severity).toBe('error');
    expect(found[0].subject).toBe(ROOT_PATH);
    expect(found[0].message).toContain('legacy single-spec residue');
  });

  test('both copies present fire one finding each, naming each path', () => {
    const report = inspectProjectState(
      input({
        workingSpecSchemaJson: true,
        legacySpecSchemaPaths: [ROOT_PATH, NESTED_PATH],
      })
    );
    const found = schemaFindings(report);
    expect(found).toHaveLength(2);
    expect(found.map((f) => f.subject).sort()).toEqual([NESTED_PATH, ROOT_PATH].sort());
  });

  test('A4: neither copy present fires nothing', () => {
    const report = inspectProjectState(
      input({ workingSpecSchemaJson: false, legacySpecSchemaPaths: [] })
    );
    expect(schemaFindings(report)).toHaveLength(0);
  });

  test('an older snapshot writer without the list falls back to the root boolean', () => {
    // Unobserved is not "none found": a writer predating legacySpecSchemaPaths
    // must keep producing the original root-path finding rather than going
    // silent, which would turn an upgrade into a silent loss of an error.
    const legacyWriterWithFile = inspectProjectState(input({ workingSpecSchemaJson: true }));
    const found = schemaFindings(legacyWriterWithFile);
    expect(found).toHaveLength(1);
    expect(found[0].subject).toBe(ROOT_PATH);

    const legacyWriterClean = inspectProjectState(input({ workingSpecSchemaJson: false }));
    expect(schemaFindings(legacyWriterClean)).toHaveLength(0);
  });
});
