// Validate a parsed waiver document against the waiver schema.
//
// This is pure shape + semantics validation. It does NOT consult the
// current time (expiry is a runtime applicability concern, not a
// validation concern) and does NOT touch the filesystem.

import { diagnostic } from '../diagnostics/construct';
import type { Diagnostic } from '../diagnostics/types';
import { err, ok } from '../result/construct';
import type { Result } from '../result/types';

import { WAIVER_RULES } from './rules';
import type { Waiver, WaiverStatus } from './types';

// Waiver id: same regex shape as spec id, kept narrow so the YAML
// filename can equal the id.
const WAIVER_ID_REGEX = /^[A-Z][A-Z0-9]*(-[A-Z0-9]+)*-\d+[a-z]?$/;
const ISO_DATETIME_REGEX = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;

function waiverDiag(rule: string, message: string, subject?: string): Diagnostic {
  return diagnostic({
    rule,
    authority: 'kernel/waiver',
    message,
    ...(subject !== undefined ? { subject } : {}),
  });
}

function isValidIsoDateTime(value: unknown): value is string {
  return typeof value === 'string' && ISO_DATETIME_REGEX.test(value);
}

function isStatus(value: unknown): value is WaiverStatus {
  return value === 'active' || value === 'revoked';
}

/**
 * Validate a parsed waiver document. Returns Ok(Waiver) only when every
 * field is well-typed AND the cross-field invariants hold:
 *
 *   - status='active'  must NOT carry a `revocation` record
 *   - status='revoked' must carry a `revocation` record with `revoked_at`
 *   - gates must be a non-empty array of non-empty strings
 *
 * `expires_at` is required and must be an ISO-8601 datetime. Whether the
 * waiver is currently expired is a separate question (see applicability).
 */
