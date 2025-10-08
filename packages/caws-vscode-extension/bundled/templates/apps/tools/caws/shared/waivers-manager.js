"use strict";
/**
 * CAWS Waivers Manager
 * TypeScript wrapper for waivers management functionality
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
exports.WaiversManager = void 0;
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
const js_yaml_1 = __importDefault(require("js-yaml"));
const base_tool_js_1 = require("./base-tool.js");
class WaiversManager extends base_tool_js_1.CawsBaseTool {
    constructor(waiversPath) {
        super();
        this.waiversPath = waiversPath || path.join(this.getCawsDirectory(), 'waivers.yml');
    }
    /**
     * Load waivers configuration
     */
    loadWaiversConfig() {
        try {
            if (!fs.existsSync(this.waiversPath)) {
                return { waivers: [] };
            }
            const content = fs.readFileSync(this.waiversPath, 'utf8');
            return js_yaml_1.default.load(content);
        }
        catch (error) {
            this.logError(`Error loading waivers config: ${error}`);
            return { waivers: [] };
        }
    }
    /**
     * Save waivers configuration
     */
    saveWaiversConfig(config) {
        try {
            const yamlContent = js_yaml_1.default.dump(config, { indent: 2 });
            fs.writeFileSync(this.waiversPath, yamlContent);
            this.logSuccess(`Waivers configuration saved to ${this.waiversPath}`);
        }
        catch (error) {
            this.logError(`Error saving waivers config: ${error}`);
            throw error;
        }
    }
    /**
     * Get all waivers for a specific gate
     */
    async getWaiversByGate(gate) {
        const config = this.loadWaiversConfig();
        const now = new Date();
        return config.waivers.filter((waiver) => {
            // Check if waiver covers this gate
            if (waiver.gate !== gate) {
                return false;
            }
            // Check if waiver is still active
            const expiresAt = new Date(waiver.expiry);
            if (now > expiresAt) {
                return false;
            }
            return waiver.status === 'active';
        });
    }
    /**
     * Check waiver status
     */
    async checkWaiverStatus(waiverId) {
        const config = this.loadWaiversConfig();
        const now = new Date();
        const waiver = config.waivers.find((w) => w.created_at === waiverId);
        if (!waiver) {
            return { active: false, reason: 'Waiver not found' };
        }
        const expiresAt = new Date(waiver.expiry);
        if (now > expiresAt) {
            return { active: false, waiver, reason: 'Waiver expired' };
        }
        if (waiver.status !== 'active') {
            return { active: false, waiver, reason: `Waiver status: ${waiver.status}` };
        }
        return { active: true, waiver };
    }
    /**
     * Create a new waiver
     */
    async createWaiver(waiver) {
        const config = this.loadWaiversConfig();
        const newWaiver = {
            ...waiver,
            created_at: new Date().toISOString(),
        };
        config.waivers.push(newWaiver);
        this.saveWaiversConfig(config);
    }
    /**
     * Revoke a waiver
     */
    async revokeWaiver(gate, owner) {
        const config = this.loadWaiversConfig();
        const waiver = config.waivers.find((w) => w.gate === gate && w.owner === owner && w.status === 'active');
        if (waiver) {
            waiver.status = 'revoked';
            this.saveWaiversConfig(config);
            this.logSuccess(`Revoked waiver for gate: ${gate}`);
        }
        else {
            this.logWarning(`No active waiver found for gate: ${gate}`);
        }
    }
    /**
     * Cleanup expired waivers
     */
    async cleanupExpiredWaivers() {
        const config = this.loadWaiversConfig();
        const now = new Date();
        const activeWaivers = config.waivers.filter((waiver) => {
            const expiresAt = new Date(waiver.expiry);
            return now <= expiresAt;
        });
        const removedCount = config.waivers.length - activeWaivers.length;
        if (removedCount > 0) {
            config.waivers = activeWaivers;
            this.saveWaiversConfig(config);
            this.logSuccess(`Cleaned up ${removedCount} expired waiver(s)`);
        }
        return removedCount;
    }
    /**
     * List all active waivers
     */
    async listActiveWaivers() {
        const config = this.loadWaiversConfig();
        const now = new Date();
        return config.waivers.filter((waiver) => {
            const expiresAt = new Date(waiver.expiry);
            return now <= expiresAt && waiver.status === 'active';
        });
    }
}
exports.WaiversManager = WaiversManager;
//# sourceMappingURL=waivers-manager.js.map