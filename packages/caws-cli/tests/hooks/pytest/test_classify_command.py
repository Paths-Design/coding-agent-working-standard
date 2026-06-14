"""Behavioral tests for classify_command.py (the command-safety brain).

CAWS-TEST-HOOKS-PYTHON-001. classify_command(raw, repo_root, home, cwd) returns
(decision, reason, source, enforcement) with decision in {allow, ask, deny}.
Each test reproduces its failure-lineage condition and asserts the ACTUAL
decision — the do-as-I-do bar. The classifier is PURE (it only decides; it never
executes the command), so even the catastrophic-command tests are safe.

Lineage anchors:
  E1  the git-init fiasco            -> git init must not be a silent allow
  E17 pattern-match bypass on init   -> flag-split / alias / env-prefix variants
  E32 scope-amend tripped its latch  -> spec-only cherry-pick carveout (allow)
"""

import pytest


def decision_of(result):
    """classify_command returns (decision, reason, source, enforcement)."""
    return result[0]


# ---------------------------------------------------------------------------
# E1 / E17 — the git-init catastrophe family and its bypass variants
# ---------------------------------------------------------------------------

class TestGitInitFamily:
    def test_plain_git_init_is_not_a_silent_allow(self, classify):
        result = classify("git init")
        # git init is approval-gated (ask), NEVER a silent allow — the Entry-1
        # catastrophe was a git init that ran unreviewed.
        assert decision_of(result) == "ask", result
        assert "init" in result[1].lower()

    def test_git_init_with_path_arg_is_gated(self, classify):
        assert decision_of(classify("git init /some/new/repo")) == "ask"

    def test_bare_flag_split_git_init_is_gated_E17(self, classify):
        # `git --bare init` — flag-split bypass variant. Must still be gated.
        assert decision_of(classify("git --bare init")) == "ask"

    def test_env_prefixed_git_init_is_gated_E17(self, classify):
        # An env prefix must not launder git init past the classifier.
        assert decision_of(classify("GIT_DIR=x git init")) == "ask"

    def test_safe_git_command_is_allowed(self, classify):
        # The classifier must not be a blunt "all git is dangerous" instrument.
        assert decision_of(classify("git status")) == "allow"

    def test_git_add_and_commit_are_allowed(self, classify):
        assert decision_of(classify("git add -A")) == "allow"
        assert decision_of(classify("git commit -m 'work'")) == "allow"

    def test_branch_creation_checkout_b_is_allowed(self, classify):
        assert decision_of(classify("git checkout -b feature/x")) == "allow"


# ---------------------------------------------------------------------------
# E32 — the scope-amendment cherry-pick carveout
# ---------------------------------------------------------------------------

class TestCherryPickCarveout:
    def test_generic_cherry_pick_is_gated(self, classify):
        # A cherry-pick that is NOT provably spec-only stays governed (ask).
        assert decision_of(classify("git cherry-pick abc123")) == "ask"

    def test_cherry_pick_helper_spec_only_detection(self, classify_module):
        # The carveout predicate itself: with no repo facts it must FAIL CLOSED
        # (cannot prove spec-only -> False -> the generic ask path).
        from pathlib import Path
        import tempfile
        tmp = Path(tempfile.mkdtemp(prefix="caws-cp-"))
        try:
            # Unresolvable sha in an empty repo: cannot prove spec-only -> False.
            assert classify_module.cherry_pick_touches_only_specs("git cherry-pick deadbeef", tmp) is False
        finally:
            import shutil
            shutil.rmtree(tmp, ignore_errors=True)


# ---------------------------------------------------------------------------
# Hard-block (deny) class — catastrophic / irreversible / credential ops
# ---------------------------------------------------------------------------

class TestDenyClass:
    @pytest.mark.parametrize("cmd", [
        "git reset --hard",
        "git reset --hard HEAD~3",
        "git push --force origin main",
        "git push -f origin main",
        "git clean -fd",
        "git checkout .",
        "git restore .",
    ])
    def test_catastrophic_git_ops_are_denied(self, classify, cmd):
        assert decision_of(classify(cmd)) == "deny", cmd

    @pytest.mark.parametrize("cmd", [
        "mkfs.ext4 /dev/sda1",
        "chmod 777 /etc",
        "shutdown now",
    ])
    def test_system_destruction_is_denied(self, classify, cmd):
        assert decision_of(classify(cmd)) == "deny", cmd

    def test_credential_file_read_is_denied(self, classify):
        assert decision_of(classify("cat ~/.ssh/id_rsa")) == "deny"

    def test_naked_rm_on_spec_yaml_is_denied(self, classify):
        # Bypassing `caws specs close|archive` via naked rm is a deny.
        assert decision_of(classify("rm .caws/specs/FOO-1.yaml")) == "deny"


