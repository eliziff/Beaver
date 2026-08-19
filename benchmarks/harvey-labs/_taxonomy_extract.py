import os, json

results_base = 'results'
tasks_def_base = 'tasks'

TASKS = [
    ('corporate-ma', 'draft-acquisition-due-diligence'),
    ('tax', 'draft-transfer-pricing-documentation'),
    ('tax', 'analyze-irs-information-document-request-for-completeness-and-risk-issues'),
    ('employment-labor', 'analyze-counterparty-markup-of-executive-employment-agreement'),
    ('antitrust-competition', 'analyze-antitrust-hsr-strategy'),
    ('insurance', 'analyze-property-damage-claim-against-commercial-policy-exclusions'),
    ('white-collar-defense-investigations', 'analyze-counterparty-markup-of-deferred-prosecution-agreement'),
    ('capital-markets', 'compare-closing-documents-against-closing-checklist'),
    ('antitrust-competition', 'analyze-counterparty-markup-of-protective-order'),
]

out = {}
for area, task in TASKS:
    key = f'{area}/{task}'
    defp = os.path.join(tasks_def_base, area, task, 'task.json')
    tdef = json.load(open(defp))
    crit_map = {c['id']: c for c in tdef['criteria']}
    n_total = len(tdef['criteria'])

    base = os.path.join(results_base, area, task)
    runs = []
    if os.path.isdir(base):
        for arm in sorted(os.listdir(base)):
            adir = os.path.join(base, arm)
            if not os.path.isdir(adir):
                continue
            for ts in sorted(os.listdir(adir)):
                tdir = os.path.join(adir, ts)
                sp = os.path.join(tdir, 'scores.json')
                mj = os.path.join(tdir, 'scores.majority.json')
                use = sp if os.path.isfile(sp) else mj
                if not os.path.isfile(use):
                    continue
                d = json.load(open(use))
                cr = d.get('criteria_results', [])
                failed = [c['id'] for c in cr if c.get('verdict') == 'fail']
                rel = os.path.join(key, arm, ts).replace(os.sep, '/')
                runs.append({
                    'arm': arm, 'ts': ts, 'file': rel,
                    'judge': d.get('judge_model'), 'n_passed': d.get('n_passed'),
                    'failed': failed,
                })
    out[key] = {'n_total': n_total, 'criteria': crit_map, 'runs': runs}

json.dump(out, open('_taxonomy_consolidated.json', 'w'), indent=1)
print('wrote _taxonomy_consolidated.json')
for k, v in out.items():
    print(f'{k}: {v["n_total"]} crit, {len(v["runs"])} runs')
