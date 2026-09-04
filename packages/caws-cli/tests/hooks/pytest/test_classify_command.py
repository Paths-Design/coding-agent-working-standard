"""
CAWS-DESIGN-GLOBAL-IDENTITY-HOME-001 A6 — leading-pathspec commit forms.

The classifier refused `git commit <path> -m <msg>` as a bare commit because
it only recognized the trailing `-- <paths>` form. Both shapes are
path-scoped: the author named their paths, git validates them. These tests
pin both forms and the still-governed truly-bare form.
"""


def test_leading_pathspec_commit_is_not_bare(classify):
    decision, *_ = classify('git commit .caws/specs/SPEC.yaml -m "spec(caws): test"')
    assert decision not in ("ask", "block"), f"leading-pathspec commit misclassified: {decision}"


def test_trailing_dashdash_pathspec_still_admitted(classify):
    decision, *_ = classify('git commit -m "spec(caws): test" -- .caws/specs/SPEC.yaml')
    assert decision not in ("ask", "block"), f"trailing -- pathspec regressed: {decision}"


def test_truly_bare_commit_still_governed(classify):
    decision, *_ = classify('git commit -m "bare"')
    assert decision == "ask", f"bare commit must stay governed (ask), got {decision}"
