"""Materialize actual same-proceeding counterparts as complete source text, without false negatives."""
from second_canada_author import *

def main():
    rows={
      'ca2-bc-hamm-postma':[('2695c989',list(range(1,12)),'Power intervention affidavit, no own exhibits'),('2e632e41',list(range(1,8)),'Keirstead intervention affidavit, no own exhibits')],
      'ca2-bc-hamm-kennedy':[('2695c989',list(range(1,12)),'Power intervention affidavit, no own exhibits'),('2e632e41',list(range(1,8)),'Keirstead intervention affidavit, no own exhibits')],
      'ca2-nb-policy713-application':[('63263b4',list(range(1,14)),'Same affiant separate standing affidavit'),('63263b4',list(range(41,70)),'Standing affidavit own B litigation list with internal Exhibit A title')],
      'ca2-nb-policy713-standing':[('d99fdd4',[1,2,3,4],'Same affiant separate judicial-review affidavit'),('d99fdd4',list(range(20,26)),'Original Policy713, not standing affidavit own A originating application')],
      'ca2-fc-cawsbar-mason':[('09bad815',list(range(68,72)),'Moore standing affidavit'),('09bad815',[73,74,75],'CAC certificate of amendment, differs from own CAWSBAR incorporation certificate')],
      'ca2-fc-cawsbar-moore':[('09bad815',list(range(7,18)),'Mason standing affidavit'),('09bad815',list(range(19,25)),'CAWSBAR certificate of incorporation, differs from own CAC amendment certificate')],
    }
    for rid,items in rows.items():
        dest=OUT/'records'/rid; manifest=[]
        for prefix,ps,reason in items:
            r=source(prefix);pages=pages_for(r);txt='\f\n'.join(pages[n-1] for n in ps)
            stem='counterpart-'+digest((r['sha256']+str(ps)).encode())[:12]
            sha=textfile(dest/'distractors'/(stem+'.txt'),txt)
            manifest.append(dict(file='distractors/'+stem+'.pdf',text_file='distractors/'+stem+'.txt',
                text_sha256=sha,source_sha256=r['sha256'],source_url=r['url'],source_pages=ps,
                same_proceeding=True,role='non_target_same_proceeding_document',reason=reason,
                review_status='pending_independent_review',provenance=PROVENANCE,
                pdf_export='Text-only logical PDF; original immutable PDF is canonical',
                equivalence_warning='Compare full original documents before any negative/equivalence decision; no equivalence from empty text.'))
        dump(dest/'distractors.json',manifest)
    print('materialized counterparts',sum(len(x) for x in rows.values()))
if __name__=='__main__':main()
