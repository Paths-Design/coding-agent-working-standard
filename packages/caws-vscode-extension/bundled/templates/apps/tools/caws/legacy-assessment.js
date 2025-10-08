#!/usr/bin/env tsx
"use strict";
/**
 * CAWS Legacy Assessment Tool
 * Assesses legacy code for CAWS migration and generates migration plans
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
exports.LegacyAssessmentTool = void 0;
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
const base_tool_js_1 = require("./shared/base-tool.js");
class LegacyAssessmentTool extends base_tool_js_1.CawsBaseTool {
    /**
     * Assess a legacy module for CAWS migration
     */
    async assessModule(modulePath) {
        const complexity = await this.calculateComplexity(modulePath);
        const coverage = await this.getCurrentCoverage(modulePath);
        const changeFrequency = await this.analyzeChangeFrequency(modulePath);
        const dependencies = await this.analyzeDependencies(modulePath);
        const recommendedTier = this.inferTier(coverage, dependencies, changeFrequency);
        const migrationPriority = this.calculatePriority(changeFrequency, coverage, complexity);
        const quickWins = this.identifyQuickWins(modulePath, coverage);
        const estimatedEffort = this.estimateEffort(complexity, coverage);
        return {
            module: modulePath,
            complexity,
            coverage,
            changeFrequency,
            dependencies,
            recommendedTier,
            migrationPriority,
            quickWins,
            estimatedEffort,
        };
    }
    /**
     * Generate migration plan for legacy codebase
     */
    async generateMigrationPlan(projectDir) {
        const modules = await this.findModules(projectDir);
        const assessments = await Promise.all(modules.map((m) => this.assessModule(m)));
        // Sort by priority and dependencies
        const sortedModules = assessments.sort((a, b) => {
            const priorityScore = { high: 3, medium: 2, low: 1 };
            return priorityScore[b.migrationPriority] - priorityScore[a.migrationPriority];
        });
        const phases = [];
        let currentPhase = [];
        let phaseNumber = 1;
        let totalDays = 0;
        const effortDays = { small: 2, medium: 5, large: 10 };
        for (const assessment of sortedModules) {
            if (currentPhase.length >= 3) {
                // Max 3 modules per phase
                const phaseDays = currentPhase.reduce((sum, mod) => sum +
                    effortDays[sortedModules.find((a) => a.module === mod)?.estimatedEffort || 'medium'], 0);
                phases.push({
                    phase: phaseNumber++,
                    modules: [...currentPhase],
                    estimatedDays: phaseDays,
                    dependencies: [],
                    risks: ['Dependencies may require coordination'],
                });
                totalDays += phaseDays;
                currentPhase = [];
            }
            currentPhase.push(assessment.module);
        }
        // Add final phase
        if (currentPhase.length > 0) {
            const phaseDays = currentPhase.reduce((sum, mod) => sum +
                effortDays[sortedModules.find((a) => a.module === mod)?.estimatedEffort || 'medium'], 0);
            phases.push({
                phase: phaseNumber,
                modules: currentPhase,
                estimatedDays: phaseDays,
                dependencies: [],
                risks: [],
            });
            totalDays += phaseDays;
        }
        const criticalPath = sortedModules
            .filter((a) => a.migrationPriority === 'high')
            .map((a) => a.module);
        return { phases, totalEstimatedDays: totalDays, criticalPath };
    }
    async findModules(projectDir) {
        const modules = [];
        const srcDir = path.join(projectDir, 'src');
        if (!fs.existsSync(srcDir)) {
            return modules;
        }
        const entries = fs.readdirSync(srcDir, { withFileTypes: true });
        for (const entry of entries) {
            if (entry.isDirectory()) {
                const modulePath = path.join('src', entry.name);
                modules.push(modulePath);
            }
        }
        return modules;
    }
    async calculateComplexity(modulePath) {
        // Simplified complexity calculation
        try {
            const files = this.findFilesRecursive(modulePath);
            let totalLines = 0;
            let cyclomaticSum = 0;
            for (const file of files) {
                const content = fs.readFileSync(file, 'utf-8');
                const lines = content.split('\n').length;
                totalLines += lines;
                // Count control flow statements as proxy for cyclomatic complexity
                const controlFlow = (content.match(/\b(if|else|for|while|switch|case|catch|&&|\|\|)\b/g) || []).length;
                cyclomaticSum += controlFlow;
            }
            return files.length > 0 ? cyclomaticSum / files.length : 0;
        }
        catch {
            return 0;
        }
    }
    async getCurrentCoverage(modulePath) {
        try {
            const coveragePath = path.join(process.cwd(), 'coverage', 'coverage-final.json');
            if (!fs.existsSync(coveragePath)) {
                return 0;
            }
            const coverageData = JSON.parse(fs.readFileSync(coveragePath, 'utf-8'));
            let totalStatements = 0;
            let coveredStatements = 0;
            for (const [file, data] of Object.entries(coverageData)) {
                if (file.includes(modulePath)) {
                    const fileData = data;
                    if (fileData.s) {
                        totalStatements += Object.keys(fileData.s).length;
                        coveredStatements += Object.values(fileData.s).filter((s) => s > 0).length;
                    }
                }
            }
            return totalStatements > 0 ? coveredStatements / totalStatements : 0;
        }
        catch {
            return 0;
        }
    }
    async analyzeChangeFrequency(modulePath) {
        // Simplified - in real implementation, use git log
        try {
            const files = this.findFilesRecursive(modulePath);
            // Placeholder: return based on number of files as proxy
            return Math.min(files.length / 10, 1);
        }
        catch {
            return 0;
        }
    }
    async analyzeDependencies(modulePath) {
        try {
            const files = this.findFilesRecursive(modulePath);
            let importCount = 0;
            for (const file of files) {
                const content = fs.readFileSync(file, 'utf-8');
                const imports = content.match(/^import .* from/gm) || [];
                importCount += imports.length;
            }
            return files.length > 0 ? importCount / files.length : 0;
        }
        catch {
            return 0;
        }
    }
    inferTier(coverage, dependencies, changeFrequency) {
        // High change frequency + low coverage = critical (Tier 1)
        if (changeFrequency > 0.7 && coverage < 0.5) {
            return 1;
        }
        // Medium activity
        if (changeFrequency > 0.4 || dependencies > 5) {
            return 2;
        }
        // Low activity, isolated
        return 3;
    }
    calculatePriority(changeFrequency, coverage, complexity) {
        const score = changeFrequency * 0.4 + (1 - coverage) * 0.4 + complexity * 0.2;
        if (score > 0.7)
            return 'high';
        if (score > 0.4)
            return 'medium';
        return 'low';
    }
    identifyQuickWins(modulePath, coverage) {
        const wins = [];
        if (coverage === 0) {
            wins.push('Add basic smoke tests for main functions');
        }
        else if (coverage < 0.3) {
            wins.push('Increase coverage by testing happy paths');
        }
        const files = this.findFilesRecursive(modulePath);
        if (files.some((f) => !f.includes('.test.') && !f.includes('.spec.'))) {
            wins.push('Add test files for untested modules');
        }
        wins.push('Extract pure functions for easier testing');
        wins.push('Add type definitions if missing');
        return wins;
    }
    estimateEffort(complexity, coverage) {
        const effortScore = complexity * 0.6 + (1 - coverage) * 0.4;
        if (effortScore > 0.7)
            return 'large';
        if (effortScore > 0.4)
            return 'medium';
        return 'small';
    }
    findFilesRecursive(dir, files = []) {
        try {
            const entries = fs.readdirSync(dir, { withFileTypes: true });
            for (const entry of entries) {
                const fullPath = path.join(dir, entry.name);
                if (entry.isDirectory() && !entry.name.includes('node_modules')) {
                    this.findFilesRecursive(fullPath, files);
                }
                else if (entry.isFile() && (entry.name.endsWith('.ts') || entry.name.endsWith('.js'))) {
                    files.push(fullPath);
                }
            }
        }
        catch {
            // Directory doesn't exist
        }
        return files;
    }
}
exports.LegacyAssessmentTool = LegacyAssessmentTool;
// CLI interface
if (import.meta.url === `file://${process.argv[1]}`) {
    (async () => {
        const command = process.argv[2];
        const tool = new LegacyAssessmentTool();
        switch (command) {
            case 'assess': {
                const modulePath = process.argv[3];
                if (!modulePath) {
                    console.error('Usage: legacy-assessment assess <module-path>');
                    process.exit(1);
                }
                try {
                    const assessment = await tool.assessModule(modulePath);
                    console.log('\n📊 Legacy Module Assessment');
                    console.log('='.repeat(50));
                    console.log(`Module: ${assessment.module}`);
                    console.log(`Complexity: ${assessment.complexity.toFixed(2)} (avg cyclomatic per file)`);
                    console.log(`Coverage: ${(assessment.coverage * 100).toFixed(1)}%`);
                    console.log(`Change Frequency: ${(assessment.changeFrequency * 100).toFixed(1)}%`);
                    console.log(`Avg Dependencies: ${assessment.dependencies.toFixed(1)}`);
                    console.log(`\nRecommended Tier: ${assessment.recommendedTier}`);
                    console.log(`Migration Priority: ${assessment.migrationPriority}`);
                    console.log(`Estimated Effort: ${assessment.estimatedEffort}`);
                    if (assessment.quickWins.length > 0) {
                        console.log(`\n🎯 Quick Wins:`);
                        assessment.quickWins.forEach((win) => {
                            console.log(`  - ${win}`);
                        });
                    }
                }
                catch (error) {
                    console.error(`❌ Assessment failed: ${error}`);
                    process.exit(1);
                }
                break;
            }
            case 'plan': {
                const projectDir = process.argv[3] || process.cwd();
                try {
                    const plan = await tool.generateMigrationPlan(projectDir);
                    console.log('\n🗓️  Legacy Migration Plan');
                    console.log('='.repeat(50));
                    console.log(`Total Estimated Days: ${plan.totalEstimatedDays}`);
                    console.log(`Number of Phases: ${plan.phases.length}`);
                    if (plan.criticalPath.length > 0) {
                        console.log(`\n🔴 Critical Path Modules:`);
                        plan.criticalPath.forEach((mod) => {
                            console.log(`  - ${mod}`);
                        });
                    }
                    console.log(`\n📋 Migration Phases:`);
                    plan.phases.forEach((phase) => {
                        console.log(`\nPhase ${phase.phase} (${phase.estimatedDays} days):`);
                        console.log(`  Modules:`);
                        phase.modules.forEach((mod) => {
                            console.log(`    - ${mod}`);
                        });
                        if (phase.risks.length > 0) {
                            console.log(`  Risks:`);
                            phase.risks.forEach((risk) => {
                                console.log(`    ⚠️  ${risk}`);
                            });
                        }
                    });
                }
                catch (error) {
                    console.error(`❌ Plan generation failed: ${error}`);
                    process.exit(1);
                }
                break;
            }
            default:
                console.log('CAWS Legacy Assessment Tool');
                console.log('');
                console.log('Usage:');
                console.log('  legacy-assessment assess <module-path>  - Assess legacy module');
                console.log('  legacy-assessment plan [project-dir]    - Generate migration plan');
                console.log('');
                console.log('Examples:');
                console.log('  legacy-assessment assess src/auth');
                console.log('  legacy-assessment plan .');
                break;
        }
    })();
}
//# sourceMappingURL=legacy-assessment.js.map