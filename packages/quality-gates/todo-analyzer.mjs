#!/usr/bin/env node

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/**
 * Hidden TODO Pattern Analyzer — Recall-boosted drop-in (v2.2)
 *
 * Automatically detects and reports hidden incomplete implementations including:
 * - Hidden TODO comments with sophisticated pattern matching
 * - Placeholder implementations and stub code
 * - Temporary solutions and workarounds
 * - Hardcoded values and constants
 * - Future improvement markers
 *
 * Key improvements from v2.0:
 *  - Much broader matching (optional code scanning, not just comments)
 *  - Direct keyword pattern matching (fast-path detection)
 *  - Pattern hits bypass heuristic confidence gate
 *  - Safer excludes (segment-aware) + --no-excludes flag
 *  - Domain-aware exclusions for TODO system types
 *  - Grouped block detection for multi-line TODOs
 *  - Enhanced reporting with markdown format support
 */

/**
 * Quality Issue class for reporting findings
 */
class QualityIssue {
  constructor(
    file_path,
    line_number,
    severity,
    rule_id,
    message,
    confidence = 1.0,
    suggested_fix = '',
    end_line_number = null
  ) {
    this.file_path = file_path;
    this.line_number = line_number;
    this.end_line_number = end_line_number || line_number;
    this.severity = severity;
    this.rule_id = rule_id;
    this.message = message;
    this.confidence = confidence;
    this.suggested_fix = suggested_fix;
  }
}

/**
 * Hidden TODO Analyzer class
 */
