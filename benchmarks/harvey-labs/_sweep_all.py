import os, json
from collections import Counter, defaultdict

results_base = 'results'

# Walk all scores.json / scores.majority.json
scores = []
for root, dirs, files in os.walk(results_base):
    for fn in ('scores.json', 'scores.majority.json'):
        if fn in files:
            p = os.path.join(root, fn)
            try:
                d = json.load(open(p))
                scores.append({
                    'path': p.replace(os.sep, '/'),
                    'task': d.get('task'),
                    'judge': d.get('judge_model'),
                    'n_crit': d.get('n_criteria'),
                    'n_pass': d.get('n_passed'),
                    'failed': [c['id'] for c in d.get('criteria_results', []) if c.get('verdict') == 'fail'],
                })
            except Exception as e:
                scores.append({'path': p.replace(os.sep, '/'), 'task': None, 'err': str(e)})

print('total scores files:', len(scores))
tasks = Counter(s.get('task') for s in scores)
print('distinct task strings:', len(tasks))
judges = Counter(s.get('judge') for s in scores)
print('judge models:', dict(judges))
print()
print('TASKS:')
for t, n in sorted(tasks.items()):
    print(f'  {n:4d}  {t}')

json.dump(scores, open('_sweep_all.json', 'w'), indent=1)
print('wrote _sweep_all.json')
