"""Routine commands the danger latch locked sessions over.

CAWS-LATCH-ROUTINE-COMMANDS-001. Of 31 latch resets recorded between 2026-10-26
and 2026-11-25, sixteen were a `kill` of explicit process IDs and two were a
file name containing "reboot".

Both shapes are excepted only in a command that is plain from end to end:
literal words, separators, if/then/else/fi and file redirections. The corpora
below pair each excepted shape with neighbours that must keep the verdict they
had: a command the reader cannot read through, one that runs the word, and one
that does more than the shape. Many of those come from a review that broke an
earlier version and from generated commands run in a real shell.
"""

import time

import pytest

REBOOT = "system shutdown/reboot"


def denied_as_reboot(result):
    return result[0] == "deny" and result[1].endswith(REBOOT)


# --- reboot and shutdown as data ---------------------------------------------

NAMES_IT = [
    # The two recorded resets, with stand-in paths.
    "node scripts/clean.mjs --sha 06c4 --retain /art/license-marker-after-reboot-20261026.json --root /p",
    "caws specs show A-1 | tail -n 5; caws evidence list --json | node -e "
    "'let s=\"\";process.stdin.on(\"data\",x=>s+=x)'; ls -l p/.t.json /art/marker-after-reboot-1.json",
    # A recorded latch that was never reset.
    "last -n 8 reboot shutdown",
    "grep -rn shutdown src",
    "rg reboot docs | head -5",
    "cat log.txt | grep -c reboot",
    "which reboot",
    "type shutdown",
    "ls -l /sbin/reboot",
    "jq .shutdown config.json",
    "cat logs/reboot.log",
    "head -n 3 notes/shutdown.md 2>/dev/null",
    "diff a/shutdown.ts b/shutdown.ts",
    "grep -n x src/pre-reboot.sh",
    "echo reboot",
    "if grep -q reboot log.txt; then echo yes; else echo no; fi",
    "git add src/shutdown.ts tests/reboot.test.js",
    "git add src/shutdown.ts && git commit -m 'reboot handling' -- src/shutdown.ts",
    "git log -p -- src/shutdown.ts",
    "git checkout -b fix/graceful-shutdown",
    "mytool --in data.json tmp/after-reboot.json",
    "timeout 60 node report.mjs out/pre-shutdown.log",
    "npx prettier --check docs/safe-reboot.md",
    "cat notes.txt > shutdown-notes.txt",
]


@pytest.mark.parametrize("command", NAMES_IT)
def test_naming_reboot_in_a_plain_command_is_not_denied(classify, command):
    result = classify(command)
    assert not denied_as_reboot(result), f"{command}: {result}"


