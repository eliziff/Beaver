"""Qualify raw parser declarations for global names and training."""
import json
import re
from functools import lru_cache
from mine import ROOT, balanced_delimiters, compile_entry, label, reusable, words


@lru_cache(maxsize=None)
def grammar_pattern(name):
    corpus = json.loads((ROOT / "common-law-cite/crates/legal-grammar/data/grammar-corpus.json").read_text(encoding="utf-8"))
    for table in corpus["tables"].values():
        for entry in table["entries"]:
            if entry["id"] == name:
                return compile_entry(entry, table.get("defs"))
    raise ValueError(f"shared grammar is missing: {name}")


@lru_cache(maxsize=1)
def reporter_forms():
    from mine import normalize
    rows = json.loads((ROOT / "common-law-cite/crates/legal-citations/registry/reporters.json").read_text(encoding="utf-8"))
    return {normalize(value) for row in rows for value in (*row["editions"], *row.get("variations", {}))}


def clean_alias(value):
    introduced = re.match(r"^\s*(?:hereinafter|ci-apr(?:[e\u00e8\u00e96~]|\s+)s)", value, re.I)
    if introduced:
        value = value[introduced.end():].lstrip(' ,:.;\"\'\u201c\u201d\u00ab\u00bb')
        value = re.sub(r"\s+(?:cit[e\u00e96]\s+aux?)\b.*$|cited\s*to\s+[A-Z].*$", "", value, flags=re.I)
    value = label(grammar_pattern("ref.registry.short-form-wording").sub("", " " + value).strip(' \t\r\n\"\'“”«»‹›‘’'))
    if not annotation_flag(value):
        for separator in re.finditer(r",\s*", value):
            if annotation_flag(value[separator.end():]) == "judge_attribution":
                return value[:separator.start()].strip()
    return value


def annotation_flag(value):
    """Identify non-name annotations that can immediately follow a citation."""
    if value.strip() in {"at", "paragraph", "paragraphs", "para.", "paras."}:
        return "pinpoint_reference"
    locator = re.sub(r"^(?:at|au|aux)\s+", "", value.strip(), flags=re.I)
    if grammar_pattern("pinpoint.para.toa").fullmatch(locator):
        return "paragraph_reference"
    if grammar_pattern("pinpoint.page.toa").fullmatch(value.strip()):
        return "page_reference"
    if re.fullmatch(r"\s*(?:paragraph\s+numbers?\s+removed|(?:see|voir)\s+note\s+\d+\s+(?:below|ci-dessous))\s*", value, re.I):
        return "editorial_note"
    tokens = {token for token in words(value) if not token.isdigit()}
    notice = {"translation", "english", "french", "certified", "unrevised", "revised",
              "traduction", "fran\u00e7aise", "francais", "fran\u00e7ais", "anglaise", "anglais",
              "certifi\u00e9e", "certifi\u00e9", "certifiee", "certifie", "francaise", "non",
              "r\u00e9vis\u00e9e", "r\u00e9vis\u00e9", "revisee", "revise", "en", "seulement",
              "par", "l", "auteur", "author", "by", "the", "editor", "version",
              "official", "officielle", "officiel", "conforme", "certifée", "autrice", "juge", "la"}
    language_notice = notice - {"par", "l", "auteur", "author", "by", "the", "editor", "version",
                               "official", "officielle", "officiel", "conforme", "certifée", "autrice", "juge", "la"}
    if tokens and tokens <= notice and (tokens & {"translation", "traduction"} or
            (tokens <= language_notice and tokens & {"anglais", "fran\u00e7ais"})):
        return "translation_notice"
    # A supplied anonymized party such as P123 is not a page number.
    if re.fullmatch(r"\s*(?:(?:page|pages)\s*|(?:p|pp)\.\s+)\d+(?:\s*[-\u2013]\s*\d+)?\s*", value, re.I):
        return "page_reference"
    if re.fullmatch(r"\s*(?:(?:at\s+)?para(?:graph)?s?\.?\s+\d+(?:\s*[-\u2013]\s*\d+)?|at\s+para(?:graph)?s?\.)\.?\s*", value, re.I):
        return "paragraph_reference"
    if re.fullmatch(r"\s*at\s+pp?\.?\s+\d+(?:\s+and\s+pp?\.?\s+\d+(?:\s*[-\u2013]\s*\d+)?)?(?:\s+(?:[A-Z]\.){2,5})?\.?\s*", value, re.I):
        return "page_reference"
    if value.casefold().strip() in {"unreported", "not reported", "non publi\u00e9", "non publi\u00e9e", "in\u00e9dit", "in\u00e9dite"}:
        return "publication_status"
    if (re.fullmatch(r"\s*per\s+.+\s+(?:c?j\.?a?\.?|jj\.?)(?:\s+as\s+(?:he|she)\s+then\s+was)?\s*", value, re.I)
            or re.match(r"\s*rendu(?:e|s|es)?\s+par\s+(?:(?:le|la|les)\s+)?juges?\s+", value, re.I)
            or re.match(r"\s*(?:(?:par\s+(?:la\s+|le\s+)?)?juge|(?:le|la|les)\s+juges?|motifs\s+(?:du|de\s+la)\s+juge|sous\s+la\s+plume\s+du\s+juge)\s+", value, re.I)
            or re.fullmatch(r"\s*per\s+(?:(?:Mr\.?|Madam)\s+)?Justice\s+.+", value, re.I)
            or re.fullmatch(r"\s*per\s+.+\bJJA?\.?\s+(?:concurring|dissenting)\s*", value, re.I)):
        return "judge_attribution"
    if re.fullmatch(r"\s*(?:(?:additional|alternate|internal|other|parallel)\s+)?(?:citations?|references?|quotations?|footnotes?)\s+omitted[.\s]*", value, re.I):
        return "editorial_note"
    if re.fullmatch(r"\s*(?:(?:my|our)\s+emphasis|(?:underlining|italics?|bold)\s+added|soulign[ée]s?\s+dans\s+l['’]original)[.\s]*", value, re.I):
        return "editorial_note"
    return None


