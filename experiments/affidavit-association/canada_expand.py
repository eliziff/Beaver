"""Reuse the public-source gold author's split, annotation and review workflow."""
import json, pathlib, sys, os
import regulatory_expand as workflow
import canada_masks
import canada_budget
import canada_alignment

if not os.environ.get('CODEX_EXEC_COMMAND'):
    binaries=list((pathlib.Path(os.environ['APPDATA'])/'npm/node_modules/@openai/codex/node_modules/@openai').glob('codex-win32-*/vendor/*/bin/codex.exe'))
    if len(binaries)==1:os.environ['CODEX_EXEC_COMMAND']=str(binaries[0])

workflow.OUT = pathlib.Path('benchmarks/local-data/affidavit-association/expansion/canada').resolve()
workflow.RUN = 'affidavit-association-canada-20261022'
workflow.AUTHOR = workflow.AUTHOR.replace('or fewer than three exhibits.', 'or no exhibits. A one- or two-exhibit record requires a concrete near-twin sibling document discriminator supported by the source, plus several substantive chronology events; reject a simple CV-only or report-only attachment.')
workflow.AUTHOR += '\nQuotations must preserve OCR characters literally: if supplied affidavit text has | where the image reads I, quote |. Never repair OCR inside a quote. ISO date ranges use separate date and end_date, never a slash in date.\n'
workflow.AUTHOR += '\nWhen an actual paragraph number is clearly visible in the original images but OCR omitted or garbled that number, add a top-level paragraphs_by_eye array containing those source-verified integers. Do not invent paragraph numbers.\n'
workflow.AUTHOR += '\nWhen SOURCE includes actual_mixed_folder_counterparts, these are real anonymous files (same_proceeding explicitly distinguishes true proceeding siblings from other-proceeding same-author versions) materialized in distractors.json and included in the retrieval folder. Assess difficulty against these concrete earlier/later same-expert documents; do not assume any extra siblings beyond the supplied inventory. Their identifying_affidavit text is counterpart provenance, never a source of target affidavit quotations or target events. A CV alone still needs a substantive source-demonstrated version discriminator, not merely another person\'s unrelated CV.\n'
workflow.AUTHOR += '\nIf association_scope is partial_source_projection, the full affidavit and full source_exhibit_inventory remain authoritative. Source_exhibit_exclusions are real filed exhibits intentionally excluded from evaluated files because certification ink cannot be removed without harming visible body content. Do not call them unattached. Gold.exhibits includes only available evaluated files, and gold must retain association_scope and source_exhibit_exclusions. Preserve ALL narrated events: events.exhibits contains only available labels; source_exhibit_labels separately retains actual source labels including excluded ones. Independently verify excluded-page overlap and that available files lost no substantive visible body. Report this as partial association, never complete filing coverage.\n'
workflow.AUTHOR += '\nIf every leak_audit item for a label is a genuine substantive reference to a different affidavit\'s exhibit, preserve that content and source-review it explicitly; gold.leak_waivers may list only those reviewed labels, with a concrete explanation in notes. Never waive an outer certification or a filing-order folio.\n'
namespace = workflow.SimpleNamespace
workflow.SimpleNamespace = lambda **kw: namespace(**dict(kw,effort='high'))
canada_budget.install(workflow)
canada_alignment.install(workflow)

def prepare():
    rows = json.loads((workflow.OUT/'acquired.json').read_text())
    # One proceeding stays bounded; retain adversarial sides and same-author rebuttals.
    chosen2023 = ('B Muldoon','Dr E Halfyard','H MacLeod','J Martin','C Stevens','A Turner','C Glebe','D Richards')
    sources=[]
    for row in rows:
        if row['family']=='2023' and not any(x in row['label'] for x in chosen2023):continue
        sources.append(dict(row,path=pathlib.Path(row['path']).relative_to(workflow.HOME).as_posix()))
    workflow.atomic_json(workflow.OUT/'sources.json',sources)
    workflow.prepare()

if __name__ == '__main__':
    if sys.argv[1]=='prepare':prepare()
    else:
        for p in (workflow.OUT/'records').glob('*/source.json'):
            source=workflow.read_json(p);canada_masks.apply(p.parent,workflow.ROOT/source['ocr_derivative'])
        workflow.annotate()
