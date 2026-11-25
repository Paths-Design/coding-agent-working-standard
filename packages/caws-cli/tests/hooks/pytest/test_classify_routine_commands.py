"""Routine commands the danger latch locked sessions over.

CAWS-LATCH-ROUTINE-COMMANDS-001. Of 31 latch resets recorded between 2026-10-26
and 2026-11-25, sixteen were a `kill` of explicit process IDs and two were a
file name containing "reboot". Paths here are stand-ins for the recorded ones.

A kill by process ID stays an ask that block-dangerous.sh refuses; its source
tells the hook not to arm the latch. reboot and shutdown are denied where a
shell or a launcher would run them, and not where a command only names them.
The refused corpora pair each admitted family with the command it must not let
through.
"""

import pytest

REBOOT = "system shutdown/reboot"


def denied_as_reboot(result):
    return result[0] == "deny" and REBOOT in result[1]


# --- reboot and shutdown as data ---------------------------------------------

@pytest.mark.parametrize("command", [
    # Two recorded resets: an artifact whose name contains the word.
    "node scripts/clean.mjs --retain /art/license-marker-after-reboot-20261026.json",
    "ls -l pkg/.license.json /art/license-marker-after-reboot-20261026.json",
    # A recorded latch that was never reset.
    "last -n 8 reboot shutdown",
    "grep -rn shutdown src",
    "rg reboot docs | head -5",
    "git log --grep reboot --oneline",
    "git checkout -b fix/graceful-shutdown",
    "git add src/shutdown.ts tests/reboot.test.js",
    "man shutdown",
    "which reboot",
    "command -v shutdown",
    "type reboot",
    "cat logs/reboot.log",
    "head -n 3 notes/shutdown.md",
    "npx jest tests/shutdown.test.js",
    "python3 -m pytest tests/test_reboot.py",
    "caws specs show SHUTDOWN-HOOK-001",
    "echo reboot",
    "for word in reboot shutdown; do grep -c $word log.txt; done",
    "jq .shutdown config.json",
    "cat notes.txt > shutdown-notes.txt",
    "ls src 2>/dev/null > reboot-list.txt",
    "ls src # reboot",
    "# shutdown\nls src",
    "grep -rn 'shutdown' src | node report.js",
    "docker exec web grep \"reboot\" /var/log/syslog",
    "ssh host 'grep reboot /var/log/syslog'",
    "bash -c 'grep -c shutdown log.txt'",
    "cat > notes.md <<'EOF'\nreboot\nshutdown now\nEOF\nls notes.md",
    "git commit -m 'reboot handling' -- a.txt",
    "git commit -F - <<'EOF'\nReboot handling\n\nshutdown is data here\nEOF",
    # A message body may hold quotes and lines that begin with the word.
    "git commit -m \"$(cat <<'EOF'\nfix: say \"reboot\"\n\nReboot the pump; shutdown later.\nEOF\n)\" -- a.txt",
    "x=$(grep -c reboot log.txt); echo $x",
    "x=`grep -c reboot log.txt`; echo $x",
])
def test_naming_reboot_is_not_running_it(classify, command):
    result = classify(command)
    assert not denied_as_reboot(result), f"{command}: {result}"


# --- reboot and shutdown as commands -----------------------------------------

