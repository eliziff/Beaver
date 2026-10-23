"""Decompose supplied names for a development-only structured prediction probe.

The canonical name is auxiliary supervision. Exact evaluation always uses the
complete original declaration. This module neither generates labels nor reads
the declaration from a citing document at inference.
"""
from collections import Counter
from functools import lru_cache
import re

import shortform as s
from mine import contains, normalize, words
from training_data import encoded_label


def copy_alignment(party, label):
    """Recover unique word-copy positions without inventing a lexical mapping."""
    source, target = words(party), words(label)
    if target and normalize(party) == normalize(label):
        return {"family": "whole_party", "positions": list(range(len(source))), "drop_positions": []}
    paths = [()]
    for token in target:
        expanded = [path + (i,) for path in paths
                    for i in range(path[-1] + 1 if path else 0, len(source))
                    if source[i] == token]
        paths = expanded
        if not paths:
            return None
        # Multiple repeated-word paths are ambiguous supervision, not a choice.
        if len(paths) > 64:
            return {"family": "ambiguous_copy_alignment", "paths": []}
    if not target:
        return None
    if len(paths) != 1:
        return {"family": "ambiguous_copy_alignment", "paths": [list(p) for p in paths[:2]]}
    positions = paths[0]
    contiguous = positions == tuple(range(positions[0], positions[-1] + 1))
    family = "whole_party" if len(positions) == len(source) else (
        "full_core" if normalize(label) == normalize(s.core(party)) else
        "contiguous_copy" if contiguous else "noncontiguous_copy")
    return {"family": family, "positions": list(positions),
            "drop_positions": [i for i in range(len(source)) if i not in positions]}


def initial_alignment(party, label):
    target = normalize(label)
    initials, labelled = s.anonymous_letters(party,compact=True), s.anonymous_letters(label,compact=True)
    if ((s.anonymous(party) or s.anonymous(label)) and initials and labelled and sorted(initials) == sorted(labelled)):
        return {"family": "reordered_initialism", "source_words": list(initials),
                "order_ambiguous": len(set(initials)) != len(initials), "anonymous_initials": True}
    if s.anonymous(party) or not (2 <= len(target) <= 10 and label.replace(".", "").isupper()):
        return None
    variants = [[w for w in words(party) if w not in excluded]
                for excluded in (s.CONNECTORS, s.CONNECTORS | s.LEGAL_ENDINGS)]
    for initial_words in variants:
        if target == "".join(w[0] for w in initial_words):
            return {"family": "initialism", "source_words": initial_words}
    initial_words = [w for w in words(party) if w not in s.LEGAL_ENDINGS]
    initialism = "".join(w[0] for w in initial_words)
    paths = [()]
    for letter in target:
        paths = [path + (i,) for path in paths
                 for i in range(path[-1] + 1 if path else 0, len(initialism)) if initialism[i] == letter]
        if not paths or len(paths) > 64:
            break
    if len(paths) == 1 and len(paths[0]) == len(target):
        return {"family": "selected_word_initials", "source_words": initial_words, "positions": list(paths[0])}
    for initial_words in variants:
        initialism = "".join(w[0] for w in initial_words)
        if len(initialism) >= 2 and Counter(target) == Counter(initialism):
            return {"family": "reordered_initialism", "source_words": initial_words,
                    "order_ambiguous": len(set(initialism)) != len(initialism)}
    return None


def abbreviation_alignment(party, label):
    source, target = words(party), words(label)
    paths = [((), ())]
    for token in target:
        expanded = []
        for positions, edits in paths:
            for i in range(positions[-1] + 1 if positions else 0, len(source)):
                original = source[i]
                if token == original:
                    expanded.append((positions + (i,), edits))
                elif 2 <= len(token) <= min(6, len(original) - 2) and len(token) <= .75 * len(original):
                    letters = iter(original)
                    if all(char in letters for char in token):
                        expanded.append((positions + (i,), edits + ((original, token),)))
        paths = expanded
        if not paths or len(paths) > 64:
            return None
    if len(paths) == 1 and paths[0][1] and len(paths[0][1]) < len(target):
        return {"family": "attested_abbreviation", "positions": list(paths[0][0]),
                "substitutions": [list(pair) for pair in paths[0][1]]}
    return None


