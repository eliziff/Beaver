"""Invented inputs for the screen's data separation and CTC decoding contracts."""

import tempfile
import unittest
from copy import deepcopy
from pathlib import Path

import cv2
import numpy as np
import pyarrow as pa
import pyarrow.ipc as ipc
import torch

from screen import Adapter, audit_sources, normalized
from indra import Indra, IndraSpatial, distillation_loss, select_channels
from margin_jitter import jitter_margins


class ScreenTests(unittest.TestCase):
    def test_margin_augmentation_retains_all_glyph_pixels_including_pale_edges(self):
        image = np.full((12, 28), 255, np.uint8)
        image[3:8, 4:20] = 70
        image[2, 22] = 254
        augmented = jitter_margins(image, [-.75, .75, .5, -.5])
        def ink(value):
            yy, xx = np.where(value < 255)
            return value[yy.min():yy.max() + 1, xx.min():xx.max() + 1]
        np.testing.assert_array_equal(ink(image), ink(augmented))
        blank = np.full_like(image, 255)
        np.testing.assert_array_equal(jitter_margins(blank, [1, -1, .5, -.5]), blank)

    def test_augmented_batches_keep_ctc_sizing_and_restore_from_torch_rng(self):
        adapter = object.__new__(Adapter)
        adapter.name, adapter.height, adapter.maximum, adapter.minimum = 'indra', 32, 4096, 8
        adapter.meta = {}
        image = np.full((32, 40), 255, np.uint8)
        image[8:24, 8:32] = 0
        encoded = cv2.imencode('.png', image)[1].tobytes()
        prepared, _ = adapter.prepare([{'text': 'o' * 80, 'im': encoded}], training=True)
        torch.manual_seed(149)
        state = torch.get_rng_state()
        first = adapter.batch(prepared, [0] * 8, 'cpu', margin_jitter=.75)
        self.assertTrue(torch.all(first[1] // 4 >= 160))
        torch.set_rng_state(state)
        second = adapter.batch(prepared, [0] * 8, 'cpu', margin_jitter=.75)
        torch.testing.assert_close(first[0], second[0], rtol=0, atol=0)
        torch.testing.assert_close(first[1], second[1], rtol=0, atol=0)
        state = torch.get_rng_state()
        adapter.batch(prepared, [0], 'cpu')
        torch.testing.assert_close(torch.get_rng_state(), state, rtol=0, atol=0)

    def test_channel_pruning_preserves_the_network_when_discarded_features_are_zero(self):
        # Independently disable features in a tiny full graph, then remove them.
        model = Indra.__new__(Indra)
        torch.nn.Module.__init__(model)
        model.stem = torch.nn.Conv2d(1, 8, (32, 4), stride=(32, 4))
        model.stem_bn = torch.nn.BatchNorm1d(8)
        model.head = torch.nn.Conv1d(8, 3, 1)
        model.blocks = torch.nn.ModuleList([torch.nn.ModuleDict({
            'dw': torch.nn.Conv1d(8, 8, 9, padding=4, groups=8),
            'expand': torch.nn.Conv1d(8, 16, 1),
            'fc1': torch.nn.Conv1d(16, 4, 1),
            'fc2': torch.nn.Conv1d(4, 16, 1),
            'project': torch.nn.Conv1d(16, 8, 1),
        }) for _ in range(2)])
        residual, expanded, squeeze = [0, 2, 4, 6], list(range(0, 16, 2)), [0, 2]
        with torch.no_grad():
            for module, kept in [(model.stem, residual)] + [
                (block[name], kept) for block in model.blocks
                for name, kept in [('dw', residual), ('expand', expanded),
                                   ('fc1', squeeze), ('project', residual)]
            ]:
                removed = [i for i in range(module.out_channels) if i not in kept]
                module.weight[removed] = 0
                module.bias[removed] = 0
        model.eval()
        pruned = deepcopy(model)
        mapping = {'residual': residual, 'blocks': [
            {'expanded': expanded, 'squeeze': squeeze} for _ in model.blocks]}
        select_channels(pruned, 4, mapping)
        pruned.eval()
        x, widths = torch.rand(2, 1, 32, 64), torch.tensor([64, 37])
        expected, lengths = model(x, widths)
        actual, actual_lengths = pruned(x, widths)
        torch.testing.assert_close(actual, expected, atol=1e-6, rtol=1e-5)
        torch.testing.assert_close(actual_lengths, lengths)
        spatial, spatial_lengths = IndraSpatial(deepcopy(pruned).eval()).eval()(x, widths)
        torch.testing.assert_close(spatial, expected, atol=1e-6, rtol=1e-5)
        torch.testing.assert_close(spatial_lengths, lengths)
        self.assertEqual(pruned.head.out_channels, 3)
        self.assertLess(sum(p.numel() for p in pruned.parameters()), sum(p.numel() for p in model.parameters()))
        actual.square().mean().backward()
        self.assertGreater(pruned.stem.weight.grad.abs().sum().item(), 0)
        auto = deepcopy(model)
        selected = select_channels(auto, 4)
        restored = deepcopy(model)
        select_channels(restored, 4, selected)
        torch.testing.assert_close(auto.eval()(x, widths)[0], restored.eval()(x, widths)[0])

    def test_distillation_ignores_padded_timesteps_and_backpropagates(self):
        student = torch.tensor([[[2., -1.], [0., 3.], [50., -50.]]], requires_grad=True)
        teacher = torch.tensor([[[1., 0.], [1., 2.], [-50., 50.]]])
        loss = distillation_loss(student, teacher, torch.tensor([2]))
        trimmed = distillation_loss(student[:, :2], teacher[:, :2], torch.tensor([2]))
        torch.testing.assert_close(loss, trimmed)
        loss.backward()
        self.assertGreater(student.grad[:, :2].abs().sum().item(), 0)
        self.assertEqual(student.grad[:, 2:].abs().sum().item(), 0)

    def test_ctc_repeats_blank_and_normalization(self):
        adapter = object.__new__(Adapter)
        adapter.chars = ['', 'a', 'b']
        ids = torch.tensor([[1, 1, 0, 1, 2, 0]])
        logits = torch.nn.functional.one_hot(ids, 3).float()
        self.assertEqual(adapter.decode(logits, torch.tensor([5])), ['aab'])
        self.assertEqual(normalized('  ﬂower\u00ad  market\n '), 'flower market')

    def test_article_cannot_straddle_splits(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / 'data').mkdir()
            for split, article, page in [('train', 501, 1), ('eval', 502, 1), ('test', 501, 2)]:
                name = f'001_INVENTED_article-{article}_pdf-page-{page}.xml'
                (root / f'{split}.lst').write_text('/retired/stage/' + name, encoding='utf-8')
                (root / 'data' / name).touch()
                (root / 'data' / name).with_suffix('.png').touch()
                table = pa.table({'lines': pa.array([{'text': 'invented', 'im': b''}])})
                with (root / f'{split}.arrow').open('wb') as sink:
                    with ipc.new_file(sink, table.schema) as writer:
                        writer.write_table(table)
            with self.assertRaisesRegex(ValueError, 'overlap'):
                audit_sources(root, root)

    def test_training_can_align_long_labels_without_using_eval_labels(self):
        adapter = object.__new__(Adapter)
        adapter.name, adapter.height, adapter.maximum = 'indra', 32, 4096
        adapter.meta = {}
        image = np.full((32, 32), 255, np.uint8)
        image[8:24, 8:24] = 0
        encoded = cv2.imencode('.png', image)[1].tobytes()
        rows = [{'text': 'a' * 80, 'im': encoded}]
        train, _ = adapter.prepare(rows, training=True)
        evaluation, _ = adapter.prepare(rows)
        self.assertGreaterEqual(train[0][0].shape[1] // 4, 159)
        self.assertLess(evaluation[0][0].shape[1], train[0][0].shape[1])

    def test_warm_start_retains_learned_extra_characters(self):
        adapter = object.__new__(Adapter)
        adapter.name, adapter.chars, adapter.meta = 'crnn', ['', 'a'], {}
        adapter.mapping = {'a': 1}
        adapter.model = torch.nn.Module()
        adapter.model.linear = torch.nn.Linear(3, 2)
        learned = torch.nn.Linear(3, 3)
        with torch.no_grad():
            learned.weight.fill_(.25)
            learned.bias.copy_(torch.tensor([.1, .2, .7]))
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'best.pt'
            torch.save({'state_dict': {'linear.weight': learned.weight, 'linear.bias': learned.bias},
                        'chars': ['', 'a', 'b'], 'epoch': 4}, path)
            checkpoint = adapter.load_checkpoint(path)
            adapter.extend([{'text': 'abba'}])
        self.assertEqual(checkpoint['epoch'], 4)
        self.assertEqual(adapter.chars, ['', 'a', 'b'])
        torch.testing.assert_close(adapter.model.linear.weight, learned.weight)
        torch.testing.assert_close(adapter.model.linear.bias, learned.bias)

    def test_narrow_evaluation_width_does_not_depend_on_transcript(self):
        adapter = object.__new__(Adapter)
        adapter.name, adapter.height, adapter.maximum = 'indra', 32, 4096
        adapter.meta = {}
        image = np.full((40, 400), 255, np.uint8)
        image[10:30, 8:392] = 0
        encoded = cv2.imencode('.png', image)[1].tobytes()
        rows = [{'text': text, 'im': encoded} for text in ['invented', 'm' * 400]]
        full, _ = adapter.prepare(rows)
        narrow, _ = adapter.prepare(rows, width_scale=.76)
        self.assertEqual(narrow[0][0].shape, narrow[1][0].shape)
        self.assertEqual(narrow[0][0].shape[0], full[0][0].shape[0])
        self.assertAlmostEqual(narrow[0][0].shape[1] / full[0][0].shape[1], .76, delta=.005)


if __name__ == '__main__':
    unittest.main()
