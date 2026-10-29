"""Durable desktop training pipeline; SSH disconnects cannot interrupt its logs."""
import argparse
import json
from pathlib import Path
import subprocess
import sys
import time


def run(root,fable):
    out=root/'cpu-model/full-page-and-line'; out.mkdir(parents=True,exist_ok=True)
    status_path=out/'run-status.json'; began=time.time()
    commands=[
        ('export-structure',['prepare_structure_split_gold.py','--root',str(root)]),
        ('focused-tests',['-m','unittest','test_cpu_full_split']),
        ('gpu-training',['train_cpu_full_split.py','--root',str(root),'--epochs','8']),
        ('cpu-validation',['validate_cpu_full_split.py','--root',str(root)]),
        ('fit-diagnostic',['diagnose_cpu_full_split.py','--root',str(root)])]
    with (out/'run.log').open('w',encoding='utf-8') as log:
        for phase,args in commands:
            status=dict(status='running',phase=phase,started_at=began)
            status_path.write_text(json.dumps(status),encoding='utf-8')
            log.write(json.dumps(dict(phase=phase))+'\n'); log.flush()
            python=Path(sys.executable).with_name('python.exe') if sys.platform=='win32' else Path(sys.executable)
            result=subprocess.run([str(python),'-u',*args],cwd=root,stdout=log,stderr=subprocess.STDOUT,
                creationflags=getattr(subprocess,'CREATE_NO_WINDOW',0))
            if result.returncode:
                status.update(status='failed',exit_code=result.returncode,finished_at=time.time())
                status_path.write_text(json.dumps(status),encoding='utf-8')
                return result.returncode
    status_path.write_text(json.dumps(dict(status='complete',started_at=began,finished_at=time.time())),encoding='utf-8')
    return 0


def status(root):
    out=root/'cpu-model/full-page-and-line'
    result=json.loads((out/'run-status.json').read_bytes())
    allowed={'stage','epoch','page_edge_f1','page_edge_ap','internal_anchor_f1','internal_anchor_ap','seconds',
        'processed_sources','total_sources'}
    for line in (out/'run.log').read_text(encoding='utf-8').splitlines():
        try: point=json.loads(line)
        except ValueError: continue
        if isinstance(point,dict) and ('epoch' in point or 'processed_sources' in point):
            result['latest_progress']={k:v for k,v in point.items() if k in allowed}
    print(json.dumps(result))


if __name__=='__main__':
    parser=argparse.ArgumentParser(description=__doc__); parser.add_argument('--root',required=True,type=Path)
    parser.add_argument('--fable',type=Path); parser.add_argument('--status',action='store_true')
    args=parser.parse_args()
    if args.status: status(args.root)
    else: raise SystemExit(run(args.root,args.fable))
