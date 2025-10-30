/**
 * CAWS Waivers Manager
 *
 * Provides fast-lane escape hatches for exceptional circumstances.
 * Waivers are temporary bypasses of quality gates with full audit trails.
 *
 * @author @darianrosebrook
 */

const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');

/**
 * Waiver Manager Class
 * Handles waiver creation, validation, expiration, and audit logging
 */
class WaiversManager {
  constructor(options = {}) {
    this.projectRoot = options.projectRoot || process.cwd();
    this.waiversDir = path.join(this.projectRoot, '.caws', 'waivers');
    this.waiversFile = path.join(this.waiversDir, 'active-waivers.yaml');
    this.auditLogFile = path.join(this.waiversDir, 'waiver-audit.log');

    // Ensure waivers directory exists
    if (!fs.existsSync(this.waiversDir)) {
      fs.mkdirSync(this.waiversDir, { recursive: true });
    }
  }

  /**
   * Waiver Schema Definition
   */
  getWaiverSchema() {
    return {
      type: 'object',
      required: ['id', 'title', 'reason', 'gates', 'expires_at', 'approved_by', 'created_at'],
      properties: {
        id: {
          type: 'string',
          pattern: '^WV-\\d{4}$',
          description: 'Waiver ID in format WV-XXXX',
        },
        title: {
          type: 'string',
          minLength: 10,
          maxLength: 200,
          description: 'Clear, descriptive title explaining the waiver',
        },
        reason: {
          type: 'string',
          enum: [
            'emergency_hotfix',
            'legacy_integration',
            'experimental_feature',
            'third_party_constraint',
            'performance_critical',
            'security_patch',
            'infrastructure_limitation',
            'other',
          ],
          description: 'Categorization of waiver reason',
        },
        description: {
          type: 'string',
          minLength: 50,
          maxLength: 1000,
          description: 'Detailed explanation of why waiver is needed',
        },
        gates: {
          type: 'array',
          items: {
            type: 'string',
            enum: [
              'spec_completeness',
              'contract_compliance',
              'coverage_threshold',
              'mutation_threshold',
              'security_scan',
              'accessibility_check',
              'performance_budget',
              'scope_boundary',
              'budget_limit',
            ],
          },
          minItems: 1,
          description: 'Quality gates to waive',
        },
        risk_assessment: {
          type: 'object',
          properties: {
            impact_level: {
              type: 'string',
              enum: ['low', 'medium', 'high', 'critical'],
            },
            mitigation_plan: {
              type: 'string',
              minLength: 50,
            },
            review_required: {
              type: 'boolean',
            },
          },
          required: ['impact_level', 'mitigation_plan'],
        },
        expires_at: {
          type: 'string',
          format: 'date-time',
          description: 'ISO 8601 datetime when waiver expires',
        },
        approved_by: {
          type: 'string',
          description: 'Person/entity approving the waiver',
        },
        created_at: {
          type: 'string',
          format: 'date-time',
          description: 'ISO 8601 datetime when waiver was created',
        },
        metadata: {
          type: 'object',
          properties: {
            related_pr: { type: 'string' },
            related_issue: { type: 'string' },
            environment: { type: 'string', enum: ['development', 'staging', 'production'] },
            urgency: { type: 'string', enum: ['low', 'normal', 'high', 'critical'] },
          },
        },
      },
    };
  }

