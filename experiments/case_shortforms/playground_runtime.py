"""Accept a name or caption and return the ranker's unique shortforms."""
import json

from mine import balanced_delimiters, normalize, words
import shortform as s

MODEL = None
PARTY_NAMES = None


def initialize(model, party_names):
    global MODEL, PARTY_NAMES
    if model.get("schema") != "case-shortform-ranker.v2" or model.get("features") != list(s.FEATURES):
        raise ValueError("The bundled model and inference features do not match. Rebuild the HTML.")
    MODEL, PARTY_NAMES = model, party_names


def rank_json(request):
    text = json.loads(request).get("text")
    if not isinstance(text, str) or len(text) > 1000:
        return json.dumps(dict(error="Enter a name or case title of up to 1,000 characters."))
    text = text.strip()
    if not words(text):
        return json.dumps(dict(names=[]))
    if not balanced_delimiters(text):
        return json.dumps(dict(error="Close matching parentheses and square brackets."))
    left, right = s.party_names(text)
    language = "en"
    if left and right:
        cleaned = s.clean_caption(text)
        match = s._party_match(cleaned)
        separator = cleaned[match.end(1):match.start(2)]
        language = "fr" if "c" in separator.casefold() else "en"
    else:
        left, right = text, ""
    choices = s.ranked(left, right, MODEL, PARTY_NAMES, language=language)
    first = s.generate(left, right, MODEL, party_aliases=PARTY_NAMES, language=language)["shortform"]
    names, seen = [], set()
    for name in [first, *[candidate.text for candidate in choices]]:
        norm = normalize(name)
        if norm and norm not in seen:
            seen.add(norm)
            names.append(name)
    return json.dumps(dict(names=names), ensure_ascii=False)
