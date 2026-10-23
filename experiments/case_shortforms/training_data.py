"""Training-only declaration components and reproducible unlabeled word counts."""
import argparse
from collections import Counter, defaultdict
from contextlib import ExitStack, closing
import hashlib
import json
from pathlib import Path
import re
import time

from mine import ROOT, data_root, normalize, readonly, words
from party_alias import matches_party as original_match
import shortform as s

BACKGROUND = ROOT / "benchmarks/local-data/case-shortforms/word-background.json"

INTRODUCERS={"decision","d\u00e9cision","arr\u00eat","affaire","case"}

def component_match(label,party):
    return original_match(label,party) or normalize(label)==normalize(s.core(party))

def sides(record,label):
    return [index for index,party in enumerate((record["left"],record["right"])) if component_match(label,party)]

def encoded_label(record,label,strip_qualifiers):
    anchored=sides(record,label)
    if len(anchored)==1:
        party=(record["left"],record["right"])[anchored[0]];core=s.core(party)
        if normalize(label) in {normalize(core),normalize(party)}:return core
        return label
    if not strip_qualifiers:return label
    candidate=label;courts={normalize(court) for court in record["courts"]};years=set(record["years"])
    for _ in range(2):
        tokens=list(s.TOKEN.finditer(candidate))
        if len(tokens)<2:break
        remove=next((size for size in range(min(4,len(tokens)-1),0,-1) if normalize("".join(token.group() for token in tokens[-size:])) in courts),None)
        if remove is None and (normalize(tokens[-1].group()) in years or tokens[-1].group() in set("123456789")):remove=1
        if remove is None:break
        candidate=candidate[:tokens[-remove].start()].rstrip(" ([,;-\u2013\u2014")
    tokens=list(s.TOKEN.finditer(candidate))
    if len(tokens)>1 and normalize(tokens[0].group()) in INTRODUCERS:candidate=candidate[tokens[1].start():]
    anchored=sides(record,candidate)
    if len(anchored)!=1:return label
    party=(record["left"],record["right"])[anchored[0]];core=s.core(party)
    return core if normalize(candidate) in {normalize(core),normalize(party)} else candidate

def encoding_views(records,strip_qualifiers):
    output=[];changed=0;new_anchored=0
    for r in records:
        aliases={};mapping={}
        for norm,alias in r["aliases"].items():
            text=encoded_label(r,alias["text"],strip_qualifiers);key=normalize(text);mapping[norm]=key
            changed+=text!=alias["text"];new_anchored+=len(sides(r,text))==1 and not any(original_match(alias["text"],party) for party in (r["left"],r["right"]))
            if key not in aliases:aliases[key]={**alias,"text":text,"document_ids":list(alias["document_ids"])}
            else:
                value=aliases[key];value["document_ids"]=sorted(set(map(tuple,value["document_ids"]))|set(map(tuple,alias["document_ids"])));value["votes"]=len(value["document_ids"])
        output.append({**r,"aliases":aliases,"modal":{mapping[norm] for norm in r["modal"]}})
    return output,{"rows":len(records),"transformed_aliases":changed,"newly_anchored_aliases":new_anchored}

