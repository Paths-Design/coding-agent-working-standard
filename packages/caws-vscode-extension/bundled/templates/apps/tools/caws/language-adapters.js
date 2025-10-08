#!/usr/bin/env tsx
"use strict";
/**
 * CAWS Language Adapter Manager
 * Multi-language support for TypeScript, Python, Rust, Go, Java
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
exports.LanguageAdapterManager = void 0;
const path = __importStar(require("path"));
const base_tool_js_1 = require("./shared/base-tool.js");
class LanguageAdapterManager extends base_tool_js_1.CawsBaseTool {
    constructor() {
        super();
        this.adapters = new Map();
        this.initializeAdapters();
    }
    initializeAdapters() {
        // TypeScript/JavaScript adapter
        this.adapters.set('typescript', {
            language: 'typescript',
            fileExtensions: ['.ts', '.tsx', '.js', '.jsx'],
            tools: {
                unitTest: { command: 'vitest', args: ['run'] },
                coverage: { command: 'vitest', args: ['run', '--coverage'] },
                mutationTest: { command: 'stryker', args: ['run'] },
                contractTest: { command: 'pact', args: ['verify'] },
                lint: { command: 'eslint', args: ['.'] },
            },
        });
        // Python adapter
        this.adapters.set('python', {
            language: 'python',
            fileExtensions: ['.py'],
            tools: {
                unitTest: { command: 'pytest', args: [] },
                coverage: { command: 'pytest', args: ['--cov'] },
                mutationTest: { command: 'mutmut', args: ['run'] },
                contractTest: { command: 'schemathesis', args: ['run'] },
                lint: { command: 'ruff', args: ['check', '.'] },
            },
            tierAdjustments: {
                1: { min_mutation: 0.6 }, // Python mutation testing is less mature
                2: { min_mutation: 0.4 },
                3: { min_mutation: 0.25 },
            },
            fallbacks: {
                mutation: 'If mutation testing unavailable, increase integration test coverage by 20%',
                contracts: 'Use pytest with OpenAPI schema validation',
            },
        });
        // Rust adapter
        this.adapters.set('rust', {
            language: 'rust',
            fileExtensions: ['.rs'],
            tools: {
                unitTest: { command: 'cargo', args: ['test'] },
                coverage: { command: 'cargo', args: ['tarpaulin', '--out', 'Json'] },
                mutationTest: { command: 'cargo', args: ['mutants'] },
                lint: { command: 'cargo', args: ['clippy', '--', '-D', 'warnings'] },
            },
            tierAdjustments: {
                1: { min_mutation: 0.65 },
                2: { min_mutation: 0.45 },
                3: { min_mutation: 0.3 },
            },
        });
        // Go adapter
        this.adapters.set('go', {
            language: 'go',
            fileExtensions: ['.go'],
            tools: {
                unitTest: { command: 'go', args: ['test', './...'] },
                coverage: {
                    command: 'go',
                    args: ['test', '-coverprofile=coverage.out', './...'],
                },
                lint: { command: 'golangci-lint', args: ['run'] },
            },
            fallbacks: {
                mutation: 'Go lacks mature mutation testing - require 90% branch coverage instead',
                contracts: 'Use go-swagger for API contract validation',
            },
        });
        // Java adapter
        this.adapters.set('java', {
            language: 'java',
            fileExtensions: ['.java'],
            tools: {
                unitTest: { command: 'mvn', args: ['test'] },
                coverage: { command: 'mvn', args: ['jacoco:report'] },
                mutationTest: {
                    command: 'mvn',
                    args: ['org.pitest:pitest-maven:mutationCoverage'],
                },
                contractTest: { command: 'mvn', args: ['pact:verify'] },
                lint: { command: 'mvn', args: ['checkstyle:check'] },
            },
        });
    }
    /**
     * Detect project language based on files present
     */
    detectLanguage(projectDir) {
        const indicators = [
            { file: 'package.json', language: 'typescript' },
            { file: 'tsconfig.json', language: 'typescript' },
            { file: 'requirements.txt', language: 'python' },
            { file: 'pyproject.toml', language: 'python' },
            { file: 'Pipfile', language: 'python' },
            { file: 'Cargo.toml', language: 'rust' },
            { file: 'go.mod', language: 'go' },
            { file: 'pom.xml', language: 'java' },
            { file: 'build.gradle', language: 'java' },
        ];
        for (const indicator of indicators) {
            const filePath = path.join(projectDir, indicator.file);
            if (this.pathExists(filePath)) {
                return indicator.language;
            }
        }
        return null;
    }
    /**
     * Get adapter for a specific language
     */
    getAdapter(language) {
        return this.adapters.get(language.toLowerCase()) || null;
    }
    /**
     * Get adjusted tier policy for a language
     */
    getAdjustedTierPolicy(language, tier) {
        const adapter = this.getAdapter(language);
        if (!adapter)
            return null;
        const basePolicies = {
            1: {
                min_branch: 0.9,
                min_coverage: 0.9,
                min_mutation: 0.7,
                requires_contracts: true,
                requires_manual_review: true,
            },
            2: {
                min_branch: 0.8,
                min_coverage: 0.8,
                min_mutation: 0.5,
                requires_contracts: true,
            },
            3: {
                min_branch: 0.7,
                min_coverage: 0.7,
                min_mutation: 0.3,
                requires_contracts: false,
            },
        };
        const basePolicy = basePolicies[tier];
        if (!basePolicy)
            return null;
        // Apply language-specific adjustments
        const adjustments = adapter.tierAdjustments?.[tier] || {};
        return { ...basePolicy, ...adjustments };
    }
    /**
     * Generate language-specific configuration
     */
    generateConfig(language) {
        const adapter = this.getAdapter(language);
        if (!adapter)
            return null;
        return {
            language: adapter.language,
            tools: adapter.tools,
            gates: this.generateGateConfig(adapter),
            tierAdjustments: adapter.tierAdjustments,
            fallbacks: adapter.fallbacks,
        };
    }
    generateGateConfig(adapter) {
        const gates = {
            coverage: {
                enabled: true,
                threshold: 0.8,
            },
            mutation: {
                enabled: !!adapter.tools.mutationTest,
                threshold: 0.5,
            },
            contracts: {
                enabled: !!adapter.tools.contractTest,
                threshold: 1.0,
            },
        };
        return gates;
    }
    /**
     * List all available adapters
     */
    listAdapters() {
        return Array.from(this.adapters.values()).map((adapter) => ({
            language: adapter.language,
            hasMutation: !!adapter.tools.mutationTest,
            hasContracts: !!adapter.tools.contractTest,
        }));
    }
    /**
     * Check if tools are available for a language
     */
    checkToolAvailability(language) {
        const adapter = this.getAdapter(language);
        if (!adapter) {
            return { language, available: {}, missing: [] };
        }
        const available = {};
        const missing = [];
        const toolChecks = [
            { name: 'unitTest', tool: adapter.tools.unitTest },
            { name: 'coverage', tool: adapter.tools.coverage },
            { name: 'mutationTest', tool: adapter.tools.mutationTest },
            { name: 'contractTest', tool: adapter.tools.contractTest },
            { name: 'lint', tool: adapter.tools.lint },
        ];
        for (const { name, tool } of toolChecks) {
            if (tool) {
                // Simple check - just verify command exists (would need proper implementation)
                available[name] = true; // Placeholder
            }
            else {
                available[name] = false;
                missing.push(name);
            }
        }
        return { language, available, missing };
    }
}
exports.LanguageAdapterManager = LanguageAdapterManager;
// CLI interface
if (import.meta.url === `file://${process.argv[1]}`) {
    const command = process.argv[2];
    const manager = new LanguageAdapterManager();
    switch (command) {
        case 'detect': {
            const projectDir = process.argv[3] || process.cwd();
            const language = manager.detectLanguage(projectDir);
            if (language) {
                console.log(`✅ Detected language: ${language}`);
                const adapter = manager.getAdapter(language);
                if (adapter) {
                    console.log(`\n📦 Available tools:`);
                    console.log(`  Unit tests: ${adapter.tools.unitTest.command}`);
                    console.log(`  Coverage: ${adapter.tools.coverage.command}`);
                    if (adapter.tools.mutationTest) {
                        console.log(`  Mutation: ${adapter.tools.mutationTest.command}`);
                    }
                    if (adapter.tools.contractTest) {
                        console.log(`  Contracts: ${adapter.tools.contractTest.command}`);
                    }
                    console.log(`  Lint: ${adapter.tools.lint.command}`);
                }
            }
            else {
                console.log('❌ Could not detect language');
                process.exit(1);
            }
            break;
        }
        case 'list': {
            const adapters = manager.listAdapters();
            console.log('Available Language Adapters:');
            console.log('='.repeat(50));
            adapters.forEach((adapter) => {
                console.log(`\n📚 ${adapter.language}`);
                console.log(`  Mutation testing: ${adapter.hasMutation ? '✅' : '❌'}`);
                console.log(`  Contract testing: ${adapter.hasContracts ? '✅' : '❌'}`);
            });
            break;
        }
        case 'config': {
            const language = process.argv[3];
            if (!language) {
                console.error('Usage: language-adapters config <language>');
                process.exit(1);
            }
            const config = manager.generateConfig(language);
            if (config) {
                console.log(JSON.stringify(config, null, 2));
            }
            else {
                console.error(`❌ No adapter found for language: ${language}`);
                process.exit(1);
            }
            break;
        }
        case 'tier': {
            const language = process.argv[3];
            const tier = parseInt(process.argv[4]);
            if (!language || !tier) {
                console.error('Usage: language-adapters tier <language> <tier>');
                process.exit(1);
            }
            const policy = manager.getAdjustedTierPolicy(language, tier);
            if (policy) {
                console.log(`Tier ${tier} policy for ${language}:`);
                console.log(JSON.stringify(policy, null, 2));
            }
            else {
                console.error(`❌ Could not get policy for ${language} tier ${tier}`);
                process.exit(1);
            }
            break;
        }
        default:
            console.log('CAWS Language Adapter Manager');
            console.log('');
            console.log('Usage:');
            console.log('  language-adapters detect [dir]          - Detect project language');
            console.log('  language-adapters list                  - List available adapters');
            console.log('  language-adapters config <language>     - Generate config for language');
            console.log('  language-adapters tier <language> <tier> - Get tier policy for language');
            console.log('');
            console.log('Supported Languages:');
            console.log('  typescript, python, rust, go, java');
            break;
    }
}
//# sourceMappingURL=language-adapters.js.map