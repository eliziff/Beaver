"""Train visual + lexical heads from raw recognition, using gold only as targets."""
import argparse
from pathlib import Path

from prepare_raw_ocr_split import read,load_raw_bank
from train_doc_split import digest,write
from train_cpu_full_split import train
from visual_text_split import VisualTextSplitModel


def fit(root,epochs):
    base=root/'teacher-data'; raw=base/'raw-ocr'
    coverage=read(raw/'coverage.json'); targets=read(raw/'internal-training.json')
    if not coverage['complete']:
        raise ValueError('OCR-only input coverage is incomplete. Supply actual production OCR exports; neither native text nor gold text is a fallback.')
    if targets['gold_sha256']!=digest(base/'internal-training.json') or targets['input_manifest_sha256']!=digest(raw/'input-manifest.json'):
        raise ValueError('Raw OCR labels or inputs changed; regenerate the alignment audit')
    if coverage['raw_targets_sha256']!=digest(raw/'internal-training.json'):
        raise ValueError('Aligned OCR target manifest changed after its coverage audit')
    from check_text_split_fit import check
    if not check(root)['passed']:
        raise ValueError('Internal tiny-fit check failed; refusing a long training run')
    bank=load_raw_bank(raw/'input-manifest.json')
    train(root,epochs,model_factory=lambda:VisualTextSplitModel(bank),output_name='visual-text',
        internal_path=raw/'internal-training.json',initial_checkpoint=root/'cpu-model/full-page-and-line/model.pt',family_balanced=True)
    report_path=root/'cpu-model/visual-text/report.json'; report=read(report_path)
    report.update(raw_input_manifest_sha256=digest(raw/'input-manifest.json'),
        text_sources={name:digest(Path(__file__).parent/name) for name in
            ('visual_text_split.py','raw_ocr_split.py','prepare_raw_ocr_split.py',Path(__file__).name)},
        input_contract='Raw recognition text/boxes; gold supplies targets only. Missing OCR proposals remain false negatives.')
    write(report_path,report)


if __name__=='__main__':
    parser=argparse.ArgumentParser(description=__doc__); parser.add_argument('--root',required=True,type=Path)
    parser.add_argument('--epochs',type=int,default=8)
    parser.add_argument('--sanity-only',action='store_true')
    args=parser.parse_args()
    if args.sanity_only:
        from check_text_split_fit import check
        print(check(args.root))
    else: fit(args.root,args.epochs)
