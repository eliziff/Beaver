"""A small deterministic candidate ranker over already parsed party names."""
from __future__ import annotations

from dataclasses import dataclass
from functools import lru_cache
import json
import math
from pathlib import Path
import re
import unicodedata

from mine import balanced_delimiters, normalize, words
from evidence import caption_flag, grammar_pattern

LEGAL_ENDINGS = set("inc incorporated corp corporation co company ltd limited llc plc llp lp ulc ltée limitée sarl sa".split())
ARTICLES = {"the", "a", "an"}
CONNECTORS = {"of", "the", "and", "de", "la", "le", "du", "des", "les", "et", "&", "van", "von", "den", "der"}
TRAILING_CONNECTORS = CONNECTORS | {"for", "to", "in", "at", "by", "with", "from", "on", "as",
    "pour", "à", "au", "aux", "avec", "chez", "dans", "en", "par", "sans", "sous", "sur",
    "del", "della", "delle", "dei", "degli", "di"}
WEAK_OPENINGS = {"new", "first", "second", "third", "general", "international", "united", "global", "church"}
CROWN = {"r", "rex", "regina", "reginam", "crown", "thecrown", "theking", "thequeen", "lacouronne",
         "hermajestythequeen", "hismajestytheking", "smajestélareine", "smajestéleroi",
         "samajestélareine", "samajestéleroi", "leroi", "lareine", "hermajesty", "hismajesty", "samajesté"}
JURISDICTIONS = {"canada", "ontario", "alberta", "quebec", "québec", "britishcolumbia", "saskatchewan",
    "manitoba", "newbrunswick", "novascotia", "princeedwardisland", "newfoundlandandlabrador",
    "nunavut", "northwestterritories", "yukon", "unitedstates", "state", "people", "commonwealth"}
ROLE = re.compile(r"\b(?:attorney.general|procureure?.g[ée]n[ée]rale?|minister|ministre|commissioner|government|"
                  r"city|town|municipality|municipalité|ville)\b", re.I)
TOKEN = re.compile(r"[^\W_]+(?:['’.\u2010\u2011-][^\W_]+)*\.?", re.UNICODE)
FEATURES = ("first_party", "own_government", "other_government", "own_numbered", "other_numbered",
            "own_corporate", "prefix", "surname", "full_core", "literal_acronym", "words", "chars",
            "removed_legal", "removed_generic", "generic_kept", "fraction_kept", "anonymous",
            "corporate_words", "corporate_fraction", "token_fit", "suffix", "interior",
            "core_words", "other_core_words", "core_chars", "one_word", "two_words",
            "start_fraction", "end_fraction", "kept_retention", "dropped_retention",
            "retention_log_fit", "first_retention", "last_retention", "first_initial",
            "uppercase", "own_ordinary", "other_ordinary", "other_corporate", "other_anonymous",
            "selection_first", "selection_last", "selection_min", "selection_mean", "selection_max",
            "other_selection_mean", "memory_match", "memory_cases", "memory_documents", "memory_share",
            "own_memory_cases", "own_memory_share", "other_memory_cases", "other_memory_share",
            "typed_fit", "typed_log_fit", "typed_kept", "typed_removed", "last_fit", "last_log_fit",
            "last_kept", "last_removed", "bigram_fit", "bigram_count", "selection_typed_mean",
            "selection_typed_min", "selection_typed_max", "other_selection_typed_mean",
            "selection_pair_mean", "other_selection_pair_mean", "prefix_count", "suffix_count",
            "phrase_rate", "phrase_count", "typed_phrase_rate", "typed_phrase_count", "alias_frequency",
            "before_fit", "before_log_fit", "before_kept", "before_dropped",
            "after_fit", "after_log_fit", "after_kept", "after_dropped",
            "start_before", "start_after", "end_before", "end_after")


SHAPE_FEATURES = ("shape_own_organization","shape_other_organization","shape_head_uppercase","shape_head_initial","shape_ampersand","shape_word_conjunction","shape_keeps_conjunction","shape_repetition","shape_head_person_frequency","shape_head_body_frequency","shape_head_body_to_name_ratio","shape_label_body_mean","shape_label_body_max","shape_label_body_min","shape_removed_body_mean","shape_role_seen","shape_role_kept","shape_after_role","shape_own_nation","shape_other_nation")
FEATURES += SHAPE_FEATURES
PROPOSAL_FEATURES = ("whole_party", "parenthetical", "legal_ending_kept", "article_kept",
    "noncontiguous_copy", "formed_initials", "abbreviated", "joint_parties", "edit_fit",
    "own_crown", "weak_head_alone", "generic_only", "numeric_fragment", "initial_fragment",
    "hyphen_component")
