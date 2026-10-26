"""Trainable reconstruction of nutrientdocs/doc-split-v1's released boundary head.

Upstream: https://huggingface.co/nutrientdocs/doc-split-v1 (Apache-2.0).
The upstream image/text encoders remain unchanged. ONNX parity is required
before adapting the existing head weights; this is not a new randomly fit head.
"""
import argparse
import json
from pathlib import Path

import numpy as np
import onnx
from onnx import numpy_helper
import onnxruntime as ort
import torch
from torch import nn
from torch.nn import functional as F

UPSTREAM = 'nutrientdocs/doc-split-v1'
REVISION = 'dccadc69dd4ae69c63f42aa6715f249c6e5e6cf8'


class BoundaryHead(nn.Module):
    def __init__(self):
        super().__init__()
        self.proj_img = nn.Linear(768, 512)
        self.proj_txt = nn.Linear(384, 512)
        self.fuse = nn.Sequential(nn.Linear(1027, 512), nn.LayerNorm(512))
        layer = nn.TransformerEncoderLayer(512, 8, 2048, dropout=0.1,
                                          activation='gelu', batch_first=True)
        self.encoder = nn.TransformerEncoder(layer, 6, enable_nested_tensor=False)
        self.head = nn.Sequential(nn.Linear(2052, 512), nn.GELU(), nn.Dropout(0.1), nn.Linear(512, 1))
        self.register_buffer('pe', torch.zeros(1024, 512))
        self.register_buffer('first_logit', torch.zeros(1, 1))

    def forward(self, v_img, v_txt, gate, mask):
        zeros = torch.zeros_like(gate)
        fused = torch.cat((self.proj_img(v_img), self.proj_txt(v_txt) * gate[..., None],
                           torch.stack((gate, zeros, zeros), dim=-1)), dim=-1)
        hidden = self.fuse(fused) + self.pe[:v_img.shape[1]][None]
        hidden = self.encoder(hidden, src_key_padding_mask=mask == 0)
        right, left = hidden[:, 1:], hidden[:, :-1]
        cosine = lambda x: (F.normalize(x[:, 1:], dim=-1, eps=1e-8) *
                            F.normalize(x[:, :-1], dim=-1, eps=1e-8)).sum(-1, keepdim=True)
        pairs = torch.cat((right, left, right - left, right * left, cosine(v_img), cosine(v_txt),
                           gate[:, :-1, None], gate[:, 1:, None]), dim=-1)
        logits = self.head(pairs).squeeze(-1)
        return torch.cat((self.first_logit.expand(v_img.shape[0], 1), logits), dim=1)


def weight_mapping(state):
    mapping = {key: ('spl.' + key, False) for key in state}
    for key, value in {'proj_img.weight': 'val_7', 'proj_txt.weight': 'val_9',
                       'fuse.0.weight': 'val_18', 'head.0.weight': 'val_828',
                       'head.3.weight': 'val_837'}.items():
        mapping[key] = value, True
    for i, qkv in enumerate((35, 155, 271, 387, 503, 619)):
        prefix = f'encoder.layers.{i}.'
        mapping[prefix + 'self_attn.in_proj_weight'] = f'val_{qkv}', True
        mapping[prefix + 'linear1.weight'] = f'val_{142 + 116 * i}', True
        mapping[prefix + 'linear2.weight'] = f'val_{151 + 116 * i}', True
    mapping['pe'] = 'pe', False
    mapping['first_logit'] = 'full', False
    return mapping


def recover(path):
    graph = onnx.load(str(path))
    weights = {v.name: torch.from_numpy(numpy_helper.to_array(v).copy()) for v in graph.graph.initializer}
    model = BoundaryHead()
    state = {key: weights[name].T.contiguous() if transpose else weights[name]
             for key, (name, transpose) in weight_mapping(model.state_dict()).items()}
    model.load_state_dict(state, strict=True)
    return model


def export_head(model, original, target):
    """Keep upstream topology and interfaces; replace only the trained tensors."""
    graph = onnx.load(str(original))
    initializers = {v.name: v for v in graph.graph.initializer}
    state = model.state_dict()
    for key, (name, transpose) in weight_mapping(state).items():
        value = state[key].detach().cpu().numpy()
        if transpose:
            value = value.T
        initializers[name].CopyFrom(numpy_helper.from_array(value.copy(), name=name))
    onnx.checker.check_model(graph)
    onnx.save(graph, str(target))


def parity(path, device='cpu'):
    """Independent invented embeddings, lengths, gates and padded contexts."""
    torch.set_num_threads(1)
    torch.set_float32_matmul_precision('highest')
    torch.backends.cuda.matmul.allow_tf32 = False
    torch.backends.cudnn.allow_tf32 = False
    torch.backends.mha.set_fastpath_enabled(False)
    torch.backends.cuda.enable_flash_sdp(False)
    torch.backends.cuda.enable_mem_efficient_sdp(False)
    torch.backends.cuda.enable_cudnn_sdp(False)
    model = recover(path).to(device).eval()
    options = ort.SessionOptions()
    options.intra_op_num_threads = 1
    session = ort.InferenceSession(str(path), sess_options=options, providers=['CPUExecutionProvider'])
    rng = np.random.default_rng(7241)
    results = []
    for count in (1, 2, 8, 33, 129):
        for padded in (False, True):
            inputs = {'v_img': rng.normal(size=(1, count, 768)).astype(np.float32),
                      'v_txt': rng.normal(size=(1, count, 384)).astype(np.float32),
                      'gate': rng.integers(0, 2, (1, count)).astype(np.float32),
                      'mask': np.ones((1, count), dtype=np.float32)}
            inputs['v_txt'] *= inputs['gate'][..., None]
            if padded and count > 2:
                inputs['mask'][:, -2:] = 0
            reference = session.run(None, inputs)[0]
            with torch.inference_mode():
                actual = model(**{k: torch.from_numpy(v).to(device) for k, v in inputs.items()}).cpu().numpy()
            np.testing.assert_allclose(actual, reference, rtol=2e-4, atol=2e-4)
            results.append({'pages': count, 'padded': padded, 'max_logit_error': float(np.max(np.abs(actual-reference)))})
    model.train()
    output = model(**{k: torch.from_numpy(v).to(device) for k, v in inputs.items()})
    output[:, 1:-2].square().mean().backward()
    assert all(p.grad is not None and torch.isfinite(p.grad).all() for p in model.parameters())
    return {'device': device, 'cases': results, 'finite_gradients': True,
            'parameters': sum(p.numel() for p in model.parameters())}


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('head', type=Path)
    parser.add_argument('--device', default='cpu')
    parser.add_argument('--out', type=Path)
    args = parser.parse_args()
    report = parity(args.head, args.device)
    if args.out:
        args.out.write_text(json.dumps(report, indent=2) + '\n', encoding='utf-8')
    print(json.dumps(report, indent=2))
