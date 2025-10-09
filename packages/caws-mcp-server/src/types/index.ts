/**
 * @fileoverview TypeScript type definitions for CAWS MCP Server
 * Comprehensive type definitions for MCP protocol compliance and tool management
 * @author @darianrosebrook
 */

// MCP Protocol Types (JSON-RPC 2.0)
export interface JsonRpcRequest {
  jsonrpc: '2.0';
  method: string;
  params?: any;
  id: string | number | null;
}

export interface JsonRpcNotification extends Omit<JsonRpcRequest, 'id'> {
  id?: never;
}

export interface JsonRpcResponse {
  jsonrpc: '2.0';
  result: any;
  id: string | number | null;
}

export interface JsonRpcError {
  jsonrpc: '2.0';
  error: JsonRpcErrorObject;
  id: string | number | null;
}

export interface JsonRpcErrorObject {
  code: number;
  message: string;
  data?: any;
}

// MCP Server Types
export interface McpServerInfo {
  name: string;
  version: string;
}

export interface McpCapabilities {
  tools?: {
    listChanged?: boolean;
  };
  resources?: {
    listChanged?: boolean;
  };
  logging?: {};
}

export interface InitializeRequest extends JsonRpcRequest {
  method: 'initialize';
  params: {
    protocolVersion: string;
    capabilities: McpCapabilities;
    clientInfo: {
      name: string;
      version: string;
    };
  };
}

export interface InitializeResponse extends JsonRpcResponse {
  result: {
    protocolVersion: string;
    capabilities: McpCapabilities;
    serverInfo: McpServerInfo;
  };
}

export interface InitializedNotification extends JsonRpcNotification {
  method: 'notifications/initialized';
}

// Tool Management Types
export interface Tool {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, any>;
    required?: string[];
  };
}

export interface ListToolsRequest extends JsonRpcRequest {
  method: 'tools/list';
}

export interface ListToolsResponse extends JsonRpcResponse {
  result: {
    tools: Tool[];
  };
}

export interface CallToolRequest extends JsonRpcRequest {
  method: 'tools/call';
  params: {
    name: string;
    arguments: Record<string, any>;
  };
}

export interface CallToolResponse extends JsonRpcResponse {
  result: {
    content: Array<{
      type: 'text';
      text: string;
    }>;
    isError?: boolean;
  };
}

// Resource Management Types
export interface Resource {
  uri: string;
  name: string;
  description: string;
  mimeType: string;
}

export interface ListResourcesRequest extends JsonRpcRequest {
  method: 'resources/list';
}

export interface ListResourcesResponse extends JsonRpcResponse {
  result: {
    resources: Resource[];
  };
}

export interface ReadResourceRequest extends JsonRpcRequest {
  method: 'resources/read';
  params: {
    uri: string;
  };
}

export interface ReadResourceResponse extends JsonRpcResponse {
  result: {
    contents: Array<{
      uri: string;
      mimeType: string;
      text?: string;
      blob?: string;
    }>;
  };
}

// CAWS Tool Types
export type CawsToolName =
  | 'caws_init'
  | 'caws_scaffold'
  | 'caws_validate'
  | 'caws_evaluate'
  | 'caws_iterate'
  | 'caws_status'
  | 'caws_diagnose'
  | 'caws_workflow_guidance'
  | 'caws_quality_monitor'
  | 'caws_progress_update'
  | 'caws_test_analysis'
  | 'caws_provenance'
  | 'caws_hooks'
  | 'caws_waiver_create'
  | 'caws_waivers_list'
  | 'caws_help';

// Tool-specific parameter types
export interface CawsInitArgs {
  projectName?: string;
  template?: string;
  interactive?: boolean;
  workingDirectory?: string;
}

export interface CawsScaffoldArgs {
  minimal?: boolean;
  withCodemods?: boolean;
  withOIDC?: boolean;
  force?: boolean;
  workingDirectory?: string;
}

export interface CawsValidateArgs {
  specFile?: string;
  workingDirectory?: string;
}

export interface CawsEvaluateArgs {
  specFile?: string;
  workingDirectory?: string;
}

export interface CawsIterateArgs {
  currentState: string;
  specFile?: string;
  workingDirectory?: string;
}

export interface CawsStatusArgs {
  specFile?: string;
  workingDirectory?: string;
}

export interface CawsDiagnoseArgs {
  fix?: boolean;
  workingDirectory?: string;
}

export interface CawsWorkflowGuidanceArgs {
  workflowType: 'tdd' | 'refactor' | 'feature';
  currentStep: number;
  context?: Record<string, any>;
}