FEATURES += PROPOSAL_FEATURES
ORGANIZATION_WORDS = set("insurance assurance assurances construction services holdings resources communications enterprises investment investments energy mining railway railways airlines hotel hotels foods transport transports association authority bank banque board bureau college coll\u00e8ge committee commission conseil council cooperative district federation f\u00e9d\u00e9ration foundation fondation hospital h\u00f4pital institute institut league office ordre school society soci\u00e9t\u00e9 syndicat union university universit\u00e9".split())
CONJUNCTION = re.compile(r"&|\b(?:and|et)\b", re.I)
REPRESENTATIVE = re.compile(r"\b(?:obo|on\s+behalf\s+of)\b", re.I)

def anonymous(value):
    tokens = words(value)
    return bool(tokens) and (all(len(token) == 1 for token in tokens) or (
        bool(re.fullmatch(r"\s*[^\W\d_]\.?\s*\((?:[^\W\d_][.\s]*){1,6}\)\s*", value))
        and all(character.isupper() for character in value if character.isalpha())))


def anonymous_letters(value, *, compact=False):
    norm = normalize(value)
    initials = anonymous(value) or (compact and value.isupper() and
        all(len(group.split())<=1 for group in re.split(r"[.()\-]",value)) and
        all(c.isalpha() or c.isspace() or c in ".()-" for c in value))
    return norm if len(norm) > 1 and norm.isalpha() and initials else ""


def party_type(value):
    norm = normalize(value)
    base = re.sub(r"\s*\([^)]*\)\s*$", "", value)
    # The shared formatter recognizes Crown titles qualified by their jurisdiction.
    base = re.sub(r"\s+(?:in(?:\s+the)?\s+right\s+of|du\s+chef\s+(?:de|du|des))\s+.+$", "", base, flags=re.I)
    if norm in CROWN or (normalize(base) in CROWN and not ROLE.search(value)):
        return "crown"
    if re.match(r"^\s*\d{4,}(?:\b|(?=[A-Z]))", value):
        return "numbered"
    if normalize(base) in JURISDICTIONS or ROLE.search(value):
        return "government"
    if any(token in LEGAL_ENDINGS for token in words(value)):
        return "corporate"
    return "ordinary"


def core(value):
    value = " ".join(value.split()).strip(" ,;")
    if anonymous(value):
        return value
    value = re.sub(r"\s*\([^)]*\)\s*$", "", value).strip(" ,;")
    tokens = list(TOKEN.finditer(value))
    while tokens and normalize(tokens[-1].group()) in LEGAL_ENDINGS:
        shortened = value[:tokens[-1].start()].rstrip(" ,.")
        preceding = list(TOKEN.finditer(shortened))
        if not preceding or shortened.endswith("&") or preceding[-1].group().casefold().rstrip(".") in CONNECTORS:
            break
        value = shortened
        tokens = list(TOKEN.finditer(value))
    if tokens and tokens[0].group().casefold() in ARTICLES and len(tokens) > 1:
        value = value[tokens[1].start():]
    return value or " ".join(value.split())


def name_slice(value, start, end):
    fragment = value[start:end]
    while end < len(value) and value[end] in ")]":
        opening = "(" if value[end] == ")" else "["
        if fragment.count(opening) <= fragment.count(value[end]):
            break
        fragment += value[end]
        end += 1
        while end < len(value) and value[end].isalpha():
            fragment += value[end]
            end += 1
    attached = re.match(r"\([^()\s]+\)[^\W\d_]+", value[end:])
    if attached:
        end += attached.end()
    return value[start:end]


def complete_fragment(text, whole):
    if text.rstrip().endswith("&"):
        return False
    if not balanced_delimiters(text):
        return False
    role = REPRESENTATIVE.search(whole)
    ending = REPRESENTATIVE.search(text.rstrip(" ."))
    if (normalize(text) != normalize(whole) and role and role.start() > 0 and words(whole[role.end():])
            and ending and ending.end() == len(text.rstrip(" ."))):
        return False
    last = list(TOKEN.finditer(text))
    return bool(last) and (normalize(text) == normalize(whole) or
        last[-1].group().casefold().rstrip(".") not in TRAILING_CONNECTORS)


@lru_cache(maxsize=65536)
def name_structure(party):
    name = core(party)
    tokens = tuple(words(name))
    first = re.search(r"[^\W_]+", name)
    head = first.group() if first else ""
    conjunction = CONJUNCTION.search(name)
    role = next((m for m in REPRESENTATIVE.finditer(name) if m.start() > 0 and m.end() < len(name)), None)
    nation = bool(set(tokens) & {"nation", "nations", "band", "tribe", "tribal"}) and len(tokens) > 1
    organization = (any(word in LEGAL_ENDINGS for word in words(party)) or
        (party_type(party) == "ordinary" and len(tokens) > 1 and bool(set(tokens) & ORGANIZATION_WORDS)) or nation)
    return name, tokens, head, conjunction, role, nation, organization


