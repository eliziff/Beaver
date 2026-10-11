// Literal original-source candidates, never parser-produced or browser gold.
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {zstdDecompressSync} from 'node:zlib';

const [directory,output,identityFile,previousSHA]=process.argv.slice(2);
if(!identityFile) throw Error('Supply original seekable pack, private inventory output and existing source identity inventory');
const digest=bytes=>createHash('sha256').update(bytes).digest('hex');
const previousBytes=fs.existsSync(output)?fs.readFileSync(output):null;
if(previousBytes&&digest(previousBytes)!==previousSHA) throw Error('Existing inventory requires its exact prior digest');
const previous=previousBytes?JSON.parse(previousBytes):null;
const indexFile=path.join(directory,'index.json'),indexBytes=fs.readFileSync(indexFile),index=JSON.parse(indexBytes);
if(index.schema!=='courtlistener.lossless-zstd-frames.v1') throw Error('Original frame index required');
const identityBytes=fs.readFileSync(identityFile),identity=JSON.parse(identityBytes);
if(identity.schema!=='courtlistener.original-source-identity-inventory.v1'
  ||indexBytes.length!==identity.source.index.bytes||digest(indexBytes)!==identity.source.index.sha256
  ||index.rows!==identity.totals.records||index.raw_bytes!==identity.source.raw_bytes
  ||index.compressed_bytes!==identity.source.compressed_bytes
  ||path.resolve(directory,'opinions.jsonl.zst')!==path.resolve(identity.source.pack))
  throw Error('Original index differs from existing source identity inventory');