export interface CawsQualityMonitorArgs {
  action: 'file_saved' | 'code_edited' | 'test_run';
  files: string[];
  context?: Record<string, any>;
}

export interface CawsProgressUpdateArgs {
  criterionId: string;
  status?: 'pending' | 'in_progress' | 'completed';
  testsWritten?: number;
  testsPassing?: number;
  coverage?: number;
  specFile?: string;
  workingDirectory?: string;
}

export interface CawsTestAnalysisArgs {
  subcommand: 'assess-budget' | 'analyze-patterns' | 'find-similar';
  specFile?: string;
  workingDirectory?: string;
}

export interface CawsProvenanceArgs {
  subcommand: 'init' | 'update' | 'show' | 'verify' | 'analyze-ai';
  commit?: string;
  message?: string;
  author?: string;
  quiet?: boolean;
  workingDirectory?: string;
}

export interface CawsHooksArgs {
  subcommand?: 'install' | 'remove' | 'status';
  force?: boolean;
  backup?: boolean;
  workingDirectory?: string;
}

export interface CawsWaiverCreateArgs {
  title: string;
  reason:
    | 'emergency_hotfix'
    | 'legacy_integration'
    | 'experimental_feature'
    | 'third_party_constraint'
    | 'performance_critical'
    | 'security_patch'
    | 'infrastructure_limitation'
    | 'other';
  description: string;
  gates: string[];
  expiresAt: string;
  approvedBy: string;
  impactLevel: 'low' | 'medium' | 'high' | 'critical';
  mitigationPlan: string;
  workingDirectory?: string;
}

export interface CawsWaiversListArgs {
  status?: 'active' | 'expired' | 'revoked' | 'all';
  workingDirectory?: string;
}

export interface CawsHelpArgs {
  tool?: string;
  category?:
    | 'project-management'
    | 'validation'
    | 'quality-gates'
    | 'development'
    | 'testing'
    | 'compliance';
}

// Tool result types
export interface ToolExecutionResult {
  success: boolean;
  data?: any;
  error?: string;
  executionTime?: number;
  metadata?: Record<string, any>;
}

// Working Spec Types (for resources)
export interface WorkingSpecResource {
  uri: string;
  name: string;
  description: string;
  mimeType: 'application/yaml';
}

// Server configuration
export interface McpServerConfig {
  name: string;
  version: string;
  toolsPath?: string;
  resourcesPath?: string;
  logLevel?: 'error' | 'warn' | 'info' | 'debug';
}

// Error types
export interface McpError extends Error {
  code: number;
  data?: any;
}

// Utility types
export type ToolArgsMap = {
  caws_init: CawsInitArgs;
  caws_scaffold: CawsScaffoldArgs;
  caws_validate: CawsValidateArgs;
  caws_evaluate: CawsEvaluateArgs;
  caws_iterate: CawsIterateArgs;
  caws_status: CawsStatusArgs;
  caws_diagnose: CawsDiagnoseArgs;
  caws_workflow_guidance: CawsWorkflowGuidanceArgs;
  caws_quality_monitor: CawsQualityMonitorArgs;
  caws_progress_update: CawsProgressUpdateArgs;
  caws_test_analysis: CawsTestAnalysisArgs;
  caws_provenance: CawsProvenanceArgs;
  caws_hooks: CawsHooksArgs;
  caws_waiver_create: CawsWaiverCreateArgs;
  caws_waivers_list: CawsWaiversListArgs;
  caws_help: CawsHelpArgs;
};

export type ToolArgs<T extends CawsToolName> = ToolArgsMap[T];

// Type guards
export function isJsonRpcRequest(obj: any): obj is JsonRpcRequest {
  return obj && obj.jsonrpc === '2.0' && typeof obj.method === 'string' && 'id' in obj;
}

export function isJsonRpcNotification(obj: any): obj is JsonRpcNotification {
  return obj && obj.jsonrpc === '2.0' && typeof obj.method === 'string' && !('id' in obj);
}

export function isInitializeRequest(obj: any): obj is InitializeRequest {
  return isJsonRpcRequest(obj) && obj.method === 'initialize';
}

export function isListToolsRequest(obj: any): obj is ListToolsRequest {
  return isJsonRpcRequest(obj) && obj.method === 'tools/list';
}

export function isCallToolRequest(obj: any): obj is CallToolRequest {
  return isJsonRpcRequest(obj) && obj.method === 'tools/call';
}

export function isListResourcesRequest(obj: any): obj is ListResourcesRequest {
  return isJsonRpcRequest(obj) && obj.method === 'resources/list';
}

export function isReadResourceRequest(obj: any): obj is ReadResourceRequest {
  return isJsonRpcRequest(obj) && obj.method === 'resources/read';
}