def shape_features(parties, text, side, background=None, covered=None, span=None):
    name, tokens, head, conjunction, role, nation, organization = name_structure(parties[side])
    other = name_structure(parties[1-side])
    label = words(text)
    own = set(label if covered is None else covered)
    background = background or {}
    body = background.get("word_documents", {})
    name_frequency = background.get("name_word_frequency", {})
    start = name.find(text)
    end = start + len(text)
    if normalize(text) == normalize(name):
        start, end = 0, len(name)
    if span is not None:
        start, end = span
    keeps_conjunction = bool(conjunction and start >= 0 and start < conjunction.start() and
        end > conjunction.end() and words(name[start:conjunction.start()]) and words(name[conjunction.end():end]))
    frequency = [math.log1p(body.get(word, 0)) for word in label]
    removed = [math.log1p(body.get(word, 0)) for word in tokens if word not in own]
    first = tokens[0] if tokens else ""
    body_first = math.log1p(body.get(first, 0))
    name_first = math.log1p(name_frequency.get(first, 0))
    return (float(organization), float(other[6]), float(len(head) > 1 and head.isupper()), float(len(head) == 1),
        float(bool(conjunction and conjunction.group() == "&")), float(bool(conjunction and conjunction.group() != "&")),
        float(keeps_conjunction), 1-len(set(tokens))/max(1, len(tokens)),
        math.log1p(background.get("person_name_cases", {}).get(first, 0)), body_first, body_first-name_first,
        sum(frequency)/max(1, len(frequency)), max(frequency, default=0.), min(frequency, default=0.),
        sum(removed)/max(1, len(removed)), float(role is not None),
        float(bool(role and start >= 0 and start <= role.start() and end >= role.end())),
        float(bool(role and start >= role.end())), float(nation), float(other[5]))

@dataclass(frozen=True)
class Candidate:
    text: str
    side: int
    kind: str
    features: tuple[float, ...]


def context_features(text, side, names, kinds, retention, covered=None):
    """Compare retained and omitted words using position, type and adjacent words."""
    label_tokens, tokens = words(text), names[side]
    own = set(label_tokens if covered is None else covered)
    tables = retention.get("context", {})
    result = {}
    for table, prefix in (("typed", "typed"), ("last", "last")):
        probabilities = []
        for index, word in enumerate(tokens):
            position = "first" if index == 0 else "last" if index == len(tokens)-1 else "middle"
            key = (kinds[side] + ":" if table == "typed" else "") + position + ":" + word
            kept, total = tables.get(table, {}).get(key, (0, 0))
            prior = retention.get("priors", {}).get(kinds[side] + ":" + ("first" if index == 0 else "other"), 0.5)
            probabilities.append((kept + 5 * prior) / (total + 5))
        fitted = [p if word in own else 1-p for word, p in zip(tokens, probabilities)]
        kept = [p for word, p in zip(tokens, probabilities) if word in own]
        removed = [p for word, p in zip(tokens, probabilities) if word not in own]
        result.update({prefix + "_fit": sum(fitted) / max(1, len(fitted)),
            prefix + "_log_fit": sum(math.log(max(1e-6, p)) for p in fitted) / max(1, len(fitted)),
            prefix + "_kept": sum(kept) / max(1, len(kept)),
            prefix + "_removed": sum(removed) / max(1, len(removed))})
    bigrams = []
    for first, second in zip(tokens, tokens[1:]):
        kept, total = tables.get("bigram", {}).get(first + " " + second, (0, 0))
        if total:
            probability = (kept + 2.5) / (total + 5)
            bigrams.append(probability if first in own and second in own else 1-probability)
    result.update(bigram_fit=sum(bigrams) / max(1, len(bigrams)), bigram_count=len(bigrams))
    preferences = {}
    for table in ("select_type", "select_pair"):
        preferences[table] = []
        for index, name in enumerate(names):
            prior = retention.get("party_selection", {}).get("priors", {}).get(f"{index}:{kinds[index]}", 0.5)
            values = []
            for word in name:
                key = f"{index}:{kinds[index]}:" + (f"{kinds[1-index]}:" if table == "select_pair" else "") + word
                selected, total = tables.get(table, {}).get(key, (0, 0))
                values.append((selected + 5 * prior) / (total + 5))
            preferences[table].append(values or [prior])
    selected = preferences["select_type"][side]
    other = preferences["select_type"][1-side]
    paired = preferences["select_pair"][side]
    other_paired = preferences["select_pair"][1-side]
    result.update(selection_typed_mean=sum(selected) / len(selected), selection_typed_min=min(selected),
        selection_typed_max=max(selected), other_selection_typed_mean=sum(other) / len(other),
        selection_pair_mean=sum(paired) / len(paired), other_selection_pair_mean=sum(other_paired) / len(other_paired),
        prefix_count=float(any(tokens[:count] == words(text) for count in range(1, len(tokens)+1))),
        suffix_count=float(any(tokens[start:] == words(text) for start in range(len(tokens)))))
    norm = normalize(text)
    for table, prefix, key in (("phrase", "phrase", norm), ("phrase_typed", "typed_phrase", kinds[side] + ":" + norm)):
        named, total = tables.get(table, {}).get(key, (0, 0))
        result[prefix + "_rate"] = (named + 0.5) / (total + 5)
        result[prefix + "_count"] = math.log1p(total)
    result["alias_frequency"] = math.log1p(tables.get("alias_frequency", {}).get(norm, 0))
    neighbors = {"before": [(tokens[index-1] if index else "^") + " " + word for index, word in enumerate(tokens)],
                 "after": [word + " " + (tokens[index+1] if index+1 < len(tokens) else "$") for index, word in enumerate(tokens)]}
    for table in ("before", "after"):
        probabilities = []
        for key in neighbors[table]:
            kept, total = tables.get(table, {}).get(key, (0, 0))
            probabilities.append((kept + 2.5) / (total + 5))
        fitted = [p if word in own else 1-p for word, p in zip(tokens, probabilities)]
        kept = [p for word, p in zip(tokens, probabilities) if word in own]
        dropped = [p for word, p in zip(tokens, probabilities) if word not in own]
        result.update({table + "_fit": sum(fitted) / max(1, len(fitted)),
            table + "_log_fit": sum(math.log(max(1e-6, p)) for p in fitted) / max(1, len(fitted)),
            table + "_kept": sum(kept) / max(1, len(kept)),
            table + "_dropped": sum(dropped) / max(1, len(dropped))})
    start = next((index for index, word in enumerate(tokens) if label_tokens and word == label_tokens[0]), None)
    end = next((index for index in range(len(tokens)-1, -1, -1) if label_tokens and tokens[index] == label_tokens[-1]), None)
    for boundary, index in (("start", start), ("end", end)):
        for neighbor in ("before", "after"):
            hit, total = (tables.get(boundary + "_" + neighbor, {}).get(neighbors[neighbor][index], (0, 0))
                          if index is not None else (0, 0))
            result[boundary + "_" + neighbor] = (hit + 0.5) / (total + 5)
    return result


