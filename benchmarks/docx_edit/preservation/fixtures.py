"""Independent synthetic OPC fixtures. No Beaver production modules are imported.
Family split is written before this generator runs; held-out bytes are only written.
"""
from __future__ import annotations
import copy, hashlib, json, pathlib, random, xml.etree.ElementTree as ET, zipfile
from io import BytesIO
from xml.sax.saxutils import escape
ROOT = pathlib.Path(__file__).resolve().parents[3]
FROZEN = ROOT / 'benchmarks/local-data/docx-preservation/frozen'
W='http://schemas.openxmlformats.org/wordprocessingml/2006/main'
R='http://schemas.openxmlformats.org/officeDocument/2006/relationships'
P='http://schemas.openxmlformats.org/package/2006/relationships'
C='http://schemas.openxmlformats.org/package/2006/content-types'
NS={'w':W,'r':R,'pr':P}
ET.register_namespace('w', W); ET.register_namespace('r', R)
def sha(b): return hashlib.sha256(b).hexdigest()
def t(s): return '<w:t xml:space="preserve">'+escape(s)+'</w:t>'
def run(s,pr=''): return '<w:r>'+('<w:rPr>'+pr+'</w:rPr>' if pr else '')+t(s)+'</w:r>'
def para(s,pr=''): return '<w:p>'+('<w:pPr>'+pr+'</w:pPr>' if pr else '')+run(s)+'</w:p>'
def story(name,body): return f'<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:{name} xmlns:w="{W}" xmlns:r="{R}">'+body+f'</w:{name}>'
def rels(rows): return ('<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="'+P+'">'+''.join(f'<Relationship Id="{i}" Type="{R}/{typ}" Target="{escape(dst)}"'+(' TargetMode="External"' if ext else '')+'/>' for i,typ,dst,ext in rows)+'</Relationships>').encode()
def package(parts):
 out=BytesIO()
 with zipfile.ZipFile(out,'w',zipfile.ZIP_DEFLATED) as z:
  for name,data in sorted(parts.items()):
   info=zipfile.ZipInfo(name,(2020,1,1,0,0,0)); info.compress_type=zipfile.ZIP_DEFLATED
   z.writestr(info,data.encode() if isinstance(data,str) else data)
 return out.getvalue()
def replace_text(parts,part,old,new):
 result=dict(parts); xml=result[part]; assert xml.count(old)==1,(part,old)
 result[part]=xml.replace(old,new); return result

