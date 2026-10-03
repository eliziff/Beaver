"""Engine-independent, whole-package DOCX oracle. Uses only Python's standard library.
Freeze rules: exact ordered text; exact normalized structural events; exact part set;
all protected XML content/attributes and opaque bytes; valid references. XML prefix,
attribute order and pure-text same-property run splitting are serialization freedoms.
Note-bearing runs retain their original grouping because splitting changes rendering.
"""
from __future__ import annotations
import argparse, collections, hashlib, json, pathlib, posixpath, subprocess, sys, xml.etree.ElementTree as ET, zipfile
from io import BytesIO
ROOT=pathlib.Path(__file__).resolve().parents[3]
FROZEN=ROOT/'.tmp/cloud-docx-hillclimb/frozen'
W='http://schemas.openxmlformats.org/wordprocessingml/2006/main';R='http://schemas.openxmlformats.org/officeDocument/2006/relationships';P='http://schemas.openxmlformats.org/package/2006/relationships'
NS={'w':W,'r':R,'pr':P}; X='{http://www.w3.org/XML/1998/namespace}space'
def sha(b): return hashlib.sha256(b).hexdigest()
def tag(n): return '{'+W+'}'+n

def unpack(data):
 with zipfile.ZipFile(BytesIO(data)) as z:
  names=z.namelist()
  if len(names)!=len(set(names)): raise ValueError('duplicate ZIP members')
  if any(n.startswith('/') or '..' in n.split('/') for n in names): raise ValueError('unsafe ZIP member path')
  result={n:z.read(n) for n in names if not n.endswith('/')}
 for n,b in result.items():
  if n.endswith(('.xml','.rels')):
   if b'<!DOCTYPE' in b or b'<!ENTITY' in b: raise ValueError('DTD/ENTITY not allowed')
   ET.fromstring(b)
 return result

def normalized(e,mask=None):
 attrs=tuple(sorted((k,v) for k,v in e.attrib.items() if not(e.tag==tag('t') and k==X)))
 text=e.text if e.tag in (tag('t'),tag('instrText'),tag('delText')) else (e.text or '').strip()
 if e.tag==tag('t') and e.get(X)!='preserve': text=(text or '').strip(' \t\r\n')
 if mask:
  for old,new in mask: text=text.replace(old,new)
 children=[]
 for c in e:
  if c.tag==tag('r') and any(atom.tag in (tag('footnoteReference'),tag('endnoteReference')) for atom in c):
   # Note-bearing run grouping can affect rendered markers. In particular, splitting
   # text + reference + text into separate runs changes note markers and numbering.
   children.append(('note-bearing-run',normalized(c,mask)))
  elif c.tag==tag('r'):
   props=c.find('w:rPr',NS); props=normalized(props) if props is not None and (len(props) or props.attrib) else None
   for atom in c:
    if atom.tag==tag('rPr'): continue
    item=('run-atom',props,tuple(sorted(c.attrib.items())),normalized(atom,mask))
    if children and atom.tag==tag('t') and children[-1][0]=='run-atom' and children[-1][1]==props and children[-1][2]==item[2] and children[-1][3][0]==tag('t') and children[-1][3][1]==item[3][1] and not children[-1][3][3] and not item[3][3]:
     prev=children[-1][3]; nxt=item[3]
     children[-1]=('run-atom',props,item[2],(prev[0],prev[1],prev[2]+nxt[2],()))
    else: children.append(item)
    if (atom.tail or '').strip(): children.append(('tail',atom.tail))
  else: children.append(normalized(c,mask))
  if (c.tail or '').strip(): children.append(('tail',c.tail))
 # OPC relationship/content-type declaration order has no document meaning.
 if e.tag in ('{'+P+'}Relationships','{http://schemas.openxmlformats.org/package/2006/content-types}Types'):
  children.sort(key=repr)
 return (e.tag,attrs,text or '',tuple(children))

def texts(parts):
 return {p:tuple((e.tag,e.text or '') for e in ET.fromstring(b).iter() if e.tag in (tag('t'),tag('instrText'),tag('delText'))) for p,b in parts.items() if p.startswith('word/') and p.endswith('.xml')}