def name_proposals(party, known=None, extra=()):
    """Construct and filter names without computing ranking features."""
    clean = core(party)
    tokens = list(TOKEN.finditer(clean))
    if not tokens:
        return
    known = known or {}
    is_anonymous = anonymous(party) and party_type(party) != "crown"
    proposed = [(clean, "full_core", None)]
    if not is_anonymous:
        proposed += [(name_slice(clean, 0, tokens[n - 1].end()), "prefix", None)
                     for n in range(1, min(4, len(tokens)) + 1)]
        if party_type(party) == "ordinary" and len(tokens) > 1:
            proposed.append((tokens[-1].group(), "surname", None))
        for start in range(len(tokens)):
            for end in range(start + 1, len(tokens) + 1):
                text = name_slice(clean, tokens[start].start(), tokens[end - 1].end())
                kind = "prefix" if start == 0 else "suffix" if end == len(tokens) else "interior"
                proposed.append((text, kind, None))
        original = " ".join(party.split()).strip(" ,;")
        variants = [(original, "original_span")]
        variants += [(match.group(1).strip(), "parenthetical")
                     for match in re.finditer(r"\(([^()]*)\)", original)]
        outside = " ".join(re.sub(r"\([^()]*\)", " ", original).split()).strip(" ,;")
        if outside != original:
            variants.append((outside, "outside_parenthetical"))
        for value, origin in variants:
            # Hyphenated components can themselves be the authored name.
            pieces = list(re.finditer(r"[^\W_]+(?:['’.][^\W_]+)*\.?", value))
            for start in range(len(pieces)):
                for end in range(start + 1, len(pieces) + 1):
                    text = name_slice(value, pieces[start].start(), pieces[end - 1].end())
                    proposed.append((text, origin, None))
        proposed += [(match.group(1), "literal_acronym", None)
                     for match in re.finditer(r"\(([A-Z][A-Z0-9]{1,9})\)", party)]
    if known:
        proposed.append((known["shortform"], "attested_party", None))
    proposed.extend((value["text"], value["kind"], value) for value in extra)
    seen = set()
    for text, kind, decoded in proposed:
        norm = normalize(text)
        if not norm or norm in seen:
            continue
        attested = bool(known and norm == normalize(known["shortform"]))
        if not attested and not complete_fragment(text, party):
            continue
        seen.add(norm)
        yield text, norm, kind, decoded, attested