# Each of these was denied before and runs, or may run, the word.
RUNS_IT = [
    "reboot", "shutdown now", "shutdown -h +5", "REBOOT", "/sbin/reboot", "/usr/sbin/shutdown -r now",
    "./reboot.sh", "./after-reboot.sh", "shutdown.exe /r /t 0",
    # assignments and wrappers
    "LANG=C reboot", "A=1 B=2 shutdown now", "env X=1 reboot", "env -i reboot", "command reboot",
    "builtin reboot", "exec reboot", "exec -a x reboot", "nohup reboot", "time reboot",
    "time -p shutdown now", "nice -n 5 reboot", "timeout 5 reboot", "timeout -k 1 5 shutdown now",
    "setsid reboot", "stdbuf -o0 reboot", "caffeinate -i reboot",
    # compound statements
    "! reboot", "true && reboot", "false || reboot", "true; reboot", "true & reboot", "reboot &",
    "true\nreboot", "true | reboot", "reboot > out.log", ">out.log reboot", "2>/dev/null reboot",
    "2>&1 reboot", "reboot>/dev/null", "(reboot)", "( true; reboot )", "{ reboot; }",
    "if true; then reboot; fi", "if reboot; then echo a; fi", "if a; then b; elif reboot; then c; fi",
    "if a; then b; else reboot; fi", "while true; do reboot; done", "until reboot; do :; done",
    "for i in 1; do reboot; done", "case $x in a) reboot;; esac", "f() { reboot; }; f",
    "f() { reboot\n}; f", "function f { reboot; }; f", "coproc reboot",
    "if [[ -n x ]] then reboot; fi", "{ true } always { reboot }",
    # substitutions and expansions
    "echo $(reboot)", "echo `reboot`", "diff <(reboot) x", "`echo reboot`", "$(echo reboot)",
    'eval "$(echo reboot)"', "x=$(echo reboot); $x", '"$(echo reboot)"', "x=reboot; $x",
    "x=/sbin/reboot; $x", "export RUN=shutdown; $RUN now", 'a=(reboot now); "${a[@]}"',
    'set -- reboot; "$@"', "{reboot,now}", "/sbin/{reboot,x}", "for c in reboot; do $c; done",
    "${CMD:-shutdown} -h now", "${x:-reboot}", ": ${x:=reboot}; $x", "x=-reboot; ${x#-}",
    "a[0]=reboot; ${a[0]}", "reboot$@", "$@reboot", "/sbin/reboot*", "x=reboot\\ now; $x",
    "set -- a; for x do reboot; done", "command $(which reboot)", "nohup $(which reboot) &",
    "time $(which shutdown) now", "systemctl $(echo reboot)", "cp $(command -v reboot) x && ./x",
    "for c in reboot; do exec $c; done", 'f() { sudo "$@"; }; f reboot',
    "$(bash -c 'echo reboot')", "x=$(grep -c reboot log.txt); echo $x",
    # continuations and comments
    "true && \\\n  reboot", "make build && \\\n    shutdown -h now", "LANG=C \\\n  reboot",
    "cd /x && \\\n  systemctl reboot", "echo $(date)#; reboot", "echo `date`#; reboot",
    "echo $((1+1))#; reboot",
    # zsh
    "=reboot", "noglob reboot", "nocorrect reboot", "repeat 1 reboot", "cat x | noglob reboot",
    # shells and text
    "bash -c reboot", "bash -c 'true; reboot'", 'sh -c "shutdown now"', "tcsh -c reboot",
    "bash reboot.sh", "bash scripts/after-reboot.sh", "source reboot.sh", ". ./shutdown.sh",
    "eval reboot", "trap reboot EXIT", "alias r=reboot; r", "echo reboot | xargs -n1 env",
    "echo reboot | xargs", "echo reboot | xargs systemctl", "echo now | xargs shutdown", "echo reboot | at now",
    "echo reboot | csh", "echo reboot > x; bash x", "echo reboot > x; ./x",
    "echo reboot > s.sh; chmod +x s.sh; ./s.sh", "echo reboot > s.sh; chmod +x s.sh; nohup ./s.sh &",
    "cat scripts/reboot.sh > z; ./z", "cat a-reboot.json | cut -d- -f2 | xargs env",
    "ls a-reboot.json | awk 1", "bash -c 'echo reboot' | at now",
    # launchers, controllers and programs given the word
    "find . -exec reboot ;", "find . -name x -execdir shutdown now +", "fd . -x reboot", "parallel reboot ::: 1",
    "watch reboot", "ssh host reboot", "ssh -p 22 user@host reboot", "sshpass -p x ssh host reboot",
    "systemctl reboot", "systemctl --no-block reboot", "systemctl isolate reboot.target", "loginctl reboot",
    "machinectl reboot h", "launchctl reboot system", "launchctl kickstart system/com.apple.reboot",
    "busybox reboot", "docker exec web reboot", "docker-compose exec web reboot", "podman exec web shutdown now",
    "kubectl exec pod -- reboot", "adb reboot", "virsh shutdown vm", "aws ec2 reboot-instances --instance-ids i-1",
    "doctl compute droplet-action reboot 1", "ansible all -m reboot", "ansible-playbook reboot.yml",
    "ansible-playbook playbooks/rolling-reboot.yml", "pkexec reboot", "systemd-run reboot",
    "tmux new-session -d reboot", "ls | entr reboot", "arch -x86_64 reboot", "rg --pre reboot x", "rg --pre=reboot x",
    "man -P reboot ls", "python3 reboot.py", "node shutdown.js", "mytool reboot", "npx reboot",
    "curl http://10.0.0.1/reboot", "curl http://10.0.0.1/reboot/now", "dbus-send x.Manager.Reboot",
    "git bisect run reboot", "git submodule foreach reboot", "git -c core.pager=reboot log",
    "git -c core.fsmonitor=/sbin/reboot status", "git -c alias.x=!reboot x", "git rebase --exec=reboot main",
    "git rebase --exec reboot main", "git add --x=reboot", "git checkout reboot",
    "ln -s /sbin/reboot x && ./x", "cp /sbin/reboot x; ./x", "cp /sbin/reboot x",
    # beside an excepted shape
    "grep reboot log; reboot", "last reboot && shutdown now", "ls a-reboot.json; reboot",
    "last reboot; mytool x", "cat reboot.log > out.txt", "echo reboot > notes.txt", "git add src/shutdown.ts; ./x",
    "grep reboot x | tee y", "'ls' reboot", "true fix/shutdown-hook; trap './reboot' EXIT",
    "grep a-reboot.json x; script -qc 'shutdown now' /dev/null", "ls a-reboot.json; mytool 'reboot'",
]


