#!/usr/bin/env python3
"""Falsify a candidate daemon in a disposable copy; never touch a live lease.

Only child processes started by this experiment may be terminated. Counterexamples
are successful experiments, but an adoption refusal. Loopback traffic stays local.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import shutil
import socket
import subprocess
import sys
import time
from source_freshness import instrument, qualify_source_change


def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--candidate-hooks', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    root = args.output.resolve()
    root.mkdir(parents=True, exist_ok=False)
    candidate = root / 'candidate'
    candidate.mkdir()
    (candidate / 'lib').mkdir()
    source_names = ['session_log_daemon.py', 'session_log_renderer.py', 'lib/session-log-daemon-client.sh']
    source_names += [str(p.relative_to(args.candidate_hooks)) for p in (args.candidate_hooks / 'lib').glob('harness_*.py')]
    for name in source_names:
        shutil.copy2(args.candidate_hooks / name, candidate / name)
    source_hashes = {name: sha(candidate / name) for name in source_names}
    source = candidate / 'session_log_renderer.py'
    instrument(source)
    logs = root / 'session'
    logs.mkdir()
    transcript = root / 'transcript.jsonl'
    transcript.write_text(json.dumps({'type':'user','message':{'content':'Keep this request.'},'timestamp':'2026-09-12T12:00:00Z'})+'\n'+
                          json.dumps({'type':'assistant','message':{'content':[{'type':'text','text':'An observable response.'}]},'timestamp':'2026-09-12T12:00:01Z'})+'\n')
    audit, outcomes = root / 'audit.jsonl', root / 'outcomes.jsonl'
    audit.write_text('')
    outcomes.write_text('')
    lease_file = root / 'owned-daemon.json'
    argv = [sys.executable,str(candidate / 'session_log_daemon.py'),'--hooks-dir',str(candidate),
            '--lease-file',str(lease_file),'--idle-s','5']
    env = {'PATH':os.environ['PATH'],'HOME':str(root),'PYTHONDONTWRITEBYTECODE':'1'}
    results = []
    with (root / 'daemon.stdout').open('wb') as stdout, (root / 'daemon.stderr').open('wb') as stderr:
        child = subprocess.Popen(argv,env=env,stdout=stdout,stderr=stderr,cwd=root)
        try:
            deadline = time.monotonic()+10
            while not lease_file.exists() and child.poll() is None and time.monotonic()<deadline:
                time.sleep(.05)
            if not lease_file.exists():
                raise RuntimeError('candidate did not publish its isolated lease; inspect daemon.stderr')
            lease = json.loads(lease_file.read_text())
            if lease['pid'] != child.pid:
                raise RuntimeError('lease is not owned by the experiment child')
            fields = [str(logs),str(root),'fixture-session','start','model','main','head','0','start',
                      str(transcript),str(audit),str(outcomes)]

            def request(label):
                with socket.create_connection(('127.0.0.1',lease['port']),timeout=5) as connection:
                    connection.sendall(('\x1f'.join([lease['token'],*fields])+'\n').encode())
                    response = connection.recv(4096).decode()
                (root / (label+'.response')).write_text(response)
                return response

            first = request('cold')
            target = logs / 'turn-001.json'
            if not first.startswith('ok ') or not target.exists():
                raise RuntimeError('cold control did not render a turn')
            shutil.copy2(target,root / 'cold-turn.json')
            before = sha(target)
            outcomes.write_text(json.dumps({'session_id':'fixture-session','timestamp':'2026-09-12T12:00:02Z',
                'handler':'new-guard-outcome','status':'block','stdout':'{"decision":"block","reason":"new observation"}',
                'stderr':'','exit_code':2})+'\n')
            response = request('sidecar-change')
            results.append({'scenario':'sidecar-only-change','response':response.strip(),
                            'before_sha256':before,'after_sha256':sha(target),
                            'new_observation_present':'new-guard-outcome' in target.read_text(),
                            'counterexample':sha(target)==before})
            shutil.copy2(target,root / 'sidecar-turn.json')
            target.write_text('corrupted same-count artifact')
            response = request('corrupted-output')
            results.append({'scenario':'same-count-output-corruption','response':response.strip(),
                            'output':target.read_text(), 'counterexample':target.read_text()=='corrupted same-count artifact'})
            # Restore the earlier corrupt output so source freshness is tested
            # independently, with same-size executable source and a fresh control.
            shutil.copy2(root / 'cold-turn.json', target)
            render_kwargs = dict(zip(('log_dir','cwd','session_id','started_at','model',
                'branch','head_sha','dirty_count','start_sha','transcript_path',
                'audit_path','hook_outcome_path'), fields))
            results.append(qualify_source_change(source, logs, root, render_kwargs, request))
        finally:
            if child.poll() is None:
                child.terminate()
            child.wait(timeout=10)
    # Controlled PID-reuse surrogate. This is our unrelated child, not an agent.
    sleeper = subprocess.Popen([sys.executable,'-c','import time; time.sleep(30)'],env=env,cwd=root)
    try:
        forged = root / 'stale-child-lease.json'
        forged.write_text(json.dumps({'pid':sleeper.pid,'last_used':0,'idle_s':1}))
        command = ['/bin/bash','-c','source "$1"; slrd_reap_if_expired "$2"','-',
                   str(candidate / 'lib/session-log-daemon-client.sh'),str(forged)]
        reaper = subprocess.run(command,env=env,cwd=root,capture_output=True,timeout=10)
        try:
            sleeper.wait(timeout=2)
        except subprocess.TimeoutExpired:
            pass
        results.append({'scenario':'unbound-pid-in-expired-lease','argv':command,'exit_code':reaper.returncode,
                        'owned_child_pid':sleeper.pid,'child_exit_code':sleeper.poll(),
                        'counterexample':sleeper.poll() is not None})
    finally:
        if sleeper.poll() is None:
            sleeper.terminate()
        sleeper.wait(timeout=5)
    report = {'schema':'caws.daemon_qualification.v1','candidate':str(args.candidate_hooks),
              'source_sha256':source_hashes,'daemon_argv':argv,'daemon_exit_code':child.returncode,
              'results':results,'adoption':'refused' if any(row['counterexample'] for row in results) else 'unproven',
              'not_verified':['Native hook latency','Simultaneous fallback/writer races','Actual OS PID reuse'],
              'next_required':['Hash sidecars and output bytes in skip key','Hash code content',
                               'Remove reaper or bind process start identity','Serialize fallback writers before snapshot reads']}
    (root / 'qualification.json').write_text(json.dumps(report,indent=2)+'\n')
    print(json.dumps(report,indent=2))
    # Exit 0 means the experiment completed. A repaired candidate need not
    # reproduce every defect; adoption is a separate, deliberately bounded field.
    return 0


if __name__ == '__main__':
    sys.exit(main())
