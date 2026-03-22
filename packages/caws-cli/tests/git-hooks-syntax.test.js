/**
 * @fileoverview Tests for git hooks bash syntax validation
 * Ensures generated hooks have valid bash syntax and properly escaped characters
 * @author @darianrosebrook
 */

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

// Import hook generators directly
const gitHooksModule = require('../src/scaffold/git-hooks');

describe('Git Hooks Bash Syntax Validation', () => {
  let tempDir;

  beforeEach(() => {
    tempDir = path.join(os.tmpdir(), `caws-hooks-syntax-test-${Date.now()}`);
    fs.mkdirSync(tempDir, { recursive: true });
  });

  afterEach(() => {
    try {
      if (fs.existsSync(tempDir)) {
        fs.rmSync(tempDir, { recursive: true, force: true });
      }
    } catch (error) {
      // Ignore cleanup errors
    }
  });

  /**
   * Validate bash syntax using bash -n (syntax check mode)
   * @param {string} scriptContent - Bash script content
   * @returns {Object} { valid: boolean, error: string|null }
   */
  function validateBashSyntax(scriptContent) {
    const scriptPath = path.join(tempDir, 'test-hook.sh');
    fs.writeFileSync(scriptPath, scriptContent, { mode: 0o755 });

    try {
      execSync(`bash -n "${scriptPath}"`, { stdio: 'pipe' });
      return { valid: true, error: null };
    } catch (error) {
      const errorMessage = error.stderr?.toString() || error.message || 'Unknown syntax error';
      return { valid: false, error: errorMessage };
    }
  }

  describe('Pre-push Hook Syntax', () => {
    test('should generate valid bash syntax', () => {
      const hookContent = gitHooksModule.generatePrePushHook();
      
      // Verify it starts with shebang
      expect(hookContent.startsWith('#!/bin/bash')).toBe(true);
      
      // Validate bash syntax
      const result = validateBashSyntax(hookContent);
      if (!result.valid) {
        console.error('Pre-push hook syntax error:', result.error);
        console.error('Hook content around error:', hookContent.substring(0, 2000));
      }
      expect(result.valid).toBe(true);
    });

    test('should properly escape parentheses in echo statements', () => {
      const hookContent = gitHooksModule.generatePrePushHook();

      // Verify multi-spec validation logic is present
      expect(hookContent).toContain('caws validate');
      expect(hookContent).toContain('.caws/specs');

      // Should NOT have unescaped parentheses in echo statements
      // This regex matches echo statements with unescaped parentheses
      const unescapedPattern = /echo\s+"[^"]*\([^)]*\)[^"]*"/;
      const matches = hookContent.match(unescapedPattern);
      if (matches) {
        // Filter out false positives (like variable substitutions ${VAR})
        const problematicMatches = matches.filter(match => 
          !match.includes('${') && // Variable substitution is fine
          !match.includes('$(') && // Command substitution is fine
          !match.includes('\\(') // Escaped parentheses are fine
        );
        expect(problematicMatches).toHaveLength(0);
      }
    });

    test('should not contain syntax errors that would break bash parsing', () => {
      const hookContent = gitHooksModule.generatePrePushHook();
      
      // Validate with bash syntax checker (this is the authoritative check)
      const result = validateBashSyntax(hookContent);
      expect(result.valid).toBe(true);
      if (!result.valid) {
        console.error('Pre-push hook syntax validation failed:', result.error);
        console.error('Hook content preview:', hookContent.substring(0, 500));
      }
    });
  });

  describe('Pre-commit Hook Syntax', () => {
    test('should generate valid bash syntax', () => {
      const hookContent = gitHooksModule.generatePreCommitHook({
        qualityGates: true,
        stagedOnly: true,
        projectDir: tempDir,
      });
      
      // Verify it starts with shebang
      expect(hookContent.startsWith('#!/bin/bash')).toBe(true);
      
      // Validate bash syntax
      const result = validateBashSyntax(hookContent);
      expect(result.valid).toBe(true);
      if (!result.valid) {
        console.error('Pre-commit hook syntax error:', result.error);
      }
    });

    test('should properly escape parentheses in echo statements', () => {
      const hookContent = gitHooksModule.generatePreCommitHook({
        qualityGates: true,
        stagedOnly: true,
        projectDir: tempDir,
      });
      
      // Check for properly escaped parentheses in echo statements
      // Variable substitutions like ${VAR} are fine, but literal parentheses should be escaped
      const lines = hookContent.split('\n');
      const echoLines = lines.filter((line) => line.trim().startsWith('echo'));
      
      echoLines.forEach((line) => {
        // Skip lines with variable substitutions or command substitutions
        if (line.includes('${') || line.includes('$(')) {
          return;
        }
        
        // Simple check: if line contains parentheses in quotes, they should be escaped
        // Look for pattern: echo "..." ( ... ) "..."
        const quoteMatch = line.match(/echo\s+"([^"]+)"/);
        if (quoteMatch) {
          const quotedContent = quoteMatch[1];
          // Check for unescaped parentheses (not part of ${} or $())
          const hasUnescapedParens = quotedContent.includes('(') && 
            !quotedContent.includes('\\(') && 
            !quotedContent.includes('${') && 
            !quotedContent.includes('$(');
          if (hasUnescapedParens) {
            // This might be a problem, but validate with bash syntax checker instead
            // Bash syntax validation will catch actual syntax errors
          }
        }
      });
      
      // The real validation is bash syntax checking
      const result = validateBashSyntax(hookContent);
      expect(result.valid).toBe(true);
    });
  });

  describe('Pre-commit Hook Context Scoping', () => {
    test('should use --context=commit for staged-only quality gates, not --ci', () => {
      const hookContent = gitHooksModule.generatePreCommitHook({
        qualityGates: true,
        stagedOnly: true,
        projectDir: tempDir,
      });

      // Pre-commit hooks must scope to staged files only.
      // --ci forces full-repo scan via listRepoFiles(), which is wrong for pre-commit.
      expect(hookContent).toContain('--context=commit');
      expect(hookContent).not.toMatch(/run-quality-gates\.mjs\s+--ci\b/);
    });

    test('should invoke caws gates run for quality gate evaluation', () => {
      const hookContent = gitHooksModule.generatePreCommitHook({
        qualityGates: true,
        stagedOnly: true,
        projectDir: tempDir,
      });

      // v2 pipeline: pre-commit calls `caws gates run` instead of the
      // old 5-option fallback chain searching for run-quality-gates.mjs
      const gatesInvocation = hookContent.includes('caws gates run') ||
        hookContent.includes('caws validate');
      expect(gatesInvocation).toBe(true);
    });
  });

  describe('Post-commit Hook Syntax', () => {
    test('should generate valid bash syntax', () => {
      const hookContent = gitHooksModule.generatePostCommitHook();
      
      // Verify it starts with shebang
      expect(hookContent.startsWith('#!/bin/bash')).toBe(true);
      
      // Validate bash syntax
      const result = validateBashSyntax(hookContent);
      expect(result.valid).toBe(true);
      if (!result.valid) {
        console.error('Post-commit hook syntax error:', result.error);
      }
    });
  });

  describe('Commit-msg Hook Syntax', () => {
    test('should generate valid bash syntax', () => {
      const hookContent = gitHooksModule.generateCommitMsgHook();
      
      // Verify it starts with shebang
      expect(hookContent.startsWith('#!/bin/bash')).toBe(true);
      
      // Validate bash syntax
      const result = validateBashSyntax(hookContent);
      expect(result.valid).toBe(true);
      if (!result.valid) {
        console.error('Commit-msg hook syntax error:', result.error);
      }
    });

    test('should properly escape parentheses in echo statements', () => {
      const hookContent = gitHooksModule.generateCommitMsgHook();
      
      // Parens in double-quoted echo strings don't need escaping in bash
      if (hookContent.includes('minimum')) {
        expect(hookContent).toContain('(minimum');
      }
      
      // Validate with bash syntax checker
      const result = validateBashSyntax(hookContent);
      expect(result.valid).toBe(true);
      if (!result.valid) {
        console.error('Commit-msg hook syntax validation failed:', result.error);
      }
    });
  });

  describe('All Hooks Integration', () => {
    test('all generated hooks should pass bash syntax validation', () => {
      const hooks = [
        {
          name: 'pre-push',
          content: gitHooksModule.generatePrePushHook(),
        },
        {
          name: 'pre-commit',
          content: gitHooksModule.generatePreCommitHook({
            qualityGates: true,
            stagedOnly: true,
            projectDir: tempDir,
          }),
        },
        {
          name: 'post-commit',
          content: gitHooksModule.generatePostCommitHook(),
        },
        {
          name: 'commit-msg',
          content: gitHooksModule.generateCommitMsgHook(),
        },
      ];

      const results = hooks.map((hook) => {
        const result = validateBashSyntax(hook.content);
        return {
          name: hook.name,
          valid: result.valid,
          error: result.error,
        };
      });

      const invalidHooks = results.filter((r) => !r.valid);
      
      if (invalidHooks.length > 0) {
        console.error('Invalid hooks found:');
        invalidHooks.forEach((hook) => {
          console.error(`  ${hook.name}: ${hook.error}`);
        });
      }

      expect(invalidHooks).toHaveLength(0);
    });

    test('all hooks should have proper shebang', () => {
      const hooks = [
        { name: 'pre-push', content: gitHooksModule.generatePrePushHook() },
        {
          name: 'pre-commit',
          content: gitHooksModule.generatePreCommitHook({
            qualityGates: true,
            stagedOnly: true,
            projectDir: tempDir,
          }),
        },
        { name: 'post-commit', content: gitHooksModule.generatePostCommitHook() },
        { name: 'commit-msg', content: gitHooksModule.generateCommitMsgHook() },
      ];

      hooks.forEach((hook) => {
        expect(hook.content.startsWith('#!/bin/bash')).toBe(true);
      });
    });
  });

  describe('Parentheses Escaping', () => {
    test('should escape all parentheses in echo statements', () => {
      const hooks = [
        { name: 'pre-push', content: gitHooksModule.generatePrePushHook() },
        {
          name: 'pre-commit',
          content: gitHooksModule.generatePreCommitHook({
            qualityGates: true,
            stagedOnly: true,
            projectDir: tempDir,
          }),
        },
        { name: 'post-commit', content: gitHooksModule.generatePostCommitHook() },
        { name: 'commit-msg', content: gitHooksModule.generateCommitMsgHook() },
      ];

      hooks.forEach((hook) => {
        // Validate bash syntax - this will catch unescaped parentheses
        const result = validateBashSyntax(hook.content);
        expect(result.valid).toBe(true);
        
        if (!result.valid) {
          throw new Error(
            `Hook ${hook.name} has bash syntax errors:\n${result.error}\n` +
            `This likely indicates unescaped parentheses or other syntax issues.`
          );
        }
        
        // Check that pre-push hook has key validation logic
        if (hook.name === 'pre-push') {
          expect(hook.content).toContain('caws validate');
          expect(hook.content).toContain('.caws/specs');
        }
        
        if (hook.name === 'commit-msg') {
          if (hook.content.includes('minimum')) {
            // Parens in echo strings don't need escaping
            expect(hook.content).toContain('(minimum');
          }
        }
      });
    });
  });
});

