"use strict";
/**
 * CAWS Validator
 * Shared validation utilities for working specs, provenance, and other data
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
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.CawsValidator = void 0;
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
const ajv_1 = __importDefault(require("ajv"));
const js_yaml_1 = __importDefault(require("js-yaml"));
const base_tool_js_1 = require("./base-tool.js");
class CawsValidator extends base_tool_js_1.CawsBaseTool {
    constructor() {
        super();
        this.ajv = new ajv_1.default({
            allErrors: true,
            strict: false,
            allowUnionTypes: true,
        });
    }
    /**
     * Validate a working spec file
     */
    validateWorkingSpec(specPath) {
        try {
            // Read the working spec file
            const specContent = fs.readFileSync(specPath, 'utf-8');
            let spec;
            // Try to parse as YAML first, then JSON
            try {
                spec = js_yaml_1.default.load(specContent);
            }
            catch {
                try {
                    spec = JSON.parse(specContent);
                }
                catch {
                    return {
                        passed: false,
                        score: 0,
                        details: {},
                        errors: ['Invalid JSON/YAML format in working spec'],
                    };
                }
            }
            // Load schema if available
            const schemaPath = path.join(this.getCawsDirectory(), 'schemas/working-spec.schema.json');
            if (fs.existsSync(schemaPath)) {
                const schemaContent = fs.readFileSync(schemaPath, 'utf-8');
                const schema = JSON.parse(schemaContent);
                // Validate against schema
                const validate = this.ajv.compile(schema);
                const valid = validate(spec);
                if (!valid) {
                    return {
                        passed: false,
                        errors: validate.errors?.map((err) => `${err.instancePath}: ${err.message}`) || [],
                        score: 0,
                        details: {},
                    };
                }
            }
            // Additional business logic validations
            const warnings = [];
            // Check risk tier thresholds
            if (spec.risk_tier === 1 && spec.acceptance?.length < 5) {
                warnings.push('Tier 1 specs should have at least 5 acceptance criteria');
            }
            if (spec.risk_tier === 2 && spec.contracts?.length === 0) {
                warnings.push('Tier 2 specs should have contract definitions');
            }
            // Check for required non-functional requirements
            const requiredNonFunctional = ['perf'];
            const missingNonFunctional = requiredNonFunctional.filter((req) => !spec.non_functional?.[req]);
            if (missingNonFunctional.length > 0) {
                warnings.push(`Missing non-functional requirements: ${missingNonFunctional.join(', ')}`);
            }
            return {
                passed: true,
                score: 1,
                details: {},
                warnings: warnings.length > 0 ? warnings : undefined,
            };
        }
        catch (error) {
            return {
                passed: false,
                score: 0,
                details: {},
                errors: [`Validation failed: ${error}`],
            };
        }
    }
    /**
     * Validate a provenance file
     */
    validateProvenance(provenancePath) {
        try {
            const provenanceContent = fs.readFileSync(provenancePath, 'utf-8');
            const provenance = JSON.parse(provenanceContent);
            // Basic structure validation
            const requiredFields = ['agent', 'model', 'commit', 'artifacts', 'results', 'approvals'];
            const missingFields = requiredFields.filter((field) => !provenance[field]);
            if (missingFields.length > 0) {
                return {
                    passed: false,
                    score: 0,
                    details: {},
                    errors: [`Missing required fields: ${missingFields.join(', ')}`],
                };
            }
            // Validate results structure
            const requiredResults = ['coverage_branch', 'mutation_score', 'tests_passed'];
            const missingResults = requiredResults.filter((field) => typeof provenance.results[field] !== 'number');
            if (missingResults.length > 0) {
                return {
                    passed: false,
                    score: 0,
                    details: {},
                    errors: [`Missing numeric results: ${missingResults.join(', ')}`],
                };
            }
            return {
                passed: true,
                score: 1,
                details: {},
            };
        }
        catch (error) {
            return {
                passed: false,
                score: 0,
                details: {},
                errors: [`Provenance validation failed: ${error}`],
            };
        }
    }
    /**
     * Validate a JSON file against a schema
     */
    validateJsonAgainstSchema(jsonPath, schemaPath) {
        try {
            // Read JSON file
            const jsonContent = fs.readFileSync(jsonPath, 'utf-8');
            const jsonData = JSON.parse(jsonContent);
            // Read schema file
            const schemaContent = fs.readFileSync(schemaPath, 'utf-8');
            const schema = JSON.parse(schemaContent);
            // Validate
            const validate = this.ajv.compile(schema);
            const valid = validate(jsonData);
            if (!valid) {
                return {
                    passed: false,
                    score: 0,
                    details: {},
                    errors: validate.errors?.map((err) => `${err.instancePath}: ${err.message}`) || [],
                };
            }
            return {
                passed: true,
                score: 1,
                details: {},
            };
        }
        catch (error) {
            return {
                passed: false,
                score: 0,
                details: {},
                errors: [`Schema validation failed: ${error}`],
            };
        }
    }
    /**
     * Validate a YAML file against a schema
     */
    validateYamlAgainstSchema(yamlPath, schemaPath) {
        try {
            // Read YAML file
            const yamlContent = fs.readFileSync(yamlPath, 'utf-8');
            const yamlData = js_yaml_1.default.load(yamlContent);
            // Read schema file
            const schemaContent = fs.readFileSync(schemaPath, 'utf-8');
            const schema = JSON.parse(schemaContent);
            // Validate
            const validate = this.ajv.compile(schema);
            const valid = validate(yamlData);
            if (!valid) {
                return {
                    passed: false,
                    score: 0,
                    details: {},
                    errors: validate.errors?.map((err) => `${err.instancePath}: ${err.message}`) || [],
                };
            }
            return {
                passed: true,
                score: 1,
                details: {},
            };
        }
        catch (error) {
            return {
                passed: false,
                score: 0,
                details: {},
                errors: [`YAML schema validation failed: ${error}`],
            };
        }
    }
    /**
     * Validate file exists and is readable
     */
    validateFileExists(filePath) {
        try {
            if (!fs.existsSync(filePath)) {
                return {
                    passed: false,
                    score: 0,
                    details: {},
                    errors: [`File not found: ${filePath}`],
                };
            }
            // Try to read the file
            fs.accessSync(filePath, fs.constants.R_OK);
            return {
                passed: true,
                score: 1,
                details: {},
            };
        }
        catch {
            return {
                passed: false,
                score: 0,
                details: {},
                errors: [`File not readable: ${filePath}`],
            };
        }
    }
    /**
     * Validate directory exists and is writable
     */
    validateDirectoryExists(dirPath) {
        try {
            if (!fs.existsSync(dirPath)) {
                return {
                    passed: false,
                    score: 0,
                    details: {},
                    errors: [`Directory not found: ${dirPath}`],
                };
            }
            // Try to write to the directory
            fs.accessSync(dirPath, fs.constants.W_OK);
            return {
                passed: true,
                score: 1,
                details: {},
            };
        }
        catch {
            return {
                passed: false,
                score: 0,
                details: {},
                errors: [`Directory not writable: ${dirPath}`],
            };
        }
    }
}
exports.CawsValidator = CawsValidator;
//# sourceMappingURL=validator.js.map