@pytest.mark.parametrize("command", [
    "reboot",
    "shutdown now",
    "shutdown -h +5",
    "REBOOT",
    "/sbin/reboot",
    "/usr/sbin/shutdown -r now",
    "./reboot.sh",
    "shutdown.exe /r /t 0",
    "LANG=C reboot",
    "A=1 B=2 shutdown now",
    "env X=1 reboot",
    "env -i reboot",
    "command reboot",
    "builtin reboot",
    "exec reboot",
    "exec -a x reboot",
    "nohup reboot",
    "time reboot",
    "time -p shutdown now",
    "nice -n 5 reboot",
    "timeout 5 reboot",
    "timeout -k 1 5 shutdown now",
    "setsid reboot",
    "stdbuf -o0 reboot",
    "caffeinate -i reboot",
    "sudo -n reboot",
    "doas reboot",
    "su root -c reboot",
    "! reboot",
    "true && reboot",
    "false || reboot",
    "true; reboot",
    "true & reboot",
    "reboot &",
    "true\nreboot",
    "true | reboot",
    "reboot > out.log",
    ">out.log reboot",
    "2>/dev/null reboot",
    "2>&1 reboot",
    "reboot>/dev/null",
    "(reboot)",
    "( true; reboot )",
    "{ reboot; }",
    "if true; then reboot; fi",
    "if reboot; then :; fi",
    "if a; then b; elif reboot; then c; fi",
    "if a; then b; else reboot; fi",
    "while true; do reboot; done",
    "until reboot; do :; done",
    "for i in 1; do reboot; done",
    "case $x in a) reboot;; esac",
    "f() { reboot; }; f",
    "f() { reboot\n}; f",
    "function f { reboot; }; f",
    "coproc reboot",
    "echo $(reboot)",
    "echo `reboot`",
    'echo "$(reboot)"',
    "diff <(reboot) x",
    "bash -c reboot",
    "bash -c 'true; reboot'",
    "sh -c \"shutdown now\"",
    "bash reboot.sh",
    "source reboot.sh",
    ". ./shutdown.sh",
    "eval reboot",
    "trap reboot EXIT",
    "alias r=reboot; r",
    "x=reboot; $x",
    "x=/sbin/reboot; $x",
    "export RUN=shutdown; $RUN now",
    "a=(reboot now); \"${a[@]}\"",
    "set -- reboot; \"$@\"",
    "{reboot,now}",
    "/sbin/{reboot,x}",
    "xargs reboot",
    "echo now | xargs shutdown",
    "echo reboot | xargs -n1 env",
    "echo reboot | at now",
    "printf reboot | sh",
    "echo reboot > x; bash x",
    "find . -exec reboot ;",
    "find . -name x -execdir shutdown now +",
    "parallel reboot ::: 1",
    "watch reboot",
    "ssh host reboot",
    "ssh -p 22 user@host sudo reboot",
    "systemctl reboot",
    "systemctl --no-block reboot",
    "loginctl reboot",
    "launchctl reboot system",
    "busybox reboot",
    "docker exec web reboot",
    "docker run --rm image reboot",
    "podman exec web shutdown now",
    "kubectl exec pod -- reboot",
    "adb reboot",
    "virsh shutdown vm",
    "aws ec2 reboot-instances --instance-ids i-1",
    "doctl compute droplet-action reboot 1",
    "git bisect run reboot",
    "git submodule foreach reboot",
    "git rebase --exec reboot main",
    "ln -s /sbin/reboot x && ./x",
    "cp /sbin/reboot x; ./x",
    "grep reboot log; reboot",
    "last reboot && shutdown now",
    # Found by running generated commands in a real shell with stub programs.
    "'reboot' now",
    '"shutdown"',
    "\\reboot",
    "re'boot'",
    "x=\"reboot\"; $x",
    "trap \"reboot\" EXIT",
    "eval 'true; reboot'",
    "env -S \"reboot now\"",
    "script -qc 'reboot' /dev/null",
    "`echo reboot`",
    "x=$(echo reboot); $x",
    "eval \"$(echo reboot)\"",
    "for c in reboot; do $c; done",
    "echo reboot > s.sh; chmod +x s.sh; ./s.sh",
    "bash <<< reboot",
    "bash <<EOF\ntrue\nEOF\nreboot",
])
def test_running_reboot_is_denied(classify, command):
    result = classify(command)
    assert result[0] == "deny", f"{command}: {result}"


# --- kill by process ID -------------------------------------------------------