class HiddenTodoAnalyzer {
  constructor(projectRoot = '.', opts = {}) {
    this.projectRoot = path.resolve(projectRoot);
    this.commentsOnly = opts.commentsOnly ?? false; // broaden by default
    this.noExcludes = opts.noExcludes ?? false;

    // Broad keyword net (fast-path detection bypassing confidence gates)
    this.quickKeyword =
      /(TODO|in a real simpl|stub|mock|placeholder|disabl|for now)(?!(_|\.|anal|\sanal|s))/i;

    // Define sophisticated hidden TODO patterns (fixed regex escaping)
    this.hiddenTodoPatterns = [
      // Incomplete implementation patterns
      /\bnot\s+yet\s+implemented\b/i,
      /\bmissing\s+implementation\b/i,
      /\bincomplete\s+implementation\b/i,
      /\bpartial\s+implementation\b/i,
      /\bunimplemented\b/i,
      /\bnot\s+done\b/i,
      /\bpending\s+implementation\b/i,
      /\bto\s+be\s+implemented\b/i,
      /\bwill\s+be\s+implemented\b/i,
      /\bcoming\s+soon\b/i,
      /\bwork\s+in\s+progress\b/i,
      /\bwip\b/i,

      // Placeholder code patterns
      /\bplaceholder\s+code\b/i,
      /\bplaceholder\s+implementation\b/i,
      /\bstub\s+implementation\b/i,
      /\bdummy\s+implementation\b/i,
      /\bfake\s+implementation\b/i,
      /\bsimplified\s+.*?\s+implementation\b/i,
      /\bfor\s+now\b.*?(just|simply|only)\b/i,
      /\btemporary\s+implementation\b/i,
      /\bmock\s+implementation\b/i,
      /\bsample\s+implementation\b/i,

      // Temporary solution patterns
      /\btemporary\s+solution\b/i,
      /\btemporary\s+fix\b/i,
      /\bquick\s+fix\b/i,
      /\bworkaround\b/i,
      /\bhack\b.*?(fix|solution)\b/i,
      /\bband-aid\s+solution\b/i,
      /\bkludge\b/i,
      /\bcrude\s+solution\b/i,
      /\brough\s+implementation\b/i,

      // Hardcoded value patterns
      /\bhardcoded\s+value\b/i,
      /\bmagic\s+number\b/i,
      /\bmagic\s+string\b/i,
      /\bconstant\s+value\b.*?(replace|change|make\s+configurable)\b/i,
      /\bfixed\s+value\b/i,
      /\bstatic\s+value\b/i,
      /\bhardcoded\s+constant\b/i,

      // Future improvement patterns
      /\bin\s+production\b.*?(implement|add|fix)\b/i,
      /\bin\s+a\s+real\s+implementation\b/i,
      /\beventually\b.*?(implement|add|fix)\b/i,
      /\bshould\s+be\b.*?(implemented|added|fixed)\b/i,
      /\bwould\s+be\b.*?(implemented|added|fixed)\b/i,
      /\bmight\s+be\b.*?(implemented|added|fixed)\b/i,
      /\bcould\s+be\b.*?(implemented|added|fixed)\b/i,
      /\blater\b.*?(implement|add|fix)\b/i,
      /\bsomeday\b.*?(implement|add|fix)\b/i,
    ];

    // TODO system exclusion patterns (from Python version - prevents false positives)
    this.todoSystemExclusionPatterns = [
      /\btodo\s+template\s+system\b/i,
      /\btodo\s+template\b/i,
      /\btodo\s+instance\b/i,
      /\btodo\s+step\b/i,
      /\btodo\s+integration\b/i,
      /\btodo\s+system\b/i,
      /\btodotemplate\b/i,
      /\btodoinstance\b/i,
      /\btodostep\b/i,
      /\btodointegration\b/i,
      /\btodotemplatesystem\b/i,
      /\btodoprogress\b/i,
      /\btododependency\b/i,
      /\btodoqualityenforcer\b/i,
      /\btodoworkflowhooks\b/i,
      /\btodostatus\b/i,
      /\btodopriority\b/i,
      /\btodosteptype\b/i,
      // Rust doc comment patterns when mentioning TODO system types
      /^\s*\/\/[!]\/.*\btodo\b.*(template|instance|step|integration|system)\b/i,
      /^\s*\/\/\/.*\btodo\b.*(template|instance|step|integration|system)\b/i,
    ];

    // Language-specific code stub detection
    this.codeStubPatterns = {
      javascript: {
        functionStub: /^\s*function\s+\w+\([^)]*\)\s*\{\s*\}\s*$/g,
        throwNotImpl:
          /throw\s+new\s+Error\(\s*["'`](TODO|Not\s+Implemented|Not\s+Yet\s+Implemented)["'`]\)/i,
        returnTodo: /return\s+(null|undefined);\s*\/\/\s*(TODO|PLACEHOLDER)/i,
        consoleLogStub: /console\.log.*;\s*\/\/\s*(TODO|PLACEHOLDER|STUB)/i,
        emptyFunction: /function\s+\w+\(.*\)\s*\{\s*\}\s*$/g,
        returnMock: /return\s+\{.*?\};\s*\/\/\s*(MOCK|FAKE|DUMMY)/i,
      },
      typescript: {
        functionStub: /^\s*(async\s+)?function\s+\w+\([^)]*\)\s*\{\s*\}\s*$/g,
        throwNotImpl:
          /throw\s+new\s+Error\(\s*["'`](TODO|Not\s+Implemented|Not\s+Yet\s+Implemented)["'`]\)/i,
        returnTodo: /return\s+(null|undefined);\s*\/\/\s*(TODO|PLACEHOLDER)/i,
        consoleLogStub: /console\.log.*;\s*\/\/\s*(TODO|PLACEHOLDER|STUB)/i,
        emptyFunction: /(async\s+)?function\s+\w+\(.*\)\s*\{\s*\}\s*$/g,
        returnMock: /return\s+\{.*?\};\s*\/\/\s*(MOCK|FAKE|DUMMY)/i,
      },
      python: {
        functionStub: /^\s*def\s+\w+\(.*\):/gm,
        passStmt: /^\s*pass\s*$/gm,
        ellipsisStmt: /^\s*\.\.\.\s*$/gm,
        raiseNotImpl: /^\s*raise\s+NotImplementedError/gm,
        returnNone: /^\s*return\s+None\s*#\s*(TODO|PLACEHOLDER)/gm,
        printStub: /^\s*print\(.*\)\s*#\s*(TODO|PLACEHOLDER|STUB)/gm,
        emptyFunction: /^\s*def\s+\w+\(.*\):\s*pass\s*$/gm,
      },
      rust: {
        functionStub:
          /^\s*(async\s+)?fn\s+\w+\([^)]*\)(\s*->\s*[^ \t{]+)?\s*\{\s*\}\s*$/gm,
        todoMacro: /^\s*todo!\(\)/gm,
        unimplementedMacro: /^\s*unimplemented!\(\)/gm,
        panicStub: /^\s*panic!\(["']TODO["']\)/gm,
        returnDefault:
          /^\s*Default::default\(\);?\s*\/\/\s*(TODO|PLACEHOLDER)/gm,
      },
      go: {
        functionStub: /^\s*func\s+\w+\([^)]*\)\s*\w*\s*\{\s*\}\s*$/gm,
        panicStub: /^\s*panic\(["']TODO["']\)/gm,
        returnNil: /^\s*return\s+nil;?\s*\/\/\s*(TODO|PLACEHOLDER)/gm,
      },
      java: {
        functionStub:
          /^\s*(public|private|protected)?\s*\w+\s+\w+\(.*\)\s*\{\s*\}\s*$/gm,
        throwTodo: /^\s*throw\s+new\s+\w*Exception\(["']TODO/i,
        returnNull: /^\s*return\s+null;?\s*\/\/\s*(TODO|PLACEHOLDER)/gm,
      },
    };

    // Excluded directories (using Set for O(1) lookups)
    this.excludedDirNames = new Set([
      'node_modules',
      '.git',
      'target',
      'dist',
      'build',
      '__pycache__',
      '.venv',
      '.stryker-tmp',
      'site-packages',
      '.dist-info',
      '.whl',
      'venv',
      'env',
      'virtualenv',
      'conda',
      'anaconda',
      '.build',
      'checkouts',
      'Tests',
      'tests',
      'examples',
      'models',
      'vocabs',
      'merges',
    ]);

    // Excluded file patterns
    this.excludedFileSubstrings = [
      '.venv',
      'site-packages',
      '.dist-info',
      '.whl',
      '.build',
      'checkouts',
      'Tests',
      'tests',
      'examples',
      'models',
      'vocabs',
      'merges',
      'LICENSE.txt',
      'bert-vocab.txt',
      'bench-all-gg.txt',
      'CMakeLists.txt',
    ];
  }

  /**
   * Analyze the entire project for hidden TODOs
   */
  async analyzeProject(showProgress = true, scopedFiles = null, engineeringSuggestions = false) {
    const allIssues = [];
    const filesToAnalyze =
      scopedFiles && scopedFiles.length > 0
        ? scopedFiles
        : this.findFilesToAnalyze();

    if (showProgress && filesToAnalyze.length > 0) {
      console.error(`Scanning ${filesToAnalyze.length} files for hidden TODOs...`);
    }

    // Process files in parallel batches for better performance
    const batchSize = 12; // Increased from 8 for better performance
    let processedCount = 0;

    for (let i = 0; i < filesToAnalyze.length; i += batchSize) {
      const batch = filesToAnalyze.slice(i, i + batchSize);
      const results = await Promise.allSettled(
        batch.map((f) => this.analyzeFile(f, engineeringSuggestions))
      );
      for (const r of results) {
        if (r.status === 'fulfilled') {
          allIssues.push(...r.value);
        } else {
          console.error(`Error analyzing file: ${r.reason}`);
        }
      }
      processedCount += batch.length;

      if (showProgress) {
        const pct = ((processedCount / filesToAnalyze.length) * 100).toFixed(1);
        console.error(
          `Progress: ${processedCount}/${filesToAnalyze.length} (${pct}%) – ${allIssues.length} issues`
        );
      }
    }

    if (showProgress) {
      console.error(
        `Analysis complete: ${allIssues.length} total issues in ${filesToAnalyze.length} files`
      );
    }

    return allIssues;
  }

  /**
   * Analyze only git staged files for hidden TODOs
   */
  async analyzeStagedFiles(showProgress = true, engineeringSuggestions = false) {
    try {
      const { spawn } = await import('child_process');
      const gitDiff = spawn('git', ['diff', '--cached', '--name-only'], {
        cwd: this.projectRoot,
      });
      let stdout = '';
      gitDiff.stdout.on('data', (d) => (stdout += d.toString()));
      await new Promise((resolve, reject) => {
        gitDiff.on('close', (code) =>
          code === 0 ? resolve() : reject(new Error(`git diff failed: ${code}`))
        );
        gitDiff.on('error', reject);
      });
      const files = stdout.trim().split('\n').filter(Boolean);
      const analyzable = files.filter(
        (f) =>
          fs.existsSync(path.join(this.projectRoot, f)) &&
          this.shouldAnalyzeFile(f)
      );
      return await this.analyzeProject(
        showProgress,
        analyzable,
        engineeringSuggestions
      );
    } catch (e) {
      console.error(`Error analyzing staged files: ${e.message}`);
      return [];
    }
  }

  /**
   * Check if a file should be analyzed based on its extension
   */
  shouldAnalyzeFile(filePath) {
    const ext = path.extname(filePath).toLowerCase();
    return [
      '.js',
      '.jsx',
      '.ts',
      '.tsx',
      '.py',
      '.rs',
      '.go',
      '.java',
      '.cpp',
      '.c',
      '.h',
      '.hpp',
    ].includes(ext);
  }

  /**
   * Find all files that should be analyzed (improved with Set-based exclusions)
   */
  findFilesToAnalyze() {
    const out = [];
    const stack = [this.projectRoot];

    while (stack.length) {
      const dir = stack.pop();
      let items = [];
      try {
        items = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const ent of items) {
        const full = path.join(dir, ent.name);
        if (ent.isDirectory()) {
          if (!this.noExcludes && this.shouldSkipDir(full)) continue;
          stack.push(full);
        } else if (ent.isFile()) {
          if (!this.noExcludes && this.shouldSkipFile(full)) continue;
          if (this.shouldAnalyzeFile(full)) out.push(full);
        }
      }
    }
    return out;
  }

  /**
   * Get path segments for segment-aware matching
   */
  pathSegments(p) {
    return p.split(path.sep).filter(Boolean);
  }

  /**
   * Check if directory should be skipped (segment-aware)
   */
  shouldSkipDir(fullPath) {
    const segs = this.pathSegments(fullPath);
    return segs.some((s) => this.excludedDirNames.has(s));
  }

  /**
   * Check if file should be skipped
   */
  shouldSkipFile(fullPath) {
    return this.excludedFileSubstrings.some((substr) =>
      fullPath.includes(substr)
    );
  }

  /**
   * Check if file is domain-specific (TODO system, mock, stub, template, etc.)
   */
  isDomainSpecificFile(filePath) {
    const relativePath = path
      .relative(this.projectRoot, filePath)
      .toLowerCase();

    // Domain-specific files that should be excluded from certain rules
    const domainPatterns = [
      // TODO management files
      /\/todo_[^/]*\.rs$/,
      /\/todo_[^/]*\.ts$/,
      /\/todo_[^/]*\.js$/,

      // Mock files
      /\/mock[^/]*\.rs$/,
      /\/mock[^/]*\.ts$/,
      /\/mock[^/]*\.js$/,

      // Stub files
      /\/stub[^/]*\.rs$/,
      /\/stub[^/]*\.ts$/,
      /\/stub[^/]*\.js$/,

      // Template files
      /\/template[^/]*\.rs$/,
      /\/template[^/]*\.ts$/,
      /\/template[^/]*\.js$/,

      // Test files (already somewhat excluded, but being explicit)
      /\/test[^/]*\.rs$/,
      /\/test[^/]*\.ts$/,
      /\/test[^/]*\.js$/,

      // Example/demo files
      /\/example[^/]*\.rs$/,
      /\/example[^/]*\.ts$/,
      /\/example[^/]*\.js$/,
      /\/demo[^/]*\.rs$/,
      /\/demo[^/]*\.ts$/,
      /\/demo[^/]*\.js$/,
    ];

    return domainPatterns.some((pattern) => pattern.test(relativePath));
  }

  /**
   * Check if rule should be skipped for domain-specific files
   */
  shouldSkipRuleForDomain(filePath, ruleId) {
    if (!this.isDomainSpecificFile(filePath)) {
      return false; // Not a domain file, apply all rules
    }

    const relativePath = path
      .relative(this.projectRoot, filePath)
      .toLowerCase();

    // Define which rules to skip for which domains
    const domainRuleExclusions = {
      // TODO domain files: skip BROAD_KEYWORD for domain-appropriate terms
      todo: ['BROAD_KEYWORD'],
      // Mock domain files: skip BROAD_KEYWORD for mock-related terms
      mock: ['BROAD_KEYWORD'],
      // Stub domain files: skip BROAD_KEYWORD for stub-related terms
      stub: ['BROAD_KEYWORD'],
      // Template domain files: skip BROAD_KEYWORD for template-related terms
      template: ['BROAD_KEYWORD'],
      // Test files: skip BROAD_KEYWORD for test-related terms
      test: ['BROAD_KEYWORD'],
      // Example files: skip BROAD_KEYWORD for example-related terms
      example: ['BROAD_KEYWORD'],
      demo: ['BROAD_KEYWORD'],
    };

    // Check which domain this file belongs to
    for (const [domain, rulesToSkip] of Object.entries(domainRuleExclusions)) {
      if (
        relativePath.includes(`/${domain}`) ||
        relativePath.includes(`_${domain}`)
      ) {
        return rulesToSkip.includes(ruleId);
      }
    }

    return false; // Default: don't skip any rules
  }

  /**
   * Check if line matches TODO system exclusion patterns (from Python version)
   */
  isTodoSystemDocumentation(line) {
    return this.todoSystemExclusionPatterns.some((pattern) => pattern.test(line));
  }

  /**
   * Analyze TODO comment for engineering-grade format suggestions
   */
  analyzeEngineeringSuggestions(comment, filePath) {
    const normalized = comment.trim();
    if (!normalized) {
      return { needsEngineeringFormat: false };
    }

    // Only analyze explicit TODOs
    if (!/\b(TODO|FIXME|HACK)\b/i.test(normalized)) {
      return { needsEngineeringFormat: false };
    }

    const suggestions = {
      needsEngineeringFormat: false,
      suggestions: '',
      templateSuggestion: '',
      missingElements: [],
      suggestedTier: 'Medium',
      priority: 'Medium',
    };

    // Check if already has engineering-grade structure
    const hasStructure = this.checkEngineeringGradeStructure(normalized);

    if (!hasStructure) {
      suggestions.needsEngineeringFormat = true;

      // Check what's missing
      const missing = this.identifyMissingElements(normalized);
      suggestions.missingElements = missing;

      // Generate suggestions
      suggestions.suggestions = this.generateSuggestionsText(missing);
      suggestions.templateSuggestion = this.generateTemplateSuggestion(normalized, missing);
    }

    return suggestions;
  }

  /**
   * Check if comment already has engineering-grade structure
   */
  checkEngineeringGradeStructure(comment) {
    const patterns = {
      completionChecklist: [
        /\bCOMPLETION CHECKLIST\b/i,
        /\bchecklist\b.*?:/i,
        /\[ \].*\b(implement|add|fix|complete)\b/i,
      ],
      acceptanceCriteria: [
        /\bACCEPTANCE CRITERIA\b/i,
        /\bacceptance\b.*?:/i,
        /\bwhen\b.*?\bthen\b/i,
      ],
      dependencies: [
        /\bDEPENDENCIES\b/i,
        /\bdepends on\b/i,
        /\brequires\b.*?(system|feature|module)/i,
      ],
      governance: [/\bGOVERNANCE\b/i, /\bCAWS Tier\b/i, /\bPRIORITY\b/i, /\bBLOCKING\b/i],
    };

    for (const [category, categoryPatterns] of Object.entries(patterns)) {
      for (const pattern of categoryPatterns) {
        if (pattern.test(comment)) {
          return true;
        }
      }
    }

    return false;
  }

  /**
   * Identify missing engineering-grade elements
   */
  identifyMissingElements(comment) {
    const missing = [];

    if (
      !/\bCOMPLETION CHECKLIST\b/i.test(comment) &&
      !/\bchecklist\b.*?:/i.test(comment) &&
      !/\[ \].*\b(implement|add|fix|complete)\b/i.test(comment)
    ) {
      missing.push('completion_checklist');
    }

    if (
      !/\bACCEPTANCE CRITERIA\b/i.test(comment) &&
      !/\bacceptance\b.*?:/i.test(comment) &&
      !/\bwhen\b.*?\bthen\b/i.test(comment)
    ) {
      missing.push('acceptance_criteria');
    }

    if (
      !/\bDEPENDENCIES\b/i.test(comment) &&
      !/\bdepends on\b/i.test(comment) &&
      !/\brequires\b.*?(system|feature|module)/i.test(comment)
    ) {
      missing.push('dependencies');
    }

    if (
      !/\bGOVERNANCE\b/i.test(comment) &&
      !/\bCAWS Tier\b/i.test(comment) &&
      !/\bPRIORITY\b/i.test(comment)
    ) {
      missing.push('governance');
    }

    return missing;
  }

  /**
   * Generate human-readable suggestions text
   */
  generateSuggestionsText(missingElements) {
    const suggestions = [];

    if (missingElements.includes('completion_checklist')) {
      suggestions.push('• Add COMPLETION CHECKLIST with specific, measurable tasks');
    }

    if (missingElements.includes('acceptance_criteria')) {
      suggestions.push('• Add ACCEPTANCE CRITERIA defining done state (Given/When/Then)');
    }

    if (missingElements.includes('dependencies')) {
      suggestions.push('• Add DEPENDENCIES section listing required systems/features');
    }

    if (missingElements.includes('governance')) {
      suggestions.push('• Add GOVERNANCE section with CAWS Tier, priority, blocking status');
    }

    return suggestions.join('\n');
  }

  /**
   * Generate a template suggestion for the TODO
   */
  generateTemplateSuggestion(originalComment, missingElements) {
    const lines = originalComment.split('\n');
    const firstLine = lines[0].trim();

    let template = `// ${firstLine}\n`;
    template += '//       <One-sentence context & why this exists>\n';
    template += '//\n';

    if (missingElements.includes('completion_checklist')) {
      template += '// COMPLETION CHECKLIST:\n';
      template += '// [ ] Primary functionality implemented\n';
      template += '// [ ] API/data structures defined & stable\n';
      template += '// [ ] Error handling + validation aligned with error taxonomy\n';
      template += '// [ ] Tests: Unit ≥80% branch coverage (≥50% mutation if enabled)\n';
      template += '// [ ] Integration tests for external systems/contracts\n';
      template += '// [ ] Documentation: public API + system behavior\n';
      template += '// [ ] Performance/profiled against SLA (CPU/mem/latency throughput)\n';
      template += '// [ ] Security posture reviewed (inputs, authz, sandboxing)\n';
      template += '// [ ] Observability: logs (debug), metrics (SLO-aligned), tracing\n';
      template += '// [ ] Configurability and feature flags defined if relevant\n';
      template += '// [ ] Failure-mode cards documented (degradation paths)\n';
      template += '//\n';
    }

    if (missingElements.includes('acceptance_criteria')) {
      template += '// ACCEPTANCE CRITERIA:\n';
      template += '// - <User-facing measurable behavior>\n';
      template += '// - <Invariant or schema contract requirements>\n';
      template += '// - <Performance/statistical bounds>\n';
      template += '// - <Interoperation requirements or protocol contract>\n';
      template += '//\n';
    }

    if (missingElements.includes('dependencies')) {
      template += '// DEPENDENCIES:\n';
      template += '// - <System or feature this relies on> (Required/Optional)\n';
      template += '// - <Interop/contract references>\n';
      template += '// - File path(s)/module links to dependent code\n';
      template += '//\n';
    }

    if (missingElements.includes('governance')) {
      template += '// ESTIMATED EFFORT: <Number + confidence range>\n';
      template += '// PRIORITY: Medium\n';
      template += '// BLOCKING: {Yes/No} – If Yes: explicitly list what it blocks\n';
      template += '//\n';
      template += '// GOVERNANCE:\n';
      template += '// - CAWS Tier: 3 (impacts rigor, provenance, review policy)\n';
      template += '// - Change Budget: <LOC or file count> (if relevant)\n';
      template += '// - Reviewer Requirements: <Roles or domain expertise>\n';
    }

    return template;
  }

  /**
   * Detect programming language from file extension
   */
  detectLanguage(ext) {
    const languageMap = {
      '.js': 'javascript',
      '.jsx': 'javascript',
      '.ts': 'typescript',
      '.tsx': 'typescript',
      '.py': 'python',
      '.rs': 'rust',
      '.go': 'go',
      '.java': 'java',
      '.cpp': 'cpp',
      '.c': 'c',
      '.h': 'c',
      '.hpp': 'cpp',
    };

    return languageMap[ext];
  }

  /**
   * Check if a line is a comment (or should be scanned if commentsOnly=false)
   */
  isCommentLine(line, language) {
    if (!this.commentsOnly) return true; // recall-boost: scan all lines unless restricted
    const trimmed = line.trim();

    switch (language) {
      case 'javascript':
      case 'typescript':
      case 'rust':
      case 'java':
      case 'cpp':
      case 'c':
        return (
          trimmed.startsWith('//') ||
          trimmed.startsWith('/*') ||
          trimmed.includes('/*') ||
          trimmed.includes('*/')
        );
      case 'go':
        return trimmed.startsWith('//');
      case 'python':
        return trimmed.startsWith('#');
      default:
        return (
          trimmed.startsWith('//') ||
          trimmed.startsWith('#') ||
          trimmed.startsWith('/*') ||
          trimmed.includes('/*') ||
          trimmed.includes('*/')
        );
    }
  }

  /**
   * Calculate confidence score for a potential hidden TODO
   */
  calculateConfidence(line) {
    let score = 0.0;

    // Check for TODO indicators (increase score)
    if (/\bTODO\b/i.test(line)) {
      score += 0.3;
    }

    // Check for implementation context (increase score)
    if (/\b(implement|implementation|fix|add|create|build)\b/i.test(line)) {
      score += 0.2;
    }

    // Check for business logic context (increase score)
    if (
      /\b(feature|function|method|class|component|service|api|auth|authentication|user|login|security)\b/i.test(
        line
      )
    ) {
      score += 0.3;
    }

    // Check for documentation indicators (decrease score)
    if (/\b(example|sample|demo|test|spec|readme|doc)\b/i.test(line)) {
      score -= 0.5;
    }

    // Check if it's in a generated file (decrease score)
    if (/\bgenerated\b|\bauto-generated\b|\bdo not edit\b/i.test(line)) {
      score -= 0.4;
    }

    // Check for TODO system documentation (decrease score - from Python version)
    if (this.isTodoSystemDocumentation(line)) {
      score -= 0.6;
    }

    // Check for legitimate technical terms (decrease score)
    const legitimateTerms = [
      /\bperformance\s+monitoring\b/i,
      /\bperformance\s+optimization\b/i,
      /\bfallback\s+mechanism\b/i,
      /\bbasic\s+authentication\b/i,
      /\bmock\s+object\b/i,
      /\bcurrent\s+implementation.*?(uses|provides|supports)\b/i,
      /\bexample\s+implementation\b/i,
      /\bsample\s+code\b/i,
      /\bdemo\s+implementation\b/i,
      /\btest\s+implementation\b/i,
    ];

    for (const term of legitimateTerms) {
      if (term.test(line)) {
        score -= 0.6;
        break;
      }
    }

    return Math.max(-1.0, Math.min(1.0, score));
  }

  /**
   * Analyze a single file for hidden TODOs (with grouped block detection)
   */
  async analyzeFile(filePath, engineeringSuggestions = false) {
    const issues = [];
    try {
      const abs = path.isAbsolute(filePath)
        ? filePath
        : path.join(this.projectRoot, filePath);
      const content = fs.readFileSync(abs, 'utf8');
      const lines = content.split('\n');
      const lang = this.detectLanguage(path.extname(abs).toLowerCase());

      // Group consecutive TODO lines into logical blocks
      const groupedBlocks = [];
      let currentBlock = null;

      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        const isCommentish = this.isCommentLine(line, lang);

        // Check if this line matches any TODO patterns
        let matchedPattern = null;
        let patternType = null;
        let confidence = 0;
        let suggestedFix = '';

        if (isCommentish || !this.commentsOnly) {
          // Fast path: broad keyword match
          if (
            this.quickKeyword.test(line) &&
            !this.shouldSkipRuleForDomain(abs, 'BROAD_KEYWORD')
          ) {
            matchedPattern = 'BROAD_KEYWORD';
            patternType = /\bTODO\b/i.test(line) ? 'warning' : 'error';
            confidence = 0.9;
            suggestedFix =
              'Review and either implement or formalize as engineering-grade TODO';
          }

          // Hidden patterns
          if (!matchedPattern) {
            for (const re of this.hiddenTodoPatterns) {
              if (
                re.test(line) &&
                !this.shouldSkipRuleForDomain(abs, 'HIDDEN_TODO')
              ) {
                matchedPattern = 'HIDDEN_TODO';
                patternType = 'error';
                confidence = 0.85;
                suggestedFix =
                  'Replace with complete implementation or remove TODO marker';
                break;
              }
            }
          }

          // Code stubs
          if (!matchedPattern && lang && this.codeStubPatterns[lang]) {
            for (const [name, re] of Object.entries(this.codeStubPatterns[lang])) {
              if (
                re.test(line) &&
                !this.shouldSkipRuleForDomain(abs, 'CODE_STUB')
              ) {
                matchedPattern = 'CODE_STUB';
                patternType = 'error';
                confidence = 0.8;
                suggestedFix =
                  'Implement complete functionality or remove stub code';
                break;
              }
            }
          }
        }

        if (matchedPattern) {
          // This line matches a TODO pattern
          if (currentBlock) {
            // Extend current block
            currentBlock.endLine = i + 1;
            currentBlock.lines.push({
              lineNumber: i + 1,
              content: line.trim(),
              pattern: matchedPattern,
            });
          } else {
            // Start new block
            currentBlock = {
              startLine: i + 1,
              endLine: i + 1,
              severity: patternType,
              ruleId: matchedPattern,
              confidence: confidence,
              suggestedFix: suggestedFix,
              lines: [
                {
                  lineNumber: i + 1,
                  content: line.trim(),
                  pattern: matchedPattern,
                },
              ],
            };
          }
        } else {
          // This line doesn't match - if we have a current block, finalize it
          if (currentBlock) {
            groupedBlocks.push(currentBlock);
            currentBlock = null;
          }
        }
      }

      // Don't forget the last block if it exists
      if (currentBlock) {
        groupedBlocks.push(currentBlock);
      }

      // Convert grouped blocks to QualityIssue objects
      for (const block of groupedBlocks) {
        let message = '';
        let engineeringSuggestionsText = '';

        if (block.lines.length === 1) {
          // Single line - use original format
          const line = block.lines[0];
          if (block.ruleId === 'BROAD_KEYWORD') {
            message = `Potential hidden TODO/placeholder: '${line.content}'`;
          } else if (block.ruleId === 'HIDDEN_TODO') {
            message = `Hidden incomplete implementation detected: '${line.content}'`;
          } else if (block.ruleId === 'CODE_STUB') {
            message = `Code stub pattern detected: '${line.content}'`;
          }
        } else {
          // Multiple lines - create grouped message
          const patterns = [...new Set(block.lines.map((l) => l.pattern))];
          const patternNames = patterns
            .map((p) =>
              p === 'BROAD_KEYWORD'
                ? 'hidden TODO/placeholder'
                : p === 'HIDDEN_TODO'
                ? 'incomplete implementation'
                : p === 'CODE_STUB'
                ? 'code stub'
                : p
            )
            .join(', ');

          message = `Grouped ${patternNames} issues (${block.lines.length} lines):\n`;
          for (const line of block.lines) {
            message += `  Line ${line.lineNumber}: ${line.content}\n`;
          }
          message = message.trim();
        }

        if (engineeringSuggestions) {
          // Apply engineering suggestions to the first line of the block
          const firstLine = block.lines[0];
          const eng = this.analyzeEngineeringSuggestions(firstLine.content, abs);
          if (eng.needsEngineeringFormat) {
            engineeringSuggestionsText = `\n\n💡 Engineering-grade format suggestions:\n${eng.suggestions}`;
            if (eng.templateSuggestion) {
              block.suggestedFix = eng.templateSuggestion;
            }
          }
        }

        const issue = new QualityIssue(
          abs,
          block.startLine,
          block.severity,
          block.ruleId,
          message + engineeringSuggestionsText,
          block.confidence,
          block.suggestedFix,
          block.endLine
        );

        issues.push(issue);
      }
    } catch (error) {
      issues.push(
        new QualityIssue(
          filePath,
          0,
          'error',
          'FILE_READ_ERROR',
          `Could not analyze file: ${error.message}`,
          1.0,
          'Check file permissions and encoding'
        )
      );
    }

    return issues;
  }

  /**
   * Format line number for display (handles ranges)
   */
  formatLineNumber(issue) {
    if (issue.line_number === issue.end_line_number) {
      return issue.line_number.toString();
    } else {
      return `${issue.line_number}-${issue.end_line_number}`;
    }
  }

  /**
   * Generate a report from the analysis results
   */
  generateReport(issues, outputFormat = 'text') {
    if (outputFormat === 'json') {
      return JSON.stringify(
        issues.map((i) => ({
          file: i.file_path,
          line: i.line_number,
          end_line: i.end_line_number,
          severity: i.severity,
          rule: i.rule_id,
          message: i.message,
          confidence: i.confidence,
          suggested_fix: i.suggested_fix,
        })),
        null,
        2
      );
    }

    if (outputFormat === 'md') {
      const errors = issues.filter((i) => i.severity === 'error');
      const warnings = issues.filter((i) => i.severity === 'warning');
      const L = [];
      L.push(`# Hidden TODO Analysis Report`);
      L.push('');
      L.push(
        `- **Files analyzed:** ${new Set(issues.map((i) => i.file_path)).size}`
      );
      L.push(`- **Total issues:** ${issues.length}`);
      L.push(`- **Errors:** ${errors.length}`);
      L.push(`- **Warnings:** ${warnings.length}`);
      if (issues.length) {
        L.push('');
        L.push(`## Top issues`);
        for (const i of issues.slice(0, 20)) {
          const rel = path.relative(this.projectRoot, i.file_path);
          const lineNum = this.formatLineNumber(i);
          const pct = (i.confidence * 100).toFixed(1);
          L.push(`- \`${rel}:${lineNum}\` — ${i.rule_id} (${pct}%)`);
          L.push(`  - ${i.message}`);
          if (i.suggested_fix) L.push(`  - _Suggestion:_ ${i.suggested_fix}`);
        }
      }
      return L.join('\n');
    }

    // Default text format
    const errors = issues.filter((i) => i.severity === 'error');
    const warnings = issues.filter((i) => i.severity === 'warning');
    const R = [];
    R.push(`Hidden TODO Analysis Report`);
    R.push(`==========================`);
    R.push('');
    R.push(
      `Total files analyzed: ${new Set(issues.map((i) => i.file_path)).size}`
    );
    R.push(`Total issues found: ${issues.length}`);
    R.push(`Errors: ${errors.length}`);
    R.push(`Warnings: ${warnings.length}`);
    R.push('');
    const show = (arr, label) => {
      if (!arr.length) return;
      R.push(`${label} (${arr.length}):`);
      for (const i of arr.slice(0, 20)) {
        const pct = (i.confidence * 100).toFixed(1);
        const lineNum = this.formatLineNumber(i);
        R.push(
          `  ${path.relative(this.projectRoot, i.file_path)}:${lineNum} (${pct}% confidence)`
        );
        R.push(`    ${i.message}`);
        if (i.suggested_fix) R.push(`    💡 ${i.suggested_fix}`);
        R.push('');
      }
      if (arr.length > 20) R.push(`  ... and ${arr.length - 20} more`);
    };
    show(errors, '❌ ERRORS');
    show(warnings, '⚠️  WARNINGS');
    return R.join('\n');
  }
}

// CLI interface
async function main() {
  const args = process.argv.slice(2);
  let pathArg = '.';
  let outputFormat = 'text';
  let minConfidence = 0.6;
  let showProgress = true;
  let exitCode = false;
  let scopedFiles = null;
  let engineeringSuggestions = false;
  let stagedOnly = false;
  let commentsOnly = false;
  let noExcludes = false;
  let outputFile = null;

  // Parse arguments
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    switch (arg) {
      case '--path':
        pathArg = args[++i];
        break;
      case '--format':
        outputFormat = args[++i];
        break;
      case '--min-confidence':
        minConfidence = parseFloat(args[++i]);
        break;
      case '--no-progress':
        showProgress = false;
        break;
      case '--exit-code':
        exitCode = true;
        break;
      case '--output-file':
        outputFile = args[++i];
        break;
      case '--scoped-files': {
        const scopedArg = args[++i];
        if (scopedArg === '-') {
          // Read from stdin (async approach for reliability)
          const stdinData = [];
          process.stdin.on('data', (chunk) => stdinData.push(chunk));
          await new Promise((resolve) => {
            process.stdin.on('end', () => {
              scopedFiles = Buffer.concat(stdinData)
                .toString()
                .trim()
                .split('\n')
                .filter(Boolean);
              resolve();
            });
          });
        } else if (
          fs.existsSync(scopedArg) &&
          (scopedArg.endsWith('.txt') ||
            scopedArg.endsWith('.list') ||
            scopedArg.includes('files'))
        ) {
          // Read from file (only if it looks like a file list)
          scopedFiles = fs
            .readFileSync(scopedArg, 'utf8')
            .trim()
            .split('\n')
            .filter(Boolean);
        } else {
          // Treat as a single file path from command line
          scopedFiles = [scopedArg];
        }
        break;
      }
      case '--engineering-suggestions':
        engineeringSuggestions = true;
        break;
      case '--staged-only':
        stagedOnly = true;
        break;
      case '--comments-only':
        commentsOnly = true;
        break; // Restrict to comments only
      case '--no-excludes':
        noExcludes = true;
        break; // Disable excludes
      case '--help':
      case '-h':
        console.log(`
Hidden TODO Pattern Analyzer (recall-boosted v2.2)

Automatically detects and reports hidden incomplete implementations including:
- Hidden TODO comments with sophisticated pattern matching
- Placeholder implementations and stub code
- Temporary solutions and workarounds
- Hardcoded values and constants
- Future improvement markers

USAGE:
  node todo-analyzer.mjs [options] [path]

OPTIONS:
  --path <path>              Root directory to analyze (default: '.')
  --format <format>          Output format: text, json, md (default: text)
  --min-confidence <float>   Minimum confidence score 0.0-1.0 (default: 0.6)
  --no-progress              Disable progress reporting
  --exit-code                Exit with code 1 if errors found
  --output-file <file>       Write output to file instead of stdout
  --comments-only            Scan only comments (default: scan all lines)
  --no-excludes              Do not skip tests/examples/models/etc.
  --scoped-files <file>      Analyze only specified files (one per line)
  --scoped-files -           Read file list from stdin
  --engineering-suggestions  Include engineering-grade TODO format suggestions
  --staged-only              Analyze only git staged files
  --help, -h                 Show this help message

EXAMPLES:
  node todo-analyzer.mjs                     # Analyze current directory
  node todo-analyzer.mjs --path src         # Analyze src directory
  node todo-analyzer.mjs --min-confidence 0.8 # Higher confidence threshold
  node todo-analyzer.mjs --format md        # Markdown output format
  node todo-analyzer.mjs --comments-only    # Restrict to comments only
  echo 'file1.rs\\nfile2.rs' | node todo-analyzer.mjs --scoped-files -
`);
        process.exit(0);
        break;
      default:
        if (arg.startsWith('--')) {
          console.error(`Unknown option: ${arg}`);
          process.exit(1);
        } else {
          pathArg = arg;
        }
    }
  }

  const analyzer = new HiddenTodoAnalyzer(pathArg, {
    commentsOnly,
    noExcludes,
  });

  try {
    let issues;
    if (stagedOnly) {
      issues = await analyzer.analyzeStagedFiles(showProgress, engineeringSuggestions);
    } else {
      issues = await analyzer.analyzeProject(
        showProgress,
        scopedFiles,
        engineeringSuggestions
      );
    }

    // Filter by confidence
    const filteredIssues = issues.filter((issue) => issue.confidence >= minConfidence);

    const report = analyzer.generateReport(filteredIssues, outputFormat);

    if (outputFile) {
      fs.writeFileSync(outputFile, report);
      console.log(`Report written to ${outputFile}`);
    } else {
      console.log(report);
    }

    if (exitCode && filteredIssues.length > 0) {
      // Exit with error code if there are issues
      const errors = filteredIssues.filter((i) => i.severity === 'error');
      if (errors.length > 0) {
        process.exit(1);
      }
    }
  } catch (error) {
    console.error(`Error: ${error.message}`);
    process.exit(1);
  }
}

// Run CLI if this file is executed directly
if (
  process.argv[1] &&
  fileURLToPath(import.meta.url) === path.resolve(process.argv[1])
) {
  main();
}

export { HiddenTodoAnalyzer, QualityIssue };
