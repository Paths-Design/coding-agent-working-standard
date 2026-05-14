// Stable rule identifiers for waiver-authored diagnostics.

export const WAIVER_RULES = {
  // Validation
  WAIVER_INVALID_ID: 'waiver.schema.invalid_id',
  WAIVER_INVALID_STATUS: 'waiver.schema.invalid_status',
  WAIVER_INVALID_GATES: 'waiver.schema.invalid_gates',
  WAIVER_INVALID_EXPIRY: 'waiver.schema.invalid_expiry',
  WAIVER_INVALID_TITLE: 'waiver.schema.invalid_title',
  WAIVER_INVALID_REASON: 'waiver.schema.invalid_reason',
  WAIVER_INVALID_APPROVED_BY: 'waiver.schema.invalid_approved_by',
  WAIVER_INVALID_CREATED_AT: 'waiver.schema.invalid_created_at',
  WAIVER_REVOKED_WITHOUT_RECORD:
    'waiver.schema.revoked_without_revocation_record',
  WAIVER_ACTIVE_WITH_REVOCATION:
    'waiver.schema.active_status_carries_revocation_record',
} as const;

export type WaiverRule = (typeof WAIVER_RULES)[keyof typeof WAIVER_RULES];

export const WAIVER_RULE_PREFIXES = ['waiver.schema.'] as const;
