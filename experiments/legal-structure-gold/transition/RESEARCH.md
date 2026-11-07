# Document-level structure parsing: what the research does

Research checked 2026-11-01, after the user caught me building document-level machinery from our own pieces without examining the literature.

**The published recipe:** DSPS/HRDoc (AAAI 2023), Detect-Order-Construct (Pattern Recognition 2024), UniHDSA (2025).
- Every text line gets a learned representation: pretrained BERT text embedding, visual RoI features and 2D position.
- Transformer encoders run within the page, then across the document's regions and headings. The document-level understanding lives in this representation.
- Every structure decision is a pairwise relation, softmax over candidates as in dependency parsing: successor (reading order), parent and left sibling (heading tree), caption or footnote to its object.
- Decoding is light: union-find for regions, tree insertion on the rightmost branch.

**The evidence for it:**
- Detect-Order-Construct hierarchy accuracy (STEDS): 0.95 on HRDoc-Simple, 0.86 on Hard, and 0.86 TOC, against DSPS's 0.81 and 0.69, trained on about 1,000 documents.
- DSPS dropped from 0.81 to 0.65 when parents were limited to the same page, so cross-page context matters.
- DocParser (rules plus features) scored about 0.2.
- Legal rhetorical roles use the same principle: hierarchical BiLSTM-CRF, then transformers with document context.
- Footnote linking has no standard learned method; published work matches markers to notes with layout and font cues.

**What it implies for us:**
- The gains come from a learned document-level encoder. A heavy joint inference layer over hand-built features (my whole.rs, 2026-11-01) is not what the literature shows working. Keep that solve as a light constraint layer only.

**Bases** (limited gold of about 4,000 documents):
- Line text: frozen pretrained multilingual sentence encoder. `multilingual-e5-small` (about 100M parameters, listed MIT) or `paraphrase-multilingual-MiniLM-L12-v2` for tier 1; a Model2Vec static distillation for CPU.
- Layout: our line features plus PP-DocLayout region labels (already shipped as ppdoc).
- Train ourselves: a small document transformer (2–4 layers), pretrained on the HTML silver lines, plus the relation heads.
- Avoid LayoutLMv3: its weights are reported non-commercial (CC BY-NC-SA).
- LiLT is MIT-tagged but token- and page-level; revisit for scans.
- Comp-HRDoc (microsoft/CompHRDoc) releases the data and evaluation, apparently not the model code.

**Tier 0:** the same model made CPU-sized (static embeddings, a small document transformer, the same heads), not a different, weaker architecture. Forests become a fallback or distillation targets.

**How to apply:**
- Check the literature first on any structure-model design.
- Never present our own machinery as research-backed without having read the papers.
- Related: [[transition-parser-2026-10-31]], [[evidence-combination-not-ml-cliche]], [[parser-goal-no-llm]], [[beaver-inference-hardware-constraint]].

Sources: arXiv 2401.11874 (Detect-Order-Construct), arXiv 2503.15893 (UniHDSA), AAAI 2023 HRDoc/DSPS, arXiv 2212.02896 (multimodal tree decoder for TOC), arXiv 1709.00770, arXiv 1911.05405 and 2502.05836 (legal rhetorical roles), xbna.pku.edu.cn 2015 (footnote linking), github.com/microsoft/CompHRDoc, github.com/MinishLab/model2vec.
