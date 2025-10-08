#!/usr/bin/env tsx
"use strict";
/**
 * Spec-to-Test Mapper
 *
 * Links acceptance criteria from working-spec.yaml to actual test cases
 * for full traceability and coverage reporting.
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
exports.SpecTestMapper = void 0;
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
const yaml = __importStar(require("js-yaml"));
class SpecTestMapper {
    constructor(workingSpecPath = '.caws/working-spec.yaml', testDir = 'tests') {
        this.workingSpecPath = workingSpecPath;
        this.testDir = testDir;
    }
    /**
     * Load working spec and parse acceptance criteria
     */
    loadWorkingSpec() {
        if (!fs.existsSync(this.workingSpecPath)) {
            throw new Error(`Working spec not found: ${this.workingSpecPath}`);
        }
        const content = fs.readFileSync(this.workingSpecPath, 'utf-8');
        const spec = yaml.load(content);
        if (!spec.acceptance || spec.acceptance.length === 0) {
            throw new Error('No acceptance criteria found in working spec');
        }
        return spec;
    }
    /**
     * Find all test files
     */
    findTestFiles() {
        const files = [];
        const walkDir = (dir) => {
            if (!fs.existsSync(dir))
                return;
            const items = fs.readdirSync(dir, { withFileTypes: true });
            for (const item of items) {
                const fullPath = path.join(dir, item.name);
                if (item.isDirectory() && item.name !== 'node_modules') {
                    walkDir(fullPath);
                }
                else if (item.isFile() &&
                    (item.name.endsWith('.test.ts') ||
                        item.name.endsWith('.test.js') ||
                        item.name.endsWith('.spec.ts') ||
                        item.name.endsWith('.spec.js'))) {
                    files.push(fullPath);
                }
            }
        };
        walkDir(this.testDir);
        return files;
    }
    /**
     * Search for tests related to an acceptance criterion
     */
    findRelatedTests(criterion) {
        const testFiles = this.findTestFiles();
        const tests = [];
        // Build search terms from the criterion
        const searchTerms = [
            criterion.id,
            ...this.extractKeywords(criterion.given),
            ...this.extractKeywords(criterion.when),
            ...this.extractKeywords(criterion.then),
        ];
        for (const file of testFiles) {
            const content = fs.readFileSync(file, 'utf-8');
            // Check if criterion ID is explicitly referenced
            if (content.includes(criterion.id) || content.includes(`[${criterion.id}]`)) {
                const testName = this.extractTestName(content, criterion.id);
                tests.push({
                    file: path.relative(process.cwd(), file),
                    testName: testName || `Tests for ${criterion.id}`,
                    type: this.classifyTest(file),
                });
                continue;
            }
            // Check for keyword matches
            const keywordMatches = searchTerms.filter((term) => content.toLowerCase().includes(term.toLowerCase()));
            if (keywordMatches.length >= 3) {
                // Threshold: at least 3 keyword matches
                const testName = this.extractTestName(content) || this.extractDescribeName(content);
                if (testName) {
                    tests.push({
                        file: path.relative(process.cwd(), file),
                        testName,
                        type: this.classifyTest(file),
                    });
                }
            }
        }
        return tests;
    }
    /**
     * Extract keywords from a text string
     */
    extractKeywords(text) {
        return text
            .toLowerCase()
            .replace(/[^\w\s]/g, ' ')
            .split(/\s+/)
            .filter((word) => word.length > 4) // Only meaningful words
            .filter((word) => !['given', 'when', 'then', 'should', 'with'].includes(word));
    }
    /**
     * Extract test name from content
     */
    extractTestName(content, criterionId) {
        const lines = content.split('\n');
        for (const line of lines) {
            if (criterionId && line.includes(criterionId)) {
                const match = line.match(/it\s*\(\s*["'](.+?)["']/);
                if (match)
                    return match[1];
            }
            const itMatch = line.match(/it\s*\(\s*["'](.+?)["']/);
            if (itMatch)
                return itMatch[1];
        }
        return null;
    }
    /**
     * Extract describe block name
     */
    extractDescribeName(content) {
        const match = content.match(/describe\s*\(\s*["'](.+?)["']/);
        return match ? match[1] : null;
    }
    /**
     * Classify test type based on file path
     */
    classifyTest(filePath) {
        if (filePath.includes('e2e'))
            return 'e2e';
        if (filePath.includes('integration'))
            return 'integration';
        if (filePath.includes('property'))
            return 'property-based';
        return 'unit';
    }
    /**
     * Generate coverage report
     */
    async generateCoverageReport() {
        const spec = this.loadWorkingSpec();
        const mappings = [];
        console.log(`\n🔍 Analyzing ${spec.acceptance.length} acceptance criteria...\n`);
        for (const criterion of spec.acceptance) {
            const tests = this.findRelatedTests(criterion);
            const covered = tests.length > 0;
            mappings.push({
                criterionId: criterion.id,
                criterion,
                tests,
                covered,
            });
            if (covered) {
                console.log(`✅ ${criterion.id}: ${tests.length} related test(s) found`);
            }
            else {
                console.log(`❌ ${criterion.id}: No related tests found`);
            }
        }
        const coveredCount = mappings.filter((m) => m.covered).length;
        const coveragePercentage = (coveredCount / spec.acceptance.length) * 100;
        const uncoveredCriteria = mappings.filter((m) => !m.covered).map((m) => m.criterionId);
        return {
            totalCriteria: spec.acceptance.length,
            coveredCriteria: coveredCount,
            coveragePercentage,
            mappings,
            uncoveredCriteria,
        };
    }
    /**
     * Generate markdown report
     */
    generateMarkdownReport(report) {
        let md = `# Acceptance Criteria Coverage Report\n\n`;
        md += `**Coverage**: ${report.coveredCriteria}/${report.totalCriteria} (${report.coveragePercentage.toFixed(1)}%)\n\n`;
        md += `## Coverage Summary\n\n`;
        md += `| Criterion ID | Status | Related Tests |\n`;
        md += `|--------------|--------|---------------|\n`;
        for (const mapping of report.mappings) {
            const status = mapping.covered ? '✅ Covered' : '❌ Not Covered';
            const testCount = mapping.tests.length;
            md += `| ${mapping.criterionId} | ${status} | ${testCount} |\n`;
        }
        md += `\n## Detailed Mappings\n\n`;
        for (const mapping of report.mappings) {
            md += `### ${mapping.criterionId}\n\n`;
            md += `**Given**: ${mapping.criterion.given}\n`;
            md += `**When**: ${mapping.criterion.when}\n`;
            md += `**Then**: ${mapping.criterion.then}\n\n`;
            if (mapping.tests.length > 0) {
                md += `**Related Tests**:\n\n`;
                for (const test of mapping.tests) {
                    md += `- [${test.type}] \`${test.file}\`\n`;
                    md += `  - ${test.testName}\n`;
                }
            }
            else {
                md += `⚠️  **No related tests found**\n\n`;
                md += `**Recommendation**: Add test for this acceptance criterion.\n`;
            }
            md += `\n---\n\n`;
        }
        if (report.uncoveredCriteria.length > 0) {
            md += `## Uncovered Criteria\n\n`;
            md += `The following acceptance criteria have no related tests:\n\n`;
            for (const id of report.uncoveredCriteria) {
                md += `- ${id}\n`;
            }
        }
        return md;
    }
    /**
     * Save report to file
     */
    async saveReport(outputPath) {
        const report = await this.generateCoverageReport();
        const markdown = this.generateMarkdownReport(report);
        fs.writeFileSync(outputPath, markdown, 'utf-8');
        console.log(`\n📄 Report saved to: ${outputPath}`);
    }
    /**
     * Display console report
     */
    async displayReport() {
        const report = await this.generateCoverageReport();
        console.log(`\n${'═'.repeat(80)}`);
        console.log(`  ACCEPTANCE CRITERIA COVERAGE REPORT`);
        console.log(`${'═'.repeat(80)}\n`);
        console.log(`📊 Coverage: ${report.coveredCriteria}/${report.totalCriteria} (${report.coveragePercentage.toFixed(1)}%)\n`);
        if (report.uncoveredCriteria.length > 0) {
            console.log(`❌ Uncovered Criteria (${report.uncoveredCriteria.length}):`);
            for (const id of report.uncoveredCriteria) {
                const mapping = report.mappings.find((m) => m.criterionId === id);
                if (mapping) {
                    console.log(`\n  ${id}:`);
                    console.log(`    Given: ${mapping.criterion.given}`);
                    console.log(`    When:  ${mapping.criterion.when}`);
                    console.log(`    Then:  ${mapping.criterion.then}`);
                }
            }
            console.log();
        }
        if (report.coveredCriteria > 0) {
            console.log(`✅ Covered Criteria (${report.coveredCriteria}):`);
            for (const mapping of report.mappings.filter((m) => m.covered)) {
                console.log(`\n  ${mapping.criterionId}: ${mapping.tests.length} test(s)`);
                for (const test of mapping.tests) {
                    console.log(`    - [${test.type}] ${test.testName}`);
                    console.log(`      📁 ${test.file}`);
                }
            }
        }
        console.log(`\n${'═'.repeat(80)}\n`);
    }
}
exports.SpecTestMapper = SpecTestMapper;
// CLI interface
if (import.meta.url === `file://${process.argv[1]}`) {
    (async () => {
        const command = process.argv[2];
        const mapper = new SpecTestMapper();
        switch (command) {
            case 'report':
                await mapper.displayReport();
                break;
            case 'save':
                const outputPath = process.argv[3] || '.caws/spec-coverage-report.md';
                await mapper.saveReport(outputPath);
                break;
            default:
                console.log(`
Usage: spec-test-mapper <command> [options]

Commands:
  report              Display coverage report in console
  save [output-path]  Save coverage report to file (default: .caws/spec-coverage-report.md)

Examples:
  npx tsx apps/tools/caws/spec-test-mapper.ts report
  npx tsx apps/tools/caws/spec-test-mapper.ts save docs/spec-coverage.md
        `);
                process.exit(1);
        }
    })();
}
//# sourceMappingURL=spec-test-mapper.js.map