@pytest.mark.parametrize("command", RUNS_IT)
def test_every_other_mention_is_denied_as_before(classify, command):
    result = classify(command)
    assert result[0] == "deny" and REBOOT in result[1], f"{command}: {result}"


# Beside another deny the reason may be that one's; the verdict is what counts.
@pytest.mark.parametrize("command", [
    "sudo -n reboot", "doas reboot", "su root -c reboot", "cat reboot.sh | sh", "printf reboot | sh",
    "true && \\\n  ssh n1 reboot", "cd /x && \\\n  sudo reboot",
])
def test_reboot_beside_another_denied_shape_is_denied(classify, command):
    assert classify(command)[0] == "deny", command


# The pattern never saw quoted words, so an exception must not start denying.
@pytest.mark.parametrize("command", [
    'LOG="logs/reboot.log"; tail -n 5 "$LOG"',
    'PATTERN="reboot"; grep -rn "$PATTERN" src',
    "TEST_NAME='shutdown' npx jest",
    "names=('shutdown' 'restart'); echo ${#names[@]}",
    'case "$x" in\n "start") echo a ;;\n "reboot") echo b ;;\nesac',
    "git commit -m 'reboot handling' -- a.txt",
    "git commit -F - <<'EOF'\nReboot handling\n\nshutdown is data here\nEOF",
    "cat > notes.md <<'EOF'\nreboot\nshutdown now\nEOF\nls notes.md",
    "docker exec web grep \"reboot\" /var/log/syslog",
])
def test_quoted_mentions_are_not_denied(classify, command):
    assert not denied_as_reboot(classify(command)), command


# --- kill by process ID -------------------------------------------------------

