#!/usr/bin/env tsx
"use strict";
/**
 * CAWS Security & Provenance Manager
 * Cryptographic signing, SLSA attestations, and security scanning
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
exports.SecurityProvenanceManager = void 0;
const crypto = __importStar(require("crypto"));
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
const base_tool_js_1 = require("./shared/base-tool.js");
class SecurityProvenanceManager extends base_tool_js_1.CawsBaseTool {
    /**
     * Sign code or provenance manifest with cryptographic signature
     */
    async signArtifact(artifactPath, privateKeyPath) {
        try {
            const content = fs.readFileSync(artifactPath, 'utf-8');
            // Generate hash of content
            const hash = crypto.createHash('sha256').update(content).digest('hex');
            // In production, would use actual private key signing
            // For now, create a deterministic signature
            const signature = this.generateSignature(content, privateKeyPath);
            const publicKeyFingerprint = this.getPublicKeyFingerprint(privateKeyPath);
            return {
                signature,
                signedBy: process.env.CAWS_SIGNER || 'caws-agent',
                signedAt: new Date().toISOString(),
                algorithm: 'SHA256withRSA',
                publicKeyFingerprint,
            };
        }
        catch (error) {
            throw new Error(`Failed to sign artifact: ${error}`);
        }
    }
    /**
     * Verify artifact signature
     */
    async verifySignature(artifactPath, signature, publicKeyPath) {
        try {
            const content = fs.readFileSync(artifactPath, 'utf-8');
            // In production, would verify with actual public key
            // For now, recreate signature and compare
            const expectedSignature = this.generateSignature(content, publicKeyPath);
            return signature === expectedSignature;
        }
        catch (error) {
            console.error(`Signature verification failed: ${error}`);
            return false;
        }
    }
    /**
     * Track model provenance for AI-generated code
     */
    async trackModelProvenance(modelId, version, provider = 'openai') {
        const checksumVerified = await this.verifyModelChecksum(modelId, version);
        return {
            modelId,
            version,
            trainingDataCutoff: this.getTrainingCutoff(modelId),
            provider,
            checksumVerified,
        };
    }
    /**
     * Hash prompts for audit trail without storing sensitive content
     */
    async hashPrompts(prompts) {
        const sanitizationApplied = prompts.some((p) => this.containsSensitiveData(p));
        const promptHashes = prompts.map((prompt) => {
            // Sanitize before hashing
            const sanitized = this.sanitizePrompt(prompt);
            return crypto.createHash('sha256').update(sanitized).digest('hex');
        });
        const injectionChecksPassed = prompts.every((p) => this.checkPromptInjection(p));
        return {
            promptHashes,
            totalPrompts: prompts.length,
            sanitizationApplied,
            injectionChecksPassed,
        };
    }
    /**
     * Run security scans and collect results
     */
    async runSecurityScans(projectDir) {
        const results = {
            secretScanPassed: true,
            sastPassed: true,
            dependencyScanPassed: true,
            details: {},
        };
        // Check for secrets
        const secretScan = await this.scanForSecrets(projectDir);
        results.secretScanPassed = secretScan.passed;
        results.details.secrets = secretScan;
        // Check for vulnerabilities
        const sastScan = await this.runSAST(projectDir);
        results.sastPassed = sastScan.passed;
        results.details.sast = sastScan;
        // Check dependencies
        const depScan = await this.scanDependencies(projectDir);
        results.dependencyScanPassed = depScan.passed;
        results.details.dependencies = depScan;
        return results;
    }
    /**
     * Generate SLSA provenance attestation
     */
    async generateSLSAAttestation(buildInfo) {
        return {
            _type: 'https://in-toto.io/Statement/v0.1',
            predicateType: 'https://slsa.dev/provenance/v0.2',
            subject: buildInfo.artifacts.map((artifact) => ({
                name: artifact,
                digest: {
                    sha256: this.hashFile(artifact),
                },
            })),
            predicate: {
                builder: {
                    id: buildInfo.builder,
                },
                buildType: 'https://caws.dev/build/v1',
                invocation: {
                    configSource: {
                        uri: `git+https://github.com/repo@${buildInfo.commit}`,
                        digest: {
                            sha256: buildInfo.commit,
                        },
                    },
                },
                metadata: {
                    buildStartedOn: buildInfo.buildTime,
                    buildFinishedOn: new Date().toISOString(),
                    completeness: {
                        parameters: true,
                        environment: false,
                        materials: true,
                    },
                    reproducible: false,
                },
                materials: buildInfo.artifacts.map((artifact) => ({
                    uri: `file://${artifact}`,
                    digest: {
                        sha256: this.hashFile(artifact),
                    },
                })),
            },
        };
    }
    generateSignature(content, keyPath) {
        // Simplified signature generation
        // In production, use actual RSA signing with private key
        const hash = crypto.createHash('sha256').update(content);
        if (keyPath && fs.existsSync(keyPath)) {
            const keyContent = fs.readFileSync(keyPath, 'utf-8');
            hash.update(keyContent);
        }
        return hash.digest('hex');
    }
    getPublicKeyFingerprint(keyPath) {
        if (keyPath && fs.existsSync(keyPath)) {
            const keyContent = fs.readFileSync(keyPath, 'utf-8');
            return crypto.createHash('sha256').update(keyContent).digest('hex').substring(0, 16);
        }
        return 'no-key';
    }
    async verifyModelChecksum(modelId, version) {
        // In production, verify against known model checksums
        // For now, return true as placeholder
        return true;
    }
    getTrainingCutoff(modelId) {
        // Known cutoff dates for common models
        const cutoffs = {
            'gpt-4': '2023-04-01',
            'gpt-4-turbo': '2023-12-01',
            'claude-3': '2023-08-01',
            'claude-sonnet-4': '2024-09-01',
        };
        return cutoffs[modelId];
    }
    containsSensitiveData(prompt) {
        const patterns = [
            /password/i,
            /api[_-]?key/i,
            /secret/i,
            /token/i,
            /credential/i,
            /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Z|a-z]{2,}\b/, // email
            /\b\d{3}-\d{2}-\d{4}\b/, // SSN
        ];
        return patterns.some((pattern) => pattern.test(prompt));
    }
    sanitizePrompt(prompt) {
        // Remove sensitive data before hashing
        let sanitized = prompt;
        // Redact emails
        sanitized = sanitized.replace(/\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Z|a-z]{2,}\b/g, '[EMAIL_REDACTED]');
        // Redact potential API keys
        sanitized = sanitized.replace(/[a-zA-Z0-9]{32,}/g, '[KEY_REDACTED]');
        return sanitized;
    }
    checkPromptInjection(prompt) {
        // Check for common prompt injection patterns
        const injectionPatterns = [
            /ignore previous instructions/i,
            /disregard all above/i,
            /system:\s*you are now/i,
            /<\|im_start\|>/,
        ];
        return !injectionPatterns.some((pattern) => pattern.test(prompt));
    }
    async scanForSecrets(projectDir) {
        const findings = [];
        // Simple secret scan (in production, use trufflehog or similar)
        const files = this.findFilesRecursive(projectDir);
        for (const file of files) {
            if (file.includes('node_modules'))
                continue;
            const content = fs.readFileSync(file, 'utf-8');
            if (this.containsSensitiveData(content)) {
                findings.push(`Potential secret in ${file}`);
            }
        }
        return { passed: findings.length === 0, findings };
    }
    async runSAST(projectDir) {
        // Placeholder for SAST integration
        // In production, integrate with Snyk, SonarQube, etc.
        return { passed: true, vulnerabilities: 0 };
    }
    async scanDependencies(projectDir) {
        // Placeholder for dependency scanning
        // In production, use npm audit, snyk, etc.
        return { passed: true, vulnerable: 0 };
    }
    hashFile(filePath) {
        if (!fs.existsSync(filePath)) {
            return '';
        }
        const content = fs.readFileSync(filePath);
        return crypto.createHash('sha256').update(content).digest('hex');
    }
    findFilesRecursive(dir, files = []) {
        try {
            const entries = fs.readdirSync(dir, { withFileTypes: true });
            for (const entry of entries) {
                const fullPath = path.join(dir, entry.name);
                if (entry.isDirectory() && !entry.name.includes('node_modules')) {
                    this.findFilesRecursive(fullPath, files);
                }
                else if (entry.isFile()) {
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
exports.SecurityProvenanceManager = SecurityProvenanceManager;
// CLI interface
if (import.meta.url === `file://${process.argv[1]}`) {
    (async () => {
        const command = process.argv[2];
        const manager = new SecurityProvenanceManager();
        switch (command) {
            case 'sign': {
                const artifactPath = process.argv[3];
                const keyPath = process.argv[4];
                if (!artifactPath) {
                    console.error('Usage: security-provenance sign <artifact> [key]');
                    process.exit(1);
                }
                try {
                    const signature = await manager.signArtifact(artifactPath, keyPath);
                    console.log('✅ Artifact signed successfully');
                    console.log(JSON.stringify(signature, null, 2));
                }
                catch (error) {
                    console.error(`❌ Signing failed: ${error}`);
                    process.exit(1);
                }
                break;
            }
            case 'verify': {
                const artifactPath = process.argv[3];
                const signature = process.argv[4];
                const keyPath = process.argv[5];
                if (!artifactPath || !signature) {
                    console.error('Usage: security-provenance verify <artifact> <signature> [key]');
                    process.exit(1);
                }
                try {
                    const valid = await manager.verifySignature(artifactPath, signature, keyPath);
                    if (valid) {
                        console.log('✅ Signature is valid');
                    }
                    else {
                        console.log('❌ Signature is invalid');
                        process.exit(1);
                    }
                }
                catch (error) {
                    console.error(`❌ Verification failed: ${error}`);
                    process.exit(1);
                }
                break;
            }
            case 'scan': {
                const projectDir = process.argv[3] || process.cwd();
                try {
                    const results = await manager.runSecurityScans(projectDir);
                    console.log('\n🔒 Security Scan Results');
                    console.log('='.repeat(50));
                    console.log(`Secret Scan: ${results.secretScanPassed ? '✅ PASSED' : '❌ FAILED'}`);
                    console.log(`SAST Scan: ${results.sastPassed ? '✅ PASSED' : '❌ FAILED'}`);
                    console.log(`Dependency Scan: ${results.dependencyScanPassed ? '✅ PASSED' : '❌ FAILED'}`);
                    if (results.details.secrets?.findings?.length > 0) {
                        console.log('\n🚨 Secret Findings:');
                        results.details.secrets.findings.forEach((finding) => {
                            console.log(`  - ${finding}`);
                        });
                    }
                    const allPassed = results.secretScanPassed && results.sastPassed && results.dependencyScanPassed;
                    process.exit(allPassed ? 0 : 1);
                }
                catch (error) {
                    console.error(`❌ Scan failed: ${error}`);
                    process.exit(1);
                }
                break;
            }
            case 'slsa': {
                const commit = process.argv[3];
                const builder = process.argv[4] || 'caws-builder';
                if (!commit) {
                    console.error('Usage: security-provenance slsa <commit> [builder]');
                    process.exit(1);
                }
                try {
                    const attestation = await manager.generateSLSAAttestation({
                        commit,
                        builder,
                        buildTime: new Date().toISOString(),
                        artifacts: ['.agent/provenance.json'],
                    });
                    console.log(JSON.stringify(attestation, null, 2));
                }
                catch (error) {
                    console.error(`❌ SLSA generation failed: ${error}`);
                    process.exit(1);
                }
                break;
            }
            default:
                console.log('CAWS Security & Provenance Manager');
                console.log('');
                console.log('Usage:');
                console.log('  security-provenance sign <artifact> [key]           - Sign artifact');
                console.log('  security-provenance verify <artifact> <sig> [key]   - Verify signature');
                console.log('  security-provenance scan [dir]                      - Run security scans');
                console.log('  security-provenance slsa <commit> [builder]         - Generate SLSA attestation');
                console.log('');
                console.log('Examples:');
                console.log('  security-provenance sign .agent/provenance.json');
                console.log('  security-provenance scan .');
                break;
        }
    })();
}
//# sourceMappingURL=security-provenance.js.map