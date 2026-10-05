#!/usr/bin/env python3
"""Stream a corpus census, then classify a deterministic stratified sample as data.

Historical outcomes are NOT labels. Captured cwd and environment are never used
as live authority. No raw commands or reasons are written to the report; byte
offsets and hashes allow a local reviewer to retrieve the original evidence.
"""
import argparse
from collections import Counter, defaultdict
import hashlib
import heapq
import importlib.util
import json
import os
from pathlib import Path
import signal
import subprocess
import sys
import time
from types import SimpleNamespace


class Deadline(BaseException):
    pass


class ForbiddenExecution(BaseException):
    pass


def worker(classifier):
    sys.dont_write_bytecode = True
    spec = importlib.util.spec_from_file_location('offline_classifier',classifier)
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    sys.path.insert(0,str(classifier.parent))
    spec.loader.exec_module(module)
    probes = []
    def no_process(argv, **kwargs):
        probes.append('subprocess_context_probe')
        return subprocess.CompletedProcess(argv,2,stdout='',stderr='offline context unavailable')
    module.subprocess = SimpleNamespace(run=no_process,SubprocessError=subprocess.SubprocessError)
    def no_token(root):
        probes.append('trusted_git_init_context')
        return False
    module.consume_trusted_git_init_context = no_token
    def audit(event,args):
        if event.startswith(('subprocess.','os.exec','os.spawn','socket.')) or event in ('os.system','os.remove','os.rename','os.rmdir','os.mkdir'):
            raise ForbiddenExecution(event)
        if event=='open':
            mode = args[1]
            flags = args[2]
            if (isinstance(mode,str) and any(x in mode for x in 'wax+')) or (isinstance(flags,int) and flags & (os.O_WRONLY|os.O_RDWR|os.O_CREAT)):
                raise ForbiddenExecution('file write')
    sys.addaudithook(audit)
    signal.signal(signal.SIGALRM,lambda *_: (_ for _ in ()).throw(Deadline()))
    for line in sys.stdin:
        item = json.loads(line)
        probes.clear()
        start = time.perf_counter_ns()
        signal.setitimer(signal.ITIMER_REAL,.25)
        try:
            result = module.classify_command(item['command'],Path('/caws-offline/repo'),
                Path('/caws-offline/home'),Path('/caws-offline/repo'),False,_adapters={})
            decision, reason, source, enforcement = result
            row = {'status':'classified','decision':decision,
                   'source':source,'enforcement':enforcement,
                   'reason_sha256':hashlib.sha256(reason.encode()).hexdigest()}
        except Deadline:
            row={'status':'timeout'}
        except ForbiddenExecution as error:
            row={'status':'execution_attempt_refused','operation':str(error)}
        except Exception as error:
            row={'status':'error','error_type':type(error).__name__}
        finally:
            signal.setitimer(signal.ITIMER_REAL,0)
        row.update(command_sha256=item['command_sha256'],offset=item['offset'],
                   elapsed_ns=time.perf_counter_ns()-start,context_probes=list(probes),
                   decision_authority='context_missing' if probes else 'text_only')
        print(json.dumps(row),flush=True)
    return 0


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--corpus',type=Path)
    parser.add_argument('--classifier',type=Path,required=True)
    parser.add_argument('--output',type=Path)
    parser.add_argument('--per-stratum',type=int,default=24)
    parser.add_argument('--worker',action='store_true')
    args=parser.parse_args()
    if args.worker:
        return worker(args.classifier.resolve())
    root=args.output.resolve()
    root.mkdir(parents=True,exist_ok=False)
    heaps=defaultdict(list)
    census=Counter()
    digest=hashlib.sha256()
    offset=0
    malformed=0
    with args.corpus.open('rb') as source:
        for line in source:
            digest.update(line)
            row_offset=offset
            offset+=len(line)
            try:
                row=json.loads(line)
            except (ValueError,UnicodeDecodeError):
                malformed+=1
                continue
            command=row.get('command')
            if not isinstance(command,str):
                malformed+=1
                continue
            harness=row.get('harness')
            if harness not in ('claude-code','codex','dsh','qwen'):
                harness='unknown'
            outcome=row.get('outcome')
            outcome=outcome.get('status','unknown') if isinstance(outcome,dict) else 'unknown'
            if outcome not in ('success','error','denied','rejected','aborted','unknown'):
                outcome='unknown'
            length=len(command.encode())
            bucket='short' if length<512 else 'medium' if length<8192 else 'large'
            stratum=f'{harness}/{outcome}/{bucket}'
            census[stratum]+=1
            command_sha=hashlib.sha256(command.encode()).hexdigest()
            # Stable content hash with an occurrence tie-breaker. Repetitions
            # remain occurrences; this is not an independent-command estimate.
            priority=int(command_sha,16)
            record={'offset':row_offset,'command':command,'command_sha256':command_sha,
                    'stratum':stratum,'bytes':length}
            item=(-priority,-row_offset,record)
            heap=heaps[stratum]
            if len(heap)<args.per_stratum:
                heapq.heappush(heap,item)
            elif item>heap[0]:
                heapq.heapreplace(heap,item)
    selected=sorted([item[2] for heap in heaps.values() for item in heap],key=lambda row:row['offset'])
    manifest=[{key:value for key,value in row.items() if key!='command'} for row in selected]
    (root/'sample.json').write_text(json.dumps(manifest,indent=2)+'\n')
    argv=[sys.executable,str(Path(__file__).resolve()),'--worker','--classifier',str(args.classifier.resolve())]
    env={'PATH':os.environ['PATH'],'HOME':'/caws-offline/home','PYTHONDONTWRITEBYTECODE':'1'}
    result=subprocess.run(argv,env=env,cwd=root,capture_output=True,
                          input=''.join(json.dumps(row)+'\n' for row in selected).encode(),timeout=300)
    (root/'classifications.jsonl').write_bytes(result.stdout)
    (root/'worker.stderr').write_bytes(result.stderr)
    results=[json.loads(line) for line in result.stdout.splitlines()]
    elapsed=sorted(row['elapsed_ns'] for row in results)
    def percentile(p):
        return elapsed[min(len(elapsed)-1,int((len(elapsed)-1)*p))]/1e6 if elapsed else None
    report={'schema':'caws.corpus_replay.v1','corpus':str(args.corpus.resolve()),'corpus_bytes':offset,
            'corpus_sha256':digest.hexdigest(),'census':dict(sorted(census.items())),
            'records':sum(census.values()),'malformed':malformed,'sampled':len(selected),
            'classifier':str(args.classifier.resolve()),'classifier_sha256':hashlib.sha256(args.classifier.read_bytes()).hexdigest(),
            'worker_argv':argv,'worker_exit_code':result.returncode,'returned':len(results),
            'status_counts':dict(Counter(row['status'] for row in results)),
            'decision_counts':dict(Counter(row.get('decision','unclassified') for row in results)),
            'context_missing':sum(bool(row['context_probes']) for row in results),
            'latency_ms':{'p50':percentile(.5),'p95':percentile(.95),'max':percentile(1)},
            'commands_executed':0,
            'limits':['No correctness labels; no false-positive or false-negative rate can be inferred.',
                      'Stratified occurrences are not an unbiased population prevalence estimate.',
                      'Captured filesystem, git index, adapters, environment and historical ownership were not reconstructed.',
                      '250 ms per classification deadline; no native hook overhead measurement.']}
    (root/'replay.json').write_text(json.dumps(report,indent=2)+'\n')
    print(json.dumps(report,indent=2))
    return 0 if result.returncode==0 and len(results)==len(selected) and all(row['status']=='classified' for row in results) else 1


if __name__=='__main__':
    sys.exit(main())
