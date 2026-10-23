"""Calibrate a student's core threshold against development teacher geometry."""

import argparse
import json
from pathlib import Path

import cv2
import numpy as np
import onnx
from onnx import numpy_helper
import onnxruntime as ort
from scipy.optimize import linear_sum_assignment

from distill_detector import digest, write_json


def boxes(output, threshold=0):
    _, height, width = output.shape
    count, labels, stats, _ = cv2.connectedComponentsWithStats((output[0] > threshold).astype(np.uint8), connectivity=4)
    if count == 1:
        return np.empty((0, 4))
    indices = np.flatnonzero(stats[:, cv2.CC_STAT_AREA] >= 2)
    indices = indices[indices != 0]
    if not len(indices):
        return np.empty((0, 4))
    y = np.repeat((np.arange(height) + .5) * 2, width)
    top = np.bincount(labels.ravel(), weights=y - output[1].ravel(), minlength=count)
    bottom = np.bincount(labels.ravel(), weights=y + output[2].ravel(), minlength=count)
    sizes = stats[indices, cv2.CC_STAT_AREA]
    top, bottom = top[indices] / sizes, bottom[indices] / sizes
    extension = .15 * np.maximum(1, bottom - top)
    left = stats[indices, cv2.CC_STAT_LEFT] * 2 - extension
    right = (stats[indices, cv2.CC_STAT_LEFT] + stats[indices, cv2.CC_STAT_WIDTH]) * 2 + extension
    return np.stack([left, top, right, bottom], axis=1)


def overlap(expected, actual):
    if not len(expected) or not len(actual):
        return 0., 0
    left = np.maximum(expected[:, None, :2], actual[None, :, :2])
    right = np.minimum(expected[:, None, 2:], actual[None, :, 2:])
    intersection = np.maximum(0, right - left).prod(axis=2)
    first = np.maximum(0, expected[:, 2:] - expected[:, :2]).prod(axis=1)
    second = np.maximum(0, actual[:, 2:] - actual[:, :2]).prod(axis=1)
    iou = intersection / np.maximum(first[:, None] + second[None, :] - intersection, 1e-9)
    rows, columns = linear_sum_assignment(iou, maximize=True)
    matched = iou[rows, columns]
    return float(matched.sum()), int((matched >= .5).sum())


def check_geometry():
    output = np.zeros((3, 8, 12), np.float32)
    output[0].fill(-4)
    output[0, 2, 1:5] = 2
    output[0, 5, 6:10] = 2
    output[1:] = 2
    actual = boxes(output)
    expected = np.array([[1.4, 3, 10.6, 7], [11.4, 9, 20.6, 13]])
    np.testing.assert_allclose(actual, expected)
    score, matches = overlap(expected, actual)
    assert matches == 2 and abs(score - 2) < 1e-6
    assert len(boxes(output, 3)) == 0


def main():
    cv2.setNumThreads(1)
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--run', type=Path, required=True)
    parser.add_argument('--cache-root', type=Path, required=True)
    args = parser.parse_args()
    check_geometry()
    receipt_path = args.run / 'results.json'
    receipt = json.loads(receipt_path.read_text())
    assert receipt['inputs'] == json.loads((args.cache_root / 'manifest.json').read_text())
    path = args.run / 'model.onnx'
    assert digest(path) == receipt['model_sha256']
    raw = args.run / 'uncalibrated.onnx'
    source = raw if receipt.get('core_calibration') else path
    if source == raw:
        assert digest(raw) == receipt['core_calibration']['uncalibrated_model_sha256']
    options = ort.SessionOptions()
    options.intra_op_num_threads = options.inter_op_num_threads = 1
    before = ort.InferenceSession(str(source), options, providers=['CPUExecutionProvider'])
    pages, example = [], None
    for index in range(receipt['inputs']['splits']['eval']['pages']):
        with np.load(args.cache_root / f'eval-{index:04}.npz') as row:
            image = row['image'][None].astype(np.float32)
            target = row['target'].astype(np.float32)
        example = image
        prediction = before.run(None, {'image': image})[0][0]
        pages.append((boxes(target), prediction))
    scores = []
    for threshold in np.linspace(-4, 4, 33):
        total = expected_count = actual_count = matched_count = 0
        for expected, prediction in pages:
            actual = boxes(prediction, threshold)
            soft, matched = overlap(expected, actual)
            total += soft
            matched_count += matched
            expected_count += len(expected)
            actual_count += len(actual)
        scores.append({'threshold': float(threshold), 'teacher_boxes': expected_count, 'student_boxes': actual_count,
                       'matched_iou_sum': total, 'geometry_score': 2 * total / max(1, expected_count + actual_count),
                       'f1_iou_50': 2 * matched_count / max(1, expected_count + actual_count)})
    baseline = next(value for value in scores if value['threshold'] == 0)
    selected = max(scores, key=lambda value: (value['geometry_score'], -abs(value['threshold'])))
    if selected['geometry_score'] <= baseline['geometry_score'] + .0001:
        selected = baseline
    threshold = selected['threshold']
    graph = onnx.load(source)
    bias = next(value for value in graph.graph.initializer if value.name == 'head.bias')
    values = numpy_helper.to_array(bias).copy()
    assert values.shape == (3,)
    values[0] -= threshold
    bias.CopyFrom(numpy_helper.from_array(values, name=bias.name))
    onnx.checker.check_model(graph)
    if source != raw:
        raw.write_bytes(source.read_bytes())
    pending = path.with_suffix('.pending')
    try:
        onnx.save(graph, pending)
        after = ort.InferenceSession(str(pending), options, providers=['CPUExecutionProvider'])
        expected = before.run(None, {'image': example})[0]
        expected[:, 0] -= threshold
        np.testing.assert_allclose(after.run(None, {'image': example})[0], expected, rtol=.0001, atol=.0001)
        pending.replace(path)
    finally:
        pending.unlink(missing_ok=True)
    receipt['core_calibration'] = {'scope': 'development teacher geometry, not human box gold',
                                   'uncalibrated_model_sha256': digest(raw), 'scores': scores, 'selected': selected,
                                   'export_parity_passed': True, 'modification': 'Fold core threshold into head bias; no new operators'}
    receipt.update(model_sha256=digest(path), model_bytes=path.stat().st_size)
    write_json(receipt_path, receipt)
    print(json.dumps({'baseline': baseline, 'selected': selected, 'model_sha256': receipt['model_sha256']}), flush=True)


if __name__ == '__main__':
    main()
