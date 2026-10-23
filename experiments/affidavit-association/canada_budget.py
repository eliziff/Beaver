"""One locked attempt budget across Canada's concurrent private subruns."""
import pathlib,json,msvcrt,contextlib,time,uuid

ROOT=pathlib.Path('benchmarks/local-data/affidavit-association/expansion/canada').resolve()
LIMIT=60

@contextlib.contextmanager
def locked():
    ROOT.mkdir(parents=True,exist_ok=True)
    with (ROOT/'model-budget.lock').open('a+b') as f:
        f.seek(0);f.write(b'0');f.flush();f.seek(0)
        for _ in range(600):
            try:msvcrt.locking(f.fileno(),msvcrt.LK_NBLCK,1);break
            except OSError:time.sleep(.1)
        else:raise RuntimeError('Canada model budget lock unavailable')
        try:yield
        finally:f.seek(0);msvcrt.locking(f.fileno(),msvcrt.LK_UNLCK,1)

def receipts():
    return [(p,json.loads(p.read_text(encoding='utf-8'))['attempts']) for p in ROOT.glob('**/receipt.json')]

def install(workflow):
    original=workflow.call
    def bounded(prompt,schema_path,images,directory,args,validate,**kw):
        state_path=ROOT/'model-budget.json';token=str(uuid.uuid4());scope=str(directory.resolve())
        with locked():
            state=json.loads(state_path.read_text()) if state_path.exists() else {'limit':LIMIT,'active':{},'history':[]}
            rs=receipts();actual=sum(len(a) for _,a in rs)
            pending=0
            for item in state['active'].values():
                current=sum(len(a) for p,a in rs if p.is_relative_to(item['scope']))
                pending+=max(0,item['attempts']-(current-item['initial']))
            # Calls started before this gate was installed can still retry once.
            pending+=sum(max(0,2-len(a)) for p,a in rs if a and a[-1]['status']=='running' and not any(p.is_relative_to(x['scope']) for x in state['active'].values()))
            if actual+pending+args.attempts>LIMIT:raise RuntimeError(f'Canada shared {LIMIT}-attempt cap reached ({actual} actual, {pending} reserved)')
            state['active'][token]={'scope':scope,'attempts':args.attempts,'initial':sum(len(a) for p,a in rs if p.is_relative_to(scope))}
            state_path.write_text(json.dumps(state,indent=2),encoding='utf-8')
        args.max_calls=LIMIT
        if kw.get('budget') is not None:kw['budget']['calls']=actual
        try:return original(prompt,schema_path,images,directory,args,validate,**kw)
        finally:
            with locked():
                state=json.loads(state_path.read_text());item=state['active'].pop(token);item['token']=token;state['history'].append(item);state['actual_attempts']=sum(len(a) for _,a in receipts());state_path.write_text(json.dumps(state,indent=2),encoding='utf-8')
    workflow.call=bounded