  /**
   * Create a new waiver
   */
  async createWaiver(waiverData) {
    // Generate waiver ID
    const waiverId = await this.generateWaiverId();

    // Set creation timestamp
    const now = new Date().toISOString();

    // Construct full waiver object
    const waiver = {
      id: waiverId,
      title: waiverData.title,
      reason: waiverData.reason,
      description: waiverData.description,
      gates: waiverData.gates,
      risk_assessment: waiverData.risk_assessment,
      expires_at: waiverData.expires_at,
      approved_by: waiverData.approved_by,
      created_at: now,
      metadata: waiverData.metadata || {},
    };

    // Validate waiver against schema
    const validation = this.validateWaiver(waiver);
    if (!validation.valid) {
      throw new Error(`Waiver validation failed: ${validation.errors.join(', ')}`);
    }

    // Check for conflicts with existing waivers
    const conflicts = await this.checkWaiverConflicts(waiver);
    if (conflicts.length > 0) {
      throw new Error(`Waiver conflicts with existing waivers: ${conflicts.join(', ')}`);
    }

    // Load existing waivers
    const waivers = await this.loadActiveWaivers();

    // Add new waiver
    waivers.push(waiver);

    // Save waivers
    await this.saveActiveWaivers(waivers);

    // Log waiver creation
    await this.auditLog('CREATE', waiverId, {
      title: waiver.title,
      reason: waiver.reason,
      gates: waiver.gates,
      expires_at: waiver.expires_at,
      approved_by: waiver.approved_by,
    });

    // Flag high-risk waivers for review
    if (
      waiver.risk_assessment.impact_level === 'critical' ||
      waiver.risk_assessment.review_required
    ) {
      await this.flagForReview(waiver);
    }

    return waiver;
  }

  /**
   * Check if waiver applies to specific gates
   */
  async checkWaiverCoverage(gatesToCheck, context = {}) {
    const activeWaivers = await this.getActiveWaivers();
    const coveredGates = new Set();
    const waiverDetails = [];

    for (const waiver of activeWaivers) {
      // Check if waiver applies to current context
      if (!this.waiverAppliesToContext(waiver, context)) {
        continue;
      }

      // Check which gates this waiver covers
      for (const gate of gatesToCheck) {
        if (waiver.gates.includes(gate)) {
          coveredGates.add(gate);
          waiverDetails.push({
            gate,
            waiver_id: waiver.id,
            reason: waiver.reason,
            expires_at: waiver.expires_at,
            approved_by: waiver.approved_by,
          });
        }
      }
    }

    return {
      coveredGates: Array.from(coveredGates),
      waiverDetails,
      allCovered: coveredGates.size === gatesToCheck.length,
    };
  }

  /**
   * Get all active waivers
   */
  async getActiveWaivers() {
    const waivers = await this.loadActiveWaivers();
    const now = new Date();

    // Filter out expired waivers and clean up
    const activeWaivers = waivers.filter((waiver) => {
      const expiresAt = new Date(waiver.expires_at);
      return expiresAt > now;
    });

    // Auto-cleanup expired waivers
    if (activeWaivers.length !== waivers.length) {
      await this.saveActiveWaivers(activeWaivers);
    }

    return activeWaivers;
  }

  /**
   * Revoke a waiver
   */
  async revokeWaiver(waiverId, reason = 'Manual revocation') {
    const waivers = await this.loadActiveWaivers();
    const index = waivers.findIndex((w) => w.id === waiverId);

    if (index === -1) {
      throw new Error(`Waiver ${waiverId} not found`);
    }

    const waiver = waivers[index];
    waivers.splice(index, 1);

    await this.saveActiveWaivers(waivers);
    await this.auditLog('REVOKE', waiverId, { reason, original_waiver: waiver });

    return waiver;
  }

  /**
   * Extend waiver expiration
   */
  async extendWaiver(waiverId, newExpiryDate, approvedBy) {
    const waivers = await this.loadActiveWaivers();
    const waiver = waivers.find((w) => w.id === waiverId);

    if (!waiver) {
      throw new Error(`Waiver ${waiverId} not found`);
    }

    const oldExpiry = waiver.expires_at;
    waiver.expires_at = new Date(newExpiryDate).toISOString();
    waiver.metadata = waiver.metadata || {};
    waiver.metadata.extended_by = approvedBy;
    waiver.metadata.extended_at = new Date().toISOString();
    waiver.metadata.previous_expiry = oldExpiry;

    await this.saveActiveWaivers(waivers);
    await this.auditLog('EXTEND', waiverId, {
      new_expiry: waiver.expires_at,
      approved_by: approvedBy,
      old_expiry: oldExpiry,
    });

    return waiver;
  }