def attach_citation_metadata(connection,rows):
    courts=json.loads(((ROOT/"common-law-cite/crates/legal-citations/registry")/"courts.json").read_text(encoding="utf-8"));reporters=json.loads(((ROOT/"common-law-cite/crates/legal-citations/registry")/"reporters.json").read_text(encoding="utf-8"))
    court_ids={court["id"]:court for court in courts};reporter_ids={reporter["citation_id"]:reporter for reporter in reporters if reporter.get("citation_id")}
    aliases=defaultdict(set)
    for court in courts:
        for label in [court["id"],*court.get("neutral",[]),*court.get("aliases",[])]:aliases[normalize(label)].add(court["id"])
    translations=json.loads(((ROOT/"common-law-cite/crates/legal-citations/registry")/"neutral-translations.json").read_text(encoding="utf-8"))
    keys=defaultdict(list)
    for key,case in connection.execute("SELECT key,case_id FROM case_key"):keys[case].append(key)
    parallel_links=connection.execute("SELECT value FROM meta WHERE key='parallel_case_links'").fetchone()
    for link in json.loads(parallel_links[0]) if parallel_links else []:
        keys[link["case_id"]].extend(keys[link["parallel_case_id"]])
    reviewed=defaultdict(set)
    evidence=connection.execute("SELECT value FROM meta WHERE key='caption_evidence'").fetchone()
    for item in json.loads(evidence[0]) if evidence else []:
        if item.get("court_labels"):
            source=connection.execute("SELECT sha256 FROM source WHERE id=?",(item["source_id"],)).fetchone()
            if not source or source[0]!=item["source_sha256"]:
                raise ValueError("reviewed court qualifier no longer matches its source")
            reviewed[item["case_id"]].update(item["court_labels"])
    for row in rows:
        years=set(re.findall(r"(?:^|[\[(])\s*((?:1[0-9]|20)\d{2})\b",row["citation"] or ""));ids=set();labels=set(reviewed[row["id"]])
        for key in keys[row["id"]]:
            parts=key.split(":")
            if len(parts)==5 and parts[1]=="neutral":years.add(parts[2]);ids.add(parts[3])
            elif len(parts)>=6 and parts[1]=="reporter":
                reporter=reporter_ids.get(parts[2],{})
                ids.update(reporter.get("courts",[]) if len(reporter.get("courts",[]))==1 else [])
                fixed=reporter.get("year_volume") and not any(e.get("numbering") for e in reporter.get("editions",{}).values())
                if len(parts)==7 or fixed:
                    if re.fullmatch(r"(?:1[0-9]|20)\d{2}",parts[4]):years.add(parts[4])
        for written in re.findall(r"\(([^()]*)\)",row["citation"] or ""):
            norm=normalize(written)
            if norm in aliases and 2<=len(norm)<=8:labels.add(norm.upper())
        for court in ids:
            entry=court_ids.get(court,{})
            labels.update(entry.get("neutral",[]))
            labels.update(entry.get("aliases",[]))
            if entry.get("level")=="iac" and entry.get("region","").startswith("ca-"):
                labels.add("CA")
        for label in list(labels):
            for mapping in translations.values():
                if label in mapping:labels.add(mapping[label])
        row["years"]=sorted(years);row["courts"]=sorted(labels);row["court_ids"]=sorted(ids)


def word_set(text):
    return {word for word in words(text) if len(word) > 1 and word.isalpha()}


def background_inputs(database):
    """Freeze the same selected texts and qualified names for remote compilation."""
    with ExitStack() as stack:
        index = stack.enter_context(closing(readonly(database)))
        paths = json.loads(index.execute("SELECT value FROM meta WHERE key='sources'").fetchone()[0])
        streams = json.loads(index.execute("SELECT value FROM meta WHERE key='text_stream_sha256'").fetchone()[0])
        excluded_docs = {(provider, local_id) for provider, local_id in index.execute(
            "SELECT DISTINCT s.provider,s.local_id FROM clean_observation o JOIN source s ON s.id=o.source_id"
            " WHERE o.kind='definition' AND o.status='accepted'")}
        excluded_cases = {row[0] for row in index.execute(
            "SELECT DISTINCT case_id FROM clean_observation WHERE kind='definition' AND status='accepted'")}
        eligible = {}
        for source_id, provider, local_id, language, sha in index.execute(
                "SELECT id,provider,local_id,language,sha256 FROM source WHERE duplicate_of IS NULL"):
            key = provider, local_id
            if key in excluded_docs:
                continue
            old = eligible.get(key)
            if old is None or (language != "en", source_id) < (old["language"] != "en", old["source_id"]):
                eligible[key] = dict(provider=provider, local_id=local_id, language=language, sha256=sha, source_id=source_id)
        selected = []
        for provider, limit in (("journal", 1000), ("a2aj", 3000)):
            records = [row for row in eligible.values() if row["provider"] == provider]
            records.sort(key=lambda row: hashlib.sha256(
                ("body-word-background-v1:"+provider+":"+str(row["local_id"])).encode()).digest())
            selected.extend(records[:limit])
        dataset = index.execute("SELECT value FROM meta WHERE key='data_quality'").fetchone()
        yield {"kind":"metadata", "documents":len(selected), "excluded_declaration_documents":len(excluded_docs),
            "excluded_declaration_cases":len(excluded_cases), "text_stream_sha256":streams,
            "dataset":json.loads(dataset[0]) if dataset else None}
        sources = {provider: stack.enter_context(closing(readonly(Path(filename)))) for provider, filename in paths.items()}
        for row in selected:
            query = ("SELECT text FROM articles WHERE article_id=?" if row["provider"] == "journal" else
                     "SELECT unofficial_text_"+row["language"]+" FROM document WHERE id=?")
            text = sources[row["provider"]].execute(query, (row["local_id"],)).fetchone()[0]
            yield {"kind":"document", **row, "text":text}
        query = """SELECT id,plaintiff,defendant FROM (
            SELECT c.id,p.plaintiff,p.defendant,
              row_number() OVER (PARTITION BY c.id ORDER BY coalesce(p.style,'')='',p.language!='en',p.language) AS priority
            FROM case_record c JOIN case_profile p ON p.case_id=c.id WHERE c.provider_id IS NOT NULL)
            WHERE priority=1 ORDER BY id"""
        for case_id, left, right in index.execute(query):
            if case_id in excluded_cases:
                continue
            yield {"kind":"caption", "case_id":case_id, "left":left, "right":right}


