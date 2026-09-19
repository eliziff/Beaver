# Sources and notices

`citation_scores` adapts the joint-evidence and citation-necessity algorithm in
`princeton-nlp/ALCE`, `eval.py`, Git blob
`4d62b5a7bbfdc14a14226733c768e72f73444a95`. Changes: operate on Beaver evidence IDs,
retain every answer block and citation, and distinguish absent scores. No upstream
CLI output truncation is copied.

## ALCE — MIT License

Copyright (c) 2023 Princeton Natural Language Processing

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.

## Downloaded dependencies and data

- MiniCheck code: `Liyan06/MiniCheck`, commit
  `b58b9fa69acbd1015ec970fa65dd752413a053d2`, Apache-2.0. Liyan Tang, Philippe Laban,
  Greg Durrett, *MiniCheck: Efficient Fact-Checking of LLMs on Grounding Documents*,
  EMNLP 2024. Model: `lytang/MiniCheck-Flan-T5-Large` (MIT model card). The actual
  resolved model revision and installed package source hash are recorded per run.
  No Bespoke non-commercial model is bundled or selected.
- ALCE: Tianyu Gao, Howard Yen, Jiatong Yu, Danqi Chen, *Enabling Large Language
  Models to Generate Text with Citations*, EMNLP 2023.
- ContractNLI: Yuta Koreeda, Christopher D. Manning, *ContractNLI: A Dataset for
  Document-level Natural Language Inference for Contracts*, Findings of EMNLP
  2021. `stanfordnlp/contract-nli`, commit
  `eced6528dd3c1d14d73f9a87df8f7bdbc03126f9`, CC BY 4.0. The importer maps labels
  to binary support and converts evidence coordinates to UTF-16; source text is
  unchanged. Hypotheses and evidence annotations are not authored by this PR.
- RAGTruth: Chuhan Niu et al., *RAGTruth: A Hallucination Corpus for Developing
  Trustworthy Retrieval-Augmented Language Models*, ACL 2024.
  `ParticleMedia/RAGTruth`, commit `c103204b9ce28d6bbad859304bf30de72b8ed8fe`, MIT.
  The importer preserves answers, derives binary support from original error
  labels, and converts offsets to UTF-16. `quality=good` matches the published
  baseline filter; the original test split is preserved.

Model weights and corpora download to the operator's environment; they are not
vendored into Beaver. `corpus.py` records every upstream file path, commit and Git
blob hash and verifies bytes before importing. These notices do not replace the
licenses distributed with the upstream repositories, model and data.
