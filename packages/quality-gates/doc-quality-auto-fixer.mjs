#!/usr/bin/env node

/**
 * Documentation Quality Auto-Fixer
 *
 * Automatically fixes common documentation quality issues detected by quality gates:
 * - Unfounded achievement claims (replace with evidence-based language)
 * - Superiority claims (remove marketing language)
 * - Inappropriate emoji usage (keep allowed, remove banned)
 * - Temporal documentation relocation (move to docs-status/)
 *
 * Usage:
 *   node packages/quality-gates/doc-quality-auto-fixer.mjs [--dry-run] [--files=file1,file2] [--fix]
 *
 * Options:
 *   --dry-run       Show what would be fixed without making changes
 *   --files         Comma-separated list of files to fix (default: all affected files)
 *   --fix           Actually apply fixes (default: dry-run mode)
 *   --interactive   Ask for confirmation before each change
 *
 * @author: @darianrosebrook
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const DRY_RUN = process.argv.includes('--dry-run') || !process.argv.includes('--fix');
const INTERACTIVE = process.argv.includes('--interactive');
const DEBUG_MODE = process.argv.includes('--debug');

// Get files filter from command line
const FILES_FILTER = (() => {
  const filesArg = process.argv.find(arg => arg.startsWith('--files='));
  if (filesArg) {
    return filesArg.substring('--files='.length).split(',').map(f => f.trim());
  }
  return null;
})();

// Allowed emojis (from project rules)
const ALLOWED_EMOJIS = ['⚠️', '✅', '🚫'];

// Banned patterns for documentation quality
const BANNED_PATTERNS = {
  // Unfounded achievement claims
  unfounded_achievements: [
    /\bproduction-ready\b/gi,
    /\benterprise-grade\b/gi,
    /\bbattle-tested\b/gi,
    /\bcomplete\b/gi,
    /\bfinished\b/gi,
    /\bdone\b/gi,
    /\bachieved\b/gi,
    /\bdelivered\b/gi,
    /\bimplemented\b/gi,
    /\boperational\b/gi,
    /\bready\b/gi,
    /\bdeployed\b/gi,
    /\blaunched\b/gi,
    /\breleased\b/gi,
    /\b100%/gi,
    /\bfully\b/gi,
    /\bcomprehensive\b/gi,
    /\bentire\b/gi,
    /\btotal\b/gi,
    /\ball\b/gi,
    /\bevery\b/gi,
    /\bperfect\b/gi,
    /\bideal\b/gi,
    /\boptimal\b/gi,
    /\bmaximum\b/gi,
    /\bminimum\b/gi,
    /\bunlimited\b/gi,
    /\binfinite\b/gi,
    /\bendless\b/gi,
  ],

  // Superiority claims
  superiority_claims: [
    /\brevolutionary\b/gi,
    /\bbreakthrough\b/gi,
    /\binnovative\b/gi,
    /\bgroundbreaking\b/gi,
    /\bcutting-edge\b/gi,
    /\bstate-of-the-art\b/gi,
    /\bnext-generation\b/gi,
    /\badvanced\b/gi,
    /\bpremium\b/gi,
    /\bsuperior\b/gi,
    /\bbest\b/gi,
    /\bleading\b/gi,
    /\bindustry-leading\b/gi,
    /\baward-winning\b/gi,
    /\bgame-changing\b/gi,
  ],
};

// Replacement mappings for unfounded claims
const ACHIEVEMENT_REPLACEMENTS = {
  'production-ready': 'operational',
  'enterprise-grade': 'operational',
  'battle-tested': 'operational',
  'complete': 'implemented',
  'finished': 'implemented',
  'done': 'completed',
  'achieved': 'completed',
  'delivered': 'completed',
  'implemented': 'implemented',
  'operational': 'operational',
  'ready': 'available',
  'deployed': 'deployed',
  'launched': 'launched',
  'released': 'released',
  '100%': 'fully',
  'fully': 'fully',
  'comprehensive': 'thorough',
  'entire': 'entire',
  'total': 'total',
  'all': 'all',
  'every': 'every',
  'perfect': 'optimal',
  'ideal': 'optimal',
  'optimal': 'optimal',
  'maximum': 'maximum',
  'minimum': 'minimum',
  'unlimited': 'unlimited',
  'infinite': 'unlimited',
  'endless': 'unlimited',
};

// Files that should be moved to docs-status (temporal documentation)
const TEMPORAL_DOC_PATTERNS = [
  /.*SUMMARY\.md$/i,
  /.*STATUS\.md$/i,
  /.*REPORT\.md$/i,
  /.*AUDIT\.md$/i,
  /.*CHECKLIST\.md$/i,
  /PHASE.*\.md$/i,
  /.*ROADMAP\.md$/i,
  /NEXT_ACTIONS\.md$/i,
];

class DocQualityAutoFixer {
  constructor() {
    this.projectRoot = path.resolve(path.join(__dirname, '..', '..'));
    this.docsStatusDir = path.join(this.projectRoot, 'docs-status');
    this.changes = [];
    this.stats = {
      filesProcessed: 0,
      filesChanged: 0,
      unfoundedClaimsFixed: 0,
      superiorityClaimsFixed: 0,
      emojisRemoved: 0,
      filesMoved: 0,
    };
  }

  async run() {
    console.log('Documentation Quality Auto-Fixer');
    console.log('=====================================');
    console.log(`Mode: ${DRY_RUN ? 'DRY RUN (no changes)' : 'LIVE FIX'}`);
    console.log(`Interactive: ${INTERACTIVE ? 'Yes' : 'No'}`);
    console.log(`Files filter: ${FILES_FILTER ? FILES_FILTER.join(', ') : 'All affected files'}`);
    console.log('');

    // Ensure docs-status directory exists
    if (!fs.existsSync(this.docsStatusDir)) {
      if (!DRY_RUN) {
        fs.mkdirSync(this.docsStatusDir, { recursive: true });
        console.log(`Created docs-status directory: ${this.docsStatusDir}`);
      } else {
        console.log(`Would create docs-status directory: ${this.docsStatusDir}`);
      }
    }

    // Get all markdown files in the project
    const allMdFiles = await this.findMarkdownFiles();

    // Filter files if specified
    const filesToProcess = FILES_FILTER
      ? allMdFiles.filter(file => FILES_FILTER.some(filter => file.includes(filter)))
      : allMdFiles;

    console.log(`Found ${filesToProcess.length} markdown files to process\n`);

    // Process each file
    for (const file of filesToProcess) {
      await this.processFile(file);
    }

    // Report results
    this.reportResults();
  }

  async findMarkdownFiles() {
    const files = [];

    const walkDir = (dir) => {
      try {
        const items = fs.readdirSync(dir);

        for (const item of items) {
          const fullPath = path.join(dir, item);

          try {
            const stat = fs.statSync(fullPath);

            if (stat.isDirectory()) {
              // Skip node_modules, .git, target, and other build directories
              if (!['node_modules', '.git', 'target', '.next', 'dist', 'build'].includes(item)) {
                walkDir(fullPath);
              }
            } else if (item.endsWith('.md')) {
              files.push(path.relative(this.projectRoot, fullPath));
            }
          } catch (statError) {
            // Skip files/directories we can't stat (permission issues, broken symlinks, etc.)
            if (DEBUG_MODE) {
              console.log(`⚠️  Skipping ${fullPath}: ${statError.message}`);
            }
          }
        }
      } catch (readError) {
        // Skip directories we can't read
        if (DEBUG_MODE) {
          console.log(`⚠️  Skipping directory ${dir}: ${readError.message}`);
        }
      }
    };

    walkDir(this.projectRoot);
    return files;
  }

  async processFile(filePath) {
    const fullPath = path.join(this.projectRoot, filePath);
    this.stats.filesProcessed++;

    try {
      const content = fs.readFileSync(fullPath, 'utf8');
      const originalContent = content;
      let newContent = content;
      let fileChanged = false;

      // Check if file should be moved to docs-status
      if (this.shouldMoveToDocsStatus(filePath)) {
        await this.moveTemporalDoc(filePath, content);
        return;
      }

      // Fix unfounded achievement claims
      newContent = this.fixUnfoundedClaims(newContent);

      // Fix superiority claims
      newContent = this.fixSuperiorityClaims(newContent);

      // Fix emoji usage
      newContent = this.fixEmojiUsage(newContent);

      // Check if content changed
      if (newContent !== originalContent) {
        fileChanged = true;
        this.stats.filesChanged++;

        if (DRY_RUN) {
          console.log(`Would fix: ${filePath}`);
          this.showDiff(originalContent, newContent, filePath);
        } else if (INTERACTIVE) {
          const shouldApply = await this.confirmChange(filePath, originalContent, newContent);
          if (shouldApply) {
            fs.writeFileSync(fullPath, newContent, 'utf8');
            console.log(`✅ Fixed: ${filePath}`);
          }
        } else {
          fs.writeFileSync(fullPath, newContent, 'utf8');
          console.log(`✅ Fixed: ${filePath}`);
        }
      } else if (DEBUG_MODE) {
        console.log(`No changes needed: ${filePath}`);
      }

    } catch (error) {
      console.error(`Error processing ${filePath}: ${error.message}`);
    }
  }

  shouldMoveToDocsStatus(filePath) {
    // Don't move files that are already in docs-status
    if (filePath.startsWith('docs-status/')) {
      return false;
    }
    return TEMPORAL_DOC_PATTERNS.some(pattern => pattern.test(filePath));
  }

  async moveTemporalDoc(filePath, content) {
    const fileName = path.basename(filePath);
    const newPath = path.join(this.docsStatusDir, fileName);
    const newRelativePath = path.relative(this.projectRoot, newPath);

    if (DRY_RUN) {
      console.log(`Would move: ${filePath} → docs-status/${fileName}`);
      this.stats.filesMoved++;
    } else if (INTERACTIVE) {
      const shouldMove = await this.confirmMove(filePath, newRelativePath);
      if (shouldMove) {
        // Ensure the target directory exists
        const targetDir = path.dirname(newPath);
        if (!fs.existsSync(targetDir)) {
          fs.mkdirSync(targetDir, { recursive: true });
        }

        fs.writeFileSync(newPath, content, 'utf8');
        fs.unlinkSync(path.join(this.projectRoot, filePath));
        console.log(`✅ Moved: ${filePath} → ${newRelativePath}`);
        this.stats.filesMoved++;
      }
    } else {
      // Ensure the target directory exists
      const targetDir = path.dirname(newPath);
      if (!fs.existsSync(targetDir)) {
        fs.mkdirSync(targetDir, { recursive: true });
      }

      fs.writeFileSync(newPath, content, 'utf8');
      fs.unlinkSync(path.join(this.projectRoot, filePath));
      console.log(`✅ Moved: ${filePath} → ${newRelativePath}`);
      this.stats.filesMoved++;
    }
  }

  fixUnfoundedClaims(content) {
    let fixedContent = content;

    for (const pattern of BANNED_PATTERNS.unfounded_achievements) {
      fixedContent = fixedContent.replace(pattern, (match) => {
        const lowerMatch = match.toLowerCase();
        const replacement = ACHIEVEMENT_REPLACEMENTS[lowerMatch] || match;
        if (replacement !== match) {
          this.stats.unfoundedClaimsFixed++;
          return replacement;
        }
        return match;
      });
    }

    return fixedContent;
  }

  fixSuperiorityClaims(content) {
    let fixedContent = content;

    for (const pattern of BANNED_PATTERNS.superiority_claims) {
      fixedContent = fixedContent.replace(pattern, (match) => {
        // Replace with more neutral language
        this.stats.superiorityClaimsFixed++;
        return match.toLowerCase() === 'advanced' ? 'available' : 'available';
      });
    }

    return fixedContent;
  }

  fixEmojiUsage(content) {
    let fixedContent = content;
    let emojiCount = 0;

    // Find all emojis (basic pattern)
    const emojiPattern = /[\u{1F600}-\u{1F64F}]|[\u{1F300}-\u{1F5FF}]|[\u{1F680}-\u{1F6FF}]|[\u{1F1E0}-\u{1F1FF}]|[\u{2600}-\u{26FF}]|[\u{2700}-\u{27BF}]/gu;

    fixedContent = fixedContent.replace(emojiPattern, (emoji) => {
      if (ALLOWED_EMOJIS.includes(emoji)) {
        return emoji; // Keep allowed emojis
      } else {
        emojiCount++;
        return ''; // Remove banned emojis
      }
    });

    this.stats.emojisRemoved += emojiCount;
    return fixedContent;
  }

  showDiff(original, modified, filePath) {
    const originalLines = original.split('\n');
    const modifiedLines = modified.split('\n');

    // Simple diff - just show first few changed lines
    for (let i = 0; i < Math.min(originalLines.length, modifiedLines.length); i++) {
      if (originalLines[i] !== modifiedLines[i]) {
        console.log(`   Line ${i + 1}:`);
        console.log(`     - ${originalLines[i]}`);
        console.log(`     + ${modifiedLines[i]}`);
        break; // Just show first change
      }
    }
    console.log('');
  }

  async confirmChange(filePath, original, modified) {
    console.log(`\nApply changes to ${filePath}? (y/N): `);

    return new Promise((resolve) => {
      process.stdin.once('data', (data) => {
        const answer = data.toString().trim().toLowerCase();
        resolve(answer === 'y' || answer === 'yes');
      });
    });
  }

  async confirmMove(fromPath, toPath) {
    console.log(`\nMove ${fromPath} to ${toPath}? (y/N): `);

    return new Promise((resolve) => {
      process.stdin.once('data', (data) => {
        const answer = data.toString().trim().toLowerCase();
        resolve(answer === 'y' || answer === 'yes');
      });
    });
  }

  reportResults() {
    console.log('\nDocumentation Quality Auto-Fixer Results');
    console.log('=============================================');

    console.log(`Files processed: ${this.stats.filesProcessed}`);
    console.log(`Files changed: ${this.stats.filesChanged}`);
    console.log(`Files moved to docs-status: ${this.stats.filesMoved}`);
    console.log('');

    console.log('Fixes applied:');
    console.log(`  • Unfounded achievement claims: ${this.stats.unfoundedClaimsFixed}`);
    console.log(`  • Superiority claims: ${this.stats.superiorityClaimsFixed}`);
    console.log(`  • Inappropriate emojis removed: ${this.stats.emojisRemoved}`);
    console.log('');

    if (DRY_RUN) {
      console.log('This was a DRY RUN - no actual changes were made.');
      console.log('Run with --fix to apply the fixes.');
    } else {
      console.log('✅ Fixes have been applied.');
    }

    if (this.stats.filesChanged > 0) {
      console.log('\nRecommendations:');
      console.log('   • Review the changes in your git diff');
      console.log('   • Test any documentation links that may have been affected');
      console.log('   • Consider running quality gates again to verify improvements');
    }
  }
}

// Main execution
async function main() {
  try {
    const fixer = new DocQualityAutoFixer();
    await fixer.run();
  } catch (error) {
    console.error('Fatal error:', error.message);
    process.exit(1);
  }
}

if (process.argv[1] && process.argv[1].endsWith('doc-quality-auto-fixer.mjs')) {
  main().catch((error) => {
    console.error('Unhandled error:', error);
    process.exit(1);
  });
}

export default DocQualityAutoFixer;


