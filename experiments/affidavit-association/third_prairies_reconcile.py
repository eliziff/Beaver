"""Bind complete text projections to immutable independently reviewed source Gold."""
from pathlib import Path
from datetime import datetime, timezone
import hashlib
import json
import sys

ROOT = Path(__file__).resolve().parents[2]
EXPANSION = ROOT / 'benchmarks/local-data/affidavit-association/expansion-3'
sys.path[:0] = [str(EXPANSION), str(ROOT / 'tools')]
from source_tools import source, views_folder
from audit_expansion import source_parts


def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def read(path):
    return json.loads(path.read_text(encoding='utf-8'))


def dump(path, value):
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2), encoding='utf-8')


def projection(parts):
    pages = []
    for part in parts:
        folder = views_folder(source(part['sha256']))
        pages.extend((folder / f'page-{n:04d}.txt').read_text(encoding='utf-8') for n in part['pages'])
    return '\f'.join(pages)


def reconcile(record):
    reviewed = record / 'reviewed-source-gold.json'
    gold = read(reviewed)
    manifest = record / 'model-views.json'
    old = read(manifest)
    # Preserve already audited, narrower source-derived masks and handwriting repairs.
    if (old.get('review_status') == 'accepted' or (record / 'model-reconciliation.json').exists()
            or any('visually verified' in v.get('reason', '') for v in old.get('views', []))):
        return False
    receipt = record / 'complete-view-reconciliation.json'
    if receipt.exists() and read(receipt).get('reviewed_source_gold_sha256') == sha(reviewed):
        return False
    history = record / 'view-history'
    history.mkdir(exist_ok=True)
    original_manifest = history / 'pre-reconciliation-model-views.json'
    if not original_manifest.exists():
        original_manifest.write_bytes(manifest.read_bytes())
    views = []
    for n, exhibit in enumerate(gold['exhibits'], 1):
        parts = source_parts(exhibit)
        entry = {'label': exhibit['label'], 'source_files': parts}
        if not parts:
            entry.update(eligible=False, reason=exhibit.get('unavailable_reason') or exhibit.get('availability') or
                         'Original target is unavailable in the complete supplied public sources.')
        else:
            text = record / 'model-text' / f'reviewed-target-{n:03d}.txt'
            text.write_text(projection(parts), encoding='utf-8')
            entry.update(file=f'reviewed-target-{n:03d}.pdf', text_file=text.relative_to(record).as_posix(),
                         text_sha256=sha(text), eligible=True, complete=True,
                         modality='complete_original_page_text' if text.read_text(encoding='utf-8').strip()
                         else 'visual_source_with_empty_text',
                         pdf_export_status='not_created_text_only_view',
                         fidelity_status='pending_original_image_and_outer_assignment_check',
                         reason='Every complete reviewed source page retained, including mixed cover/body pages. '
                         'No cover heuristic, preview limit, invented transcription or source modification. '
                         'Final OCR and extrinsic compilation-mark fidelity remain separate checks.')
        views.append(entry)
    body = record / 'model-text' / 'reviewed-referring-document.txt'
    body.write_text(projection(source_parts(gold['referring_document'])), encoding='utf-8')
    dump(manifest, dict(review_status='pending_fidelity_review', source_gold_sha256=sha(reviewed),
         referring_document_view=dict(text_file=body.relative_to(record).as_posix(), text_sha256=sha(body)),
         views=views, reason='Canonical complete text inventory mechanically reconciled to independent source Gold; '
         'no new source acceptance or final model fidelity approval is asserted.'))
    dump(receipt, dict(origin='machine_test', method='mechanical_full_page_projection',
         recorded_at_utc=datetime.now(timezone.utc).isoformat(), reviewed_source_gold_sha256=sha(reviewed),
         immutable_author_gold_sha256=sha(record / 'source-gold.json'), previous_manifest_sha256=sha(original_manifest),
         current_manifest_sha256=sha(manifest), labels=len(views), eligible=sum(v['eligible'] for v in views),
         source_gold_unchanged=True, final_model_fidelity='pending'))
    return True


if __name__ == '__main__':
    lane = EXPANSION / 'prairies-other' / 'records'
    records = [lane / name for name in sys.argv[1:]] if len(sys.argv) > 1 else sorted(lane.iterdir())
    changed = [record.name for record in records if (record / 'reviewed-source-gold.json').exists() and reconcile(record)]
    print(json.dumps({'reconciled': changed}))
