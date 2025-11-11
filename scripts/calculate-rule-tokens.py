#!/usr/bin/env python3
"""
Calculate token counts for Cursor rules using tiktoken (GPT-4 tokenization).

Usage:
    python scripts/calculate-rule-tokens.py [--update] [--rule <rule-file>]

If --update is provided, updates the ruleTokenCount in frontmatter.
If --rule is provided, only processes that specific rule file.
"""

import argparse
import re
import sys
from pathlib import Path

try:
    import tiktoken
except ImportError:
    print("Error: tiktoken not installed. Install with: pip install tiktoken")
    sys.exit(1)


def count_tokens(text: str, model: str = "gpt-4") -> int:
    """Count tokens using tiktoken for specified model."""
    try:
        encoding = tiktoken.encoding_for_model(model)
        return len(encoding.encode(text))
    except KeyError:
        # Fallback to cl100k_base (GPT-4 uses this)
        encoding = tiktoken.get_encoding("cl100k_base")
        return len(encoding.encode(text))


def extract_content_from_mdc(file_path: Path) -> str:
    """Extract content from MDC file (everything after frontmatter)."""
    content = file_path.read_text(encoding="utf-8")
    
    # Find frontmatter end
    frontmatter_end = content.find("---", 3)
    if frontmatter_end == -1:
        # No frontmatter, return all content
        return content
    
    # Return content after frontmatter
    return content[frontmatter_end + 3:].lstrip()


def update_rule_token_count(file_path: Path, token_count: int) -> bool:
    """Update ruleTokenCount in frontmatter. Returns True if updated."""
    content = file_path.read_text(encoding="utf-8")
    
    # Check if frontmatter exists
    if not content.startswith("---"):
        print(f"Warning: {file_path} doesn't have frontmatter")
        return False
    
    # Find frontmatter end
    frontmatter_end = content.find("---", 3)
    if frontmatter_end == -1:
        print(f"Warning: {file_path} has malformed frontmatter")
        return False
    
    frontmatter = content[3:frontmatter_end].strip()
    rest = content[frontmatter_end + 3:]
    
    # Check if ruleTokenCount already exists
    if re.search(r"^ruleTokenCount:\s*\d+", frontmatter, re.MULTILINE):
        # Update existing
        frontmatter = re.sub(
            r"^ruleTokenCount:\s*\d+",
            f"ruleTokenCount: {token_count}",
            frontmatter,
            flags=re.MULTILINE
        )
    else:
        # Add before alwaysApply or at end
        if re.search(r"^alwaysApply:", frontmatter, re.MULTILINE):
            frontmatter = re.sub(
                r"^(alwaysApply:)",
                f"ruleTokenCount: {token_count}\n\\1",
                frontmatter,
                flags=re.MULTILINE
            )
        else:
            frontmatter += f"\nruleTokenCount: {token_count}"
    
    # Reconstruct file
    new_content = f"---\n{frontmatter}\n---{rest}"
    file_path.write_text(new_content, encoding="utf-8")
    return True


def process_rule_file(file_path: Path, update: bool = False) -> int:
    """Process a single rule file. Returns token count."""
    content = extract_content_from_mdc(file_path)
    token_count = count_tokens(content)
    
    print(f"{file_path.name:50} {token_count:6} tokens")
    
    if update:
        if update_rule_token_count(file_path, token_count):
            print(f"  ✅ Updated ruleTokenCount")
        else:
            print(f"  ⚠️  Could not update ruleTokenCount")
    
    return token_count


def main():
    parser = argparse.ArgumentParser(
        description="Calculate token counts for Cursor rules"
    )
    parser.add_argument(
        "--update",
        action="store_true",
        help="Update ruleTokenCount in frontmatter"
    )
    parser.add_argument(
        "--rule",
        type=str,
        help="Process only this specific rule file"
    )
    parser.add_argument(
        "--rules-dir",
        type=str,
        default=".cursor/rules",
        help="Rules directory (default: .cursor/rules)"
    )
    
    args = parser.parse_args()
    
    rules_dir = Path(args.rules_dir)
    if not rules_dir.exists():
        print(f"Error: Rules directory not found: {rules_dir}")
        sys.exit(1)
    
    # Find rule files
    if args.rule:
        rule_files = [rules_dir / args.rule]
        if not rule_files[0].exists():
            print(f"Error: Rule file not found: {rule_files[0]}")
            sys.exit(1)
    else:
        rule_files = sorted(rules_dir.glob("*.mdc"))
    
    if not rule_files:
        print(f"No .mdc files found in {rules_dir}")
        sys.exit(1)
    
    print(f"\n{'Rule File':<50} {'Tokens':>6}")
    print("-" * 58)
    
    total_tokens = 0
    always_applied_tokens = 0
    
    for rule_file in rule_files:
        token_count = process_rule_file(rule_file, args.update)
        total_tokens += token_count
        
        # Check if always applied
        content = rule_file.read_text(encoding="utf-8")
        if re.search(r"^alwaysApply:\s*true", content, re.MULTILINE):
            always_applied_tokens += token_count
    
    print("-" * 58)
    print(f"{'Total tokens':<50} {total_tokens:6}")
    print(f"{'Always-applied tokens':<50} {always_applied_tokens:6} ({always_applied_tokens/total_tokens*100:.1f}%)")
    
    if args.update:
        print(f"\n✅ Updated {len(rule_files)} rule file(s)")


if __name__ == "__main__":
    main()

