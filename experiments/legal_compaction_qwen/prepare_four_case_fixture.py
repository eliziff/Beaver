"""Record a four-case post-cutoff fixture from the local A2AJ corpus."""

from __future__ import annotations

import json
from pathlib import Path

from harness import A2AJ_DB_DEFAULT, load_a2aj_case, load_case, CaseSpec


CASES = (
    (190682, "2026 SCC 13", "Quebec (Attorney General) v. Lalande"),
    (190469, "2026 SCC 18", "R. v. Saddleback"),
    (190687, "2026 SCC 9", "Riddle v. ivari"),
    (190675, "2026 SCC 19", "R. v. Vrbanic"),
)


def main() -> None:
    records = []
    for document_id, citation, name in CASES:
        source, url, ref = load_a2aj_case(A2AJ_DB_DEFAULT, document_id)
        spec = CaseSpec(
            doc_id=f"case-{document_id}",
            filename=f"{name} ({citation})",
            citation=citation,
            path=None,
            key_paragraphs=(),
            descriptors={},
            a2aj_document_id=document_id,
        )
        doc = load_case(spec, max_chars=72_000)
        records.append(
            {
                "a2aj_document_id": document_id,
                "citation": citation,
                "name": name,
                "source_ref": ref,
                "source_url": url,
                "source_chars": len(source),
                "packet_chars": len(doc.packet),
                "paragraphs_in_packet": [doc.paragraphs[0].number, doc.paragraphs[-1].number],
                "source_sha256": doc.source_sha256,
                "packet_sha256": doc.packet_sha256,
            }
        )
    output = {
        "experiment": "legal_compaction_qwen_four_case_post_cutoff",
        "context_limit": 32_768,
        "packet_cap_chars": 72_000,
        "selection_rule": "Each source is below the one-case packet budget; the four packets together exceed 32K tokens.",
        "knowledge_cutoff_rule": "All decisions are 2026 SCC decisions, after the dated model knowledge snapshots used for this experiment.",
        "cases": records,
        "combined_packet_chars": sum(item["packet_chars"] for item in records),
    }
    out = Path(__file__).with_name("four_case_fixture.json")
    out.write_text(json.dumps(output, indent=2) + "\n", encoding="utf-8")
    print(out)
    print(json.dumps({"combined_packet_chars": output["combined_packet_chars"], "cases": records}, indent=2))


if __name__ == "__main__":
    main()