@pytest.mark.parametrize("command", [
    # The sixteen recorded resets, with stand-in paths.
    "kill -INT 25828",
    "/bin/kill -INT 90559",
    "kill 30339",
    'kill 50835 50904 50960 50964; sleep 1; pgrep -fl "run_seq.py|run_one.py" | grep -v pgrep; echo done',
    "/opt/Godot --path /p/godot res://tools/tabs.tscn > /p/tmp/tabs.log 2>&1 &\nPID=$!\nsleep 30\n"
    'kill "$PID" 2>/dev/null\nsleep 1\ncat /p/tmp/tabs.log | head -60',
    "kill -TERM 74559",
    "kill -TERM 76705",
    "kill -INT 47527",
    "kill -TERM 64436 70156",
    "kill -TERM 24841",
    "kill 14977",
    "kill -TERM 33060 && caws specs amend-scope X-1 --add engine/a.fbx.meta",
    "kill -TERM 89653",
    "ps -p 97774,97957 -o pid,ppid,etime,command\nkill -INT 97774",
    "kill -CONT 77081",
    "set -e\nif lsof -a -p 89409 -d cwd -Fn | rg -Fx 'n/p/screens' && lsof -a -p 89409 -t | rg -Fx 89409; then\n"
    "  kill -TERM 89409\nfi\npnpm preview --host 127.0.0.1 --port 5225 --strictPort",
    # Neighbouring spellings.
    "kill -9 1234", "kill -1 1234", "kill -0 1234", "kill -SIGTERM 1234", "kill -s TERM 1234", "kill -n 15 1234",
    "kill -- 1234", "kill -TERM -- 1234", "/usr/bin/kill 1234", "kill 14977 2>/dev/null",
    "kill 14977 >/dev/null 2>&1", "kill 14977 2> /dev/null", "kill 2", "kill 4194304", "kill 1234; kill -9 5678",
    "sleep 9 &\nkill $!", 'sleep 9 &\nSERVER_PID=$!; kill -TERM ${SERVER_PID}', 'sleep 9 &\nkill "$!"',
])
def test_a_plain_kill_by_process_id_is_marked(classify, command):
    result = classify(command)
    assert result == ("ask", "destructive operation (PROC_KILL)", "pid_kill", "confirm"), command


KEEPS_THE_LATCH = [
    # not one process
    "kill -1", "kill -9 -1", "kill -- -1", "kill 0", "kill -TERM 0", "kill 1", "kill -9 1", "kill 1234 1",
    "kill 1234 -1", "kill -9 -- -1234", "kill -TERM -1234", "kill %1", "kill 1234 %1", "kill", "kill -l", "kill -9",
    "kill 01234", "kill 4194305", "kill 4294967295", "kill 4294967297", "kill " + "9" * 5000,
    "kill 5678 '0'>/dev/null", "kill 5678 '1'>/dev/null",
    # not a literal signal
    "kill -s {TERM,-1} 1234", "kill -s $x 1234", "kill -s -1 1234", "kill -s 'TERM -1' 1234", "kill -q 1234",
    # read from elsewhere
    "kill $PID", 'kill "$PID"', "kill $(pgrep node)", "kill -9 `cat server.pid`", "kill $(lsof -tiTCP:5262)",
    "kill 12{34,35}", "kill 12*", "kill 12?4", "kill $((1234))", "PID=1; kill $PID", "PID=$!; PID=-1; kill $PID",
    "kill $PID; PID=$!", "PID=$!; read PID; kill $PID", "PID=$!; mytool PID; kill $PID",
    "PID=$!; eval \"PID=-1\"; kill -9 $PID", "PID=$!; kill $OTHER_PID",
    "_=$!; echo -1; kill -9 $_", "REPLY=$!; kill -9 $REPLY", "PID=$! kill -9 $PID", "(PID=$!); kill -9 $PID",
    "# PID=$!\nkill -9 $PID", "PID=$!; source env.sh; kill -9 $PID", "argv=$!; set -- -1; kill -9 $argv",
    "for PID in 1 2; do :; done; PID=$!; kill $PID", "PID=$!; printf -v PID -- -1; kill $PID",
    "PID=$!; kill x$PID", "PID=$!; kill -$PID", "PID=$!; kill '$PID'", 'PID=$!; kill "$PID', "PID=$!; echo $PID; kill $PID",
    # not the kill program, or not plain
    "./kill 1234", "/tmp/kill 1234", "command kill 1234", "kill() { command kill -9 -- -1; }; kill 1234",
    "alias kill=pkill; kill 1234", "enable -n kill; kill 1234", "hash -p /tmp/x kill; kill 1234", "'kill' 1234",
    "kill 1234 > log.txt", "kill 1234 # old", "kill 1234 \\\n", "(kill 1234)", "{ kill 1234; }", "! kill 1234",
    "bash -c 'kill 1234'", "echo $(kill 1234)", "kill 1234 <<< x", "kill 1234 | bash",
    # by name
    "pkill -f worker.py", "pkill -9 node", "killall node",
    # beside another operation, in either order
    "kill 1234; pkill -f worker", "pkill -f worker; kill 1234", "kill 1234 && docker run alpine",
    "docker run alpine && kill 1234", "kill 1234; kill -1", "kill -1; kill 1234", "kill 1234; kill $(pgrep node)",
    "kill 1234; curl -X POST http://host/a", "kill 1234; if pgrep -f x; then pkill -f x; fi",
    "kill 1234; timeout 5 pkill -f worker", "kill 1234; unknown-launcher pkill -f worker",
    "kill 1234; for p in $(pgrep node); do kill -9 $p; done", "kill 1234; cat <(pkill -f worker)",
    "kill 1234; python3 x.py", "kill 1234; node x.js", "kill 1234; env pkill x", "kill 1234; find . -delete",
    "kill 1234; npm publish", "kill 1234; gh repo delete x", "kill 1234; git rebase main",
]


