"""Read-only commands must not draw a risk signal; mutating ones must keep it.

CAWS-GUARD-FALSE-SIGNALS-001. Field harvest (../rc, Oct-Nov 2026): the read-only
git subcommands below drew thousands of "unknown git subcommand ... ask before
invoking" advisories, and `curl -G --data-urlencode` (a GET with a query
string) was classified HTTP_MUTATE, a capability ask whose second occurrence
arms the session danger latch. Each read-only case is paired with the hostile
form that must stay governed.
"""

import pytest


# --- git: read-only subcommands are admitted without an advisory ------------

READ_ONLY_GIT = [
    "git grep -n foo",
    "git grep -e pattern -- '*.py'",
    "git grep -eO",  # -e consumes "O" as the pattern; this is not -O
    "git grep -e -O foo",  # -e consumes the next token "-O" as the pattern
    "git grep -f -O foo",  # -f consumes "-O" as the pattern file name
    "git merge-base main HEAD",
    "git merge-base --is-ancestor abc123 main",
    "git ls-tree -r HEAD",
    "git for-each-ref refs/heads --format='%(refname)'",
    "git show-ref --heads",
    "git check-attr -a README.md",
    "git diff-tree --no-commit-id --name-only -r HEAD",
    "git -C /tmp/somewhere grep foo",
]


@pytest.mark.parametrize("cmd", READ_ONLY_GIT)
def test_read_only_git_subcommand_is_allowed_without_advisory(classify, cmd):
    decision, reason, _source, enforcement = classify(cmd)
    assert (decision, reason, enforcement) == ("allow", "", "pass"), cmd


# git grep -O / --open-files-in-pager launches an external program on the
# matching files, so grep is admitted only without it. git accepts any
# unambiguous abbreviation of a long option, and -O may sit inside a cluster.
GREP_OPENS_PROGRAM = [
    "git grep -O foo",
    "git grep -Ovim foo",
    "git grep -nO foo",
    "git grep --open-files-in-pager foo",
    "git grep --open-files-in-pager=less foo",
    "git grep --open foo",
    "git grep --op foo",
    # -e consumes "--" as its pattern, so the -O after it is a live option.
    # Observed: `git grep -e -- -Oecho -- CLAUDE.md` ran echo on the match.
    "git grep -e -- -Ovim",
    "git grep -n -e pattern -O",
]


@pytest.mark.parametrize("cmd", GREP_OPENS_PROGRAM)
def test_git_grep_that_opens_a_program_keeps_its_ask(classify, cmd):
    decision, reason, source, enforcement = classify(cmd)
    assert (decision, source, enforcement) == ("ask", "legacy_family", "advisory"), cmd
    assert "--open-files-in-pager" in reason, (cmd, reason)


def test_git_diff_tree_writing_an_output_file_keeps_its_ask(classify):
    decision, reason, source, enforcement = classify(
        "git diff-tree --output=/tmp/d.txt -p HEAD"
    )
    assert (decision, source, enforcement) == ("ask", "legacy_family", "advisory")
    assert "--output" in reason


@pytest.mark.parametrize(
    "cmd,sub",
    [
        ("git merge feature", "merge"),
        ("git push origin main", "push"),
        ("git fetch origin", "fetch"),
        ("git apply patch.diff", "apply"),
        ("git archive -o out.tar HEAD", "archive"),
    ],
)
def test_mutating_git_subcommand_keeps_its_unknown_subcommand_ask(classify, cmd, sub):
    decision, reason, source, enforcement = classify(cmd)
    assert (decision, source, enforcement) == ("ask", "legacy_family", "advisory"), cmd
    assert f"unknown git subcommand: {sub}" in reason, reason


# --- curl: -G/--get turns request data into a query string -----------------

CURL_GET_WITH_DATA = [
    'curl -s -G "https://commons.wikimedia.org/w/api.php" --data-urlencode "action=query" | jq .',
    "curl -sG https://example.test/api --data-urlencode q=x",
    "curl --get -d q=x https://example.test/api",
    "curl -G -d q=x https://example.test/api",
    "curl -G -X GET -d q=x https://example.test/api",
    "curl -s https://example.test/api",
    "curl -G --user-agent probe -d q=x https://example.test/api",
    # Each transfer is read on its own; both of these are GETs.
    "curl -G -d a=1 https://example.test/r --next -G -d b=2 https://example.test/s",
    # curl reads nothing after -- as an option (observed: `-- -v` became a URL).
    "curl -G -d q=x https://example.test/api -- -X POST",
]


@pytest.mark.parametrize("cmd", CURL_GET_WITH_DATA)
def test_curl_get_request_is_not_classified_as_mutation(classify, cmd):
    decision, reason, _source, _enforcement = classify(cmd)
    assert decision == "allow", (cmd, reason)
    assert "HTTP_MUTATE" not in reason