# ---------------------------------------------------------------------------
# Quote-safety + segmentation — the classifier must not false-positive
# ---------------------------------------------------------------------------

class TestQuoteSafetyAndSegmentation:
    def test_echo_of_a_dangerous_string_is_allowed(self, classify):
        # The dangerous text is QUOTED data, not an executed command. The
        # quote-stripping must prevent a false positive.
        assert decision_of(classify('echo "git reset --hard"')) == "allow"

    def test_echo_of_rm_rf_string_is_allowed(self, classify):
        assert decision_of(classify('echo "rm -rf /"')) == "allow"

    def test_pipeline_takes_the_most_restrictive_segment(self, classify):
        # safe && dangerous -> the dangerous segment governs (deny wins).
        assert decision_of(classify("git status && git reset --hard")) == "deny"

    def test_safe_pipeline_stays_allow(self, classify):
        assert decision_of(classify("git status && git log --oneline")) == "allow"


# ---------------------------------------------------------------------------
# Pure helper functions (mutation-rich, deterministic)
# ---------------------------------------------------------------------------

class TestPureHelpers:
    def test_detect_git_subcommand(self, classify_module):
        assert classify_module.detect_git_subcommand("git init") == "init"
        assert classify_module.detect_git_subcommand("git status") == "status"
        assert classify_module.detect_git_subcommand("git checkout -b x") == "checkout"

    def test_strip_quotes(self, classify_module):
        assert classify_module.strip_quotes('"hello"') == "hello"
        assert classify_module.strip_quotes("'world'") == "world"
        assert classify_module.strip_quotes("bare") == "bare"

    def test_command_basename(self, classify_module):
        assert classify_module.command_basename("/usr/bin/git") == "git"
        assert classify_module.command_basename("git") == "git"

    def test_is_assignment_token(self, classify_module):
        assert classify_module.is_assignment_token("FOO=bar") is True
        assert classify_module.is_assignment_token("git") is False

    def test_segment_command_splits_on_operators(self, classify_module):
        segs = classify_module.segment_command("a && b ; c | d")
        # Each operator boundary yields a distinct segment.
        joined = " ".join(segs)
        assert "a" in joined and "b" in joined and "c" in joined and "d" in joined
        assert len(segs) >= 4


# ---------------------------------------------------------------------------
# Decision matrix — emits the ACTUAL classifier tuples as a runtime artifact
# (run with `pytest -s` to see the table) AND asserts the matrix is internally
# consistent (the three decision classes are non-empty and disjoint).
# ---------------------------------------------------------------------------

class TestDecisionMatrixArtifact:
    # (command, expected_decision) — the lineage-anchored decision matrix.
    MATRIX = [
        ("git status", "allow"),
        ("git checkout -b feature/x", "allow"),
        ('echo "rm -rf /"', "allow"),
        ("git init", "ask"),
        ("git --bare init", "ask"),
        ("git cherry-pick abc123", "ask"),
        ("git reset --hard", "deny"),
        ("git push --force origin main", "deny"),
        ("mkfs.ext4 /dev/sda1", "deny"),
        ("rm .caws/specs/FOO-1.yaml", "deny"),
    ]

    def test_decision_matrix_emits_artifact_and_is_consistent(self, classify, capsys):
        rows = []
        seen = {"allow": 0, "ask": 0, "deny": 0}
        for cmd, expected in self.MATRIX:
            decision, reason, source, enforcement = classify(cmd)
            rows.append((decision, enforcement, source, cmd, expected))
            assert decision == expected, f"{cmd!r}: got {decision}, expected {expected}"
            seen[decision] += 1

        # Emit the concrete artifact: the real (decision, enforcement, source)
        # tuples the SHIPPED classifier produced for each lineage-anchored command.
        with capsys.disabled():
            print("\n--- CAWS classify_command decision matrix (runtime artifact) ---")
            for decision, enforcement, source, cmd, _ in rows:
                print(f"  {decision:5s} | enf={enforcement:9s} | src={source:14s} | {cmd!r}")

        # The matrix exercises all three decision classes (not all-allow / all-deny).
        assert seen["allow"] >= 1 and seen["ask"] >= 1 and seen["deny"] >= 1, seen
