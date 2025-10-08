"use strict";
/**
 * CAWS Gate Checker
 * Consolidated gate checking logic for coverage, mutation, contracts, and trust score
 *
 * @author @darianrosebrook
 */
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.CawsGateChecker = void 0;
const path = __importStar(require("path"));
const base_tool_js_1 = require("./base-tool.js");
const waivers_manager_js_1 = require("./waivers-manager.js");
class CawsGateChecker extends base_tool_js_1.CawsBaseTool {
    constructor() {
        super();
        this.tierPolicies = {
            1: {
                min_branch: 0.9,
                min_mutation: 0.7,
                min_coverage: 0.9,
                requires_contracts: true,
                requires_manual_review: true,
            },
            2: {
                min_branch: 0.8,
                min_mutation: 0.5,
                min_coverage: 0.8,
                requires_contracts: true,
            },
            3: {
                min_branch: 0.7,
                min_mutation: 0.3,
                min_coverage: 0.7,
                requires_contracts: false,
            },
        };
        this.loadTierPolicies();
        this.waiversManager = new waivers_manager_js_1.WaiversManager();
    }
    /**
     * Load tier policies from configuration
     */
    loadTierPolicies() {
        const policy = this.loadTierPolicy();
        if (policy) {
            this.tierPolicies = { ...this.tierPolicies, ...policy };
        }
    }
    /**
     * Check if a waiver applies to the given gate
     */
    async checkWaiver(gate, workingDirectory) {
        try {
            const waivers = await this.waiversManager.getWaiversByGate(gate);
            if (waivers.length === 0) {
                return { waived: false };
            }
            // Check if any waiver applies (for now, return the first active one)
            for (const waiver of waivers) {
                const status = await this.waiversManager.checkWaiverStatus(waiver.created_at);
                if (status.active) {
                    return { waived: true, waiver };
                }
            }
            return { waived: false };
        }
        catch (error) {
            return { waived: false, reason: `Waiver check failed: ${error}` };
        }
    }
    /**
     * Load and validate working spec from project
     */
    async loadWorkingSpec(workingDirectory) {
        try {
            const specPath = path.join(workingDirectory || this.getWorkingDirectory(), '.caws/working-spec.yml');
            if (!this.pathExists(specPath)) {
                return { errors: ['Working spec not found at .caws/working-spec.yml'] };
            }
            const spec = await this.readYamlFile(specPath);
            if (!spec) {
                return { errors: ['Failed to parse working spec'] };
            }
            return {
                spec,
                experiment_mode: spec.experiment_mode,
                human_override: spec.human_override,
                ai_assessment: spec.ai_assessment,
            };
        }
        catch (error) {
            return { errors: [`Failed to load working spec: ${error}`] };
        }
    }
    /**
     * Check if human override applies to waive requirements
     */
    checkHumanOverride(humanOverride, requirement) {
        if (!humanOverride) {
            return { waived: false };
        }
        if (humanOverride.waived_requirements?.includes(requirement)) {
            return {
                waived: true,
                reason: `Human override by ${humanOverride.approved_by}: ${humanOverride.reason}`,
            };
        }
        return { waived: false };
    }
    /**
     * Check if experiment mode applies reduced requirements
     */
    checkExperimentMode(experimentMode) {
        if (!experimentMode) {
            return { reduced: false };
        }
        return {
            reduced: true,
            adjustments: {
                skip_mutation: true,
                skip_contracts: true,
                reduced_coverage: 0.5, // Minimum coverage for experiments
                skip_manual_review: true,
            },
        };
    }
    /**
     * Check branch coverage against tier requirements
     */
    async checkCoverage(options) {
        try {
            // Check waivers and overrides first
            const waiverCheck = await this.checkWaiver('coverage', options.workingDirectory);
            if (waiverCheck.waived) {
                return {
                    passed: true,
                    score: 1.0, // Waived checks pass with perfect score
                    details: {
                        waived: true,
                        waiver_reason: waiverCheck.waiver?.reason,
                        waiver_owner: waiverCheck.waiver?.owner,
                    },
                    tier: options.tier,
                };
            }
            // Load working spec for overrides and experiment mode
            const specData = await this.loadWorkingSpec(options.workingDirectory);
            // Check human override
            const overrideCheck = this.checkHumanOverride(specData.human_override, 'coverage');
            if (overrideCheck.waived) {
                return {
                    passed: true,
                    score: 1.0,
                    details: {
                        overridden: true,
                        override_reason: overrideCheck.reason,
                    },
                    tier: options.tier,
                };
            }
            // Check experiment mode
            const experimentCheck = this.checkExperimentMode(specData.experiment_mode);
            let effectiveTier = options.tier;
            if (experimentCheck.reduced && experimentCheck.adjustments?.reduced_coverage) {
                // For experiments, use reduced coverage requirement
                effectiveTier = 4; // Special experiment tier
                this.tierPolicies[4] = {
                    min_branch: experimentCheck.adjustments.reduced_coverage,
                    min_mutation: 0,
                    min_coverage: experimentCheck.adjustments.reduced_coverage,
                    requires_contracts: false,
                    requires_manual_review: false,
                };
            }
            const coveragePath = path.join(options.workingDirectory || this.getWorkingDirectory(), 'coverage/coverage-final.json');
            if (!this.pathExists(coveragePath)) {
                return {
                    passed: false,
                    score: 0,
                    details: {
                        error: 'Coverage report not found. Run tests with coverage first.',
                    },
                    errors: ['Coverage report not found'],
                };
            }
            const coverageData = this.readJsonFile(coveragePath);
            if (!coverageData) {
                return {
                    passed: false,
                    score: 0,
                    details: { error: 'Failed to parse coverage data' },
                    errors: ['Failed to parse coverage data'],
                };
            }
            // Calculate coverage from detailed data
            let totalStatements = 0;
            let coveredStatements = 0;
            let totalBranches = 0;
            let coveredBranches = 0;
            let totalFunctions = 0;
            let coveredFunctions = 0;
            for (const file of Object.values(coverageData)) {
                const fileData = file;
                if (fileData.s) {
                    totalStatements += Object.keys(fileData.s).length;
                    coveredStatements += Object.values(fileData.s).filter((s) => s > 0).length;
                }
                if (fileData.b) {
                    for (const branches of Object.values(fileData.b)) {
                        totalBranches += branches.length;
                        coveredBranches += branches.filter((b) => b > 0).length;
                    }
                }
                if (fileData.f) {
                    totalFunctions += Object.keys(fileData.f).length;
                    coveredFunctions += Object.values(fileData.f).filter((f) => f > 0).length;
                }
            }
            // Calculate percentages
            const statementsPct = totalStatements > 0 ? (coveredStatements / totalStatements) * 100 : 0;
            const branchesPct = totalBranches > 0 ? (coveredBranches / totalBranches) * 100 : 0;
            const functionsPct = totalFunctions > 0 ? (coveredFunctions / totalFunctions) * 100 : 0;
            const branchCoverage = branchesPct / 100;
            const policy = this.tierPolicies[effectiveTier];
            const passed = branchCoverage >= policy.min_branch;
            return {
                passed,
                score: branchCoverage,
                details: {
                    branch_coverage: branchCoverage,
                    required_branch: policy.min_branch,
                    functions_coverage: functionsPct / 100,
                    lines_coverage: statementsPct / 100,
                    statements_coverage: statementsPct / 100,
                },
            };
        }
        catch (error) {
            return {
                passed: false,
                score: 0,
                details: { error: `Coverage check failed: ${error}` },
                errors: [`Coverage check failed: ${error}`],
            };
        }
    }
    /**
     * Check mutation testing score
     */
    async checkMutation(options) {
        try {
            // Check waivers and overrides first
            const waiverCheck = await this.checkWaiver('mutation', options.workingDirectory);
            if (waiverCheck.waived) {
                return {
                    passed: true,
                    score: 1.0,
                    details: {
                        waived: true,
                        waiver_reason: waiverCheck.waiver?.reason,
                        waiver_owner: waiverCheck.waiver?.owner,
                    },
                    tier: options.tier,
                };
            }
            // Load working spec for overrides and experiment mode
            const specData = await this.loadWorkingSpec(options.workingDirectory);
            // Check human override
            const overrideCheck = this.checkHumanOverride(specData.human_override, 'mutation_testing');
            if (overrideCheck.waived) {
                return {
                    passed: true,
                    score: 1.0,
                    details: {
                        overridden: true,
                        override_reason: overrideCheck.reason,
                    },
                    tier: options.tier,
                };
            }
            // Check experiment mode
            const experimentCheck = this.checkExperimentMode(specData.experiment_mode);
            if (experimentCheck.reduced && experimentCheck.adjustments?.skip_mutation) {
                return {
                    passed: true,
                    score: 1.0,
                    details: {
                        experiment_mode: true,
                        mutation_skipped: true,
                    },
                    tier: options.tier,
                };
            }
            const mutationPath = path.join(options.workingDirectory || this.getWorkingDirectory(), 'reports/mutation/mutation.json');
            if (!this.pathExists(mutationPath)) {
                return {
                    passed: false,
                    score: 0,
                    details: {
                        error: 'Mutation report not found. Run mutation tests first.',
                    },
                    errors: ['Mutation report not found'],
                };
            }
            const mutationData = this.readJsonFile(mutationPath);
            if (!mutationData) {
                return {
                    passed: false,
                    score: 0,
                    details: { error: 'Failed to parse mutation data' },
                    errors: ['Failed to parse mutation data'],
                };
            }
            const killed = mutationData.metrics.killed || 0;
            const total = mutationData.metrics.totalDetected || 1;
            const mutationScore = killed / total;
            const policy = this.tierPolicies[options.tier];
            const passed = mutationScore >= policy.min_mutation;
            return {
                passed,
                score: mutationScore,
                details: {
                    mutation_score: mutationScore,
                    required_mutation: policy.min_mutation,
                    killed,
                    total,
                    survived: mutationData.metrics.survived || 0,
                },
            };
        }
        catch (error) {
            return {
                passed: false,
                score: 0,
                details: { error: `Mutation check failed: ${error}` },
                errors: [`Mutation check failed: ${error}`],
            };
        }
    }
    /**
     * Check contract test compliance
     */
    async checkContracts(options) {
        try {
            // Check waivers and overrides first
            const waiverCheck = await this.checkWaiver('contracts', options.workingDirectory);
            if (waiverCheck.waived) {
                return {
                    passed: true,
                    score: 1.0,
                    details: {
                        waived: true,
                        waiver_reason: waiverCheck.waiver?.reason,
                        waiver_owner: waiverCheck.waiver?.owner,
                    },
                    tier: options.tier,
                };
            }
            const policy = this.tierPolicies[options.tier];
            if (!policy.requires_contracts) {
                return {
                    passed: true,
                    score: 1.0,
                    details: { contracts_required: false, tier: options.tier },
                };
            }
            const contractResultsPath = path.join(options.workingDirectory || this.getWorkingDirectory(), 'test-results/contract-results.json');
            if (!this.pathExists(contractResultsPath)) {
                return {
                    passed: false,
                    score: 0,
                    details: { error: 'Contract test results not found' },
                    errors: ['Contract tests not run or results not found'],
                };
            }
            const results = this.readJsonFile(contractResultsPath);
            if (!results) {
                return {
                    passed: false,
                    score: 0,
                    details: { error: 'Failed to parse contract test results' },
                    errors: ['Failed to parse contract test results'],
                };
            }
            const passed = results.numPassed === results.numTotal && results.numTotal > 0;
            return {
                passed,
                score: passed ? 1.0 : 0,
                details: {
                    tests_passed: results.numPassed,
                    tests_total: results.numTotal,
                    consumer_tests: results.consumer || false,
                    provider_tests: results.provider || false,
                },
            };
        }
        catch (error) {
            return {
                passed: false,
                score: 0,
                details: { error: `Contract check failed: ${error}` },
                errors: [`Contract check failed: ${error}`],
            };
        }
    }
    /**
     * Calculate overall trust score
     */
    async calculateTrustScore(options) {
        try {
            // Run all gate checks
            const [coverageResult, mutationResult, contractResult] = await Promise.all([
                this.checkCoverage(options),
                this.checkMutation(options),
                this.checkContracts(options),
            ]);
            // Load provenance if available
            let provenance = null;
            try {
                const provenancePath = path.join(options.workingDirectory || this.getWorkingDirectory(), '.agent/provenance.json');
                if (this.pathExists(provenancePath)) {
                    provenance = this.readJsonFile(provenancePath);
                }
            }
            catch {
                // Provenance not available
            }
            // CAWS trust score weights
            const weights = {
                coverage: 0.3,
                mutation: 0.3,
                contracts: 0.2,
                a11y: 0.1,
                perf: 0.1,
            };
            // Calculate weighted score
            let totalScore = 0;
            let totalWeight = 0;
            // Coverage component
            totalScore += coverageResult.score * weights.coverage;
            totalWeight += weights.coverage;
            // Mutation component
            totalScore += mutationResult.score * weights.mutation;
            totalWeight += weights.mutation;
            // Contracts component
            totalScore += contractResult.score * weights.contracts;
            totalWeight += weights.contracts;
            // A11y component (placeholder - would check axe results)
            const a11yScore = provenance?.results?.a11y === 'pass' ? 1.0 : 0.5;
            totalScore += a11yScore * weights.a11y;
            totalWeight += weights.a11y;
            // Performance component (placeholder - would check perf budgets)
            const perfScore = provenance?.results?.perf ? 0.8 : 0.5;
            totalScore += perfScore * weights.perf;
            totalWeight += weights.perf;
            const trustScore = totalScore / totalWeight;
            const tierPolicy = this.tierPolicies[options.tier];
            const passed = trustScore >= 0.8;
            // Apply tier-specific penalties
            let adjustedScore = trustScore;
            if (options.tier <= 2 && !contractResult.passed) {
                adjustedScore *= 0.8; // 20% penalty for missing contracts on high tiers
            }
            return {
                passed,
                score: adjustedScore,
                details: {
                    tier: options.tier,
                    tier_policy: tierPolicy,
                    coverage: coverageResult,
                    mutation: mutationResult,
                    contracts: contractResult,
                    a11y: { score: a11yScore, details: provenance?.results?.a11y },
                    perf: { score: perfScore, details: provenance?.results?.perf },
                    raw_score: trustScore,
                    weights,
                },
            };
        }
        catch (error) {
            return {
                passed: false,
                score: 0,
                details: { error: `Trust score calculation failed: ${error}` },
                errors: [`Trust score calculation failed: ${error}`],
            };
        }
    }
    /**
     * Get tier policy for a specific tier
     */
    getTierPolicy(tier) {
        return this.tierPolicies[tier] || null;
    }
    /**
     * Get all available tiers
     */
    getAvailableTiers() {
        return Object.keys(this.tierPolicies).map(Number);
    }
}
exports.CawsGateChecker = CawsGateChecker;
//# sourceMappingURL=gate-checker.js.map