def party_alignment(party, label):
    return copy_alignment(party, label) or initial_alignment(party, label) or abbreviation_alignment(party, label)


def align_base(record, label):
    """Describe training evidence; unresolved labels never become edit programs."""
    matches = []
    for side, party in enumerate((record["left"], record["right"])):
        if party:
            alignment = party_alignment(party, label)
            if alignment:
                matches.append({"side": side, **alignment})
    if len(matches) > 1:
        return {"family": "ambiguous_party", "alternatives": matches}
    if matches:
        return matches[0]
    halves = re.split(r"\s+(?:v\.?|vs\.?|c\.?)\s+", label, flags=re.I)
    if len(halves) == 2:
        alignments = [party_alignment(party, text) if party else None
                      for party, text in zip((record["left"], record["right"]), halves)]
        if all(a and not a["family"].startswith("ambiguous") for a in alignments):
            return {"family": "joint_party_edit", "components": alignments, "text_components": halves}
    return {"family": "unresolved_transformation_or_input"}


@lru_cache(maxsize=65536)
def canonical(party, text):
    name = s.core(text)
    party_core = s.core(party)
    # A literal word such as an uppercase brand is still a word, not initials.
    if not s.anonymous(party) and not contains(words(party_core), words(name)):
        initials = {"".join(word[0] for word in words(party) if word not in excluded)
                    for excluded in (s.CONNECTORS, s.CONNECTORS | s.LEGAL_ENDINGS)}
        if (2 <= len(normalize(name)) <= 10 and name.replace(".", "").isupper()
                and normalize(name) in initials):
            return party_core, "initials"
    return name, "ending" if normalize(name) != normalize(text) else "words"


def unpack(choice):
    return ((choice["text"], choice["side"], choice["kind"])
            if isinstance(choice, dict) else tuple(choice))


def parts(record, choice):
    text, side, kind = unpack(choice)
    stem = text
    if "court" in kind:
        court = next(code for code in sorted(record["courts"], key=lambda code: -len(code))
                     if stem.endswith(" " + code))
        stem = stem[:-len(court)-1]
    if "year" in kind:
        year = next(year for year in record["years"] if stem.endswith(" " + year))
        stem = stem[:-len(year)-1]
    name, rendering = canonical((record["left"], record["right"])[side], stem)
    return name, side, rendering, "year" in kind, "court" in kind


def label_keys(record, modal=False):
    labels = record["modal"] if modal else record["aliases"]
    result = set()
    for norm in labels:
        label = record["aliases"][norm]["text"]
        component = encoded_label(record, label, True)
        for side, party in enumerate((record["left"], record["right"])):
            result.add((normalize(canonical(party, component)[0]), side))
    return result


def self_check():
    record = {"left": "Larch Lantern Fabrication Limited", "right": "R",
              "years": ["2044"], "courts": ["XYZ"]}
    assert parts(record, ("Larch Lantern 2044 XYZ", 0, "prefix_year_court")) == (
        "Larch Lantern", 0, "words", True, True)
    assert parts(record, ("LLF", 0, "attested_acronym")) == (
        "Larch Lantern Fabrication", 0, "initials", False, False)
    assert parts(record, ("Larch Lantern Fabrication Ltd", 0, "abbreviated")) == (
        "Larch Lantern Fabrication", 0, "ending", False, False)
    assert canonical("QRS Lantern Ltd", "QRS") == ("QRS", "words")
    assert canonical("E.F.", "E.F.") == ("E.F.", "words")
    assert canonical("Cobalt 2044 Ltd", "Cobalt 2044") == ("Cobalt 2044", "words")


if __name__ == "__main__":
    self_check()
    print("independently invented naming-operation checks passed")
