"use strict";
/**
 * CAWS Base Tool
 * Shared functionality for all CAWS tools including file operations,
 * configuration management, and common utilities
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
exports.CawsBaseTool = void 0;
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
const url_1 = require("url");
class CawsBaseTool {
    constructor() {
        this.__dirname = path.dirname((0, url_1.fileURLToPath)(import.meta.url));
        this.workingDirectory = process.cwd();
        this.cawsDirectory = path.join(this.workingDirectory, '.caws');
    }
    /**
     * Get the CAWS configuration directory
     */
    getCawsDirectory() {
        return this.cawsDirectory;
    }
    /**
     * Get the working directory
     */
    getWorkingDirectory() {
        return this.workingDirectory;
    }
    /**
     * Safely read a JSON file with error handling
     */
    readJsonFile(filePath) {
        try {
            if (!fs.existsSync(filePath)) {
                return null;
            }
            const content = fs.readFileSync(filePath, 'utf-8');
            return JSON.parse(content);
        }
        catch (error) {
            this.logError(`Failed to read JSON file ${filePath}: ${error}`);
            return null;
        }
    }
    /**
     * Safely write a JSON file with backup option
     */
    writeJsonFile(filePath, data, options = {}) {
        try {
            const { createDir = true, backup = false } = options;
            // Create directory if needed
            if (createDir) {
                const dir = path.dirname(filePath);
                if (!fs.existsSync(dir)) {
                    fs.mkdirSync(dir, { recursive: true });
                }
            }
            // Create backup if requested
            if (backup && fs.existsSync(filePath)) {
                const backupPath = `${filePath}.backup`;
                fs.copyFileSync(filePath, backupPath);
            }
            // Write the file
            fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf-8');
            return true;
        }
        catch (error) {
            this.logError(`Failed to write JSON file ${filePath}: ${error}`);
            return false;
        }
    }
    /**
     * Safely read a YAML file
     */
    async readYamlFile(filePath) {
        try {
            if (!fs.existsSync(filePath)) {
                return null;
            }
            const content = fs.readFileSync(filePath, 'utf-8');
            const yaml = await Promise.resolve().then(() => __importStar(require('js-yaml')));
            return yaml.load(content);
        }
        catch (error) {
            this.logError(`Failed to read YAML file ${error}`);
            return null;
        }
    }
    /**
     * Check if a path exists
     */
    pathExists(filePath) {
        return fs.existsSync(filePath);
    }
    /**
     * Create directory if it doesn't exist
     */
    ensureDirectoryExists(dirPath) {
        try {
            if (!fs.existsSync(dirPath)) {
                fs.mkdirSync(dirPath, { recursive: true });
            }
            return true;
        }
        catch (error) {
            this.logError(`Failed to create directory ${dirPath}: ${error}`);
            return false;
        }
    }
    /**
     * Get relative path from working directory
     */
    getRelativePath(absolutePath) {
        return path.relative(this.workingDirectory, absolutePath);
    }
    /**
     * Get absolute path from relative path
     */
    getAbsolutePath(relativePath) {
        return path.resolve(this.workingDirectory, relativePath);
    }
    /**
     * Load tier policy configuration
     */
    loadTierPolicy() {
        const policyPath = path.join(this.cawsDirectory, 'policy', 'tier-policy.json');
        return this.readJsonFile(policyPath);
    }
    /**
     * Load CAWS configuration
     */
    loadCawsConfig() {
        const configPath = path.join(this.cawsDirectory, 'config.json');
        return this.readJsonFile(configPath);
    }
    /**
     * Log an error message
     */
    logError(message) {
        console.error(`❌ ${message}`);
    }
    /**
     * Log a warning message
     */
    logWarning(message) {
        console.warn(`⚠️  ${message}`);
    }
    /**
     * Log an info message
     */
    logInfo(message) {
        console.log(`ℹ️  ${message}`);
    }
    /**
     * Log a success message
     */
    logSuccess(message) {
        console.log(`✅ ${message}`);
    }
    /**
     * Create a standardized result object
     */
    createResult(success, message, data, errors, warnings) {
        return {
            success,
            message,
            data,
            errors: errors || [],
            warnings: warnings || [],
        };
    }
    /**
     * Validate required environment variables
     */
    validateEnvironment(variables) {
        const missing = variables.filter((varName) => !process.env[varName]);
        if (missing.length > 0) {
            this.logError(`Missing required environment variables: ${missing.join(', ')}`);
            return false;
        }
        return true;
    }
    /**
     * Get environment variable with fallback
     */
    getEnvVar(name, fallback = '') {
        return process.env[name] || fallback;
    }
    /**
     * Parse command line arguments
     */
    parseArgs(expectedArgs) {
        const args = process.argv.slice(2);
        const result = {};
        for (let i = 0; i < args.length; i++) {
            if (i < expectedArgs.length) {
                result[expectedArgs[i]] = args[i];
            }
        }
        return result;
    }
    /**
     * Show usage information
     */
    showUsage(usage, description) {
        console.log(`Usage: ${usage}`);
        console.log(description);
    }
    /**
     * Exit with appropriate code
     */
    exitWithResult(result) {
        if (result.success) {
            this.logSuccess(result.message);
            process.exit(0);
        }
        else {
            this.logError(result.message);
            if (result.errors && result.errors.length > 0) {
                result.errors.forEach((error) => this.logError(error));
            }
            process.exit(1);
        }
    }
}
exports.CawsBaseTool = CawsBaseTool;
//# sourceMappingURL=base-tool.js.map