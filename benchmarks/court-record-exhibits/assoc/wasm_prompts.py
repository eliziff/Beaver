"""Tokenized f2l prompts of one record (as llm_mc.py builds them, rotation 0) for the WASM timing run.

Usage: python wasm_prompts.py <record> <out.json> [--shortlist oof_v4.npz]
"""
import json, os, sys
import numpy as np
from transformers import AutoTokenizer

sys.argv = [sys.argv[0], "Qwen/Qwen2.5-0.5B-Instruct", "x"] + sys.argv[1:]
import llm_mc as M

rid, out = sys.argv[3], sys.argv[4]
tok = AutoTokenizer.from_pretrained(M.MODEL)
r = next(x for x in json.load(open(os.path.join(M.HERE, "inputs2.json"), encoding="utf-8")) if x["record"] == rid)
s = np.load(os.path.join(M.HERE, M.SHORT))[rid]
heads = [M.filehead(t) for t in r["texts"]]
psgs = [M.passage(r["ctx"][l], l) for l in r["labels"]]
k = min(M.K, *s.shape)
prompts = []
for j in range(len(r["files"])):
    cand = sorted(np.argsort(-s[:, j])[:k])
    p = M.prompt_f2l(heads[j], [psgs[i] for i in cand])
    text = tok.apply_chat_template([{"role": "user", "content": p}], tokenize=False, add_generation_prompt=True) + "The answer is"
    prompts.append(tok.encode(text))
letters = [tok.encode(" " + c, add_special_tokens=False)[0] for c in M.LET]
json.dump({"record": rid, "prompts": prompts, "letters": letters}, open(out, "w"))
print(rid, len(prompts), "prompts,", sum(map(len, prompts)), "tokens")
