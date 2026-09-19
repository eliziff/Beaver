"""Overlap scoring for the case-treatment structure slate.

Character-space IoU between predicted and gold opinion spans, so it is
comparable to the mean-boundary-overlap figure the other candidates are graded
with. Usage: python score_slate.py <tag>
"""
import io
import json
import statistics
import sys

R = 'experiments/jev-attribution/receipts/'


def main(tag, tolerance=1):
    packets = {p['document_id']: p for p in json.load(io.open(R + 'hard-slate.json', encoding='utf-8'))}
    run = json.load(io.open(R + 'boundary-predictions-%s.json' % tag, encoding='utf-8'))

    def char_span(packet, a, b):
        lines = {l['line']: l for l in packet['lines']}
        if a is None or b is None or a not in lines or b not in lines or b < a:
            return None
        return (lines[a]['start'], lines[b]['end'])

    def iou(x, y):
        if not x or not y:
            return 0.0
        inter = max(0, min(x[1], y[1]) - max(x[0], y[0]))
        union = max(x[1], y[1]) - min(x[0], y[0])
        return inter / union if union > 0 else 0.0

    rows = []
    for r in run:
        if 'predicted' not in r:
            continue
        packet = packets[r['document_id']]
        gold = r['gold']
        pred = r['predicted']
        overlaps = []
        for i, g in enumerate(gold):
            if i < len(pred) and pred[i].get('end') is not None:
                within = (abs(pred[i]['start'] - g['start_line']) <= tolerance
                          and abs(pred[i]['end'] - g['end_line']) <= tolerance)
                if within:
                    overlaps.append(1.0)
                else:
                    overlaps.append(iou(char_span(packet, pred[i]['start'], pred[i]['end']),
                                        char_span(packet, g['start_line'], g['end_line'])))
            else:
                overlaps.append(0.0)
        rows.append({'id': r['document_id'], 'n_gold': len(gold), 'n_pred': len(pred),
                     'mean_overlap': statistics.mean(overlaps) if overlaps else 0.0,
                     'all_acceptable': (len(pred) == len(gold)
                                        and overlaps and all(x >= 0.9 for x in overlaps)),
                     'exact_within_tol': (len(pred) == len(gold)
                                          and overlaps and all(x == 1.0 for x in overlaps))})

    single = [r for r in rows if r['n_gold'] == 1]
    multi = [r for r in rows if r['n_gold'] > 1]

    def report(name, subset):
        if not subset:
            return
        print('%-8s n=%-3d mean boundary overlap %.3f | all opinions >=0.9: %d/%d | within %d line: %d/%d' % (
            name, len(subset), statistics.mean([r['mean_overlap'] for r in subset]),
            sum(1 for r in subset if r['all_acceptable']), len(subset),
            tolerance, sum(1 for r in subset if r['exact_within_tol']), len(subset)))

    print('tag=%s' % tag)
    report('ALL', rows)
    report('single', single)
    report('multi', multi)


if __name__ == '__main__':
    main(sys.argv[1] if len(sys.argv) > 1 else 'hard',
         int(sys.argv[2]) if len(sys.argv) > 2 else 1)