def build(index):
 # Each family has a distinct text order, row topology, story target and section policy.
 rng=random.Random(4100+index)
 name=['Aster','Birch','Cedar','Dune','Elm','Flint','Grove','Hazel','Iris','Juniper','Kestrel','Larch','Moss','Nettle','Orchid'][index-1]
 token=f'{name} amber'; updated=f'{name} silver'
 book=f'Beacon_{index}'; note_id=10+index
 before=para(name+' field station log.','<w:pStyle w:val="Heading1"/>')
 # Note/reference placement varies without images or existing Review markup.
 boundary=index%4
 if boundary==0:
  selected='<w:p>'+run('Observe ')+f'<w:bookmarkStart w:id="{index}" w:name="{book}"/>'+run(token,'<w:b/>')+f'<w:bookmarkEnd w:id="{index}"/>'+run(' before dawn.')+'</w:p>'
 elif boundary==1:
  selected='<w:p><w:r>'+t('Observe '+token)+f'<w:footnoteReference w:id="{note_id}"/>'+t(' before dawn.')+'</w:r></w:p>'
 elif boundary==2:
  selected='<w:p>'+run('Observe ')+f'<w:hyperlink r:id="rHyper"><w:r><w:rPr><w:i/></w:rPr>{t(token)}</w:r></w:hyperlink>'+run(' before dawn.')+'</w:p>'
 else:
  selected='<w:p>'+run('Observe ')+run(name+' ')+f'<w:bookmarkStart w:id="{index}" w:name="{book}"/>'+run('amber')+f'<w:bookmarkEnd w:id="{index}"/>'+run(' before dawn.')+'</w:p>'
 # Distinct primary structural archetypes, not merely renamed paragraphs.
 if index==5:
  selected=selected.replace('footnoteReference', 'endnoteReference').replace(f'w:id="{note_id}"',f'w:id="{note_id+100}"')
 elif index==6:
  selected=selected.replace('</w:hyperlink>',f'<w:r><w:footnoteReference w:id="{note_id}"/></w:r></w:hyperlink>')
 elif index==7:
  selected=selected.replace(run('amber'),run('amber','<w:i/>')).replace(f'<w:bookmarkEnd w:id="{index}"/>','')
  selected=selected.replace('</w:p>',f'<w:bookmarkEnd w:id="{index}"/></w:p>')
 elif index==8:
  selected=selected.replace(run(token,'<w:b/>'),run(token,'<w:b/><w:u w:val="single"/>')+f'<w:r><w:endnoteReference w:id="{note_id+100}"/></w:r>')
 elif index==9:
  selected='<w:tbl><w:tblPr/><w:tblGrid><w:gridCol w:w="7200"/></w:tblGrid><w:tr><w:tc><w:tcPr/><w:p/><w:tbl><w:tblPr/><w:tblGrid><w:gridCol w:w="3600"/></w:tblGrid><w:tr><w:tc><w:tcPr/>'+selected+'</w:tc></w:tr></w:tbl><w:p/></w:tc></w:tr></w:tbl>'
 elif index==10:
  selected='<w:tbl><w:tblPr/><w:tblGrid><w:gridCol w:w="2400"/><w:gridCol w:w="2400"/><w:gridCol w:w="2400"/></w:tblGrid><w:tr><w:tc><w:tcPr><w:gridSpan w:val="3"/></w:tcPr>'+selected+'</w:tc></w:tr></w:tbl>'
 elif index==11:
  selected=selected.replace('<w:p>','<w:p><w:pPr><w:numPr><w:ilvl w:val="1"/><w:numId w:val="7"/></w:numPr></w:pPr>',1)
 elif index==12:
  selected='<w:sdt><w:sdtPr><w:alias w:val="Observation"/><w:tag w:val="observation-record"/><w:id w:val="1200"/></w:sdtPr><w:sdtContent>'+selected+'</w:sdtContent></w:sdt>'
 elif index==13:
  selected=selected.replace('<w:p>','<w:p><w:pPr><w:keepNext/><w:pageBreakBefore/></w:pPr>',1)
 elif index==14:
  selected=selected.replace('r:id="rHyper"',f'w:anchor="{book}"')
 elif index==15:
  selected=selected.replace(run(name+' '),run(name+' ','<w:b/>')).replace(run('amber'),run('amber','<w:i/>'))
 # Always include an independently guarded bookmark destination.
 if boundary not in (0,3): before += '<w:p>'+f'<w:bookmarkStart w:id="{index}" w:name="{book}"/>'+run('Fixed destination '+name)+f'<w:bookmarkEnd w:id="{index}"/>'+'</w:p>'
 note_anchor=para('Calibration remains unchanged.')[:-6]+f'<w:r><w:footnoteReference w:id="{note_id}"/><w:endnoteReference w:id="{note_id+100}"/></w:r></w:p>'
 linked='<w:p>'+run('Consult ')+f'<w:hyperlink r:id="rHyper">'+run(name+' chart','<w:u w:val="single"/>')+'</w:hyperlink>'+run(' and ')+f'<w:hyperlink w:anchor="{book}">'+run('the destination')+'</w:hyperlink>'+run('.')+'</w:p>'
 cell=lambda x,pr='':'<w:tc><w:tcPr><w:tcW w:w="2400" w:type="dxa"/>'+pr+'</w:tcPr>'+x+'</w:tc>'
 row1='<w:tr>'+cell(para(name+' merged heading'),'<w:gridSpan w:val="2"/>')+cell(para('Control column'))+'</w:tr>'
 row2='<w:tr>'+cell(para(name+' matrix amber'),'<w:vMerge w:val="restart"/>')+cell(para('Cell middle'))+cell(para('Cell right'))+'</w:tr>'
 row3='<w:tr>'+cell(para(''),'<w:vMerge/>')+cell(para('Cell lower'))+cell(para('End of matrix'))+'</w:tr>'
 # Family-specific table form: varying detail rows, continuation merge widths and row headers.
 extra=''.join('<w:tr>'+('<w:trPr><w:tblHeader/></w:trPr>' if j==0 and index%2 else '')+cell(para(f'{name} survey {j}'))+cell(para(f'Fixed observation {j}'),'<w:gridSpan w:val="2"/>')+'</w:tr>' for j in range(index%5))
 row3+=extra
 table='<w:tbl><w:tblPr><w:tblW w:w="7200" w:type="dxa"/></w:tblPr><w:tblGrid><w:gridCol w:w="2400"/><w:gridCol w:w="2400"/><w:gridCol w:w="2400"/></w:tblGrid>'+row1+row2+row3+'</w:tbl>'
 if index%3==0:
  nested='<w:tbl><w:tblPr/><w:tblGrid><w:gridCol w:w="1800"/></w:tblGrid><w:tr>'+cell(para(name+' nested amber'))+'</w:tr></w:tbl>'
  table=table.replace(para('Cell right'),para('Cell right')+nested+para('Nested guard'))
 numbering=''.join(para(f'{name} item {j} amber' if j==2 else f'{name} item {j} fixed',f'<w:numPr><w:ilvl w:val="{1 if j==2 else 0}"/><w:numId w:val="7"/></w:numPr>') for j in range(1,4))
 section=lambda orient='',refs=True: ('<w:sectPr>'+('<w:headerReference w:type="default" r:id="rHeader"/><w:footerReference w:type="default" r:id="rFooter"/>' if refs else '')+f'<w:type w:val="{"continuous" if index%2 else "nextPage"}"/><w:pgSz w:w="{15840 if orient else 12240}" w:h="{12240 if orient else 15840}"'+(' w:orient="landscape"' if orient else '')+'/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440" w:header="720" w:footer="720" w:gutter="0"/><w:cols w:num="'+str(2 if index%2 else 1)+'" w:space="720"/></w:sectPr>')
 cut='<w:p><w:pPr>'+section(refs=True)+'</w:pPr>'+run(name+' section boundary')+'</w:p>'
 chunks=[selected,note_anchor,table,numbering,linked]
 rng.shuffle(chunks)
 body=before+''.join(chunks[:3])+cut+''.join(chunks[3:])+para(name+' tail remains exact.')+section('landscape',False)
 parts={'word/document.xml':story('document','<w:body>'+body+'</w:body>'),
 'word/header1.xml':story('hdr',para(name+' header amber')+para('Header fixed counterseal')),
 'word/footer1.xml':story('ftr',para(name+' footer amber')+'<w:p>'+run('Sheet ' )+'<w:r><w:fldChar w:fldCharType="begin"/></w:r><w:r><w:instrText xml:space="preserve"> PAGE </w:instrText></w:r><w:r><w:fldChar w:fldCharType="separate"/></w:r>'+run('1')+'<w:r><w:fldChar w:fldCharType="end"/></w:r></w:p>'),
 'word/footnotes.xml':story('footnotes','<w:footnote w:type="separator" w:id="-1"><w:p><w:r><w:separator/></w:r></w:p></w:footnote><w:footnote w:type="continuationSeparator" w:id="0"><w:p><w:r><w:continuationSeparator/></w:r></w:p></w:footnote>'+f'<w:footnote w:id="{note_id}">'+para(name+' footnote amber')+'</w:footnote>'),
 'word/endnotes.xml':story('endnotes','<w:endnote w:type="separator" w:id="-1"><w:p><w:r><w:separator/></w:r></w:p></w:endnote><w:endnote w:type="continuationSeparator" w:id="0"><w:p><w:r><w:continuationSeparator/></w:r></w:p></w:endnote>'+f'<w:endnote w:id="{note_id+100}">'+para(name+' endnote amber')+'</w:endnote>'),
 'word/numbering.xml':story('numbering','<w:abstractNum w:abstractNumId="4"><w:multiLevelType w:val="multilevel"/>'+''.join(f'<w:lvl w:ilvl="{i}"><w:start w:val="{3 if i==0 else 1}"/><w:numFmt w:val="{fmt}"/><w:lvlText w:val="{txt}"/><w:lvlJc w:val="left"/></w:lvl>' for i,fmt,txt in [(0,'decimal','%1.'),(1,'lowerLetter','(%2)')])+'</w:abstractNum><w:num w:numId="7"><w:abstractNumId w:val="4"/></w:num>'),
 'word/styles.xml':story('styles','<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/></w:style><w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/><w:basedOn w:val="Normal"/><w:pPr><w:outlineLvl w:val="0"/></w:pPr><w:rPr><w:b/></w:rPr></w:style>'),
 'word/settings.xml':story('settings','<w:zoom w:percent="100"/>'),
 'docProps/core.xml':'<?xml version="1.0" encoding="UTF-8"?><cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>Independent station fixture '+name+'</dc:title><dc:creator>machine_test</dc:creator></cp:coreProperties>'}
 rows=[('rStyles','styles','styles.xml',False),('rSettings','settings','settings.xml',False),('rNumber','numbering','numbering.xml',False),('rHeader','header','header1.xml',False),('rFooter','footer','footer1.xml',False),('rFoot','footnotes','footnotes.xml',False),('rEnd','endnotes','endnotes.xml',False),('rHyper','hyperlink',f'https://example.org/stations/{index}',True)]
 parts['word/_rels/document.xml.rels']=rels(rows)
 parts['_rels/.rels']=rels([('rDoc','officeDocument','word/document.xml',False)])
 # The core properties relationship uses package metadata's namespace.
 parts['_rels/.rels']=parts['_rels/.rels'].replace(b'</Relationships>',b'<Relationship Id="rCore" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/></Relationships>')
 types={'document':'document.main','header1':'header','footer1':'footer','footnotes':'footnotes','endnotes':'endnotes','numbering':'numbering','styles':'styles','settings':'settings'}
 parts['[Content_Types].xml']='<Types xmlns="'+C+'"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/>'+''.join(f'<Override PartName="/word/{key}.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.{val}+xml"/>' for key,val in types.items())+'<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/></Types>'
 # Expectations are authored as surgical OOXML edits, never derived from tool output.
 inline_expected=replace_text(parts,'word/document.xml',token,updated) if boundary!=3 else replace_text(parts,'word/document.xml','>amber<','>silver<')
 inline_expected=replace_text(inline_expected,'word/document.xml','Observe ','Record ')
 inline_expected=replace_text(inline_expected,'word/document.xml',' before dawn.',' after dusk.')
 tasks=[{'name':'roundtrip','tool':'session','expected':parts},
 {'name':'edit-inline','tool':'Edit','old_string':'Observe '+token+' before dawn.','new_string':'Record '+updated+' after dusk.','expected':inline_expected}]
 rich_index=(index-1)%8
 if rich_index<2:
  typ='header' if rich_index==0 else 'footer'; part=f'word/{typ}1.xml'; old=f'{name} {typ} amber'; new=f'{name} {typ} silver'
  program=f"replace_text(find({old!r}, doc.sections[0].{typ})[0], 'amber', 'silver')"
 elif rich_index<4:
  typ='footnote' if rich_index==2 else 'endnote'; part=f'word/{typ}s.xml'; old=f'{name} {typ} amber'; new=f'{name} {typ} silver'
  program="from docx.opc.constants import RELATIONSHIP_TYPE as RT\n"+f"part = doc.part.part_related_by(RT.{typ.upper()}S)\nroot = part.element\nnode = next(x for x in root.iter(qn('w:t')) if x.text == {old!r})\nnode.text = {new!r}"
 elif rich_index==4:
  part='word/document.xml';old=name+' matrix amber';new=name+' matrix silver'; program=f"replace_text(find({old!r})[0], 'amber', 'silver')"
 elif rich_index==5:
  part='word/document.xml'; old=f'{name} item 2 amber';new=f'{name} item 2 silver';program=f"replace_text(find({old!r})[0], 'amber', 'silver')"
 elif rich_index==6:
  part='word/document.xml';old=name+' chart';new=name+' atlas';program=f"replace_text(find('Consult ')[0], {old!r}, {new!r})"
 else:
  part='word/document.xml';old=token;new=updated;program=f"replace_text(find('Observe ')[0], 'amber', 'silver')"
 expected=replace_text(parts,part,old,new) if not(rich_index==7 and boundary==3) else replace_text(parts,part,'>amber<','>silver<')
 tasks.append({'name':'python-rich','tool':'word_python','program':program,'expected':expected})
 expected=replace_text(parts,'word/document.xml',token,updated) if boundary!=3 else replace_text(parts,'word/document.xml','>amber<','>silver<')
 tasks.append({'name':'python-inline','tool':'word_python','program':"replace_text(find('Observe ')[0], 'amber', 'silver')",'expected':expected})
 # The fixed second rich task changes only the final section's columns; body and all story links remain exact.
 final=section('landscape',False); changed=final.replace('w:num="'+str(2 if index%2 else 1)+'"','w:num="3"')
 expected=replace_text(parts,'word/document.xml',final,changed)
 tasks.append({'name':'python-section','tool':'word_python','program':"set_page(doc.sections[-1], columns=3)",'expected':expected})
 return parts,tasks

def main():
 split=json.loads((FROZEN/'split.json').read_text())['families']; rows=[]
 for family,subset in split.items():
  directory=FROZEN/subset/family; directory.mkdir(parents=True,exist_ok=True)
  source,tasks=build(int(family[-2:])); blob=package(source); (directory/'source.docx').write_bytes(blob)
  for task in tasks:
   expected=package(task.pop('expected')); (directory/(task['name']+'.expected.docx')).write_bytes(expected)
   task.update(id=family+'/'+task['name'],family=family,source='source.docx',expected=task['name']+'.expected.docx')
  (directory/'tasks.json').write_text(json.dumps(tasks,indent=2)+'\n')
  rows.append({'family':family,'subset':subset,'source_sha256':sha(blob),'tasks_sha256':sha((directory/'tasks.json').read_bytes()),'expected_sha256':{t['name']:sha((directory/t['expected']).read_bytes()) for t in tasks}})
 (FROZEN/'fixture-manifest.json').write_text(json.dumps(rows,indent=2)+'\n')
 print(json.dumps({'generated_families':len(rows),'development':12,'heldout':3,'tasks_per_family':5,'manifest_sha256':sha((FROZEN/'fixture-manifest.json').read_bytes())}))
if __name__=='__main__': main()
