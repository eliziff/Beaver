"""Collect raw and CPU-optimized operators for the two recognizers and detectors."""
import argparse
import hashlib
import json
import tempfile
from collections import defaultdict
from pathlib import Path

import onnx
import onnxruntime as ort


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--assets-root", type=Path, required=True)
    args = parser.parse_args()
    assert ort.__version__ == "1.22.0", "Match the packaged ORT Web version"
    output = args.assets_root / "reduced"
    output.mkdir(parents=True, exist_ok=True)
    operators = defaultdict(set)
    sources = {}

    def collect(graph_model):
        versions = {entry.domain: entry.version for entry in graph_model.opset_import}

        def nodes(graph):
            for node in graph.node:
                operators[(node.domain or "ai.onnx", versions[node.domain])].add(node.op_type)
                for attribute in node.attribute:
                    if attribute.type == onnx.AttributeProto.GRAPH:
                        nodes(attribute.g)
                    elif attribute.type == onnx.AttributeProto.GRAPHS:
                        for child in attribute.graphs:
                            nodes(child)
        nodes(graph_model.graph)

    with tempfile.TemporaryDirectory(prefix="ocr-operator-config-") as scratch:
        for relative in ["indra/model.onnx", "crnn/model.onnx", "detectors/indra/model.onnx", "detectors/paddle/model.onnx"]:
            model = args.assets_root / relative
            sources[relative] = hashlib.sha256(model.read_bytes()).hexdigest()
            collect(onnx.load(model))
            options = ort.SessionOptions()
            options.intra_op_num_threads = 1
            options.optimized_model_filepath = str(Path(scratch) / (relative.replace("/", "-") + ".onnx"))
            ort.InferenceSession(str(model), options, providers=["CPUExecutionProvider"], disabled_optimizers=["NchwcTransformer"])
            collect(onnx.load(options.optimized_model_filepath))
    # WASM uses NHWC convolution fusions that the native x86 optimizer cannot emit.
    operators[("com.microsoft", 1)].update({"FusedConv", "FusedMatMul", "NhwcConv"})
    lines = [f"{domain};{version};{','.join(sorted(names))}" for (domain, version), names in sorted(operators.items())]
    (output / "required_operators.config").write_text("\n".join(lines) + "\n", encoding="utf-8")
    (output / "build-inputs.json").write_text(json.dumps({"ort_version": ort.__version__, "models_sha256": sources, "operators": lines}, indent=2) + "\n", encoding="utf-8")
    print("\n".join(lines))


if __name__ == "__main__":
    main()