export function validateWaiver(input: unknown): Result<Waiver> {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    return err(
      waiverDiag(WAIVER_RULES.WAIVER_INVALID_ID, 'Waiver must be a YAML/JSON object.')
    );
  }
  const v = input as Record<string, unknown>;

  if (typeof v['id'] !== 'string' || !WAIVER_ID_REGEX.test(v['id'])) {
    return err(
      waiverDiag(
        WAIVER_RULES.WAIVER_INVALID_ID,
        `Waiver id must match ${WAIVER_ID_REGEX} (got ${JSON.stringify(v['id'])}).`,
        typeof v['id'] === 'string' ? v['id'] : undefined
      )
    );
  }
  const id = v['id'];

  if (typeof v['title'] !== 'string' || v['title'].trim().length < 5) {
    return err(
      waiverDiag(
        WAIVER_RULES.WAIVER_INVALID_TITLE,
        'Waiver title is required and must be at least 5 non-whitespace characters.',
        id
      )
    );
  }

  if (!isStatus(v['status'])) {
    return err(
      waiverDiag(
        WAIVER_RULES.WAIVER_INVALID_STATUS,
        `Waiver status must be 'active' or 'revoked' (got ${JSON.stringify(v['status'])}).`,
        id
      )
    );
  }
  const status = v['status'];

  if (
    !Array.isArray(v['gates']) ||
    v['gates'].length === 0 ||
    !v['gates'].every((g) => typeof g === 'string' && g.length > 0)
  ) {
    return err(
      waiverDiag(
        WAIVER_RULES.WAIVER_INVALID_GATES,
        'Waiver gates must be a non-empty array of non-empty strings.',
        id
      )
    );
  }
  const gates = v['gates'].slice() as string[];

  if (typeof v['reason'] !== 'string' || v['reason'].trim().length < 3) {
    return err(
      waiverDiag(WAIVER_RULES.WAIVER_INVALID_REASON, 'Waiver reason is required.', id)
    );
  }

  if (typeof v['approved_by'] !== 'string' || v['approved_by'].trim().length === 0) {
    return err(
      waiverDiag(
        WAIVER_RULES.WAIVER_INVALID_APPROVED_BY,
        'Waiver approved_by is required.',
        id
      )
    );
  }

  if (!isValidIsoDateTime(v['created_at'])) {
    return err(
      waiverDiag(
        WAIVER_RULES.WAIVER_INVALID_CREATED_AT,
        'Waiver created_at must be an ISO-8601 datetime with timezone.',
        id
      )
    );
  }

  if (!isValidIsoDateTime(v['expires_at'])) {
    return err(
      waiverDiag(
        WAIVER_RULES.WAIVER_INVALID_EXPIRY,
        'Waiver expires_at must be an ISO-8601 datetime with timezone.',
        id
      )
    );
  }

  // Optional scope
  let scope: Waiver['scope'];
  if (v['scope'] !== undefined) {
    if (
      typeof v['scope'] !== 'object' ||
      v['scope'] === null ||
      Array.isArray(v['scope'])
    ) {
      return err(
        waiverDiag(
          WAIVER_RULES.WAIVER_INVALID_GATES,
          'Waiver scope must be an object when present.',
          id
        )
      );
    }
    const s = v['scope'] as Record<string, unknown>;
    if (s['spec_id'] !== undefined && typeof s['spec_id'] !== 'string') {
      return err(
        waiverDiag(
          WAIVER_RULES.WAIVER_INVALID_GATES,
          'Waiver scope.spec_id must be a string when present.',
          id
        )
      );
    }
    if (typeof s['spec_id'] === 'string') {
      scope = { spec_id: s['spec_id'] };
    } else {
      scope = {};
    }
  }

  // Optional constraints
  let constraints: Waiver['constraints'];
  if (v['constraints'] !== undefined) {
    if (
      typeof v['constraints'] !== 'object' ||
      v['constraints'] === null ||
      Array.isArray(v['constraints'])
    ) {
      return err(
        waiverDiag(
          WAIVER_RULES.WAIVER_INVALID_GATES,
          'Waiver constraints must be an object when present.',
          id
        )
      );
    }
    const c = v['constraints'] as Record<string, unknown>;
    if (
      c['max_uses'] !== undefined &&
      (typeof c['max_uses'] !== 'number' || !Number.isInteger(c['max_uses']) || c['max_uses'] < 0)
    ) {
      return err(
        waiverDiag(
          WAIVER_RULES.WAIVER_INVALID_GATES,
          'Waiver constraints.max_uses must be a non-negative integer.',
          id
        )
      );
    }
    if (typeof c['max_uses'] === 'number') {
      constraints = { max_uses: c['max_uses'] };
    } else {
      constraints = {};
    }
  }

  // Revocation record cross-field invariants
  let revocation: Waiver['revocation'];
  const rev = v['revocation'];
  if (status === 'revoked') {
    if (
      typeof rev !== 'object' ||
      rev === null ||
      Array.isArray(rev) ||
      !isValidIsoDateTime((rev as Record<string, unknown>)['revoked_at'])
    ) {
      return err(
        waiverDiag(
          WAIVER_RULES.WAIVER_REVOKED_WITHOUT_RECORD,
          'Revoked waivers must carry a revocation object with `revoked_at`.',
          id
        )
      );
    }
    const r = rev as Record<string, unknown>;
    revocation = {
      revoked_at: r['revoked_at'] as string,
      ...(typeof r['revoked_by'] === 'string' ? { revoked_by: r['revoked_by'] } : {}),
      ...(typeof r['reason'] === 'string' ? { reason: r['reason'] } : {}),
    };
  } else if (rev !== undefined) {
    return err(
      waiverDiag(
        WAIVER_RULES.WAIVER_ACTIVE_WITH_REVOCATION,
        'Active waivers must not carry a revocation record.',
        id
      )
    );
  }

  const waiver: Waiver = {
    id,
    title: v['title'] as string,
    status,
    gates,
    reason: v['reason'] as string,
    approved_by: v['approved_by'] as string,
    created_at: v['created_at'] as string,
    expires_at: v['expires_at'] as string,
    ...(scope !== undefined ? { scope } : {}),
    ...(constraints !== undefined ? { constraints } : {}),
    ...(revocation !== undefined ? { revocation } : {}),
  };
  return ok(waiver);
}