@pytest.mark.parametrize("command", [
    "kill 30339",
    "kill -INT 25828",
    "kill -TERM 64436 70156",
    "kill -9 1234",
    "kill -1 1234",
    "kill -SIGTERM 1234",
    "kill -s TERM 1234",
    "kill -n 15 1234",
    "kill -- 1234",
    "kill -TERM -- 1234",
    "kill -CONT 77081",
    "/bin/kill -INT 90559",
    "command kill 1234",
    "kill 14977 2>/dev/null",
    "kill 14977 >/dev/null 2>&1",
    "kill 14977 2> /dev/null",
    "kill 50835 50904 50960; sleep 1; pgrep -fl run_seq.py | grep -v pgrep",
    "ps -p 97774,97957 -o pid,command\nkill -INT 97774",
    "kill -TERM 33060 && caws specs amend-scope X-1 --add a.txt",
    "set -e\nif lsof -p 89409 | rg -Fx 89409; then\n  kill -TERM 89409\nfi\npnpm preview",
    "server --port 1 > out.log 2>&1 &\nPID=$!\nsleep 30\nkill \"$PID\" 2>/dev/null\nsleep 1",
    "sleep 9 &\nkill $!",
    "sleep 9 &\nP=$!; kill -TERM ${P}",
    "kill 1234; kill -9 5678",
    "bash -c 'kill 1234'",
    "echo $(kill 1234)",
])
def test_kill_by_process_id_is_refused_without_the_latch(classify, command):
    decision, reason, source, enforcement = classify(command)
    assert (decision, source, enforcement) == ("ask", "pid_kill", "confirm"), (command, reason)
    assert "PROC_KILL" in reason


@pytest.mark.parametrize("command", [
    "kill -1",
    "kill -9 -1",
    "kill -- -1",
    "kill 0",
    "kill -TERM 0",
    "kill 1",
    "kill -9 1",
    "kill 1234 1",
    "kill 1234 -1",
    "kill -9 -- -1234",
    "kill -TERM -1234",
    "kill %1",
    "kill $PID",
    "kill \"$PID\"",
    "kill $(pgrep node)",
    "kill -9 `cat server.pid`",
    "kill $(lsof -tiTCP:5262)",
    "kill 12{34,35}",
    "kill 12*",
    "kill 1234 > log.txt",
    "kill",
    "kill -l",
    "PID=1; kill $PID",
    "PID=$!; PID=-1; kill $PID",
    "PID=$!; read PID; kill $PID",
    "for PID in 1 2; do :; done; PID=$!; kill $PID",
    "PID=$!; printf -v PID -- -1; kill $PID",
    "pkill -f worker.py",
    "pkill -9 node",
    "killall node",
    "exec pkill -TERM -f worker",
    # Beside another risky operation, in either order.
    "kill 1234; pkill -f worker",
    "pkill -f worker; kill 1234",
    "kill 1234 && docker run alpine",
    "docker run alpine && kill 1234",
    "kill 1234; kill -1",
    "kill -1; kill 1234",
    "kill 1234; kill $(pgrep node)",
    "kill 1234; curl -X POST http://host/a",
])
def test_other_kills_keep_the_latch(classify, command):
    decision, reason, source, enforcement = classify(command)
    assert (decision, source, enforcement) == ("ask", "capability", "confirm"), (command, reason)


@pytest.mark.parametrize("command", [
    "kill 1234; git reset --hard",
    "git push --force origin main; kill 1234",
    "kill 1234 && rm -rf /",
    "sudo kill 1234",
    "kill 1234; reboot",
])
def test_a_denied_command_beside_a_kill_is_still_denied(classify, command):
    assert classify(command)[0] == "deny", command


def test_kill_zero_signal_probe_verdict_is_unchanged(classify):
    # `kill -0` only asks whether a process exists; it was a capability ask by
    # process ID before and is one of the refused-without-latch spellings now.
    result = classify("kill -0 1234")
    assert (result[0], result[2]) == ("ask", "pid_kill")