def compile_background(inputs, output):
    started = time.monotonic()
    body_words, person_names, name_words = Counter(), Counter(), Counter()
    witnesses, unique_names = [], set()
    personal_cases = 0
    for item in inputs:
        if item['kind']=='metadata':
            metadata = {key:value for key,value in item.items() if key!='kind'}
        elif item['kind']=='document':
            if hashlib.sha256(item['text'].encode('utf-8')).hexdigest()!=item['sha256']:
                raise ValueError('background source text changed; reindex before rebuilding statistics')
            body_words.update(word_set(item['text']))
            witnesses.append({key:value for key,value in item.items() if key not in {'kind','text'}})
            if len(witnesses)%500==0:print(f"background: {len(witnesses)}/{metadata['documents']} documents",flush=True)
        elif item['kind']=='caption':
            left,right = item['left'],item['right']
            for party in (left,right):
                if not party or s.anonymous(party) or s.party_type(party) == "crown":
                    continue
                kind, tokens = s.party_type(party), tuple(words(s.core(party)))
                if not tokens:
                    continue
                institution = (any(word in s.LEGAL_ENDINGS for word in words(party)) or
                    (kind == "ordinary" and len(tokens) > 1 and bool(set(tokens) & s.ORGANIZATION_WORDS)))
                key = ("institution" if institution else kind), tokens
                if key not in unique_names:
                    unique_names.add(key)
                    name_words.update(set(tokens))
            if not left or not right or s.party_type(left) != "crown" or s.party_type(right) != "ordinary" or s.anonymous(right):
                continue
            name = s.core(right)
            tokens = words(name)
            if tokens:
                person_names.update({normalize(name), tokens[-1]})
                personal_cases += 1
    result = {"word_documents": {word: count for word, count in body_words.items() if count >= 2},
        "person_name_cases": dict(person_names), "name_word_frequency": dict(name_words),
        "provenance": {"documents": len(witnesses), "personal_caption_cases": personal_cases,
            "unique_party_cores": len(unique_names), **metadata,
            "input": "one language per document; all accepted-declaration documents excluded; qualified primary-provider party profiles exclude every accepted-declaration case",
            "source_witness_sha256": hashlib.sha256(json.dumps(witnesses, sort_keys=True).encode()).hexdigest(),
            "source_witnesses": witnesses, "recipe_sha256": hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),
            "seconds": round(time.monotonic()-started, 2)}}
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps(result, ensure_ascii=False, separators=(",", ":"))+"\n", encoding="utf-8")
    print(json.dumps({key: value for key, value in result["provenance"].items() if key != "source_witnesses"}), flush=True)
    return result


def build_background(database, output):
    return compile_background(background_inputs(database), output)


def load_background(filename=BACKGROUND):
    data = json.loads(Path(filename).read_text(encoding="utf-8"))
    # Individual corpus witnesses stay in the private regeneration artifact.
    return {**{key: data[key] for key in ("word_documents", "person_name_cases", "name_word_frequency")},
            "provenance": {key: value for key, value in data["provenance"].items() if key != "source_witnesses"}}


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--database", type=Path, default=data_root()/"cache/case-shortforms/shortforms.sqlite")
    parser.add_argument("--output", type=Path, default=BACKGROUND)
    args = parser.parse_args()
    build_background(args.database, args.output)
