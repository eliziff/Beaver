"""Rotate the two selected OCR recognizers and Kraken through matched CPU trials."""

import argparse
import gc
import json
from pathlib import Path
import statistics
import sys
import time

import numpy as np
import torch

from evaluate import Kraken, feed, session
from screen import Adapter, batches, digest, read_rows, write_json


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--data-root', type=Path, required=True)
    parser.add_argument('--crnn-weights', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--kraken-pack', type=Path, required=True)
    parser.add_argument('--kraken-runtime', type=Path, required=True)
    args = parser.parse_args()
    sys.stdout.reconfigure(encoding='utf-8')
    torch.set_num_threads(2)
    rows = read_rows(args.data_root / 'test.arrow')
    rows = [rows[i] for i in np.linspace(0, len(rows) - 1, min(512, len(rows)), dtype=int)]
    runtimes, inputs, result = {}, {}, {'models': {}}
    result['protocol'] = {'lines': len(rows), 'batch_size': 16, 'cpu_threads': 2, 'trials': 3,
                          'warmup': 'one complete pass per model',
                          'order': 'rotate starting model each trial; all three models run each round',
                          'scope': 'warm inference only; frozen ordinal sample; prepared tensors; no decoding or page processing',
                          'test_arrow_sha256': digest(args.data_root / 'test.arrow')}
    for name in ['indra', 'crnn', 'kraken']:
        if name == 'kraken':
            adapter = Kraken(args.kraken_pack, args.kraken_runtime)
            path = adapter.path
        else:
            adapter = Adapter(name, args)
            path = args.output / name / 'recognizer.onnx'
        prepared, _ = adapter.prepare(rows)
        runtimes[name] = session(path, 2)
        inputs[name] = [feed(adapter, runtimes[name], prepared, ids) for ids in batches(prepared, 16)]
        result['models'][name] = {'sha256': digest(path), 'seconds': []}
        for batch in inputs[name]:
            runtimes[name].run(None, batch)
        del adapter, prepared
        gc.collect()
    names = list(runtimes)
    for trial in range(3):
        for name in names[trial:] + names[:trial]:
            started = time.perf_counter()
            for batch in inputs[name]:
                runtimes[name].run(None, batch)
            result['models'][name]['seconds'].append(time.perf_counter() - started)
    for entry in result['models'].values():
        assert len(entry['seconds']) == 3 and all(seconds > 0 for seconds in entry['seconds'])
        entry['median_lines_per_second'] = len(rows) / statistics.median(entry['seconds'])
    reference = result['models']['kraken']['median_lines_per_second']
    for entry in result['models'].values():
        entry['relative_to_kraken'] = entry['median_lines_per_second'] / reference
    evaluation = json.loads((args.output / 'evaluation.json').read_text(encoding='utf-8'))
    assert evaluation['test_arrow_sha256'] == result['protocol']['test_arrow_sha256']
    for name in ['indra', 'crnn']:
        assert result['models'][name]['sha256'] == evaluation['models'][name]['onnx']['sha256']
    write_json(args.output / 'paired-timing.json', result)
    print(json.dumps(result), flush=True)


if __name__ == '__main__':
    main()
