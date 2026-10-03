"""Freeze evaluator identity after independent self-tests, before production edits."""
from __future__ import annotations
import datetime, hashlib, json, pathlib, subprocess
ROOT=pathlib.Path(__file__).resolve().parents[3]
FROZEN=ROOT/'.tmp/cloud-docx-hillclimb/frozen'
def sha(p):return hashlib.sha256(p.read_bytes()).hexdigest()
def main():
 target=FROZEN/'freeze.json'
 if target.exists():raise SystemExit('Already frozen; genuine harness correction requires a new version and rebaseline.')
 files={}
 for p in sorted(FROZEN.rglob('*')):
  if p.is_file():files[str(p.relative_to(ROOT))]=sha(p)
 for p in sorted((ROOT/'benchmarks/docx_edit/preservation').glob('*')):
  if p.suffix in ('.py','.ts','.md'):files[str(p.relative_to(ROOT))]=sha(p)
 split=json.loads((FROZEN/'split.json').read_text());counts={k:list(split['families'].values()).count(k) for k in ('development','heldout')}
 assert counts=={'development':12,'heldout':3}
 selftest=ROOT/'.tmp/cloud-docx-hillclimb/oracle-selftest.json';result=json.loads(selftest.read_text());assert result['selftest']=='pass'
 created=datetime.datetime.now(datetime.timezone.utc)
 payload={'schema':'docx-preservation-frozen-v3','created_utc':created.isoformat(),
 'submission':{'origin':'machine_test','run_id':'docx-preservation-'+created.strftime('%Y%m%dT%H%M%S%fZ')},
 'provenance':'Independently invented station-log OOXML packages; no private documents or existing production output used as gold.',
 'source_head':subprocess.check_output(['git','rev-parse','HEAD'],cwd=ROOT,text=True).strip(),
 'source_archive_sha256':sha(ROOT/'.tmp/cloud-docx-hillclimb/control/baseline-source.tar.gz'),
 'split':{'unit':'source document structural family','development_families':12,'heldout_families':3,'development_tasks':60,'heldout_tasks':15,'assignment_sha256':sha(FROZEN/'split.json'),'policy':'Heldout files and task expectations remain unopened during development; hashes only until final incumbent selected.'},
 'score':{'primary':'integer count of tasks with successful public execution AND verified exact artifact; maximize60DEV','exact_task':'All independently authored intended target changes occur at their structural locations.','collateral_free':'Every protected XML structure, property, ordered content, reference and opaque package part is preserved; changed sites may retain source or match expected value.','verified_artifact':'Entire output equals independently authored expected package under frozen normalization; all references resolve; word_python source unchanged before apply, published bytes equal preview, actual LibreOffice opened with finite positive page count.','tool_success':'Separate diagnostic; never sufficient for verified artifact.'},
 'normalization':['ZIP metadata/compression/order ignored; member identity exact.','XML namespace prefix, attribute ordering and relationship/content-type declaration ordering ignored.','Equivalent adjacent same-property/same-run-attribute pure-text runs may split or merge. Note-bearing runs retain their original grouping and child boundaries.','xml:space interpreted before same-property text coalescing; boundary whitespace without preserve is insignificant.','Run properties and attributes, bookmark/reference locations, hyperlink containers, paragraph/table/section order, non-whitespace XML tails remain exact.','No-op session outputs require byte equality for every uncompressed package member.'],
 'acceptance':['Strict improvement in development primary integer score.','Every verified baseline task remains verified; every incumbent success remains verified.',
 'Every per-task baseline/incumbent exact_task and preservation success remains successful, even where overall task failed.','No frozen harness, fixture, gold or gate change during candidate search.','Production patch bounded to existing DOCX operation and preserves features; affected correctness tests must pass.','Holdout opened once for final selected incumbent; never tune against it.','Real harness corrections require explicit new version, source-reverted baseline and separate receipts.'],
 'selftest':{'sha256':sha(selftest),'reference_passes':result['reference_passes'],'negative_controls_rejected':result['negative_controls_rejected']},
 'production_identity_paths':sorted(subprocess.check_output(['git','ls-files','backend/src/','backend/scripts/word_python/'],cwd=ROOT,text=True).splitlines()),
 'files':files}
 target.write_text(json.dumps(payload,indent=2)+'\n')
 for rel in files:(ROOT/rel).chmod(0o444)
 target.chmod(0o444)
 print(json.dumps({'freeze':str(target.relative_to(ROOT)),'sha256':sha(target),'files':len(files),'tasks':60,'heldout_tasks':15}))
if __name__=='__main__':main()
