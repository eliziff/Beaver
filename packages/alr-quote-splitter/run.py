import dataclasses
import json
import sys

from deterministic_splitter import extract_fields, split_footnote_recall_first


def split(text):
    result = split_footnote_recall_first(text)
    offset = lambda value: len(text[:value].encode("utf-16-le")) // 2
    return {"status": result.status, "reasons": result.reasons,
            "parts": [{**dataclasses.asdict(part), "start": offset(part.start),
                       "end": offset(part.end), "fields": dataclasses.asdict(extract_fields(part))}
                      for part in result.parts],
            "delimiters": [[offset(start), offset(end), value]
                           for start, end, value in result.delimiters]}


if __name__ == "__main__":
    texts = json.load(sys.stdin)
    if not isinstance(texts, list) or any(not isinstance(text, str) for text in texts):
        raise ValueError("Expected an array of citation-unit strings")
    print(json.dumps([split(text) for text in texts], ensure_ascii=True))