  /**
   * Get waiver statistics and health metrics
   */
  async getWaiverStats() {
    const waivers = await this.getActiveWaivers();
    const now = new Date();

    const stats = {
      total_active: waivers.length,
      by_reason: {},
      by_risk_level: {},
      expiring_soon: [], // Next 7 days
      high_risk: [],
      total_gates_waived: 0,
      average_lifespan_days: 0,
    };

    const sevenDaysFromNow = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);

    for (const waiver of waivers) {
      // Count by reason
      stats.by_reason[waiver.reason] = (stats.by_reason[waiver.reason] || 0) + 1;

      // Count by risk level
      const riskLevel = waiver.risk_assessment.impact_level;
      stats.by_risk_level[riskLevel] = (stats.by_risk_level[riskLevel] || 0) + 1;

      // Check expiring soon
      const expiresAt = new Date(waiver.expires_at);
      if (expiresAt <= sevenDaysFromNow) {
        stats.expiring_soon.push({
          id: waiver.id,
          title: waiver.title,
          expires_at: waiver.expires_at,
          days_remaining: Math.ceil((expiresAt - now) / (24 * 60 * 60 * 1000)),
        });
      }

      // Track high-risk waivers
      if (riskLevel === 'high' || riskLevel === 'critical') {
        stats.high_risk.push({
          id: waiver.id,
          title: waiver.title,
          risk_level: riskLevel,
          reason: waiver.reason,
        });
      }

      // Count gates waived
      stats.total_gates_waived += waiver.gates.length;

      // Calculate lifespan
      const createdAt = new Date(waiver.created_at);
      const lifespanDays = (expiresAt - createdAt) / (24 * 60 * 60 * 1000);
      stats.average_lifespan_days += lifespanDays;
    }

    if (waivers.length > 0) {
      stats.average_lifespan_days /= waivers.length;
    }

