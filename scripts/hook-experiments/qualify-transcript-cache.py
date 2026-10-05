#!/usr/bin/env python3
"""Compare cached parsing with fresh parsing under deliberate source changes."""
import argparse
import copy
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import sys
import time


def digest(value):
    return hashlib.sha256(json.dumps(value,sort_keys=True).encode()).hexdigest()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--renderer',type=Path,required=True)
    parser.add_argument('--output',type=Path,required=True)
    args = parser.parse_args()
    root = args.output.resolve()
    root.mkdir(parents=True,exist_ok=False)
    spec = importlib.util.spec_from_file_location('qualified_renderer',args.renderer)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    transcript = root/'transcript.jsonl'
    row = lambda text: json.dumps({'type':'user','message':{'content':text}})+'\n'
    original = ''.join(row('question '+str(index)) for index in range(1000)).encode()
    transcript.write_bytes(original)
    cache = {}
    results = []

    def compare(label):
        start = time.perf_counter_ns()
        cached = module.parse_transcript_events(str(transcript),cache=cache)
        warm_ns = time.perf_counter_ns()-start
        start = time.perf_counter_ns()
        fresh = module.parse_transcript_events(str(transcript))
        cold_ns = time.perf_counter_ns()-start
        result = {'scenario':label,'mode':cache['mode'],'cached_sha256':digest(cached),
                  'fresh_sha256':digest(fresh),'equal':cached==fresh,'events':len(fresh),
                  'cached_ns':warm_ns,'fresh_ns':cold_ns,
                  'source_sha256':hashlib.sha256(transcript.read_bytes()).hexdigest()}
        (root/(label+'.cached.json')).write_text(json.dumps(cached))
        (root/(label+'.fresh.json')).write_text(json.dumps(fresh))
        results.append(result)

    compare('cold')
    compare('unchanged')
    with transcript.open('ab') as target:
        target.write(row('appended').encode())
    compare('append')
    stat = transcript.stat()
    transcript.write_bytes(transcript.read_bytes().replace(b'question 1"',b'question X"',1))
    os.utime(transcript,ns=(stat.st_atime_ns,stat.st_mtime_ns))
    compare('rewrite-same-size-mtime')
    transcript.write_text(row('truncated'))
    compare('truncate')
    replacement = root/'replacement'
    replacement.write_text(row('replacement'))
    replacement.replace(transcript)
    compare('inode-replacement')
    with transcript.open('ab') as target:
        target.write(b'{"type":"user","message":{"content":"partial')
    compare('partial-line')
    with transcript.open('ab') as target:
        target.write(b' completed"}}\n')
    compare('partial-completed')
    # Failing adapter mutates its state before raising. The prior checkpoint
    # must stay usable, not silently inherit that partial state mutation.
    def normalize(row, state):
        if row.get('fail'):
            state['count']=999
            raise ValueError('deliberate adapter failure')
        state['count']=state.get('count',0)+1
        return [{'ev':'user_text','text':str(state['count'])}]
    adapters=(module.TranscriptRowAdapter('fixture',lambda row:True,normalize),)
    transcript.write_text('{"ok":true}\n')
    checkpoint={}
    module.parse_transcript_events(str(transcript),adapters=adapters,cache=checkpoint)
    before=copy.deepcopy(checkpoint)
    with transcript.open('a') as target:
        target.write('{"fail":true}\n')
    failed=False
    try:
        module.parse_transcript_events(str(transcript),adapters=adapters,cache=checkpoint)
    except ValueError as error:
        failed=str(error)=='deliberate adapter failure'
    results.append({'scenario':'adapter-failure-rollback','exception_observed':failed,
                    'checkpoint_unchanged':checkpoint==before,'equal':failed and checkpoint==before,
                    'state_before':before['adapter_state'],'state_after':checkpoint['adapter_state']})
    report={'schema':'caws.transcript_cache_qualification.v1','renderer':str(args.renderer.resolve()),
            'renderer_sha256':hashlib.sha256(args.renderer.read_bytes()).hexdigest(),'results':results,
            'limits':['In-process parse cache only; no daemon or native latency claim.',
                      'Single measurements are not a benchmark distribution.',
                      'Installed Codex custom adapters take their explicit path and do not use this cache.']}
    (root/'qualification.json').write_text(json.dumps(report,indent=2)+'\n')
    print(json.dumps(report,indent=2))
    return 0 if all(row['equal'] for row in results) else 1


if __name__=='__main__':
    sys.exit(main())
