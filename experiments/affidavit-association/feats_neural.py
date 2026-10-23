"""Four reference contexts and complete file text for chunked association."""
import re
import numpy as np

BOILER = re.compile(r"\b(?:attached|annexed|appended|marked|produced|enclosed)\b(?:\s+(?:hereto|herewith|to\s+(?:this|my)\s+(?:\w+\s+)?affidavit))*(?:\s+(?:and|as))*(?:\s+marked)?(?:\s+as)?\s+exhibits?\s+\"?[A-Z0-9-]{1,5}\"?(?:\s+to\s+(?:this|my)\s+(?:\w+\s+)?affidavit)?|\b(?:is|are)\s+(?:a\s+)?(?:true\s+)?cop(?:y|ies)\s+of\b|\bcop(?:y|ies)\s+of\b|\bexhibits?\s+\"?[A-Z0-9-]{1,5}\"?", re.I)


def desc_of(c):
    s = c["item"] or c["main"]
    return re.sub(r"\s+", " ", BOILER.sub(" ", s)).strip(" .,;:")


def rrank(m, axis):
    r = (-m).argsort(axis).argsort(axis)
    return 1.0 / (1 + r)


def views(r):
    C = r["ctx"]
    refs = {"segb": [C[l]["seg"][0] for l in r["labels"]], "sega": [C[l]["seg"][1] for l in r["labels"]],
            "desc": [desc_of(C[l]) for l in r["labels"]], "para": [C[l]["paragraph"] for l in r["labels"]]}
    files = {"full": list(r["texts"])}
    return refs, files