    return stats;
  }

  // Private helper methods

  async generateWaiverId() {
    const existingWaivers = await this.loadActiveWaivers();
    const usedIds = new Set(existingWaivers.map((w) => parseInt(w.id.split('-')[1])));

    let counter = 1;
    while (usedIds.has(counter)) {
      counter++;
    }

    return `WV-${counter.toString().padStart(4, '0')}`;
  }

  validateWaiver(waiver) {
    // Basic validation - in production, use a full JSON schema validator
    const errors = [];

    if (!waiver.id || !waiver.id.match(/^WV-\d{4}$/)) {
      errors.push('Invalid waiver ID format');
    }

    if (!waiver.title || waiver.title.length < 10) {
      errors.push('Title too short (minimum 10 characters)');
    }

    if (
      !waiver.reason ||
      ![
        'emergency_hotfix',
        'legacy_integration',
        'experimental_feature',
        'third_party_constraint',
        'performance_critical',
        'security_patch',
        'infrastructure_limitation',
        'other',
      ].includes(waiver.reason)
    ) {
      errors.push('Invalid waiver reason');
    }

    if (!waiver.gates || !Array.isArray(waiver.gates) || waiver.gates.length === 0) {
      errors.push('At least one gate must be specified');
    }

    if (!waiver.expires_at) {
      errors.push('Expiration date required');
    } else {
      const expiresAt = new Date(waiver.expires_at);
      const now = new Date();
      if (expiresAt <= now) {
        errors.push('Expiration date must be in the future');
      }
    }

    if (!waiver.approved_by) {
      errors.push('Approval information required');
    }

    return {
      valid: errors.length === 0,
      errors,
    };
  }

  async checkWaiverConflicts(newWaiver) {
    const activeWaivers = await this.getActiveWaivers();
    const conflicts = [];

    for (const existingWaiver of activeWaivers) {
      // Check for overlapping gates
      const overlappingGates = newWaiver.gates.filter((gate) =>
        existingWaiver.gates.includes(gate)
      );

      if (overlappingGates.length > 0) {
        conflicts.push(
          `Waiver ${existingWaiver.id} already covers gates: ${overlappingGates.join(', ')}`
        );
      }
    }

    return conflicts;
  }

  waiverAppliesToContext(waiver, context) {
    // Check environment restrictions
    if (waiver.metadata?.environment && context.environment) {
      if (waiver.metadata.environment !== context.environment) {
        return false;
      }
    }

    // Add more context checks as needed (branch, user, etc.)
    return true;
  }

  async loadActiveWaivers() {
    try {
      if (!fs.existsSync(this.waiversFile)) {
        return [];
      }

      const content = fs.readFileSync(this.waiversFile, 'utf8');
      const data = yaml.load(content) || {};

      // Handle both formats: direct array or {waivers: {...}} structure
      if (Array.isArray(data)) {
        return data;
      }

      if (data.waivers && typeof data.waivers === 'object') {
        // Convert the waivers object to an array
        return Object.values(data.waivers).map((waiver) => {
          // Normalize waiver format for quality gates
          return {
            id: waiver.id,
            title: waiver.title || waiver.description || waiver.id,
            reason: waiver.reason || waiver.reason_code || 'unknown',
            description: waiver.description || waiver.title || waiver.id,
            gates: Array.isArray(waiver.gates) ? waiver.gates : [waiver.gates],
            expires_at: waiver.expires_at,
            approved_by: waiver.approved_by || waiver.risk_owner || 'unknown',
            created_at: waiver.created_at || waiver.approved_at || new Date().toISOString(),
            risk_assessment: waiver.risk_assessment || {
              impact_level: waiver.impact_level || 'medium',
              mitigation_plan: waiver.mitigation || waiver.mitigation_plan || 'Unknown mitigation',
            },
            metadata: waiver.metadata || {},
          };
        });
      }

      return [];
    } catch (error) {
      console.warn(`Warning: Could not load waivers file: ${error.message}`);
      return [];
    }
  }

  async saveActiveWaivers(waivers) {
    // Convert array back to object format for compatibility
    const waiversObj = {};
    waivers.forEach((waiver) => {
      waiversObj[waiver.id] = waiver;
    });

    const data = {
      waivers: waiversObj,
    };

    const content = [
      '# CAWS Active Waivers',
      '# This file contains all currently active waivers that temporarily bypass quality gates',
      '# Waivers are automatically cleaned up when they expire',
      '',
      yaml.dump(data, {
        indent: 2,
        sortKeys: true,
      }),
    ].join('\n');

    fs.writeFileSync(this.waiversFile, content, 'utf8');
  }

  async auditLog(action, waiverId, details) {
    const logEntry = {
      timestamp: new Date().toISOString(),
      action,
      waiver_id: waiverId,
      details,
      user: process.env.USER || process.env.USERNAME || 'unknown',
      cwd: process.cwd(),
    };

    const logLine = JSON.stringify(logEntry) + '\n';

    fs.appendFileSync(this.auditLogFile, logLine);
  }

  async flagForReview(waiver) {
    // Create a flag file for code owners to review
    const flagFile = path.join(this.waiversDir, `review-${waiver.id}.md`);

    const flagContent = `# Waiver Review Required: ${waiver.id}

## Waiver Details
- **ID**: ${waiver.id}
- **Title**: ${waiver.title}
- **Reason**: ${waiver.reason}
- **Risk Level**: ${waiver.risk_assessment.impact_level}
- **Approved By**: ${waiver.approved_by}
- **Expires**: ${waiver.expires_at}

## Description
${waiver.description}

## Gates Waived
${waiver.gates.map((gate) => `- ${gate}`).join('\n')}

## Risk Assessment
**Impact Level**: ${waiver.risk_assessment.impact_level}
**Mitigation Plan**: ${waiver.risk_assessment.mitigation_plan}

## Review Checklist
- [ ] Risk assessment is adequate
- [ ] Mitigation plan is sufficient
- [ ] Waiver duration is appropriate
- [ ] No alternative solutions available
- [ ] Code owners approve waiver usage

---
*This waiver requires manual review. Please check the waiver details and mitigation plan before approving continued use.*
`;

    fs.writeFileSync(flagFile, flagContent);

    // Also log this flagging action
    await this.auditLog('FLAG_REVIEW', waiver.id, {
      flag_file: flagFile,
      risk_level: waiver.risk_assessment.impact_level,
      review_required: waiver.risk_assessment.review_required,
    });
  }
}

module.exports = WaiversManager;