CURL_MUTATIONS = [
    "curl -G -X POST -d q=x https://example.test/api",
    "curl -X DELETE https://example.test/api/1",
    "curl -XPUT https://example.test/api/1",
    "curl -sXPOST https://example.test/api",
    "curl -d q=x https://example.test/api",
    "curl -sd q=x https://example.test/api",
    "curl --data-raw x https://example.test/api",
    "curl --data-urlencode q=x https://example.test/api",
    # -d consumes the next token as the request body, so this "-G" is data,
    # not the --get flag: curl sends a POST.
    "curl -d -G https://example.test/api",
    # The last -X wins in curl.
    "curl -X GET -X POST https://example.test/api",
    # A long option consumes its value: curl sends the body "-G" here, and in
    # the second command "-G" is a header value (observed via --libcurl:
    # POSTFIELDS "-G"; header "-G" plus POSTFIELDS "q=x").
    "curl --data -G https://example.test/api",
    "curl --header -G -d q=x https://example.test/api",
    # --next resets -G: the second transfer posts q=y (observed via --libcurl).
    "curl -G -d q=x https://example.test/read --next -d q=y https://example.test/write",
    "curl -G -d q=x https://example.test/read -: -d q=y https://example.test/write",
    "curl -G -d q=x https://example.test/read -s: -d q=y https://example.test/write",
    # --no-get turns get mode back off.
    "curl -G --no-get -d q=x https://example.test/api",
    # A long option curl 8.7.1 does not list may take the next token as its
    # value, so that token cannot switch on get mode.
    "curl --some-newer-option -G -d q=x https://example.test/api",
]


@pytest.mark.parametrize("cmd", CURL_MUTATIONS)
def test_curl_request_body_or_mutating_method_is_classified_as_mutation(classify, cmd):
    decision, reason, source, enforcement = classify(cmd)
    assert (decision, source, enforcement) == ("ask", "capability", "confirm"), cmd
    assert reason == "state mutation (HTTP_MUTATE)", (cmd, reason)


def test_curl_explicit_non_mutating_method_with_data_keeps_the_prior_classification(classify):
    # The prior rule judged an explicit method by name alone, so `-X GET -d`
    # (a GET with a body, as in read-only search APIs) was not a mutation.
    # This slice leaves that unchanged; it does not decide the policy.
    for cmd in (
        "curl -X GET -d q=x https://example.test/api",
        "curl -X HEAD -d q=x https://example.test/api",
    ):
        decision, reason, _source, _enforcement = classify(cmd)
        assert decision == "allow", (cmd, reason)


def test_curl_transfers_reads_clusters_consumed_arguments_and_transfer_breaks(classify_module):
    transfers = classify_module.curl_transfers
    assert transfers(["-sG", "--data-urlencode", "q=x", "https://e.test"]) == [("", True, True)]
    assert transfers(["-sd", "q=x", "https://e.test"]) == [("", True, False)]
    assert transfers(["-sXPOST", "https://e.test"]) == [("POST", False, False)]
    assert transfers(["-d", "-G", "https://e.test"]) == [("", True, False)]
    assert transfers(["-H", "-G", "https://e.test"]) == [("", False, False)]
    assert transfers(["--header", "-G", "https://e.test"]) == [("", False, False)]
    assert transfers(["--data", "-G", "https://e.test"]) == [("", True, False)]
    assert transfers(["--request", "patch", "https://e.test"]) == [("PATCH", False, False)]
    assert transfers(["-X", "GET", "-X", "POST"]) == [("POST", False, False)]
    assert transfers(["-G", "-d", "a", "u1", "--next", "-d", "b", "u2"]) == [
        ("", True, True),
        ("", True, False),
    ]
    assert transfers(["-G", "-d", "a", "u1", "-s:", "-d", "b", "u2"]) == [
        ("", True, True),
        ("", True, False),
    ]
    assert transfers(["-G", "-d", "a", "u", "--", "-X", "POST"]) == [("", True, True)]
    assert transfers(["--unlisted-option", "-G", "-d", "a", "u"]) == [("", True, False)]
    assert transfers(["--no-silent", "-G", "-d", "a", "u"]) == [("", True, True)]


def test_curl_option_tables_are_disjoint_and_hold_the_body_options(classify_module):
    cc = classify_module
    assert not (cc._CURL_ARG_LONG_OPTS & cc._CURL_BOOL_LONG_OPTS)
    for name in ("data", "data-raw", "data-binary", "data-urlencode", "header", "request"):
        assert name in cc._CURL_ARG_LONG_OPTS, name
    for name in ("get", "next", "silent", "location"):
        assert name in cc._CURL_BOOL_LONG_OPTS, name
