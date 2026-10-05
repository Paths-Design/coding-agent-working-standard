"""Classifier admission of lockfile-only and index-only restores.

CAWS-DEFECT-CANONICAL-GUARD-NO-SANCTIONED-LOCKFILE-RESTORE-01. A path restore
whose EVERY target is a package-manager lockfile is regenerable, and
`git restore --staged <path>` changes only the index; the classifier admits both.
Under bypass mode an "ask" is a block, so an ask here would undo the guard's
admission. Every other restore stays "ask" (or "deny" for `.`), and a refusal
reason names an alternative that applies.
"""

import pytest

LOCKFILES = [
    "package-lock.json",
    "npm-shrinkwrap.json",
    "yarn.lock",
    "pnpm-lock.yaml",
    "bun.lockb",
    "Cargo.lock",
    "poetry.lock",
    "uv.lock",
    "Gemfile.lock",
    "composer.lock",
    "go.sum",
]


def decision(result):
    return result[0]


@pytest.mark.parametrize(
    "command",
    [
        "git checkout package-lock.json",
        "git checkout -- package-lock.json",
        "git restore package-lock.json",
        "git restore -- package-lock.json",
        "git checkout web/yarn.lock",
        "git restore package-lock.json web/yarn.lock",
    ],
)
def test_lockfile_only_restore_is_allowed(classify, command):
    assert classify(command)[:2] == ("allow", "")


@pytest.mark.parametrize("name", LOCKFILES)
def test_every_listed_lockfile_is_allowed_at_any_depth(classify, name):
    assert classify(f"git restore {name}")[:2] == ("allow", "")
    assert classify(f"git checkout -- a/b/{name}")[:2] == ("allow", "")


@pytest.mark.parametrize(
    "command",
    [
        "git checkout package-lock.json src/index.ts",
        "git checkout -- package-lock.json src/index.ts",
        "git restore package-lock.json src/index.ts",
        "git checkout main package-lock.json",
        "git restore --source=HEAD~1 package-lock.json",
        "git restore -p package-lock.json",
        "git checkout -f package-lock.json",
        "git checkout package-lock.json.bak",
        "git restore web/*",
    ],
)
def test_lockfile_exemption_does_not_widen(classify, command):
    assert decision(classify(command)) == "ask"


def test_checkout_of_a_branch_is_still_ask(classify):
    result = classify("git checkout main")
    assert decision(result) == "ask"
    assert "only `checkout -b` and a restore of package-manager lockfiles" in result[1]


def test_lockfile_restore_chained_to_a_dangerous_command_takes_the_worst(classify):
    assert decision(classify("git checkout package-lock.json; git reset --hard")) == "deny"
    assert decision(classify("git restore package-lock.json && git restore src/a.ts")) == "ask"


@pytest.mark.parametrize(
    "command",
    [
        "git restore --staged src/index.ts",
        "git restore -S src/index.ts",
        "git restore --staged -- src/index.ts",
        "git restore --staged .",
    ],
)
def test_index_only_restore_is_allowed(classify, command):
    assert classify(command)[:2] == ("allow", "")


@pytest.mark.parametrize(
    "command",
    [
        "git restore --staged --worktree src/index.ts",
        "git restore --staged --source=HEAD~1 src/index.ts",
        "git restore --staged -p src/index.ts",
    ],
)
def test_staged_restore_with_other_effects_is_ask(classify, command):
    assert decision(classify(command)) == "ask"


def test_restore_of_source_is_ask_with_an_applicable_alternative(classify):
    result = classify("git restore src/index.ts")
    assert decision(result) == "ask"
    assert result[1] == (
        "git restore of a path other than a package-manager lockfile discards "
        "uncommitted work (only `--staged` and lockfile-only restores are "
        "auto-admitted); ask before invoking"
    )


@pytest.mark.parametrize("command", ["git restore .", "git checkout ."])
def test_discard_everything_stays_denied(classify, command):
    assert decision(classify(command)) == "deny"
