/**
 * Shared language support constants for CAWS quality gates.
 *
 * Centralizes code extension lists, comment style detection, and convention
 * file exclusions so gates stay language-agnostic without duplicating config.
 *
 * @author @darianrosebrook
 */

/**
 * Code file extensions recognized by quality gates.
 * Gates use this set to decide which files to analyze for SLOC, stubs, naming, etc.
 */
export const CODE_EXTENSIONS = new Set([
  // JavaScript / TypeScript
  '.js', '.jsx', '.ts', '.tsx', '.mjs', '.cjs', '.mts', '.cts',
  // Python
  '.py',
  // Rust
  '.rs',
  // Go
  '.go',
  // Java / Kotlin
  '.java', '.kt',
  // Swift
  '.swift',
  // Ruby
  '.rb',
  // PHP
  '.php',
  // C / C++
  '.c', '.cpp', '.h', '.hpp', '.cc', '.cxx',
  // C#
  '.cs',
  // Scala
  '.scala',
  // Elixir
  '.ex', '.exs',
  // Lua
  '.lua',
  // Shell
  '.sh', '.bash', '.zsh',
]);

/**
 * Returns the comment style for a given file extension.
 *
 * - 'c': Uses // line comments and /* block comments (C-family, JS, TS, Rust, Go, Java, etc.)
 * - 'hash': Uses # line comments, no standard block syntax (Python, Ruby, Shell, Elixir, etc.)
 *
 * @param {string} ext - File extension including the dot (e.g. '.py')
 * @returns {'c'|'hash'} Comment style identifier
 */
export function commentStyleFor(ext) {
  switch (ext) {
    case '.py':
    case '.rb':
    case '.sh':
    case '.bash':
    case '.zsh':
    case '.ex':
    case '.exs':
    case '.lua':
      return 'hash';
    default:
      return 'c';
  }
}

/**
 * Files that are conventional entry points across language ecosystems.
 * These are excluded from duplicate-stem analysis in the naming gate because
 * multiple packages legitimately have files with these names.
 */
export const CONVENTION_FILES = new Set([
  // Rust
  'lib.rs', 'mod.rs', 'main.rs', 'build.rs',
  // JavaScript / TypeScript
  'index.js', 'index.ts', 'index.mjs', 'index.cjs', 'index.jsx', 'index.tsx',
  // Python
  '__init__.py', 'setup.py', 'conftest.py', '__main__.py',
  // Go
  'main.go', 'doc.go',
  // Java
  'Main.java', 'Application.java',
  // C#
  'Program.cs',
  // Build / config
  'Cargo.toml', 'Makefile', 'Dockerfile',
]);

/**
 * Package boundary marker files used to determine project/crate roots.
 * When walking up the directory tree to find a package boundary,
 * the presence of any of these files marks a package root.
 */
export const PACKAGE_MARKERS = [
  'package.json',     // Node.js / npm
  'Cargo.toml',       // Rust
  'go.mod',           // Go
  'pyproject.toml',   // Python (modern)
  'setup.py',         // Python (legacy)
  'pom.xml',          // Java (Maven)
  'build.gradle',     // Java / Kotlin (Gradle)
  'build.gradle.kts', // Kotlin (Gradle Kotlin DSL)
  'Gemfile',          // Ruby
  'composer.json',    // PHP
  'mix.exs',          // Elixir
];