def candidates(left: str | None, right: str | None, generic=(), weak_heads=(), retention=None, party_aliases=None, background=None, extra=None):
    parties = [left or "", right or ""]
    kinds = [party_type(party) if party else "missing" for party in parties]
    generic = set(generic)
    weak_heads = set(weak_heads)
    discardable = LEGAL_ENDINGS | CONNECTORS | generic
    cleaned = [core(party) for party in parties]
    names = [words(party) for party in cleaned]
    originals = [words(party) for party in parties]
    clean_norms = [normalize(party) for party in cleaned]
    anonymous_originals = [anonymous(party) for party in parties]
    memory = [(party_aliases or {}).get(normalize(party), {}) if party and not anonymous_originals[side] else {}
              for side, party in enumerate(parties)]
    result = []
    selection = (retention or {}).get("party_selection", {})
    preferences = []
    for side, party in enumerate(parties):
        prior = selection.get("priors", {}).get(f"{side}:{kinds[side]}", 0.5)
        values = []
        for token in names[side]:
            selected, total = selection.get("tokens", {}).get(f"{side}:{token}", (0, 0))
            values.append((selected + 5 * prior) / (total + 5))
        preferences.append(values or [prior])
    for side, party in enumerate(parties):
        if not party:
            continue
        clean = cleaned[side]
        core_words = names[side]
        is_anonymous = anonymous_originals[side] and kinds[side] != "crown"
        parentheticals = [set(words(match.group(1))) for match in re.finditer(r"\(([^()]*)\)", party)]
        hyphenated = [match for match in TOKEN.finditer(party) if any(char in match.group() for char in "-\u2010\u2011")]
        probabilities = []
        for index, token in enumerate(core_words):
            position = "first" if index == 0 else "other"
            prior = (retention or {}).get("priors", {}).get(kinds[side] + ":" + position, 0.5)
            kept, total = (retention or {}).get("tokens", {}).get(position + ":" + token, (0, 0))
            # Five prior observations keep rare words near their party-type rate.
            probabilities.append((kept + 5 * prior) / (total + 5))
        known, other_known = memory[side], memory[1-side]
        for text, norm, kind, decoded, attested in name_proposals(party, known, (extra or {}).get(side, [])):
            own = words(text)
            original_words = originals[side]
            covered = decoded["covered"] if decoded is not None else own
            parenthetical = any(set(covered) <= tokens for tokens in parentheticals)
            raw_start = party.find(text)
            raw_end = raw_start + len(text)
            hyphen_component = raw_start >= 0 and any(
                match.start() < raw_start < match.end() or match.start() < raw_end < match.end()
                for match in hyphenated)
            dropped = [word for word in original_words if word not in covered]
            kept = [p for word, p in zip(core_words, probabilities) if word in covered]
            removed = [p for word, p in zip(core_words, probabilities) if word not in covered]
            fitted = [p if word in covered else 1 - p for word, p in zip(core_words, probabilities)]
            start = max(0, clean.find(text))
            end = start + len(text)
            if decoded is not None:
                origin = max(0, unicodedata.normalize("NFKC", party).find(clean))
                start = min(len(clean), max(0, decoded["span"][0] - origin))
                end = min(len(clean), max(start, decoded["span"][1] - origin))
            kept_count = len(own) if decoded is None else sum(w in covered for w in original_words)
            values = {
                "first_party": float(side == 0),
                "own_government": float(kinds[side] == "government"),
                "other_government": float(kinds[1-side] in {"government", "crown"}),
                "own_numbered": float(kinds[side] == "numbered"),
                "other_numbered": float(kinds[1-side] == "numbered"),
                "own_corporate": float(kinds[side] == "corporate"),
                "prefix": float(kind == "prefix"), "surname": float(kind == "surname"),
                "full_core": float(clean_norms[side] == norm),
                "literal_acronym": float(kind == "literal_acronym" or (kind == "attested_party" and text.replace(".", "").isupper())),
                "words": len(own) / 4, "chars": len(text) / 30,
                "removed_legal": sum(word in LEGAL_ENDINGS for word in dropped),
                "removed_generic": sum(word in generic for word in dropped),
                "generic_kept": sum(word in generic for word in covered),
                "fraction_kept": kept_count / max(1, len(original_words)),
                "anonymous": float(is_anonymous),
                "corporate_words": len(own) / 4 if kinds[side] == "corporate" else 0,
                "corporate_fraction": (len(own) if decoded is None else len(kept)) / max(1, len(core_words)) if kinds[side] == "corporate" else 0,
                "token_fit": sum(fitted) / max(1, len(fitted)),
                "suffix": float(kind == "suffix"), "interior": float(kind == "interior"),
                "core_words": len(core_words) / 4,
                "other_core_words": len(names[1-side]) / 4,
                "core_chars": len(clean) / 30,
                "one_word": float(len(own) == 1), "two_words": float(len(own) == 2),
                "start_fraction": start / max(1, len(clean)),
                "end_fraction": end / max(1, len(clean)),
                "kept_retention": sum(kept) / max(1, len(kept)),
                "dropped_retention": sum(removed) / max(1, len(removed)),
                "retention_log_fit": sum(math.log(max(1e-6, p)) for p in fitted) / max(1, len(fitted)),
                "first_retention": probabilities[0] if probabilities else 0.5,
                "last_retention": probabilities[-1] if probabilities else 0.5,
                "first_initial": float(len(core_words[0]) == 1),
                "uppercase": float(text.replace(".", "").isupper()),
                "own_ordinary": float(kinds[side] == "ordinary"),
                "other_ordinary": float(kinds[1-side] == "ordinary"),
                "other_corporate": float(kinds[1-side] == "corporate"),
                "other_anonymous": float(anonymous_originals[1-side]),
                "selection_first": preferences[side][0], "selection_last": preferences[side][-1],
                "selection_min": min(preferences[side]),
                "selection_mean": sum(preferences[side]) / len(preferences[side]),
                "selection_max": max(preferences[side]),
                "other_selection_mean": sum(preferences[1-side]) / len(preferences[1-side]),
            }
            values.update(memory_match=float(attested),
                memory_cases=math.log1p(known.get("case_count", 0)) if attested else 0,
                memory_documents=math.log1p(known.get("definition_documents", 0)) if attested else 0,
                memory_share=known.get("vote_share", 0) if attested else 0,
                own_memory_cases=math.log1p(known.get("case_count", 0)), own_memory_share=known.get("vote_share", 0),
                other_memory_cases=math.log1p(other_known.get("case_count", 0)), other_memory_share=other_known.get("vote_share", 0))
            values.update(context_features(text, side, names, kinds, retention or {},
                                           covered if decoded is not None else None))
            values.update(zip(SHAPE_FEATURES, shape_features(parties, text, side, background,
                covered if decoded is not None else None, (start, end) if decoded is not None else None)))
            values.update(zip(PROPOSAL_FEATURES, (
                float(norm == normalize(party)), float(parenthetical),
                sum(word in LEGAL_ENDINGS for word in own), float(own[0] in ARTICLES),
                float(kind in {"edit_join", "outside_parenthetical"}), float(kind == "edit_initials"),
                float(kind == "edit_abbreviation"), float(kind == "edit_joint"),
                decoded.get("score", 0.) / max(1, len(original_words)) if decoded else 0.,
                float(kinds[side] == "crown"), float(len(own) == 1 and own[0] in weak_heads),
                float(all(word in discardable for word in own)),
                float(text.isdigit() and norm != normalize(party)),
                float(anonymous(text) and not anonymous_originals[side]),
                float(hyphen_component)
            )))
            result.append(Candidate(text, side, kind, tuple(values[name] for name in FEATURES)))
    return result