const packFile=path.join(directory,'opinions.jsonl.zst'),handle=fs.openSync(packFile,'r');
const fields=['html','html_anon_2020','html_columbia','html_lawbox','html_with_citations','xml_harvard','xml_scan'];
const attrBody=String.raw`(?:"[^"]*"|'[^']*'|[^'">])*`;
const tag=new RegExp('<\\/?[A-Za-z][\\w:.-]*(?=\\s|\\/?>)'+attrBody+'>','gu');
const anchors=new RegExp('<a(?=\\s|\\/?>)'+attrBody+'>([\\s\\S]*?)<\\/a\\s*>','giu');
const banners=new RegExp('(?=(<(div|p|center|h[1-6])(?=\\s|\\/?>)'+attrBody+'>([\\s\\S]*?)<\\/\\2\\s*>))','giu');
const breaks=new RegExp('(?:<br(?=\\s|\\/?>)'+attrBody+'>\\s*){4,}','giu');
const form=new RegExp('(<form(?=\\s|\\/?>)'+attrBody+'>)(\\s*)<\\/form\\s*>','giu');
const attributes=/\s+([^\s=<>/'"]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>]+)))?/gu;
const strip=value=>value.replace(tag,' ').replace(/\s+/gu,' ').trim();
const printedLabel=value=>strip(value);
// Reuse the existing source-identity inventory's bounded comment/script/style
// spans; also conservatively omit CDATA, PIs, RCDATA and other raw-text spans.
const hidden=new RegExp('<!--[\\s\\S]*?(?:-->|$)|<!\\[CDATA\\[[\\s\\S]*?(?:\\]\\]>|$)'
  +'|<\\?[\\s\\S]*?(?:\\?>|$)|<(script|style|textarea|title|xmp|iframe|noembed|noframes)(?=\\s|\\/?>)'
  +attrBody+'>[\\s\\S]*?(?:<\\/\\1\\s*>|$)|<plaintext(?=\\s|\\/?>)'+attrBody+'>[\\s\\S]*$','giu');
function contextExclusions(source) {
  return [...source.matchAll(hidden)].map(match=>({start:match.index,end:match.index+match[0].length,
    kind:match[0].startsWith('<!--')?'comment':match[0].startsWith('<![')?'cdata':
      match[0].startsWith('<?')?'processing_instruction':'raw_text_or_rcdata'}));
}
const known=new Set([
  'a9a71d22b0459617880b5cc00f4b2c42ff1fec0eb02a270e13ad5751fe94e9ab',
  '1dcd6fd702280848a9de7a76c1b631cad39543c877ce867ccb597dfeac0a2cd9'
]);
const counts={records:0,populated_markup_fields:0,source_utf8_bytes:0,
  fields_with_literal_footnotes_word:0,fields_with_excluded_spans:0,excluded_context_spans:0,
  footnotes_word_fields_with_excluded_spans:0,
  fields_with_standalone_banner:0,fields_with_printed_body_label:0,fields_with_terminal_footer:0,
  matched_fields:0,matched_opinions:0,matched_notes:0,previously_observed_original_fields:0,
  newly_found_literal_fields:0};
const byField={},excludedReasons={},excludedSpanCounts={},nearMissReasons={},witnesses=[],nearMisses=[],excludedCandidates=[];
const allIds=new Set(),matchedIds=new Set(),packHash=createHash('sha256');
let nextOffset=0,rawBytes=0;
const started=performance.now();
const bump=(object,key)=>{object[key]=(object[key]??0)+1;};
function attributeMap(opening) {
  const rows=[...opening.slice(2).matchAll(attributes)],values={},duplicates=[];
  for(const match of rows) {
    const key=match[1].toLowerCase();
    if(Object.hasOwn(values,key)) duplicates.push(key);
    values[key]=match[2]??match[3]??match[4]??'';
  }
  return {values,duplicates};
}
function sourceLayouts(original,exclusions) {
  let previousEnd=0;
  const safe=[];
  for(const span of exclusions) {
    safe.push(original.slice(previousEnd,span.start),' '.repeat(span.end-span.start));previousEnd=span.end;
  }
  safe.push(original.slice(previousEnd));
  const source=safe.join(''),intersects=(start,end)=>exclusions.some(span=>span.start<end&&span.end>start);
  const range=(start,end)=>({start,end,utf8_start:Buffer.byteLength(original.slice(0,start)),
    utf8_end:Buffer.byteLength(original.slice(0,end))});
  const misses=new Set(),observedBanners=new Map();
  for(const match of source.matchAll(banners)) {
    if(!/^Footnotes$/iu.test(strip(match[3]))) continue;
    const end=match.index+match[1].length,previous=observedBanners.get(end);
    if(intersects(match.index,end)) {misses.add('banner_intersects_excluded_span');continue;}
    if(!previous || previous.start<match.index)
      observedBanners.set(end,{...range(match.index,end),tag:match[2],literal:original.slice(match.index,end)});
  }
  const foundAnchors=[];
  for(const match of source.matchAll(anchors)) {
    if(/<a(?=\s|\/?>)/iu.test(match[1])) continue;
    const opening=tag.exec(match[0])?.[0];tag.lastIndex=0;
    if(!opening) continue;
    const attrs=attributeMap(opening),label=printedLabel(match[1]);
    const body=/^Footnote\s+([0-9]+)\s*:$/iu.exec(label),reference=/^\[FN\s*([0-9]+)\]$/iu.exec(label);
    if(intersects(match.index,match.index+match[0].length)) {
      if(body||reference) misses.add('printed_anchor_intersects_excluded_span');continue;
    }
    foundAnchors.push({...range(match.index,match.index+match[0].length),opening,label,
      attributes:attrs.values,duplicate_attributes:attrs.duplicates,
      number:body?.[1]??reference?.[1]??null,kind:body?'body':reference?'reference':null});
  }
  const foundFooters=[];
  for(const br of source.matchAll(breaks)) {
    const after=br.index+br[0].length;
    form.lastIndex=after;const empty=form.exec(source);form.lastIndex=0;
    if(!empty) continue;
    const prefix=source.slice(after,empty.index),suffix=source.slice(empty.index+empty[0].length);
    if(!/^(?:\s|<(?:div|center)(?=\s|\/?>)(?:"[^"]*"|'[^']*'|[^'">])*>)*$/iu.test(prefix)
      || !/^(?:\s|<\/[A-Za-z][\w:.-]*\s*>)*$/u.test(suffix)) continue;
    if(intersects(br.index,source.length)) {misses.add('terminal_footer_intersects_excluded_span');continue;}
    foundFooters.push({...range(br.index,source.length),br_count:[...br[0].matchAll(/<br(?=\s|\/?>)/giu)].length,
      literal_breaks:br[0],literal_wrappers:prefix,literal_empty_form:empty[0],literal_closing_tail:suffix});
  }
  const layouts=[];
  if(!observedBanners.size) misses.add('no_standalone_banner');
  if(!foundAnchors.some(anchor=>anchor.kind==='body')) misses.add('no_printed_body_anchor');
  if(!foundFooters.length) misses.add('no_terminal_four_br_empty_form_footer');
  for(const banner of observedBanners.values()) for(const footer of foundFooters) {
    if(footer.start<banner.end) continue;
    const bodies=foundAnchors.filter(anchor=>anchor.kind==='body'&&anchor.start>=banner.end&&anchor.end<=footer.start);
    if(!bodies.length) continue;
    const notes=[];
    for(const [at,body] of bodies.entries()) {
      const identities=[body.attributes.id,body.attributes.name].filter(Boolean);
      const reciprocal=foundAnchors.filter(anchor=>anchor.kind==='reference'&&anchor.number===body.number
        &&anchor.end<=banner.start&&identities.some(value=>anchor.attributes.href==='#'+value)
        &&[anchor.attributes.id,anchor.attributes.name].filter(Boolean).some(value=>body.attributes.href==='#'+value));
      const proseEnd=bodies[at+1]?.start??footer.start,prose=original.slice(body.end,proseEnd);
      const proseText=strip(source.slice(body.end,proseEnd)).replace(/&(?:#[0-9]+|#x[0-9a-f]+|[a-z][a-z0-9]*);/giu,' ');
      const encodedIdentity=[...identities,body.attributes.href,...reciprocal.flatMap(anchor=>
        [anchor.attributes.id,anchor.attributes.name,anchor.attributes.href])].filter(Boolean).some(value=>/[&\u0080-\uFFFF]/u.test(value));
      if(!reciprocal.length) {misses.add('printed_body_without_reciprocal_printed_reference');continue;}
      if(!/\p{L}/u.test(proseText)) {misses.add('no_literal_following_prose');continue;}
      if(encodedIdentity) {misses.add('identifier_encoding_requires_adjudication');continue;}
      if(body.duplicate_attributes.length||reciprocal.some(anchor=>anchor.duplicate_attributes.length)) {
        misses.add('duplicate_anchor_attribute_requires_adjudication');continue;
      }
      notes.push({number:body.number,body_anchor:body,reference_anchors:reciprocal,
        following_prose_utf16_start:body.end,following_prose_utf16_end:proseEnd,
        following_prose_utf8_start:Buffer.byteLength(original.slice(0,body.end)),
        following_prose_utf8_end:Buffer.byteLength(original.slice(0,proseEnd)),
        following_raw_utf8_bytes:Buffer.byteLength(prose),following_raw_sha256:digest(Buffer.from(prose)),
        excluded_context_spans_in_prose:exclusions.filter(span=>span.start<proseEnd&&span.end>body.end),
        following_starts_with_literal_text:!prose.trimStart().startsWith('<'),
        body_target_literal_anchor_matches:foundAnchors.filter(anchor=>
          identities.some(value=>anchor.attributes.id===value||anchor.attributes.name===value)).length});
    }
    if(notes.length===bodies.length) layouts.push({banner,footer,printed_body_count:bodies.length,notes});
  }
  return {layouts,misses:[...misses],banner_count:observedBanners.size,
    printed_body_count:foundAnchors.filter(anchor=>anchor.kind==='body').length,footer_count:foundFooters.length};
}
try {
  if(fs.fstatSync(handle).size!==index.compressed_bytes) throw Error('Original compressed size changed');
  for(const frame of index.frames) {
    const sourceFrame={offset:frame.offset,bytes:frame.bytes,raw_bytes:frame.raw_bytes,sha256:frame.sha256};
    if(frame.offset!==nextOffset) throw Error('Non-contiguous original frames');
    const compressed=Buffer.alloc(frame.bytes);
    if(fs.readSync(handle,compressed,0,compressed.length,frame.offset)!==compressed.length) throw Error('Short original frame');
    packHash.update(compressed);nextOffset+=frame.bytes;
    const raw=zstdDecompressSync(compressed);
    if(raw.length!==frame.raw_bytes||digest(raw)!==frame.sha256) throw Error('Original frame bytes/SHA changed');
    rawBytes+=raw.length;const ids=[];
    for(const line of raw.toString('utf8').split('\n').filter(Boolean)) {
      const record=JSON.parse(line),id=String(record.opinion.id);ids.push(id);counts.records++;
      if(allIds.has(id)) throw Error('Duplicate original opinion membership');allIds.add(id);
      for(const field of fields) {
        const source=record.opinion[field];if(source===null||source===undefined||source==='') continue;
        if(typeof source!=='string') throw Error('Non-string populated markup field');
        counts.populated_markup_fields++;counts.source_utf8_bytes+=Buffer.byteLength(source);
        const stats=byField[field]??={populated:0,source_utf8_bytes:0,with_excluded_spans:0,matched:0};
        stats.populated++;stats.source_utf8_bytes+=Buffer.byteLength(source);
        const footnotesWord=/Footnotes/iu.test(source),exclusions=contextExclusions(source);
        if(footnotesWord) counts.fields_with_literal_footnotes_word++;
        if(exclusions.length) {
          const reasons=[...new Set(exclusions.map(span=>span.kind))];
          counts.fields_with_excluded_spans++;counts.excluded_context_spans+=exclusions.length;stats.with_excluded_spans++;
          for(const reason of reasons) bump(excludedReasons,reason);
          for(const span of exclusions) bump(excludedSpanCounts,span.kind);
          if(footnotesWord) {
            counts.footnotes_word_fields_with_excluded_spans++;
            if(excludedCandidates.length<40) excludedCandidates.push({opinion_id:id,field,reasons,
              source_utf8_bytes:Buffer.byteLength(source),source_sha256:digest(Buffer.from(source)),source_frame:sourceFrame});
          }
        }
        if(!footnotesWord) continue;
        const result=sourceLayouts(source,exclusions);
        counts.fields_with_standalone_banner+=Number(result.banner_count>0);
        counts.fields_with_printed_body_label+=Number(result.printed_body_count>0);
        counts.fields_with_terminal_footer+=Number(result.footer_count>0);
        if(!result.layouts.length) {
          for(const reason of result.misses) bump(nearMissReasons,reason);
          if(nearMisses.length<40) nearMisses.push({opinion_id:id,field,source_utf8_bytes:Buffer.byteLength(source),
            source_sha256:digest(Buffer.from(source)),source_frame:sourceFrame,reasons:result.misses,
            banner_count:result.banner_count,printed_body_count:result.printed_body_count,footer_count:result.footer_count});
          continue;
        }
        const sha=digest(Buffer.from(source));
        witnesses.push({opinion_id:id,cluster_id:String(record.opinion.cluster_id),field,
          source_sha256:sha,source_utf8_bytes:Buffer.byteLength(source),source_frame:sourceFrame,
          previously_observed_original_source:known.has(sha),layouts:result.layouts});
        counts.matched_fields++;stats.matched++;matchedIds.add(id);
        counts.matched_notes+=result.layouts.reduce((sum,layout)=>sum+layout.notes.length,0);
        if(known.has(sha)) counts.previously_observed_original_fields++;else counts.newly_found_literal_fields++;
      }
    }
    if(JSON.stringify(ids)!==JSON.stringify(frame.ids)) throw Error('Ordered original frame membership changed');
  }
} finally {fs.closeSync(handle);}
if(counts.records!==index.rows||rawBytes!==index.raw_bytes||nextOffset!==index.compressed_bytes)
  throw Error('Original aggregate record/raw/compressed counts changed');
if(counts.populated_markup_fields!==identity.totals.populated_markup_fields
  ||counts.source_utf8_bytes!==identity.totals.source_utf8_bytes)
  throw Error('Original populated markup field totals changed');
counts.matched_opinions=matchedIds.size;
const variants={notes_per_layout:{},br_count:{},banner_tag:{},direct_literal_prose_notes:0,
  markup_first_prose_notes:0,multiple_reciprocal_reference_notes:0,ambiguous_literal_body_targets:0};
for(const witness of witnesses) for(const layout of witness.layouts) {
  bump(variants.notes_per_layout,String(layout.notes.length));bump(variants.br_count,String(layout.footer.br_count));
  bump(variants.banner_tag,layout.banner.tag.toLowerCase());
  for(const note of layout.notes) {
    variants[note.following_starts_with_literal_text?'direct_literal_prose_notes':'markup_first_prose_notes']++;
    variants.multiple_reciprocal_reference_notes+=Number(note.reference_anchors.length>1);
    variants.ambiguous_literal_body_targets+=Number(note.body_target_literal_anchor_matches>1);
  }
}
const report={schema:'courtlistener.original-uncontained-layout-inventory.v1',created_utc:new Date().toISOString(),
  pack:packFile,pack_compressed_sha256:packHash.digest('hex'),
  index:{file:indexFile,bytes:indexBytes.length,sha256:digest(indexBytes)},verified_frames:index.frames.length,
  source_identity_inventory:{file:identityFile,bytes:identityBytes.length,sha256:digest(identityBytes)},
  records:counts.records,counts,populated_markup_fields_by_field:byField,source_variations:variants,
  context_exclusion_field_counts:excludedReasons,excluded_context_span_counts:excludedSpanCounts,
  footnotes_word_fields_with_excluded_spans_first_40:excludedCandidates,
  first_pass_conservative_field_exclusion:previous?{
    report_sha256:digest(previousBytes),report_bytes:previousBytes.length,created_utc:previous.created_utc,
    inventory_source_sha256:previous.inventory_source_sha256,counts:previous.counts,
    source_variations:previous.source_variations,context_exclusion_counts:previous.context_exclusion_counts,
    seconds:previous.seconds}:null,
  near_miss_reason_counts:nearMissReasons,near_miss_fields_first_40:nearMisses,witnesses,
  matching_rule:'Standalone literal Footnotes banner; subsequent printed Footnote N: anchor with reciprocal earlier [FNN] fragment anchor; following tag-stripped literal prose; terminal run of at least four BR tags followed by an empty FORM, optional DIV/CENTER opening wrappers, then only whitespace/closing tags. Every printed body anchor between banner/footer must satisfy the pair/prose conditions.',
  limitations:'Candidate discovery from complete original field strings, not semantic note gold, HTML parsing, DOM reparsing, natural fragment navigation, or a whole-CourtListener result. Bounded literal comment/CDATA/processing-instruction/raw-text/RCDATA spans are replaced by spaces preserving original UTF-16 positions; required banner/anchor/footer spans intersecting them are rejected. Prose ignores their text but retains the original interval/hash and excluded span coordinates. Malformed context nesting, XML/HTML parser differences and unadjudicated excluded content carry no absence claim. Anchor pairing uses literal ASCII attribute identifiers without entity decoding, original UTF-16/UTF-8 positions, raw tag spelling and numeric label spelling. Tag stripping is lexical; following prose is a literal-letter predicate rather than an independently certified semantic body boundary.',
  inventory_source_sha256:digest(fs.readFileSync(fileURLToPath(import.meta.url))),
  regeneration_argv:['node','--max-old-space-size=96','experiments/courtlistener-renditions/inventory-uncontained-layout.mjs',directory,output,identityFile,
    ...(previousSHA?[previousSHA]:[])],
  publication_guard:'Invoke under existing budget.writer() + require_bytes(16 MiB) and physical guard',
  seconds:(performance.now()-started)/1000};
const bytes=Buffer.from(JSON.stringify(report,null,2)+'\n');
if(bytes.length>16*1024*1024) throw Error('Inventory exceeds bounded report lease');
const pending=output+'.pending';
try {
  fs.writeFileSync(pending,bytes,{flag:'wx'});
  fs.renameSync(pending,output);
} finally {
  if(fs.existsSync(pending)) fs.unlinkSync(pending);
}
console.log(JSON.stringify({output,bytes:bytes.length,sha256:digest(bytes),counts,source_variations:variants,
  matched_opinion_ids:[...matchedIds],seconds:report.seconds}));