@pytest.mark.parametrize("command", KEEPS_THE_LATCH)
def test_other_kills_are_not_marked(classify, command):
    assert classify(command)[2] != "pid_kill", command


@pytest.mark.parametrize("command", [
    c for c in KEEPS_THE_LATCH if c.startswith(("kill 1234; ", "kill 1234 &&", "kill -1", "kill 0"))
])
def test_a_kill_first_keeps_the_capability_ask(classify, command):
    result = classify(command)
    assert result[:1] + result[2:] == ("ask", "capability", "confirm"), f"{command}: {result}"


@pytest.mark.parametrize("command", [
    "kill 1234; git reset --hard", "git push --force origin main; kill 1234", "kill 1234 && rm -rf /",
    "sudo kill 1234", "kill 1234; reboot", "git reset --hard; kill " + "9" * 5000,
])
def test_a_denied_command_beside_a_kill_is_still_denied(classify, command):
    assert classify(command)[0] == "deny", command


# --- the reader ---------------------------------------------------------------

@pytest.mark.parametrize("character", list("$`\\(){}[]*?!#^\r\x0b") + [" ", "é"])
def test_the_reader_refuses_what_it_does_not_know(classify_module, character):
    assert classify_module.read_plain_command(f"ls a{character}b") is None
    assert classify_module.read_plain_command(f"ls {character}") is None


@pytest.mark.parametrize("text", [
    "a <<EOF\nx\nEOF", "a <<< x", "a <> x", "a >| x", "a <(b)", "a >(b)", "a |& b", "a ;; b", "a 'x", 'a "x', 'a "$x"',
    'a "`x`"', 'a "\\x"', 'a "!x"', "x=1", "x=1 a", "x+=1 a", "=ls", "for x", "while x", "time x", "a >", "a &>(b)",
])
def test_the_reader_refuses_what_it_cannot_read(classify_module, text):
    assert classify_module.read_plain_command(text) is None


def test_the_reader_reads_words_files_and_commands(classify_module):
    commands = classify_module.read_plain_command(
        "if a 'b c'\"d\" x=1 2>&1 >out 2>> err <in; then e& f&&g||h|i\nj; fi"
    )
    assert [[word.text for word in c.words] for c in commands if c.words] == [
        ["a", "b cd", "x=1"], ["e"], ["f"], ["g"], ["h"], ["i"], ["j"],
    ]
    assert commands[0].files == ["out", "err", "in"]


@pytest.mark.parametrize("text", [
    "reboot " + "a=$!;" * 20000,
    "kill 1;" * 20000,
    "ls reboot " + "'x'" * 40000,
    "kill 1234 " + "$(" * 2000,
    "grep reboot " + "a/" * 60000,
])
def test_reading_is_not_slow_on_long_input(classify_module, text):
    started = time.monotonic()
    classify_module.names_power_as_data(text)
    classify_module.is_plain_pid_kill(text)
    assert time.monotonic() - started < 2