def tree_score(features, trees):
    score = 0.0
    for node in trees:
        while isinstance(node, list):
            node = node[2] if features[node[0]] <= node[1] else node[3]
        score += node
    return score


def model_candidates(left, right, model, party_aliases=None, *, style="", language="en"):
    extra = None
    if "edit_decoder" in model:
        from edit_decoder import propose
        extra = propose({"left": left, "right": right, "style": style, "language": language}, model["edit_decoder"])
    return candidates(left, right, model.get("generic_tokens", []), model.get("weak_heads", []),
                      model.get("token_retention"), party_aliases, model.get("background_statistics"), extra)


def ranked(left, right, model, party_aliases=None, *, style="", language="en"):
    choices = model_candidates(left, right, model, party_aliases, style=style, language=language)
    return sorted(choices, key=lambda candidate: (
        -tree_score(candidate.features, model["trees"]),
        len(candidate.text), candidate.side, normalize(candidate.text), candidate.text))


def generate(left, right, model, citation="", party_aliases=None, *, style="", language="en"):
    choices = ranked(left, right, model, party_aliases, style=style, language=language)
    if not choices:
        return {"shortform": citation, "method": "citation_fallback", "side": None, "rule": "no_parsed_distinctive_party"}
    selected = choices[0]
    party = (left, right)[selected.side]
    known = (party_aliases or {}).get(normalize(party)) if not anonymous(party) else None
    if known and normalize(selected.text) == normalize(known["shortform"]):
        return {"shortform": known["shortform"], "method": "generated_attested_party", "side": selected.side,
                "rule": "name_attested_in_other_cases", "party_name_documents": known["definition_documents"]}
    return {"shortform": selected.text,
            "method": "generated_edit" if selected.kind.startswith("edit_") else "generated",
            "side": selected.side, "rule": selected.kind}


def strip_citation_tail(value):
    if re.search(r"\d", value):
        versus = re.search(r"\s+[vc]\.?\s+", value, re.I)
        for match in grammar_pattern("cite.in-text").finditer(value):
            prefix = value[:match.start()].rstrip()
            if not prefix or versus and match.start() <= versus.end():
                continue
            if re.search(r"\s+[vc]\.?$", prefix, re.I):
                continue
            if prefix.endswith((",", ";")) or match.group().startswith("[") or re.fullmatch(r"(?:19|20)\d{2}\s+[A-Z]{2,8}\s+\d+", match.group()):
                value = prefix.rstrip(" ,;([")
                break
    value = re.split(r"(?:,\s*|\s+)\[\s*(?=(?:1[0-9]|20)\d{2}\])", value, maxsplit=1)[0]
    value = re.split(r"\[\d{1,3}\]\s*,?\s*(?=(?:le|la)\s+juge\b)", value, maxsplit=1, flags=re.I)[0]
    return value.strip(" ,;")


