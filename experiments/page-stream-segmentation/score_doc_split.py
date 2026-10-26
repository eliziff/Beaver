"""Score explicit teacher targets, without treating unlabelled PDF gaps as negatives."""
import argparse
from collections import Counter
import hashlib
import json
import math
from pathlib import Path


def curve(labels, probabilities, unreachable_positives=0):
    if labels.keys() != probabilities.keys():
        return None
    positives = sum(labels.values())+unreachable_positives
    if not positives:
        return None
    groups = {}
    for key, probability in probabilities.items():
        groups.setdefault(probability, []).append(labels[key])
    tp, fp, previous_recall, average_precision, best = 0, 0, 0., 0., None
    for threshold in sorted(groups, reverse=True):
        group = groups[threshold]
        tp += sum(group)
        fp += len(group)-sum(group)
        recall, precision = tp/positives, tp/(tp+fp)
        average_precision += (recall-previous_recall)*precision
        previous_recall = recall
        fn = positives-tp
        point = {'threshold': threshold, 'precision': precision, 'recall': recall,
                 'f1': 2*tp/(2*tp+fp+fn), 'false_splits': fp, 'missed_splits': fn}
        if best is None or point['f1'] > best['f1']:
            best = point
    if best is None:
        best=dict(threshold=1.,precision=0.,recall=0.,f1=0.,false_splits=0,missed_splits=positives)
    return {'average_precision': average_precision, 'best_f1_on_this_split': best,
            'limit': 'Threshold selected on these labels; this is a development diagnostic, not held-out accuracy or probability calibration.'}


def score(dataset, predictions, split):
    labels = {}
    for case in dataset['cases']:
        if case['split'] == split:
            for page, label in case['targets'].items():
                key = case['sha256'], page
                if key in labels:
                    raise ValueError('Repeated gold seam')
                labels[key] = label
    probabilities = {}
    for source in predictions['sources']:
        for page, probability in source['probabilities'].items():
            key = source['sha256'], page
            if (key in probabilities or key not in labels or type(probability) not in (float, int)
                    or not math.isfinite(probability) or not 0 <= probability <= 1):
                raise ValueError('Prediction must identify one known teacher seam and a finite probability')
            probabilities[key] = probability
    counts = Counter()
    for key, probability in probabilities.items():
        predicted, wanted = int(probability >= .5), labels[key]
        counts[{(1,1): 'true_splits', (1,0): 'false_splits', (0,1): 'missed_splits',
                (0,0): 'true_continuations'}[predicted,wanted]] += 1
    tp, fp, fn = counts['true_splits'], counts['false_splits'], counts['missed_splits']
    ratio = lambda a,b: a/b if b else None
    return {'split': split, 'threshold': .5, 'known_seams': len(labels), 'scored_seams': len(probabilities),
        'coverage': ratio(len(probabilities),len(labels)), 'counts': dict(counts),
        'precision': ratio(tp,tp+fp), 'recall': ratio(tp,tp+fn), 'f1': ratio(2*tp,2*tp+fp+fn),
        'precision_recall_curve': curve(labels, probabilities),
        'limitations': 'Explicit teacher page-edge targets only. No whole-packet, within-page or probability-calibration claim.'}


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('dataset', type=Path)
    parser.add_argument('predictions', type=Path)
    parser.add_argument('--split', choices=('train','development','test'), default='development')
    parser.add_argument('--out', type=Path, required=True)
    args = parser.parse_args()
    result = score(json.loads(args.dataset.read_text()), json.loads(args.predictions.read_text()), args.split)
    for name, path in [('dataset',args.dataset),('predictions',args.predictions)]:
        with path.open('rb') as stream:
            result[name+'_sha256'] = hashlib.file_digest(stream,'sha256').hexdigest()
    args.out.write_text(json.dumps(result,indent=2)+'\n',encoding='utf-8')
    print(json.dumps(result,indent=2))
