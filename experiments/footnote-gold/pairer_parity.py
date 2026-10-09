"""Score this repo's footnote pairer against the Open Access Journals Database pairer on the
goldset's own input lines (Codex transcription, postcorrected regions), with that database's
own scorer, so the two numbers are directly comparable.

    python experiments/footnote-gold/pairer_parity.py --out <dir> [--original]

`--original` also reruns the database's pairer on the same lines. The database checkout is
read only: its pairer and scorer are the oracle, imported from its own tree.
"""
import argparse, json, subprocess, sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
OLJ = Path(r'C:/Users/elias/Desktop/Open Access Journals Database')
GOLDSET = OLJ / 'Text-Fidelity-Project/tools/footnotes/output/goldset/target_1500_20260706_03'
EXAMPLE = ROOT / 'native/legal-structure-node/target/release/examples/olj_lines.exe'


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--out', type=Path, required=True)
    parser.add_argument('--original', action='store_true', help="Also rerun the database's own pairer")
    args = parser.parse_args()
    args.out.mkdir(parents=True, exist_ok=True)
    sys.path[:0] = [str(OLJ), str(OLJ / 'Text-Fidelity-Project')]
    from tools.footnotes import footnote_goldset as olj

    lines = GOLDSET / 'gold_text_copies/gold_lines.markerized.jsonl'
    raw = args.out / 'raw_markers.jsonl'
    subprocess.run([str(EXAMPLE), str(lines), str(raw)], check=True)
    keys = set()
    candidates = args.out / 'candidate_markers.jsonl'
    with candidates.open('w', encoding='utf-8', newline='\n') as handle:
        for index, row in enumerate(map(json.loads, raw.open(encoding='utf-8')), 1):
            normalized = olj.normalize_marker_row(row, source_kind='legal_pdf_pairing', gold_status='candidate_output',
                                                  source_path=lines, source_row_index=index)
            if normalized is not None:
                handle.write(json.dumps(normalized, ensure_ascii=False) + '\n')
    for row in olj.iter_jsonl(lines, encoding='utf-8-sig', skip_invalid=True):
        if all(olj.article_key(row)):
            keys.add(olj.article_key(row))
    gold = args.out / 'gold_markers.scored.jsonl'
    olj.write_jsonl(gold, [row for row in olj.load_gold_markers(GOLDSET / 'gold_markers.locked.jsonl') if olj.article_key(row) in keys])
    ours = olj.score_goldset(gold_markers_jsonl=gold, candidate_source=candidates, output_dir=args.out / 'scorecard')
    report = {'ours': {k: ours.get(k) for k in ('candidate_pair_count', 'gold_pair_count', 'pair_precision', 'pair_recall', 'pair_f1', 'ref_recall', 'label_recall')}}
    if args.original:
        summary = olj.run_footnote_strategy_on_goldset(goldset_dir=GOLDSET, output_dir=args.out / 'original', replace=True)
        report['original'] = {k: summary.get(k) for k in report['ours']}
    print(json.dumps(report, indent=1))


if __name__ == '__main__':
    main()