def clean_caption(style, citation=""):
    lines = (style or "").strip().splitlines()
    if len(lines) >= 4 and re.fullmatch(r"[A-Z][a-z]+\s+(?:19|20)\d{2}", lines[0].strip()):
        lines = lines[2:]
    value = " ".join(" ".join(lines).split()).strip(" ,;")
    if re.search(r"\b(?:Comp\s*Trib|Trib\.?\s*Conc\.?)\b", citation, re.I):
        value = re.split(r"\s+[-–—]\s+(?:(?:(?:Amended|Final|Preliminary|Scheduling)\s+|"
                         r"Public version of(?: confidential)?\s+|Version publique des\s+)?"
                         r"(?:Order|Reasons|Ordonnance|Motifs)\b|Directive au greffe\b)", value, maxsplit=1, flags=re.I)[0]
        value = re.sub(r"\s+[-–—]\s*(?:19|20)\d{2}\s+(?:Comp\s*Trib|Trib\.?\s*Conc\.?)\s+\d+$", "", value, flags=re.I)
        value = re.sub(r",\s*(?:19|20)\d{2}\s+(?:Comp\s*Trib|Trib\.?\s*Conc\.?)\s+\d+,\s*(?:Reasons|Motifs)\b.*$", "", value, flags=re.I)
    value = re.sub(r"^Footnote\s+\d+\s+", "", value, flags=re.I)
    value = re.sub(r"^(?:[Cc]f\.?|[Ee]\.\s*g\.|[Cc]onsider)\s+(?![vc]\.?\s+)", "", value)
    value = re.sub(r"\s+re\s+costs\s*$", "", value, flags=re.I)
    value = re.split(r"\s+Date de la décision(?: du tribunal)?\s*:", value, maxsplit=1, flags=re.I)[0]
    value = re.split(r"\s+Collection\s+(?:Canada Pension Plan|Employment Insurance)\b", value, maxsplit=1)[0]
    value = re.sub(r"^\d{1,3}[.)]\s+(?=[^\W\d_])", "", value)
    # Preserve the original double-space marker until the footnote number has been removed.
    original = " ".join(lines).strip()
    if re.match(r"^\d{1,3}\s{2,}(?=[^\W\d_])", original):
        value = re.sub(r"^\d{1,3}\s+", "", value)
    value = re.sub(r"^(?:see(?:\s+also)?|voir(?:\s+aussi)?)\s+", "", value, flags=re.I)
    value = re.sub(r"^.*?\b(?:Decision Content|Contenu de la décision)\s+"
                   r"(?:(?:Federal Court Reports|Recueil des décisions de la Cour fédérale)\s+)?", "", value, flags=re.I)
    value = re.sub(r"^Court\.\s+In\s+", "", value)
    value = re.sub(r"\b([vc])\s+\.\s*", r"\1. ", value)
    value = re.sub(r"\b(Ltd|Inc|Co)\.(?=[vc]\.\s)", r"\1. ", value)
    if citation and value.endswith(citation):
        value = value[:-len(citation)].rstrip(" ,;")
    return re.sub(r"^R\.v\.\s*", "R v. ", strip_citation_tail(value))


def _party_match(style):
    pattern = grammar_pattern("ref.infer.parties")
    # Uppercase C/V within a name must not precede an explicit lowercase separator.
    return re.fullmatch(pattern.pattern, style, flags=pattern.flags & ~re.I) or pattern.fullmatch(style)


def party_names(style):
    cleaned = clean_caption(style)
    if caption_flag(cleaned) or re.match(r"^(?:reference|renvoi)\b", cleaned, re.I):
        return None, None
    match = _party_match(cleaned)
    return match.groups() if match else (None, None)