def visible(parts):
 # Paragraph text order is invariant under legitimate run splitting.
 return {p:tuple(''.join(e.text or '' for e in q.iter() if e.tag in (tag('t'),tag('instrText'),tag('delText'))) for q in ET.fromstring(b).iter(tag('p'))) for p,b in parts.items() if p.startswith('word/') and p.endswith('.xml')}

def reference_errors(parts):
 errors=[];trees={p:ET.fromstring(b) for p,b in parts.items() if p.endswith(('.xml','.rels'))}
 for rp,root in trees.items():
  if not rp.endswith('.rels'): continue
  seen=set(); owner=posixpath.join(posixpath.dirname(posixpath.dirname(rp)),posixpath.basename(rp)[:-5]) if rp!='_rels/.rels' else ''
  for rel in root:
   rid=rel.get('Id');target=rel.get('Target','')
   if rid in seen: errors.append('duplicate relationship '+rp+':'+str(rid))
   seen.add(rid)
   if rel.get('TargetMode')=='External':
    if not rel.get('Type','').endswith('/hyperlink'): errors.append('non-hyperlink external relationship')
   else:
    resolved=posixpath.normpath(posixpath.join(posixpath.dirname(owner),target)).lstrip('/')
    if resolved not in parts: errors.append('missing relationship target '+resolved)
  if owner in trees:
   for node in trees[owner].iter():
    for k,v in node.attrib.items():
     if k.startswith('{'+R+'}') and v not in seen: errors.append('dangling story relationship '+owner+':'+v)
 all_bookmarks=set()
 for part,root in trees.items():
  if not part.startswith('word/') or not part.endswith('.xml'): continue
  starts=[e.get(tag('id')) for e in root.iter(tag('bookmarkStart'))];ends=[e.get(tag('id')) for e in root.iter(tag('bookmarkEnd'))]
  if collections.Counter(starts)!=collections.Counter(ends): errors.append('bookmark pair mismatch '+part)
  if len(starts)!=len(set(starts)): errors.append('duplicate bookmark id '+part)
  all_bookmarks.update(e.get(tag('name')) for e in root.iter(tag('bookmarkStart')))
 for part,root in trees.items():
  for e in root.iter(tag('hyperlink')):
   anchor=e.get(tag('anchor'))
   if anchor and anchor not in all_bookmarks: errors.append('dangling bookmark anchor '+str(anchor))
 for kind in ('footnote','endnote'):
  root=trees.get('word/'+kind+'s.xml'); ids=[e.get(tag('id')) for e in root] if root is not None else []
  if len(ids)!=len(set(ids)): errors.append('duplicate '+kind+' id')
  for part,tree in trees.items():
   for e in tree.iter(tag(kind+'Reference')):
    if e.get(tag('id')) not in ids: errors.append('dangling '+kind+' reference '+part)
 numbering=trees.get('word/numbering.xml');num_ids={};abstract=set()
 if numbering is not None:
  abstract_values=[e.get(tag('abstractNumId')) for e in numbering.findall('w:abstractNum',NS)]
  if len(abstract_values)!=len(set(abstract_values)): errors.append('duplicate abstractNumId')
  abstract=set(abstract_values)
  values=[e.get(tag('numId')) for e in numbering.findall('w:num',NS)]
  if len(values)!=len(set(values)): errors.append('duplicate numId')
  for e in numbering.findall('w:num',NS):
   a=e.find('w:abstractNumId',NS);nid=e.get(tag('numId'));num_ids[nid]=a.get(tag('val')) if a is not None else None
   if num_ids[nid] not in abstract: errors.append('dangling abstractNumId')
 for tree in trees.values():
  for e in tree.iter(tag('numId')):
   if e.get(tag('val')) not in num_ids and e.get(tag('val'))!='0': errors.append('dangling numId')
 return errors