def caption_flag(value):
    """Recognize captured reasons and captions containing several opposing groups."""
    if not value:
        return None
    if not balanced_delimiters(value):
        return "malformed_delimiters"
    if len(words(value)) >= 14 and re.search(r"\b(?:was|were|because|however)\b", value, re.I):
        return "judgment_prose"
    if re.search(r"\bthis\s+is\s+(?:an?|the)\s+(?:application|appeal|petition|action)\b|"
                 r"\b(?:reasons|judgment)\s+(?:are\s+)?indexed\s+(?:as|at)\b|"
                 r"(?:^|\n)\s*\[\d{1,3}\]\s+[A-Z][a-z]+\s", value, re.I):
        return "judgment_prose"
    if re.search(r"^Vol\.\s*\d+\b|\b(?:Yes|No)\s+(?:Dismissed|Granted)\b|"
                 r"\bRespond\s*ing\s+Party\b|\([^()]{1,160}:\s*[^()]*,\s*\d{4}\)\s+\d+", value, re.I):
        return "captured_context"
    if (re.search(r";\s*[^;]*?\s+[vc]\.?\s+", value, re.I)
            or re.search(r"\s+[vc]\.?\s+.+?\s+[vc]\.?\s+", value)):
        return "multiple_proceedings"
    return None


def base_name_flag(value, parties):
    """Exclude document-local declarations from the isolated base-name task."""
    from party_alias import matches_party

    if not balanced_delimiters(value):
        return "malformed_delimiters"
    annotation = annotation_flag(value)
    if annotation:
        return annotation
    role_words = {"reasons", "ruling", "rulings", "judgment", "judgement", "decision", "order", "direction",
        "application", "motion", "appeal", "trial", "injunction", "settlement", "award", "rfj", "motifs", "jugement", "ordonnance"}
    # A malformed recovered caption can contain an entire paragraph of reasons.
    if any(caption_flag(party) in {"judgment_prose", "captured_context", "malformed_delimiters"} for party in parties):
        return "document_local_role" if set(words(value)) & role_words else "invalid_party_input"
    # Actual party names can contain words such as May, Trial or Decision.
    if any(party and matches_party(value, party) for party in parties):
        return None
    from mine import normalize
    if any(party and normalize(value) == normalize(party) for party in parties):
        return None
    if all(parties) and re.fullmatch(r"(?:[A-Za-z]{1,8}\.\s*){2,}", value.strip()) and normalize(value) in reporter_forms():
        return "reporter_reference"
    halves = re.split(r"\s+(?:v\.?|vs\.?|c\.?)\s+", value, flags=re.I)
    if len(halves) == 2 and all(party and matches_party(part, party)
                                for part, party in zip(halves, parties)):
        return None
    introduced = re.sub(r"^(?:l[\u2019']\s*)?(?:case|decision|d\u00e9cision|arr\u00eat|affaire)\s+", "", value, flags=re.I)
    if introduced != value and any(party and matches_party(introduced, party) for party in parties):
        return None
    if set(words(value)) & role_words:
        return "document_local_role"
    if re.fullmatch(r"\s*voir\s+dire\s+(?:(?:no\.?)\s*|#\s*)?\d+\s*", value, re.I):
        return "document_local_role"
    months = r"january|february|march|april|may|june|july|august|september|october|november|december|janvier|f\u00e9vrier|mars|avril|mai|juin|juillet|ao\u00fbt|septembre|octobre|novembre|d\u00e9cembre"
    if re.fullmatch(r"\s*(?:(?:\d{1,2}\s+)?(?:" + months + r")\s+\d{1,4}|\d{4}[-/]\d{1,2}[-/]\d{1,2})\s*", value, re.I):
        return "document_local_date"
    return None


def usable_alias(value):
    value = clean_alias(value)
    if not balanced_delimiters(value):
        return False
    ordered = words(value)
    tokens = {token for token in ordered if not token.isdigit()}
    if annotation_flag(value):
        return False
    if tokens and tokens <= {"la", "le", "les", "l", "du", "de", "première", "premier", "seconde",
            "deuxième", "troisième", "instance", "appel", "décision", "jugement", "arrêt", "motifs", "ordonnance"}:
        return False
    if tokens and tokens <= {"the", "of", "for", "and", "in", "a", "court", "trial", "appeal", "leave",
            "application", "tax", "merits", "main", "action", "underlying", "original", "prior", "subsequent",
            "first", "second", "third", "final", "interlocutory", "summary", "decision", "judgment",
            "reasons", "order", "majority", "dissent", "emphasis", "added"}:
        return False
    return bool(value) and reusable(value)