def caption_profile(style, left=None, right=None, citation=""):
    cleaned = clean_caption(style, citation)
    flag = caption_flag(style) or caption_flag(cleaned)
    if flag:
        return (cleaned if flag == "multiple_proceedings" else ""), None, None
    if re.match(r"^(?:reference|renvoi)\b", cleaned, re.I):
        return cleaned, None, None
    left, right = (strip_citation_tail(" ".join(party.split())) if party else None for party in (left, right))
    match = _party_match(cleaned)
    inferred_parties = match.groups() if match else (None, None)
    original_match = grammar_pattern("ref.infer.parties").fullmatch(" ".join((style or "").split()))
    if match and original_match and match.groups() != original_match.groups():
        left, right = (inferred if supplied and normalize(supplied) == normalize(previous) else supplied
                       for supplied, previous, inferred in zip((left, right), original_match.groups(), inferred_parties))
    changed = cleaned != " ".join((style or "").split()).strip(" ,;")
    inconsistent = bool(cleaned) and any(party and normalize(party) not in normalize(cleaned)
                                        for party in (left, right))
    left, right = (left or inferred_parties[0]), (right or inferred_parties[1])
    if changed or inconsistent:
        repaired = [left, right]
        for side, inferred in enumerate(inferred_parties):
            if not inferred:
                continue
            supplied = repaired[side]
            if changed and original_match and normalize(supplied) == normalize(original_match.groups()[side]):
                repaired[side] = inferred
                continue
            supplied = re.sub(r"^(?:contra|accord|cf\.?|compare)[\s,]+", "", supplied, flags=re.I)
            # Restore omitted caption words and discard citation spillover, while
            # retaining a fuller supplied name when the caption abbreviates it.
            remaining = iter(words(inferred))
            tokens = words(supplied)
            if tokens and all(any(token == wanted for token in remaining) for wanted in tokens):
                repaired[side] = inferred
        left, right = repaired
    return cleaned, left, right


def generate_case(style, left, right, model, citation="", party_aliases=None, *, qualified=False, language="en"):
    if caption_flag(style):
        return {"shortform": citation, "method": "citation_fallback", "side": None,
                "rule": caption_flag(style)}
    if not qualified:
        if style:
            style, left, right = caption_profile(style, left, right, citation)
        if not (left or right):
            left, right = party_names(style)
    if left or right:
        return generate(left, right, model, citation, party_aliases, style=style, language=language)
    if not style:
        return generate(None, None, model, citation)
    title = " ".join(style.split()).strip(" ,;")
    reference = re.match(r"^(?:reference\s+(?:re|regarding)|renvoi\s+(?:relatif\s+[àa]|sur))\s+", title, re.I)
    if reference:
        title = title[reference.end():]
    else:
        title = re.sub(r"^(?:in\s+(?:the\s+)?estate\s+of|in\s+re|re)\s+", "", title, flags=re.I)
    title = core(title)
    tokens = list(TOKEN.finditer(title))
    count = min(3, len(tokens))
    while count and not complete_fragment(name_slice(title, 0, tokens[count-1].end()), title):
        count -= 1
    if not count:
        return generate(None, None, model, citation)
    selected = name_slice(title, 0, tokens[count-1].end())
    if count == 1 and words(selected)[0] in model.get("weak_heads", []) and len(tokens) > 1:
        final = tokens[-1].group()
        extended = selected + " " + final
        if normalize(final) == normalize(selected) or not complete_fragment(extended, title):
            return generate(None, None, model, citation)
        selected = extended
    if reference:
        suffix = " Reference" if reference.group().lower().startswith("reference") else " — renvoi"
        selected += suffix
    return {"shortform": selected, "method": "title_generated", "side": None, "rule": "caption_title"}


def baseline(left, right, government=False):
    left, right = left or "", right or ""
    selected = right if party_type(left) == "crown" or (government and party_type(left) in {"government", "numbered"}
                                                     and party_type(right) not in {"crown", "government", "numbered"}) else left or right
    return core(selected)


def disambiguate(records):
    """Short names are document-scoped labels; their underlying authority IDs never change."""
    groups = {}
    for record in records:
        groups.setdefault(normalize(record["shortform"]), []).append(record)
    result = {record["identity"]: record["shortform"] for record in records}
    for group in groups.values():
        if len({record["identity"] for record in group}) < 2:
            continue
        for record in group:
            result[record["identity"]] = f"{record['shortform']} ({record['citation']})"
    if len(set(map(normalize, result.values()))) != len(result):
        raise ValueError("The available names and citations cannot disambiguate these authorities")
    return result


def load_model(filename=None):
    model = json.loads(Path(filename or Path(__file__).with_name("model.json")).read_text(encoding="utf-8"))
    if model.get("schema") != "case-shortform-ranker.v2" or model.get("features") != list(FEATURES):
        raise ValueError("refit the case-shortform model for the current candidate features")
    return model


def parsed_parties(engine, style, citation):
    """Reuse both existing native name primitives; numbered/lowercase captions need the second."""
    if not style:
        return None, None, "missing_caption"
    extracted = next((c for c in engine.extract(f"{style}, {citation}") if c.get("parties")
                      and normalize((c.get("style") or {}).get("text", "")) == normalize(style)), None)
    if extracted:
        return extracted["parties"].get("plaintiff"), extracted["parties"].get("defendant"), "native_parties"
    inferred = engine.call("inferShortForms", {"text": style, "kind": "case"})
    complete = any(row["rule"] == "case_style" and normalize(row["value"]) == normalize(style) for row in inferred)
    parties = [row["value"] for row in inferred if row["rule"] == "case_party"]
    if complete and len(parties) == 2:
        return parties[0], parties[1], "native_party_inference"
    return None, None, "unparsed_or_nonadversarial"
