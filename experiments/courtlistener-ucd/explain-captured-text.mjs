// Inspect existing independent captured-source diagnostics; no parser rerun.
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {zstdDecompressSync} from 'node:zlib';

const [nativeDirectory,goldFile]=process.argv.slice(2);
if(!nativeDirectory || !goldFile) throw Error('Supply native web-run directory and frozen captured-source gold JSONL');
const prefix=path.basename(goldFile).replace(/-gold\.jsonl$/u,'');
const nativeFile=path.join(nativeDirectory,'records.jsonl.zst');
const diagnosticFile=path.join(nativeDirectory,prefix+'-markup-text-differences.jsonl');
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const rows=bytes=>bytes.toString('utf8').split(/\r?\n/u).filter(line=>line.trim()).map(JSON.parse);
const key=row=>row.html_sha256+':'+row.body_index;
const nativeBytes=fs.readFileSync(nativeFile),goldBytes=fs.readFileSync(goldFile),diagnosticBytes=fs.readFileSync(diagnosticFile);
const native=new Map(rows(zstdDecompressSync(nativeBytes)).map(row=>[key(row),row]));
const gold=new Map(rows(goldBytes).map(row=>[key(row),row]));
const diagnostics=rows(diagnosticBytes),nonWhitespace=[];
const comparisonFile=path.join(nativeDirectory,prefix+'-structure-summary.json');
const comparisonBytes=fs.readFileSync(comparisonFile),comparison=JSON.parse(comparisonBytes);
if(comparison.native_receipt_sha256!==hash(nativeBytes) || comparison.gold_sha256!==hash(goldBytes))
  throw Error('Source comparison does not bind the retained native receipt and gold');
const bodyTextExact=comparison.captured_live_body_text?.mismatches===0
  && comparison.captured_live_body_text.bodies===comparison.bodies
  && comparison.captured_live_body_text.exact_normalized_body_text===comparison.bodies;
const omittedJumpbacks=[],unexplainedNonWhitespace=[];
let whitespaceOnly=0;
for(const diagnostic of diagnostics) {
  const document=native.get(key(diagnostic)),source=gold.get(key(diagnostic));
  const element=source?.elements.find(row=>row.source_index===diagnostic.source_index);
  const actual=document?.markup_elements[diagnostic.source_index];
  if(!element || !actual || actual.markup_start!==diagnostic.markup_start ||
      actual.range.start!==diagnostic.range.start || actual.range.end!==diagnostic.range.end)
    throw Error('Diagnostic does not match its retained source and native element');
  const expected=element.text_content,rendered=document.text.slice(actual.range.start,actual.range.end);
  if(expected.replace(/\s/gu,'')===rendered.replace(/\s/gu,'')) whitespaceOnly++;
  else {
    nonWhitespace.push(diagnostic);
    const descendants=source.elements.filter(candidate=>{
      let index=candidate.source_index;
      while(index!==null) {
        if(index===element.source_index) return true;
        index=source.elements[index].parent_index;
      }
      return false;
    });
    const arrows=descendants.filter(candidate=>candidate.tag==='a'
      && (candidate.attributes.class??'').split(/\s+/u).includes('jumpback')
      && candidate.text_content.trim()==='↵'
      && document.markup_elements[candidate.source_index].range.start===document.markup_elements[candidate.source_index].range.end);
    // Require one independently retained arrow per omitted subtree and exact
    // remaining text, plus the original whole-body browser text oracle.
    if(bodyTextExact && arrows.length>0 && [...expected].filter(value=>value==='↵').length===arrows.length
        && expected.replaceAll('↵','').replace(/\s/gu,'')===rendered.replace(/\s/gu,''))
      omittedJumpbacks.push({...diagnostic,omitted_source_indices:arrows.map(value=>value.source_index)});
    else unexplainedNonWhitespace.push(diagnostic);
  }
}
const report={schema:'courtlistener.captured-text-diagnostic-explanation.v1',created_utc:new Date().toISOString(),
  sources:Object.fromEntries([[nativeFile,nativeBytes],[goldFile,goldBytes],[diagnosticFile,diagnosticBytes],[comparisonFile,comparisonBytes]]
    .map(([file,bytes])=>[file,{bytes:bytes.length,sha256:hash(bytes)}])),
  diagnostics:diagnostics.length,whitespace_only:whitespaceOnly,non_whitespace:nonWhitespace,
  omitted_jumpback_subtrees:omittedJumpbacks,unexplained_non_whitespace:unexplainedNonWhitespace,
  harness_sha256:hash(fs.readFileSync(process.argv[1])),
  method:'Independent equality after removing Unicode whitespace from retained source textContent and native rendered range; no gold regeneration or parser rerun',
  scope:'Explains these diagnostics only. Empty jumpback subtrees require retained arrow text, exact descendant topology, empty native ranges and exact original whole-body browser text. Per-element browser rendered-text and visibility were not captured; no fresh CSS or navigation claim'};
const output=path.join(nativeDirectory,prefix+'-text-diagnostic-explanation.json');
fs.writeFileSync(output,JSON.stringify(report,null,2)+'\n');
console.log(JSON.stringify({output,diagnostics:report.diagnostics,whitespace_only:whitespaceOnly,non_whitespace:nonWhitespace.length,omitted_jumpback_subtrees:omittedJumpbacks.length,unexplained_non_whitespace:unexplainedNonWhitespace.length}));