def compare(source,expected,actual):
 try: a=unpack(source);e=unpack(expected);b=unpack(actual)
 except Exception as ex: return {'exact_task':False,'preservation':False,'artifact_correct':False,'failures':['invalid package: '+str(ex)]}
 failures=[];changes=[]
 if set(a)!=set(e): raise ValueError('Frozen tasks may not add/remove package parts')
 if set(e)!=set(b): failures.append('package member set differs')
 exact=True;preserved=True
 def allowed(source,gold,actual):
  if source==gold: return actual==gold
  if not isinstance(source,tuple) or not isinstance(gold,tuple): return actual==source or actual==gold
  if not isinstance(actual,tuple) or len(source)!=len(gold) or len(actual)!=len(gold): return False
  return all(allowed(x,y,z) for x,y,z in zip(source,gold,actual))
 def targets(source,gold,actual):
  if source==gold: return True
  if not isinstance(source,tuple) or not isinstance(gold,tuple): return actual==gold
  if not isinstance(actual,tuple) or len(source)!=len(gold) or len(actual)!=len(gold): return False
  return all(targets(x,y,z) for x,y,z in zip(source,gold,actual))
 for part in sorted(set(e)&set(b)):
  eb=e[part];bb=b[part]
  if not part.endswith(('.xml','.rels')):
   if eb!=bb: preserved=False;failures.append('opaque part changed '+part)
   continue
  sr=normalized(ET.fromstring(a[part]));er=normalized(ET.fromstring(eb));br=normalized(ET.fromstring(bb))
  if not targets(sr,er,br): exact=False
  if not allowed(sr,er,br): preserved=False
  if er!=br:
   changes.append(part);failures.append('ordered XML differs '+part)
 if reference_errors(b): failures+=reference_errors(b);preserved=False
 preserved=preserved and set(e)==set(b)
 exact=exact and set(e)==set(b)
 if a==e:
  if a!=b: preserved=False;failures.append('no-op changed package part bytes')
  exact=not changes and preserved
 if visible(e)!=visible(b): failures.append('ordered story text differs')
 if not exact: failures.append('requested change missing or incorrect')
 return {'exact_task':exact,'preservation':preserved,'artifact_correct':exact and preserved and not changes,'failures':failures,'differing_parts':changes}

