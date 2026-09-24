"""Native onnxruntime CPU throughput of the same q4 model and prompts, at 1 and 4 threads
(to scale the single-thread WASM number to a multi-threaded browser worker).
Usage: python native_time.py <model.onnx> <prompts.json> [maxPrompts=2]"""
import json, sys, time
import numpy as np
import onnxruntime as ort

model, pj = sys.argv[1], sys.argv[2]
maxp = int(sys.argv[3]) if len(sys.argv) > 3 else 2
d = json.load(open(pj))
for thr in (1, 4):
    so = ort.SessionOptions(); so.intra_op_num_threads = thr
    s = ort.InferenceSession(model, so, providers=["CPUExecutionProvider"])
    L = sum(1 for i in s.get_inputs() if i.name.endswith(".key"))
    t0 = time.time(); ntok = 0
    for ids in d["prompts"][:maxp]:
        past = {f"past_key_values.{l}.{kv}": np.zeros((1, 2, 0, 64), np.float32) for l in range(L) for kv in ("key", "value")}
        for st in range(0, len(ids), 128):
            ch = ids[st:st + 128]; end = st + len(ch)
            out = s.run(None, {"input_ids": np.array([ch], np.int64), "attention_mask": np.ones((1, end), np.int64),
                               "position_ids": np.arange(st, end, dtype=np.int64)[None], **past})
            names = [o.name for o in s.get_outputs()]
            past = {n.replace("present", "past_key_values"): v for n, v in zip(names, out) if n.startswith("present")}
        ntok += len(ids)
    dt = time.time() - t0
    print(f"threads {thr}: {ntok} tokens {dt:.1f}s {ntok / dt:.1f} tok/s")
