#!/usr/bin/env python3
"""Paired, deterministic, bootstrap scorer. Frozen before production edits."""
import argparse
import json
import math
import random
import statistics
from pathlib import Path


def median(values):
    return statistics.median(values)


def quantile(values, q):
    values = sorted(values)
    x = (len(values) - 1) * q
    lo = math.floor(x)
    return values[lo] + (values[math.ceil(x)] - values[lo]) * (x - lo)


def geomean(values):
    return math.exp(statistics.mean(math.log(x) for x in values))


def score(records, resamples=10000):
    groups = {}
    for record in records:
        groups.setdefault(record['workload'], {}).setdefault(record['pair'], {})[record['side']] = record
    ratios = {}
    workloads = {}
    for workload, pairs in sorted(groups.items()):
        ordered = [pairs[key] for key in sorted(pairs)]
        if any(set(pair) != {'a', 'b'} for pair in ordered):
            raise ValueError('Incomplete pairs cannot be scored')
        ratios[workload] = [median(pair['b']['times_ms']) / median(pair['a']['times_ms']) for pair in ordered]
        a = [x for pair in ordered for x in pair['a']['times_ms']]
        b = [x for pair in ordered for x in pair['b']['times_ms']]
        ma = [pair['a']['peak_rss_kib'] for pair in ordered]
        mb = [pair['b']['peak_rss_kib'] for pair in ordered]
        workloads[workload] = {
            'pairs': len(ordered), 'a_median_ms': median(a), 'b_median_ms': median(b),
            'paired_normalized_median': median(ratios[workload]),
            'a_p95_ms': quantile(a, .95), 'b_p95_ms': quantile(b, .95),
            'p95_time_ratio': quantile(b, .95) / quantile(a, .95),
            'a_peak_rss_p95_kib': quantile(ma, .95), 'b_peak_rss_p95_kib': quantile(mb, .95),
            'peak_rss_p95_ratio': quantile(mb, .95) / quantile(ma, .95),
            'peak_rss_max_ratio': max(mb) / max(ma),
        }
    point = geomean([median(x) for x in ratios.values()])
    rng = random.Random(20261002)
    boot = []
    # Resample whole corresponding workload rounds to preserve machine drift covariance.
    n = min(map(len, ratios.values()))
    for _ in range(resamples):
        sampled = [rng.randrange(n) for _ in range(n)]
        boot.append(geomean([median([values[i] for i in sampled]) for values in ratios.values()]))
    return {
        'schema_version': 'beaver.court-cloud-paired-score.v1',
        'objective': point, 'improvement_percent': (1 - point) * 100,
        'bootstrap_ci95': [quantile(boot, .025), quantile(boot, .975)],
        'bootstrap_upper95_one_sided': quantile(boot, .95),
        'workloads': workloads,
        'all_correct': all(record['correctness'] for record in records),
        'guardrails_pass': all(value['p95_time_ratio'] <= 1.05 and value['peak_rss_p95_ratio'] <= 1.05
                               and value['peak_rss_max_ratio'] <= 1.05
                               for value in workloads.values()),
        'strict_improvement_supported': point < 1 and quantile(boot, .95) < 1,
    }


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('receipts', nargs='+', type=Path)
    parser.add_argument('--output', type=Path)
    args = parser.parse_args()
    records = []
    for receipt in args.receipts:
        data = [json.loads(line) for line in receipt.read_text().splitlines() if line.strip()]
        prefix = receipt.name
        for item in data:
            item['pair'] = f'{prefix}:{item["pair"]:04d}'
        records.extend(data)
    result = score(records)
    output = json.dumps(result, indent=2) + '\n'
    if args.output:
        args.output.write_text(output)
    print(output)
