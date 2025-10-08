#!/usr/bin/env tsx
"use strict";
/**
 * CAWS Provenance Tool
 * Enhanced provenance generation with metadata and hashing
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
exports.ProvenanceCLI = void 0;
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
const crypto = __importStar(require("crypto"));
const yaml = __importStar(require("js-yaml"));
const base_tool_js_1 = require("./shared/base-tool.js");
class ProvenanceCLI extends base_tool_js_1.CawsBaseTool {
    /**
     * Generate provenance information for a CAWS project
     */
    generateProvenance() {
        try {
            // Check if we're in a CAWS project
            if (!this.pathExists('.caws')) {
                throw new Error('Not in a CAWS project directory');
            }
            const workingSpecPath = '.caws/working-spec.yaml';
            if (!this.pathExists(workingSpecPath)) {
                throw new Error('Working specification file not found');
            }
            // Load working spec
            const specContent = fs.readFileSync(workingSpecPath, 'utf8');
            const spec = yaml.load(specContent);
            // Load package.json for version
            let version = '1.0.0';
            const packageJsonPath = path.join(process.cwd(), 'package.json');
            if (this.pathExists(packageJsonPath)) {
                const pkg = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
                version = pkg.version || version;
            }
            // Generate provenance data
            const provenance = {
                agent: 'caws-cli',
                model: process.env.CAWS_MODEL || 'cli-interactive',
                modelHash: version,
                toolAllowlist: [
                    'node',
                    'npm',
                    'git',
                    'fs-extra',
                    'inquirer',
                    'commander',
                    'js-yaml',
                    'ajv',
                    'chalk',
                    'tsx',
                    'typescript',
                ],
                artifacts: ['.caws/working-spec.yaml'],
                results: {
                    project_id: spec.id || 'unknown',
                    project_title: spec.title || 'Unknown Project',
                    risk_tier: spec.risk_tier || 3,
                    mode: spec.mode || 'standard',
                    change_budget: spec.change_budget,
                    blast_radius: spec.blast_radius,
                    operational_rollback_slo: spec.operational_rollback_slo,
                    acceptance_criteria_count: spec.acceptance?.length || 0,
                    contracts_count: spec.contracts?.length || 0,
                },
                approvals: spec.approvals || [],
                timestamp: new Date().toISOString(),
                version: '1.0.0',
                hash: '', // Will be calculated below
            };
            // Calculate hash
            const hashContent = JSON.stringify(provenance, Object.keys(provenance).sort());
            provenance.hash = crypto.createHash('sha256').update(hashContent).digest('hex');
            return provenance;
        }
        catch (error) {
            throw new Error(`Provenance generation failed: ${error}`);
        }
    }
    /**
     * Save provenance data to a file
     */
    saveProvenance(provenance, outputPath) {
        try {
            // Ensure directory exists
            const dir = path.dirname(outputPath);
            if (!this.pathExists(dir)) {
                fs.mkdirSync(dir, { recursive: true });
            }
            // Save provenance
            fs.writeFileSync(outputPath, JSON.stringify(provenance, null, 2));
            this.logSuccess(`Provenance saved to ${outputPath}`);
        }
        catch (error) {
            throw new Error(`Failed to save provenance: ${error}`);
        }
    }
    /**
     * Display provenance information
     */
    displayProvenance(provenance) {
        console.log('\n📋 CAWS Provenance');
        console.log('='.repeat(50));
        console.log(`Agent: ${provenance.agent}`);
        console.log(`Model: ${provenance.model}`);
        console.log(`Version: ${provenance.version}`);
        console.log(`Timestamp: ${provenance.timestamp}`);
        console.log(`Hash: ${provenance.hash.substring(0, 16)}...`);
        console.log('\n📊 Project Results:');
        Object.entries(provenance.results).forEach(([key, value]) => {
            if (value !== undefined && value !== null) {
                console.log(`  ${key}: ${value}`);
            }
        });
        console.log('\n🔧 Tool Allowlist:');
        provenance.toolAllowlist.slice(0, 5).forEach((tool) => {
            console.log(`  - ${tool}`);
        });
        if (provenance.toolAllowlist.length > 5) {
            console.log(`  ... and ${provenance.toolAllowlist.length - 5} more`);
        }
        console.log('\n📦 Artifacts:');
        provenance.artifacts.forEach((artifact) => {
            console.log(`  - ${artifact}`);
        });
        if (provenance.approvals.length > 0) {
            console.log('\n✅ Approvals:');
            provenance.approvals.forEach((approval) => {
                console.log(`  - ${approval}`);
            });
        }
        console.log('='.repeat(50));
    }
}
exports.ProvenanceCLI = ProvenanceCLI;
// Main CLI handler
if (import.meta.url === `file://${process.argv[1]}`) {
    const command = process.argv[2];
    const cli = new ProvenanceCLI();
    try {
        switch (command) {
            case 'generate': {
                const provenance = cli.generateProvenance();
                const outputPath = process.argv[3] || '.agent/provenance.json';
                cli.saveProvenance(provenance, outputPath);
                cli.displayProvenance(provenance);
                break;
            }
            case 'show': {
                const filePath = process.argv[3] || '.agent/provenance.json';
                if (!cli.pathExists(filePath)) {
                    console.error(`❌ Provenance file not found: ${filePath}`);
                    process.exit(1);
                }
                const content = fs.readFileSync(filePath, 'utf8');
                const provenance = JSON.parse(content);
                cli.displayProvenance(provenance);
                break;
            }
            default:
                console.log('CAWS Provenance Tool');
                console.log('');
                console.log('Commands:');
                console.log('  generate [output]  - Generate and save provenance data');
                console.log('  show [file]        - Display provenance from file');
                console.log('');
                console.log('Examples:');
                console.log('  provenance.ts generate .agent/provenance.json');
                console.log('  provenance.ts show .agent/provenance.json');
                process.exit(1);
        }
    }
    catch (error) {
        console.error(`❌ Error: ${error}`);
        process.exit(1);
    }
}
//# sourceMappingURL=provenance.js.map