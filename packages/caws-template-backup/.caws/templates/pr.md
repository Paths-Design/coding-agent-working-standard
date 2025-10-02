# {{PR_TITLE}}

## Summary
{{PR_SUMMARY}}

## Working Spec
- **Risk Tier**: {{RISK_TIER}}
- **Mode**: {{PR_MODE}}
- **Invariants**: {{INVARIANTS}}

## Tests
- **Unit Coverage**: {{UNIT_COVERAGE}}% (target {{TARGET_COVERAGE}}%)
- **Mutation Score**: {{MUTATION_SCORE}}% (target {{TARGET_MUTATION}}%)
- **Integration Tests**: {{INTEGRATION_TESTS}} flows
- **E2E Smoke**: {{E2E_TESTS}} ({{E2E_STATUS}})
- **Accessibility**: {{A11Y_SCORE}} ({{A11Y_STATUS}})

## Non-functional
- **API p95**: {{API_PERF}}ms (budget {{API_BUDGET}}ms)
- **Security**: {{SAST_STATUS}}

## Migration & Rollback
{{MIGRATION_NOTES}}

## Known Limits
{{KNOWN_LIMITS}}

## Trust Score
{{TRUST_SCORE}}/100 (target ≥82)

---

## Review Checklist
- [ ] Scope matches `scope.in` from working spec
- [ ] Change budget respected (files: {{MAX_FILES}}, LOC: {{MAX_LOC}})
- [ ] All tests pass with required coverage/mutation thresholds
- [ ] Contract tests green (if applicable)
- [ ] Accessibility requirements met
- [ ] Performance budgets respected
- [ ] Migration/rollback plan provided
- [ ] Security scan clean
- [ ] SBOM and attestation generated
- [ ] Provenance manifest valid

## Approvals
{{APPROVALS}}

---

**Working Spec**: See `.caws/working-spec.yaml`
**Provenance**: See `.agent/provenance.json`
**SBOM**: See `.agent/sbom.json`
**Attestation**: See `.agent/attestation.json`
