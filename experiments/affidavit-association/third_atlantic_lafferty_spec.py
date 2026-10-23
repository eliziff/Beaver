"""Complete territorial criminal factum and actual opposing-file references."""
from pathlib import Path
import fitz
from third_atlantic_sources import s,O
ap='27e6b97f5a1c8acfbafe50f9d76f637b37c31a2093342988178a41614ad68284'
re='388eac7b9e483cfcdb2624894d1068fcd03a1d8796c4d2aa2070a8e36c9608dd'
ag='d72d4f5edde68f5e7b07f0d452bf299fbd8ca2b8f9071d080bba23cdd82d9936'
reply='874a79481b6046560c82aba5567b39621459170e16e66f41c999e3e7cbcd356f'
sources=[]
for sh,n,images,role in [(re,24,[1,5,9,15,16,19,22,23,24],'Complete Crown respondent factum. Exact references to Appellant factum paragraphs69 and63 are in footnotes59,75,87. These concern this case’s evidentiary position; the actual full appellant factum is available, not an inferred trial record.'),(ap,29,[1,4,5,6,28,29],'Complete actual appellant factum. Exact public party instrument, distinct from missing Appellant Record and underlying evidence. Do not certify it as original trial transcripts or factual findings.'),(ag,16,[1,4,15,16],'Complete Ontario intervention factum, potential same-case counterpart; check whether positively referred to before using as a negative.'),(reply,7,[1,2,6,7],'Complete later appellant reply. Contains hypothetical legal examples which are not real chronology events; do not substitute this later reply for original appellant factum.')]:
 r=s.source(sh);s.extract(r);folder=s.views_folder(r)
 with fitz.open(r['original_path']) as doc:
  for p in images:
   target=folder/f'page-{p:04}.png'
   if not target.exists():doc[p-1].get_pixmap(matrix=fitz.Matrix(1.5,1.5)).save(target)
 sources.append(dict(sha256=sh,role=role,pages=list(range(1,n+1)),image_pages=images))
rid='an3-nt-lafferty-respondent-factum'
s.dump(O/'specs'/(rid+'.json'),dict(record_id=rid,lane='atlantic-north',jurisdiction='nt',body_sha256=re,body_pages=list(range(1,25)),sources=sources,source_cautions='Complete Crown24-page instrument in Canadian Northwest Territories criminal case, SCC42284, origin A-1-AP-2025-000007/S-1-CR-2023-000026. Source caption controls jurisdiction, not Crown counsel Iqaluit address. At least the expressly referenced full Appellant factum is available: preserve actual aliases and paragraph anchors, not an invented ExhibitA. Full original lower reasons2025NWTSC25 and2026NWTCA3 not located from official sources in current search; linked CanLII routes retained but NOT fetched. Keep them and ALL factual trial evidence/admissions/testimony/closing submissions and collective record scopes in complete inventory with honest unavailable status. Do not substitute quotations in party factums for certified lower records. Specific trial closing footnotes55–57 say February24,2026 while earlier footnotes say2025: preserve contradiction, no arbitrary correction. Appellant/Hannah and witness/Ikeda are distinct women; witness’s former partner AustinMoore is not Ikeda herself. Attribute contested characterizations and legal positions. All complete bodies and available target texts supplied without preview caps. Generic precedents/statutes are not factual positives. Public original has no case-sensitivity restrictions per Crown, but do not invent factual allegations beyond supplied public text. Gold independent of model-view fidelity.'))
print(rid)