def selftest():
 # Uses DEV only. Every independently authored reference must pass; wrong outputs must fail.
 rows=[]; note_boundary_count=0; note_boundary_kinds=set()
 for d in sorted((FROZEN/'development').iterdir()):
  source=(d/'source.docx').read_bytes()
  reference_count=0;negative_count=0
  for task in json.loads((d/'tasks.json').read_text()):
   expected=(d/task['expected']).read_bytes(); reference=compare(source,expected,expected)
   assert reference['artifact_correct'],(task['id'],reference);reference_count+=1
   if task['tool']!='session':
    assert not compare(source,expected,source)['artifact_correct'],task['id'];negative_count+=1
  # Corruptions must be rejected even if expected target text still exists.
  edited=next(t for t in json.loads((d/'tasks.json').read_text()) if t['name']=='edit-inline')
  gold=(d/edited['expected']).read_bytes();parts=unpack(gold)
  def reorder(data):
   root=ET.fromstring(data);body=root.find('w:body',NS);positions=[i for i,x in enumerate(body) if x.tag==tag('p')];i,j=positions[:2]
   first,second=body[i],body[j];body[i],body[j]=second,first
   return ET.tostring(root,encoding='utf-8',xml_declaration=True)
  variants={
   'protected-text':('word/header1.xml',lambda x:x.replace(b'counterseal',b'counterfeit')),
   'broken-link':('word/_rels/document.xml.rels',lambda x:x.replace(b'Target="header1.xml"',b'Target="missing.xml"')),
   'broken-note':('word/document.xml',lambda x:x.replace(b'w:footnoteReference w:id="',b'w:footnoteReference w:id="999')),
   'merge-geometry':('word/document.xml',lambda x:x.replace(b'w:gridSpan w:val="2"',b'w:gridSpan w:val="3"',1)),
   'paragraph-order':('word/document.xml',reorder),
   'run-attribute':('word/document.xml',lambda x:x.replace(b'<w:r>',b'<w:r w:rsidR="CAFE0001">',1)),
   'meaningful-tail':('word/document.xml',lambda x:x.replace(b'</w:r>',b'</w:r>unexpected-tail',1)),
   'text-attribute':('word/document.xml',lambda x:x.replace(b'<w:t ',b'<w:t w:unexpected="changed" ',1)),
   'space-semantics':('word/footer1.xml',lambda x:x.replace(b' xml:space="preserve">Sheet ',b'>Sheet ',1)),
   'duplicate-number-id':('word/numbering.xml',lambda x:x.replace(b'</w:numbering>',b'<w:num w:numId="7"><w:abstractNumId w:val="4"/></w:num></w:numbering>')),
   'duplicate-abstract-id':('word/numbering.xml',lambda x:x.replace(b'</w:numbering>',b'<w:abstractNum w:abstractNumId="4"/></w:numbering>')),
   'number-reference':('word/numbering.xml',lambda x:x.replace(b'w:abstractNumId w:val="4"',b'w:abstractNumId w:val="404"')),
   'bookmark-anchor':('word/document.xml',lambda x:x.replace(b'w:anchor="Beacon_',b'w:anchor="Missing_')),
  }
  from fixtures import package
  for name,(part,fn) in variants.items():
   changed=dict(parts);changed[part]=fn(changed[part]); assert changed[part]!=parts[part],name
   assert not compare(source,gold,package(changed))['artifact_correct'],(d.name,name);negative_count+=1
  missing=dict(parts);missing.pop('word/footer1.xml');assert not compare(source,gold,package(missing))['artifact_correct'];negative_count+=1
  # Splitting a note-bearing run can change the rendered marker/numbering even
  # when all text, reference IDs, child order, attributes and properties survive.
  # Corrupt edited gold, so the no-op member-byte rule cannot catch this for us.
  import copy
  note_tree=ET.fromstring(parts['word/document.xml'])
  candidates=[i for i,r in enumerate(note_tree.iter(tag('r'))) if any(a.tag in (tag('footnoteReference'),tag('endnoteReference')) for a in r) and len([a for a in r if a.tag!=tag('rPr')])>1]
  for run_index in candidates:
   tree=ET.fromstring(parts['word/document.xml']);r=list(tree.iter(tag('r')))[run_index]
   parent=next(p for p in tree.iter() if r in list(p));at=list(parent).index(r)
   atoms=[a for a in r if a.tag!=tag('rPr')];props=r.find('w:rPr',NS)
   for offset,atom in enumerate(atoms):
    node=ET.Element(r.tag,r.attrib)
    if props is not None: node.append(copy.deepcopy(props))
    node.append(copy.deepcopy(atom));parent.insert(at+offset,node)
   parent.remove(r)
   corrupted=dict(parts);corrupted['word/document.xml']=ET.tostring(tree,encoding='utf-8',xml_declaration=True)
   assert visible(corrupted)==visible(parts),d.name+' note split kept all ordered text'
   assert not reference_errors(corrupted),d.name+' note split kept valid references'
   assert normalized(ET.fromstring(parts['word/document.xml']))!=normalized(tree),d.name+' note grouping differs'
   result=compare(source,gold,package(corrupted))
   assert not result['artifact_correct'] and not result['preservation'],d.name+' note run split was accepted'
   note_boundary_kinds.update(a.tag.rsplit('}',1)[-1] for a in atoms if a.tag in (tag('footnoteReference'),tag('endnoteReference')))
   negative_count+=1;note_boundary_count+=1
  # An equivalent split of a protected run is allowed on actual edits.
  split=unpack(gold);tree=ET.fromstring(split['word/header1.xml']);r=next(tree.iter(tag('r')));node=r.find('w:t',NS);value=node.text;at=max(1,len(value)//2)
  import copy
  right=copy.deepcopy(r);node.text=value[:at];right.find('w:t',NS).text=value[at:];parent=next(p for p in tree.iter() if r in list(p));parent.insert(list(parent).index(r)+1,right);split['word/header1.xml']=ET.tostring(tree,encoding='utf-8',xml_declaration=True)
  assert compare(source,gold,package(split))['artifact_correct'],d.name+' legitimate split';reference_count+=1
  rows.append({'family':d.name,'reference_passes':reference_count,'negative_controls_rejected':negative_count})
 assert note_boundary_kinds=={'footnoteReference','endnoteReference'}
 result={'selftest':'pass','note_boundary_controls':note_boundary_count,'note_boundary_kinds':sorted(note_boundary_kinds),'families':len(rows),'reference_passes':sum(x['reference_passes'] for x in rows),'negative_controls_rejected':sum(x['negative_controls_rejected'] for x in rows),'details':rows}
 print(json.dumps(result,indent=2));return result

def check_freeze(subset="development"):
 manifest=json.loads((FROZEN/'freeze.json').read_text())
 for rel,digest in manifest['files'].items():
  if '/frozen/heldout/' in rel and subset!='heldout': continue
  if sha((ROOT/rel).read_bytes())!=digest: raise RuntimeError('frozen file altered: '+rel)
 return sha((FROZEN/'freeze.json').read_bytes())

def score(run_dir,subset):
 freeze=check_freeze(subset); run=pathlib.Path(run_dir)
 if subset=="heldout":
  receipt=json.loads((run/"runner-receipt.json").read_text())
  if receipt.get("subset")!="heldout" or not receipt.get("final_incumbent_sha256"): raise RuntimeError("Heldout scoring requires final-incumbent-sealed runner receipt")
 records=json.loads((run/'tool-results.json').read_text());scored=[]
 for result in records:
  d=FROZEN/subset/result['family'];task=next(t for t in json.loads((d/'tasks.json').read_text()) if t['id']==result['id'])
  output=run/result['output']; actual=output.read_bytes() if output.exists() else b''
  verdict=compare((d/'source.docx').read_bytes(),(d/task['expected']).read_bytes(),actual)
  if task['tool']=='word_python':
   for invariant in ('source_unchanged_before_apply','preview_applied_exact_bytes','libreoffice_opened'):
    if result.get(invariant) is not True:
     verdict['artifact_correct']=False;verdict['failures'].append('publication/render invariant failed: '+invariant)
   if not isinstance(result.get('pages'),(int,float)) or not 0<result['pages']<1000000:
    verdict['artifact_correct']=False;verdict['failures'].append('render did not report a positive page count')
  scored.append({**result,**verdict,'task_pass':bool(result['tool_success'] and verdict['artifact_correct']),'output_sha256':sha(actual) if actual else None})
 expected_count=sum(len(json.loads((d/'tasks.json').read_text())) for d in (FROZEN/subset).iterdir())
 assert len(scored)==expected_count and len({r['id'] for r in scored})==expected_count,'all frozen tasks must run'
 summary={'schema':'docx-preservation-score-v1','subset':subset,'freeze_sha256':freeze,'tasks':len(scored),'tool_success':sum(r['tool_success'] for r in scored),'exact_task_passes':sum(r['exact_task'] for r in scored),'collateral_free_passes':sum(r['preservation'] for r in scored),'verified_artifact_passes':sum(r['artifact_correct'] for r in scored),'score':sum(r['task_pass'] for r in scored),'hard_constraints':['Every baseline verified success must remain verified.','Strict integer verified-artifact score gain.','Frozen evaluator, tasks, fixtures and expected packages unchanged.','No package/reference/text/unchanged-area collateral.'],'results':scored}
 (run/'score.json').write_text(json.dumps(summary,indent=2)+'\n')
 print(json.dumps({k:v for k,v in summary.items() if k!='results'},indent=2))
 for row in scored:
  if not row['artifact_correct']: print(row['id'],row.get('error',''),'; '.join(row['failures']))
 return summary
if __name__=='__main__':
 parser=argparse.ArgumentParser();parser.add_argument('command',choices=['selftest','score','check-freeze']);parser.add_argument('--run');parser.add_argument('--subset',choices=['development','heldout'],default='development');args=parser.parse_args()
 if args.command=='selftest':selftest()
 elif args.command=='score':score(args.run,args.subset)
 else:print(check_freeze())
