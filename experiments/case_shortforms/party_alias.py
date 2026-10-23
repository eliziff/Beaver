"""Learn short party names from declarations about other cases, without merging cases."""
from collections import defaultdict

from mine import contains, normalize, words
from shortform import CONNECTORS, LEGAL_ENDINGS, anonymous, anonymous_letters


def matches_party(alias, party):
    tokens, name = words(alias), words(party)
    if not tokens or not name:
        return False
    if contains(name, tokens) or (anonymous(party) and normalize(alias) == normalize(party)):
        return True
    source_initials, target_initials = anonymous_letters(party,compact=True), anonymous_letters(alias,compact=True)
    if ((anonymous(party) or anonymous(alias)) and source_initials and target_initials
            and sorted(source_initials) == sorted(target_initials)):
        return True
    initials = {"".join(word[0] for word in name if word not in excluded)
                for excluded in (CONNECTORS, CONNECTORS | LEGAL_ENDINGS)}
    return (2 <= len(normalize(alias)) <= 10 and alias.replace(".", "").isupper()
            and normalize(alias) in initials)


def learn_party_names(records, minimum_cases=2, minimum_documents=2, minimum_share=0.6):
    """Only attested whole-word names or literal author acronyms may transfer."""
    names = defaultdict(lambda: defaultdict(lambda: {"documents": set(), "cases": set(), "spellings": defaultdict(set)}))
    for record in records:
        parties = (record["left"], record["right"])
        for alias in record["aliases"].values():
            label = alias["text"]
            sides = [side for side, party in enumerate(parties) if party and matches_party(label, party)]
            if len(sides) != 1:
                continue
            party = parties[sides[0]]
            initials=anonymous_letters(party,compact=True)
            if anonymous(party) or (initials and normalize(label)!=initials and sorted(normalize(label))==sorted(initials)):
                continue
            value = names[normalize(party)][normalize(label)]
            documents = set(map(tuple, alias["document_ids"]))
            value["documents"].update(documents)
            value["cases"].add(record["id"])
            value["spellings"][label].update(documents)
    result = {}
    for party, aliases in names.items():
        total = sum(len(value["documents"]) for value in aliases.values())
        eligible = []
        for norm, value in aliases.items():
            count = len(value["documents"])
            if len(value["cases"]) < minimum_cases or count < minimum_documents or count < minimum_share * total:
                continue
            label = min(value["spellings"], key=lambda text: (-len(value["spellings"][text]), len(text), text))
            eligible.append({"shortform": label, "definition_documents": count,
                             "case_count": len(value["cases"]), "vote_share": count / total})
        if eligible:
            result[party] = min(eligible, key=lambda row: (-row["definition_documents"], len(row["shortform"]), row["shortform"]))
    return result
