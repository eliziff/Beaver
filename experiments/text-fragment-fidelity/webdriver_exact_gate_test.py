#!/usr/bin/env python3
import importlib.util
import io
import inspect
import json
import os
import subprocess
import sys
import tempfile
from pathlib import Path


HERE = Path(__file__).resolve().parent
SPEC = importlib.util.spec_from_file_location("fragment_gate", HERE / "webdriver-exact-gate.py")
gate = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(gate)

assert gate.source_document_key({
    "dataset": "BCCA", "label": "BCCA_2008_BCCA_283_p85_short-exact",
}) == "2008_BCCA_283"
assert gate.source_document_key({
    "dataset": "LEGISLATION-AB",
    "label": "LEGISLATION-AB_RSA_2000_c_M-26_sec1(1)_short-exact",
}) == "RSA_2000_c_M-26"

page = gate.search_normalized(
    "In this Regulation les definitions suivent au présent règlement. "
    "“class A society”, in relation to a year."
)
block = "In this Regulation “ class A society ”, in relation to a year."
quote = "Regulation “ class A society ”, in relation to"
islands = gate.quote_islands([page], block, quote)
assert islands and len(islands) == 2, islands

right = "class%20A%20society%E2%80%9D%2C%20in%20relation%20to"
right_matches = gate.directive_matches([page], right)
assert len(right_matches) == 1, right_matches
assert gate.directive_matches([page], "class%20A%20society,-in%20relation%20to") == []

repeated = [
    gate.search_normalized("start first end; start second end"),
    gate.search_normalized("start third end"),
]
assert gate.directive_matches(repeated, "start,end") == [
    (0, 0, len("start first end")),
]
assert gate.directive_matches(["same words", "same words"], "same%20words") == [
    (0, 0, len("same words")),
]
assert gate.all_occurrences("concatenate cat category", "cat") == [(12, 15)]
assert gate.sequence_starts(["a", "a", "a"], ["a", "a"]) == [0, 1]
assert gate.sequence_starts(["a", "b"], []) == [0, 1, 2]
source_index = gate.source_token_index([
    {"word": word} for word in ["a", "a", "a", "b", "a", "b"]
])
for wanted in (["a", "a"], ["a", "b"], ["b", "a"], ["missing"], []):
    assert gate.indexed_sequence_starts(source_index, list(wanted)) == \
        gate.sequence_starts(source_index["values"], list(wanted))
assert gate.directive_matches([
    "prefix start without terminator",
    "prefix start final end",
], "prefix-,start,end") == [(1, len("prefix "), len("prefix start final end"))]
assert gate.search_normalized("Straße") != gate.search_normalized("STRASSE")
assert gate.SOURCE_LINE_LABEL.match("3 \u00e2\u20ac\u201c Invoice 079853")

selected = [
    {"span": islands[0]},
    {"span": right_matches[0]},
]
assert all(gate.spans_cover(island, selected) for island in islands)
assert not gate.spans_cover(islands[0], selected[1:])

punctuated = gate.search_normalized('before words â€œtarget wordsâ€ after words')
wanted = gate.quote_islands([punctuated], 'â€œtarget wordsâ€', 'â€œtarget wordsâ€')[0]
painted = (0, wanted[1] - 1, wanted[2] + 1)
assert gate.span_stays_within_words(painted, wanted, punctuated)
assert not gate.span_stays_within_words((0, 0, wanted[2]), wanted, punctuated)

duplicate_pages = [
    gate.search_normalized('appendix A to the Sahtu Dene and Metis Agreement entered into force'),
    gate.search_normalized('(iii) the Sahtu Dene and Metis Agreement entered into force'),
]
assert gate.quote_islands(
    duplicate_pages,
    '(iii) the Sahtu Dene and Metis Agreement entered into force',
    'Sahtu Dene and Metis Agreement entered',
)[0][0] == 1
deduplicated = gate.quote_islands(
    ["a a inserted b"], "a b", "a b",
)
assert deduplicated == [(0, 2, 3), (0, 13, 14)], deduplicated
same_context = " ".join(["same"] * 32)
context_page = gate.search_normalized(
    f"othermarker {same_context} target tail sourcemarker {same_context} target tail"
)
context_islands = gate.quote_islands(
    [context_page], f"sourcemarker {same_context} target tail", "target",
    source_identity={"before": ["same"] * 32, "after": ["tail"]},
)
assert context_islands[0][1] == context_page.rindex("target"), context_islands
tight_before_context = gate.quote_islands(
    ["unrelated words", "before alpha inserted beta after"],
    "before alpha beta after", "alpha beta",
    source_identity={"before": ["before"], "after": ["after"]},
)
assert tight_before_context == [
    (1, len("before "), len("before alpha")),
    (1, len("before alpha inserted "), len("before alpha inserted beta")),
], tight_before_context
duplicate_index = gate.pages_word_index(duplicate_pages)
assert gate.exact_word_sequence_starts(
    duplicate_index, ["sahtu", "dene", "and", "metis", "agreement", "entered"],
) == [4, 14]
assert gate.quote_islands(
    duplicate_pages,
    '(iii) the Sahtu Dene and Metis Agreement entered into force',
    'Sahtu Dene and Metis Agreement entered', document_index=duplicate_index,
) == gate.quote_islands(
    duplicate_pages,
    '(iii) the Sahtu Dene and Metis Agreement entered into force',
    'Sahtu Dene and Metis Agreement entered',
)
inserted_pages = ["before alpha publisher inserted beta after"]
inserted_index = gate.pages_word_index(inserted_pages)
assert gate.exact_word_sequence_starts(inserted_index, ["alpha", "beta"]) == []
assert gate.quote_islands(
    inserted_pages, "before alpha beta after", "alpha beta",
    source_identity={"before": ["before"], "after": ["after"]},
    document_index=inserted_index,
) == gate.quote_islands(
    inserted_pages, "before alpha beta after", "alpha beta",
    source_identity={"before": ["before"], "after": ["after"]},
)
anchored_duplicate = gate.quote_islands(
    ["before alpha beta after", "before alpha beta after"],
    "before alpha beta after", "alpha beta", preferred_page=1,
)
assert anchored_duplicate == [(1, len("before "), len("before alpha beta"))], anchored_duplicate

quote_proofs = [{"wordStart": 10, "wordEnd": 20}]
assert gate.range_probe_verdict(quote_proofs, [
    {"status": "matched", "wordStart": 10, "wordEnd": 15},
    {"status": "matched", "wordStart": 15, "wordEnd": 20},
]) == "range-exact"
assert gate.range_probe_verdict(quote_proofs, [
    {"status": "matched", "wordStart": 11, "wordEnd": 20},
]) == "range-partial"
assert gate.range_probe_verdict(quote_proofs, [
    {"status": "matched", "wordStart": 9, "wordEnd": 20},
]) == "range-stray"
exact_quote_proofs = [{"status": "located", "wordStart": 10, "wordEnd": 20}]
assert gate.one_to_one_range_verdict(exact_quote_proofs, [
    {"status": "matched", "wordStart": 10, "wordEnd": 20},
]) == "range-exact"
assert gate.one_to_one_range_verdict(exact_quote_proofs, [
    {"status": "matched", "wordStart": 10, "wordEnd": 19},
]) == "range-source-interval-mismatch"
assert gate.lexically_exact_edge_paint(
    [{"status": "paint-extraneous", "insertedWords": 0, "wordStart": 4,
      "wordEnd": 9, "wordIslands": [(4, 9)]}],
)
assert not gate.lexically_exact_edge_paint(
    [{"status": "paint-extraneous", "insertedWords": 1, "wordStart": 4,
      "wordEnd": 10, "wordIslands": [(4, 9)]}],
)
assert not gate.lexically_exact_edge_paint([])
assert gate.html_real_paint_verdict([{
    "verdict": "exact-match", "rangeVerdict": "range-source-interval-mismatch",
}]) == "exact-match"
assert gate.html_real_paint_verdict([
    {"verdict": "exact-match", "rangeVerdict": "range-exact"},
    {"verdict": "paint-extraneous", "rangeVerdict": "range-exact"},
]) == "paint-extraneous"

isolation_seed = {
    "target": "https://example.test/page#:~:text=Alpha%20beta&text=Gamma,delta",
    "paintQuotes": ["Alpha beta", "Gamma through delta"],
    "sourceWordIntervals": [
        {"quoteIndex": 0, "firstWord": 1, "lastWord": 2},
        {"quoteIndex": 0, "firstWord": 3, "lastWord": 5},
    ],
}
isolation_plan = gate.html_isolation_plan(isolation_seed)
assert isolation_plan["status"] == "ready", isolation_plan
assert [item["target"] for item in isolation_plan["items"]] == [
    "https://example.test/page#:~:text=Alpha%20beta",
    "https://example.test/page#:~:text=Gamma,delta",
]
assert [item["sourceInterval"] for item in isolation_plan["items"]] == \
    isolation_seed["sourceWordIntervals"]
assert gate.html_isolation_plan({
    **isolation_seed, "paintQuotes": ["Alpha beta"],
})["status"] == "html-isolation-cardinality-mismatch"

top_landing = gate.html_initial_viewport_proof({
    "status": "located", "scrollY": 0, "innerHeight": 100,
    "documentRects": [{"y": 0, "height": 20}],
})
assert top_landing["status"] == "initial-viewport-exact"
assert top_landing["topOfDocument"]
assert gate.html_initial_viewport_proof({
    "status": "located", "scrollY": 0, "innerHeight": 100,
    "documentRects": [{"y": 150, "height": 20}],
})["status"] == "initial-viewport-missed-passage"


def html_test_png(painted):
    image = gate.Image.new("RGB", (80, 60), "white")
    if painted:
        gate.ImageDraw.Draw(image).rectangle((10, 10, 40, 20), fill=(0, 255, 0))
    output = gate.io.BytesIO()
    image.save(output, format="PNG")
    return output.getvalue()


class FakeAsyncHtmlDriver:
    def __init__(self, screenshots):
        self.screenshots = list(screenshots)
        self.screenshot_calls = 0

    def get_screenshot_as_png(self):
        screenshot = self.screenshots[min(self.screenshot_calls, len(self.screenshots) - 1)]
        self.screenshot_calls += 1
        return screenshot

    def execute_script(self, script, *_args):
        if script.startswith("return {scrollY"):
            return {"scrollY": 0, "innerHeight": 60}
        return {
            "quotes": [{
                "status": "located", "scrollY": 0, "innerHeight": 60,
                "documentTop": 10,
                "documentRects": [{"x": 10, "y": 10, "width": 30, "height": 10}],
                "wordStart": 1, "wordEnd": 3,
            }],
            "ranges": [{"status": "matched", "wordStart": 0, "wordEnd": 3}],
        }


blank_png = html_test_png(False)
painted_png = html_test_png(True)
initial_driver = FakeAsyncHtmlDriver([blank_png, painted_png])
_probe, initial_paint, _image = gate.initial_html_target_proof(
    initial_driver, ["Alpha beta"], {"blockText": "", "anchor": ""},
    {}, retry_delays=(0,),
)
assert initial_driver.screenshot_calls == 2
assert initial_paint["status"] == "initial-viewport-exact", initial_paint
assert initial_paint["attempts"] == 2 and initial_paint["waitMs"] == 0

coverage_driver = FakeAsyncHtmlDriver([blank_png, painted_png])
_png, _image, paint_metrics = gate.capture_html_highlight(
    coverage_driver,
    [{"x": 10, "y": 10, "width": 30, "height": 10}],
    [{"x": 10, "y": 10, "width": 30, "height": 10}],
    {}, retry_delays=(0,),
)
assert coverage_driver.screenshot_calls == 2
assert paint_metrics["paintAttempts"] == 2 and paint_metrics["paintWaitMs"] == 0
assert gate.html_geometry_status(paint_metrics) == "exact-match", paint_metrics
assert "const resolve" not in gate.QUOTE_BATCH_SCRIPT


def long_range_png():
    image = gate.Image.new("RGB", (100, 100), "white")
    gate.ImageDraw.Draw(image).rectangle((10, 50, 50, 60), fill=(0, 255, 0))
    output = gate.io.BytesIO()
    image.save(output, format="PNG")
    return output.getvalue()


class FakeLongRangeDriver:
    def __init__(self):
        self.scroll_y = 0
        self.gets = []

    def get(self, target):
        self.gets.append(target)
        self.scroll_y = 0

    def get_screenshot_as_png(self):
        return long_range_png()

    def execute_script(self, script, *args):
        if script.startswith("return {scrollY"):
            return {"scrollY": self.scroll_y, "innerHeight": 100}
        if script.startswith("window.scrollTo"):
            self.scroll_y = max(0, args[0] - 50)
            return self.scroll_y
        return {"quotes": [{
            "status": "located", "scrollY": self.scroll_y, "innerHeight": 100,
            "documentTop": 50,
            "documentRects": [
                {"x": 10, "y": 50, "width": 40, "height": 10},
                {"x": 10, "y": 300, "width": 40, "height": 10},
            ],
            "wordStart": 1, "wordEnd": 20,
        }]}


long_driver = FakeLongRangeDriver()
long_proof, _image = gate.html_navigation_paint_proof(
    long_driver, "http://127.0.0.1/page#:~:text=Alpha,Omega", ["Alpha through Omega"],
    {"label": "TEST_long", "blockText": "", "anchor": ""}, {}, "isolated-0", False,
)
assert long_driver.gets == [
    "http://127.0.0.1/page?proof=isolated-0#:~:text=Alpha,Omega",
]
assert long_proof["verdict"] == "exact-match", long_proof
assert long_proof["rangeVerdict"] == "diagnostic-skipped-window-find"
assert [capture["position"] for capture in long_proof["quotes"][0]["paintCaptures"]] == [
    "start", "end",
]
assert min(long_proof["quotes"][0]["endpointHighlightPixels"]) >= 10
assert gate.html_end_needs_own_capture([
    {"y": 50, "height": 10}, {"y": 300, "height": 10},
], 0, 100)
assert not gate.html_end_needs_own_capture([
    {"y": 50, "height": 10}, {"y": 80, "height": 10},
], 0, 100)

combined = gate.combined_pdf_geometries(
    [{"span": (0, 0, 5)}, {"span": (0, 8, 12)}, {"span": (1, 0, 4)}],
    {
        (0, 0, 5): {"pageSize": [100, 200], "lineBounds": [[10, 170, 30, 180]]},
        (0, 8, 12): {"pageSize": [100, 200], "lineBounds": [[15, 140, 40, 150]]},
        (1, 0, 4): {"pageSize": [100, 200], "lineBounds": [[20, 160, 45, 170]]},
    },
)
assert list(combined) == [1, 2]
assert combined[1]["directivesOnPage"] == 2
assert len(combined[1]["lineBounds"]) == 2
assert combined[2]["directivesOnPage"] == 1

single_page_groups = [[(0, 0, 5), (0, 8, 12)], [(1, 0, 4)]]
assert gate.pdf_single_page_intended_groups({
    "intendedGroups": single_page_groups,
}) == single_page_groups
assert gate.pdf_single_page_intended_groups({
    "intendedGroups": [[(0, 0, 5), (1, 0, 4)]],
}) is None
assert gate.pdf_directive_union_verdict(single_page_groups, [
    {"status": "exact", "provedSpans": [(0, 0, 5), (0, 8, 12)]},
    {"status": "exact", "provedSpans": [(1, 0, 4)]},
]) == "exact-match"
assert gate.pdf_directive_union_verdict(single_page_groups, [
    {"status": "exact", "provedSpans": [(0, 0, 5), (0, 8, 12)]},
    {"status": "exact", "provedSpans": [(1, 1, 4)]},
]) == "pdf-directive-union-mismatch"
assert gate.pdf_reuses_combined_navigation(1, "exact")
assert not gate.pdf_reuses_combined_navigation(2, "exact")
assert not gate.pdf_reuses_combined_navigation(1, "pdf-combined-fragment-lost")

assert "allow_subset" not in inspect.signature(gate.pdf_paint_geometry_proof).parameters
subset = gate.pdf_paint_geometry_proof(
    {"components": [{"pixels": 5, "bounds": [10, 10, 20, 20]}], "deltaPixels": 5},
    gate.Image.new("RGB", (100, 100), "white"),
    {"pageSize": [100, 100], "lineBounds": [[10, 10, 20, 20], [10, 30, 20, 40]]},
)
assert subset["status"] == "pdf-paint-geometry-mismatch"

expected_line = {"pageSize": [100, 100], "lineBounds": [[10, 70, 30, 80]]}
right_line = gate.pdf_paint_geometry_proof(
    {"components": [{"pixels": 5, "bounds": [10, 20, 30, 30]}], "deltaPixels": 5},
    gate.Image.new("RGB", (100, 100), "white"), expected_line,
)
assert right_line["status"] == "pdf-paint-geometry-exact", right_line
wrong_line = gate.pdf_paint_geometry_proof(
    {"components": [{"pixels": 5, "bounds": [10, 50, 30, 60]}], "deltaPixels": 5},
    gate.Image.new("RGB", (100, 100), "white"), expected_line,
)
assert wrong_line["status"] == "pdf-paint-geometry-mismatch", wrong_line
rgb_control = gate.Image.new("RGB", (100, 100), "white")
rgb_painted = rgb_control.copy()
gate.ImageDraw.Draw(rgb_painted).rectangle((10, 20, 30, 30), fill=(190, 170, 210))
assert gate.mask_count(gate.target_mask(rgb_painted, "pdf")) == 0
rgb_mask = gate.rgb_delta_mask(rgb_painted, rgb_control)
rgb_geometry = gate.pdf_paint_geometry_proof(
    {"components": [], "deltaMethod": "rgb-control-delta"},
    rgb_painted, expected_line, rgb_mask,
)
assert rgb_geometry["status"] == "pdf-paint-geometry-exact", rgb_geometry


class NoisyPdfDriver:
    def __init__(self, images):
        self.images = iter(images)

    def get_screenshot_as_png(self):
        output = io.BytesIO()
        next(self.images).save(output, format="PNG")
        return output.getvalue()


target_control = gate.Image.new("RGB", (100, 100), "white")
noisy_frames = []
for noise_bounds in ((50, 50, 55, 55), (70, 70, 75, 75)):
    frame = target_control.copy()
    draw = gate.ImageDraw.Draw(frame)
    draw.rectangle((10, 20, 30, 30), fill=(230, 210, 250))
    draw.rectangle(noise_bounds, fill="black")
    noisy_frames.append(frame)
target_delta, _, _, _ = gate.stable_highlight_delta(
    NoisyPdfDriver(noisy_frames),
    gate.target_mask(target_control, "pdf"),
    target_control,
    1,
    {},
)
assert target_delta["status"] == "stable-delta", target_delta
assert target_delta["deltaMethod"] == "target-color-delta", target_delta

document = "[48] Alpha beta gamma"
document_words = gate.source_words(document)
assert gate.source_words("😀 Alpha")[0]["utf16Start"] == 3
for labelled in ("[48] Alpha", "48] Alpha", "58.1(3)(a) Alpha", "(a) Alpha"):
    labelled_words = gate.source_words(labelled)
    alpha_index = next(index for index, word in enumerate(labelled_words)
                       if word["word"] == "alpha")
    assert all(gate.source_line_label_reason(labelled, labelled_words, index)
               for index in range(alpha_index)), labelled
    assert all(gate.source_quote_label_reason(labelled, labelled_words, index)
               for index in range(alpha_index)), labelled
    assert gate.source_line_label_reason(labelled, labelled_words, alpha_index) is None
    assert gate.source_quote_label_reason(labelled, labelled_words, alpha_index) is None
for ordinary, index in (
    ("2024 people agreed", 0),
    ("Section 12 applies", 1),
    ("58.1 percent was paid", 0),
    ("58.1 percent was paid", 1),
    ("Clause (a) remains prose", 1),
):
    ordinary_words = gate.source_words(ordinary)
    assert gate.source_line_label_reason(ordinary, ordinary_words, index) is None, ordinary
    assert gate.source_quote_label_reason(ordinary, ordinary_words, index) is None, ordinary

complete_seed = {
    "label": "TEST_1_p1_exact", "dataset": "TEST", "quotes": [document],
    "paintQuotes": ["Alpha beta gamma"],
    "sourceWordIntervals": [{
        "quoteIndex": 0, "start": document_words[1]["start"],
        "end": document_words[3]["end"], "firstWord": 1, "lastWord": 3,
    }],
    "sourceSafeComplete": True, "paintedWords": 3,
    "target": "https://example.test/#:~:text=Alpha,gamma",
}
complete_contract = gate.canonical_source_contract(complete_seed, document, False)
assert complete_contract["accepted"], complete_contract
omitted_seed = {
    **complete_seed,
    "paintQuotes": ["Alpha beta"],
    "sourceWordIntervals": [{
        "quoteIndex": 0, "start": document_words[1]["start"],
        "end": document_words[2]["end"], "firstWord": 1, "lastWord": 2,
    }],
    "paintedWords": 2,
}
omitted_contract = gate.canonical_source_contract(omitted_seed, document, False)
assert not omitted_contract["accepted"]
assert omitted_contract["unacceptedOmissions"] == [{
    "quoteIndex": 0, "tokenIndex": 3, "token": "gamma",
    "reason": "unclassified-substantive",
}]

ordinary_document = "Preamble 12 ordinary words"
ordinary_words = gate.source_words(ordinary_document)
ordinary_seed = {
    "label": "TEST_ordinary", "dataset": "TEST", "quotes": ["12 ordinary words"],
    "paintQuotes": ["ordinary words"],
    "sourceWordIntervals": [{
        "quoteIndex": 0, "start": ordinary_words[2]["utf16Start"],
        "end": ordinary_words[3]["utf16End"], "firstWord": 2, "lastWord": 3,
    }],
    "sourceSafeComplete": True, "paintedWords": 2,
    "target": "https://example.test/#:~:text=ordinary%20words",
}
ordinary_contract = gate.canonical_source_contract(
    ordinary_seed, ordinary_document, False,
)
assert ordinary_contract["unacceptedOmissions"] == [{
    "quoteIndex": 0, "tokenIndex": 0, "token": "12",
    "reason": "unclassified-substantive",
}], ordinary_contract

raw_label_document = "Preamble [48] Alpha beta"
raw_label_words = gate.source_words(raw_label_document)
raw_label_seed = {
    "label": "TEST_raw_label", "dataset": "TEST", "quotes": ["[48] Alpha beta"],
    "paintQuotes": ["Alpha beta"],
    "sourceWordIntervals": [{
        "quoteIndex": 0, "start": raw_label_words[2]["utf16Start"],
        "end": raw_label_words[3]["utf16End"], "firstWord": 2, "lastWord": 3,
    }],
    "sourceSafeComplete": True, "paintedWords": 2,
    "target": "https://example.test/#:~:text=Alpha%20beta",
}
raw_label_contract = gate.canonical_source_contract(
    raw_label_seed, raw_label_document, False,
)
assert raw_label_contract["accepted"], raw_label_contract
assert raw_label_contract["omitted"] == [{
    "quoteIndex": 0, "tokenIndex": 0, "token": "48",
    "reason": "line-start-furniture",
}]

overlap_seed = {
    **complete_seed,
    "paintQuotes": ["Alpha beta", "beta gamma"],
    "sourceWordIntervals": [
        {"quoteIndex": 0, "start": document_words[1]["utf16Start"],
         "end": document_words[2]["utf16End"], "firstWord": 1, "lastWord": 2},
        {"quoteIndex": 0, "start": document_words[2]["utf16Start"],
         "end": document_words[3]["utf16End"], "firstWord": 2, "lastWord": 3},
    ],
    "paintedWords": 3,
    "target": "https://example.test/#:~:text=Alpha,beta&text=beta,gamma",
}
overlap_contract = gate.canonical_source_contract(overlap_seed, document, False)
assert overlap_contract["accepted"], overlap_contract
assert overlap_contract["paintedWords"] == 3

signature = "at Ottawa Canada this 26th day of September 2011 Real Favreau Favreau J"
signature_core = "CITATION 2011 TCC 418 COURT FILE Apostle"
signature_document = f"{signature} OLD RECORD\n{signature} {signature_core}"
signature_words = gate.source_words(signature_document)
signature_quote = f"{signature} {signature_core}"
core_first = next(index for index, item in enumerate(signature_words)
                  if item["word"] == "citation")
paint_first = core_first + 1
signature_seed = {
    "label": "TEST_3_p1_exact", "dataset": "TEST", "quotes": [signature_quote],
    "paintQuotes": ["2011 TCC 418 COURT FILE Apostle"],
    "sourceWordIntervals": [{
        "quoteIndex": 0, "start": signature_words[paint_first]["utf16Start"],
        "end": signature_words[-1]["utf16End"],
        "firstWord": paint_first, "lastWord": len(signature_words) - 1,
    }],
    "sourceSafeComplete": True,
    "paintedWords": len(signature_words) - paint_first,
    "target": "https://example.test/#:~:text=2011,Apostle",
}
signature_contract = gate.canonical_source_contract(
    signature_seed, signature_document, True,
)
assert signature_contract["accepted"], signature_contract
assert {item["reason"] for item in signature_contract["omitted"]} == {
    "duplicate-signature-metadata",
}

seam_document = "Alpha\nbeta gamma"
seam_words = gate.source_words(seam_document)
seam_seed = {
    "label": "TEST_2_p1_exact", "dataset": "TEST", "quotes": [seam_document],
    "paintQuotes": ["Alpha", "gamma"],
    "sourceWordIntervals": [
        {"quoteIndex": 0, "start": seam_words[0]["utf16Start"],
         "end": seam_words[0]["utf16End"], "firstWord": 0, "lastWord": 0},
        {"quoteIndex": 0, "start": seam_words[2]["utf16Start"],
         "end": seam_words[2]["utf16End"], "firstWord": 2, "lastWord": 2},
    ],
    "sourceSafeComplete": True, "paintedWords": 2,
    "target": "https://example.test/#:~:text=Alpha&text=gamma",
}
seam_contract = gate.canonical_source_contract(seam_seed, seam_document, True)
assert not seam_contract["accepted"], seam_contract
assert seam_contract["status"] == "source-coverage-unaccepted-omission"
assert seam_contract["unacceptedOmissions"] == [{
    "quoteIndex": 0, "tokenIndex": 1, "token": "beta",
    "reason": "pdf-extraction-line-seam",
}]


assert gate.PDF_PAINT_CONTRACT.endswith("-v13-source-identity")
assert gate.HTML_PAINT_CONTRACT.endswith("-v15-source-identity")
for viewer_script in (
    gate.PDF_VIEWER_STATUS_SCRIPT,
    gate.PDF_NATURAL_VIEWPORT_SCRIPT,
    gate.PDF_PAGE_STATE_SCRIPT,
):
    assert "window.viewer || document.querySelector('pdf-viewer')" in viewer_script
    assert "viewer.loaded" in viewer_script
    assert "documentDimensions" in viewer_script
for viewer_helper in (
    gate.wait_pdf_viewer,
    gate.stable_natural_pdf_highlight,
    gate.wait_pdf_page,
):
    assert "execute_script" not in inspect.getsource(viewer_helper)


class ReadyPdfOopif:
    def evaluate(self, script):
        assert script == gate.PDF_VIEWER_STATUS_SCRIPT
        return {
            "status": "ready", "size": {"width": 480, "height": 520},
            "documentDimensions": {"width": 480, "height": 1200},
        }


assert gate.wait_pdf_viewer(ReadyPdfOopif(), 0.1, {})["status"] == "ready"


class FakeChromeDriver:
    capabilities = {
        "goog:chromeOptions": {"debuggerAddress": "localhost:9222"},
    }


class ScriptedWebSocket:
    def __init__(self, target_ids=("pdf-frame",)):
        self.target_ids = list(target_ids)
        self.target_index = 0
        self.messages = []
        self.responses = []
        self.closed = False

    def send(self, raw_message):
        message = json.loads(raw_message)
        self.messages.append(message)
        method = message["method"]
        if method == "Target.getTargets":
            target_id = self.target_ids[min(self.target_index, len(self.target_ids) - 1)]
            self.target_index += 1
            result = {"targetInfos": [
                {"targetId": "outer", "type": "page", "url": "https://example.test/"},
                {"targetId": target_id, "type": "iframe",
                 "url": gate.PDF_VIEWER_URL + "?stream=1"},
            ]}
        elif method == "Target.attachToTarget":
            assert message["params"]["flatten"] is True
            result = {"sessionId": "session-" + message["params"]["targetId"]}
        elif method == "Runtime.evaluate":
            assert message["sessionId"].startswith("session-pdf-")
            assert message["params"]["awaitPromise"] is True
            assert message["params"]["returnByValue"] is True
            result = {"result": {"type": "object", "value": {"status": "ready"}}}
        else:
            raise AssertionError(method)
        # Target events and unrelated responses may arrive before our response.
        self.responses.extend((
            json.dumps({"method": "Target.targetInfoChanged", "params": {}}),
            json.dumps({"id": message["id"] + 1000, "result": {}}),
            json.dumps({"id": message["id"], "result": result}),
        ))

    def recv(self):
        return self.responses.pop(0)

    def close(self):
        self.closed = True


def fake_version(address):
    assert address == "localhost:9222"
    return {"webSocketDebuggerUrl": "ws://localhost:9222/devtools/browser/test"}


assert gate.PdfOopifCdp.select_target([
    {"targetId": "page", "type": "page", "url": "https://example.test/"},
    {"targetId": "pdf", "type": "iframe", "url": gate.PDF_VIEWER_URL},
])["targetId"] == "pdf"
for targets in ([], [
    {"targetId": str(index), "type": "iframe", "url": gate.PDF_VIEWER_URL}
    for index in range(2)
]):
    try:
        gate.PdfOopifCdp.select_target(targets)
    except gate.PdfOopifTargetUnavailable:
        pass
    else:
        raise AssertionError("non-unique PDF target was accepted")

socket = ScriptedWebSocket()
bridge = gate.PdfOopifCdp(
    FakeChromeDriver(), version_loader=fake_version,
    websocket_factory=lambda _url, **_options: socket,
)
assert bridge.evaluate("return {status: arguments[0]};", "ready") == {"status": "ready"}
assert bridge.evaluate("return {status: 'again'};") == {"status": "ready"}
attach_messages = [message for message in socket.messages
                   if message["method"] == "Target.attachToTarget"]
runtime_messages = [message for message in socket.messages
                    if message["method"] == "Runtime.evaluate"]
assert len(attach_messages) == 1
assert [message["sessionId"] for message in runtime_messages] == [
    "session-pdf-frame", "session-pdf-frame",
]
assert '"ready"' in runtime_messages[0]["params"]["expression"]
bridge.close()
assert socket.closed

replacement_socket = ScriptedWebSocket(("pdf-first", "pdf-second"))
replacement_bridge = gate.PdfOopifCdp(
    FakeChromeDriver(), version_loader=fake_version,
    websocket_factory=lambda _url, **_options: replacement_socket,
)
replacement_bridge.evaluate("return {status: 'first'};")
replacement_bridge.evaluate("return {status: 'second'};")
assert [message["params"]["targetId"] for message in replacement_socket.messages
        if message["method"] == "Target.attachToTarget"] == ["pdf-first", "pdf-second"]
assert [message["sessionId"] for message in replacement_socket.messages
        if message["method"] == "Runtime.evaluate"] == [
            "session-pdf-first", "session-pdf-second",
        ]
replacement_bridge.close()


class BrokenWebSocket(ScriptedWebSocket):
    def recv(self):
        raise OSError("connection reset")


broken_socket = BrokenWebSocket()
reconnected_socket = ScriptedWebSocket()
connections = iter((broken_socket, reconnected_socket))
reconnecting_bridge = gate.PdfOopifCdp(
    FakeChromeDriver(), version_loader=fake_version,
    websocket_factory=lambda _url, **_options: next(connections),
)
assert reconnecting_bridge.evaluate("return {status: 'ready'};") == {"status": "ready"}
assert broken_socket.closed
reconnecting_bridge.close()
assert reconnected_socket.closed

session_events = []


class FakeSessionProcess:
    returncode = None

    def poll(self):
        return self.returncode


class FakeSessionService:
    def __init__(self):
        self.process = FakeSessionProcess()

    def stop(self):
        session_events.append("service-stopped")
        self.process.returncode = 0


class FakeSessionDriver:
    def quit(self):
        session_events.append("driver-quit")


class FakeSessionBridge:
    def close(self):
        session_events.append("bridge-closed")


original_service = gate.Service
original_chrome = gate.webdriver.Chrome
original_bridge = gate.PdfOopifCdp
original_stop_tree = gate.stop_process_tree
try:
    fake_service = FakeSessionService()
    fake_driver = FakeSessionDriver()
    fake_bridge = FakeSessionBridge()
    gate.Service = lambda _path: fake_service
    gate.webdriver.Chrome = lambda **_options: fake_driver
    gate.PdfOopifCdp = lambda _driver: fake_bridge
    gate.stop_process_tree = lambda process: session_events.append(
        "tree-stopped" if process is fake_service.process else "wrong-tree"
    )
    with gate.chrome_session(object()) as session:
        assert session[0] is fake_driver and session[2] is fake_bridge
finally:
    gate.Service = original_service
    gate.webdriver.Chrome = original_chrome
    gate.PdfOopifCdp = original_bridge
    gate.stop_process_tree = original_stop_tree
assert session_events == ["bridge-closed", "driver-quit", "service-stopped"]

session_events.clear()
try:
    fake_service = FakeSessionService()
    fake_driver = FakeSessionDriver()
    gate.Service = lambda _path: fake_service
    gate.webdriver.Chrome = lambda **_options: fake_driver
    gate.PdfOopifCdp = lambda _driver: FakeSessionBridge()
    def failed_quit():
        session_events.append("driver-quit")
        raise RuntimeError("session already gone")
    def failed_service_stop():
        session_events.append("service-stopped")
        raise RuntimeError("service already gone")
    fake_driver.quit = failed_quit
    fake_service.stop = failed_service_stop
    def stop_exact_process(process):
        assert process is fake_service.process
        session_events.append("tree-stopped")
        process.returncode = 0
    gate.stop_process_tree = stop_exact_process
    with gate.chrome_session(object()):
        pass
finally:
    gate.Service = original_service
    gate.webdriver.Chrome = original_chrome
    gate.PdfOopifCdp = original_bridge
    gate.stop_process_tree = original_stop_tree
assert session_events == [
    "bridge-closed", "driver-quit", "service-stopped", "tree-stopped",
]


natural_image = gate.Image.new("RGB", (100, 100), "white")
gate.ImageDraw.Draw(natural_image).rectangle((10, 20, 30, 30), fill=(230, 205, 250))
natural_png = gate.io.BytesIO()
natural_image.save(natural_png, format="PNG")
natural_viewport = {
    "status": "ready", "currentPage": 1,
    "position": {"x": 0, "y": 70},
    "size": {"width": 100, "height": 100},
    "pageRects": {"1": {"x": 0, "y": 0, "width": 100, "height": 100}},
}


class FakeNaturalPdfDriver:
    def __init__(self):
        self.screenshot_calls = 0

    def get_screenshot_as_png(self):
        self.screenshot_calls += 1
        return natural_png.getvalue()


class FakeNaturalPdfOopif:
    def __init__(self):
        self.calls = []

    def evaluate(self, script, pages):
        self.calls.append((script, pages))
        return natural_viewport


assert "fitToPage" not in gate.PDF_NATURAL_VIEWPORT_SCRIPT
assert "goToPage" not in gate.PDF_NATURAL_VIEWPORT_SCRIPT
natural_driver = FakeNaturalPdfDriver()
natural_oopif = FakeNaturalPdfOopif()
natural_paint, _png, captured_image = gate.stable_natural_pdf_highlight(
    natural_driver, natural_oopif, 1, [1], 0.2, {},
)
assert natural_paint["status"] == "stable-highlight", natural_paint
assert natural_oopif.calls and natural_driver.screenshot_calls >= 2
natural_geometry = gate.pdf_natural_landing_geometry_proof(
    natural_paint, captured_image, {1: expected_line}, natural_viewport, 1, expected_line,
)
assert natural_geometry["status"] == "pdf-natural-landing-geometry-exact", natural_geometry
two_lines = {
    **expected_line,
    "lineBounds": [*expected_line["lineBounds"], [10, 50, 30, 60]],
}
missing_second_line = gate.pdf_natural_landing_geometry_proof(
    natural_paint, captured_image, {1: two_lines}, natural_viewport, 1, two_lines,
)
assert missing_second_line["status"] == "pdf-natural-target-geometry-mismatch", missing_second_line
extraneous_natural_image = natural_image.copy()
gate.ImageDraw.Draw(extraneous_natural_image).rectangle(
    (70, 70, 80, 80), fill=(230, 205, 250),
)
extraneous_natural = gate.pdf_natural_landing_geometry_proof(
    natural_paint, extraneous_natural_image, {1: expected_line},
    natural_viewport, 1, expected_line,
)
assert extraneous_natural["status"] == "pdf-natural-paint-geometry-extraneous", \
    extraneous_natural
assert gate.pdf_combined_verdict("exact", "pdf-location-exact") == "exact-match"
assert gate.pdf_combined_verdict("exact", "pdf-directive-extraneous") == \
    "pdf-directive-extraneous"

island_seed = {
    "blockText": "alpha beta gamma",
    "paintQuotes": ["alpha beta gamma"],
    "target": "https://example.test/#:~:text=alpha&text=beta%20gamma",
}
island_quotes, island_ranges = gate.cached_text_range_proof(
    "alpha publisher inserted beta gamma", island_seed,
)
assert island_quotes[0]["wordIslands"] == [(0, 1), (3, 5)], island_quotes
assert gate.range_probe_verdict(island_quotes, island_ranges) == "range-exact"
stray_quotes, stray_ranges = gate.cached_text_range_proof(
    "alpha publisher inserted beta gamma",
    {**island_seed, "target": "https://example.test/#:~:text=alpha,gamma"},
)
assert gate.range_probe_verdict(stray_quotes, stray_ranges) == "range-stray"
addition_seed = {
    "blockText": "relief sought in addition appellant in this appeal",
    "paintQuotes": ["addition appellant in"],
    "target": "https://example.test/#:~:text=addition,appellant%20in",
}
addition_index = gate.rendered_document_index(
    "The relief sought, in addition, appellant in this appeal was narrow.",
)
addition_quotes, addition_ranges = gate.cached_text_range_proof(
    addition_index, addition_seed,
)
assert addition_quotes[0]["wordIslands"] == [(4, 7)], addition_quotes
assert addition_ranges[0]["wordStart"] == 4, addition_ranges
assert addition_ranges[0]["wordEnd"] == 7, addition_ranges
assert gate.range_probe_verdict(addition_quotes, addition_ranges) == "range-exact"
with tempfile.TemporaryDirectory() as directory:
    directory = Path(directory)
    source_dir = directory / "source-contracts"
    contract_seed = {
        "target": "https://example.test/#:~:text=alpha",
        "paintQuotes": ["alpha"], "quotes": ["alpha beta"],
        "sourceWordIntervals": [{"quoteIndex": 0, "start": 0, "end": 5,
                                  "firstWord": 0, "lastWord": 0}],
        "paintedWords": 1, "sourceSafeComplete": True, "dataset": "TEST",
    }
    identity = gate.source_contract_cache_identity(contract_seed, "alpha beta", False)
    gate.write_source_contract_cache(identity, {"status": "proved", "accepted": True}, source_dir)
    assert gate.read_source_contract_cache(identity, source_dir) == {
        "status": "proved", "accepted": True,
    }
    changed = [
        gate.source_contract_cache_identity(
            {**contract_seed, "quotes": ["alpha gamma"]}, "alpha beta", False,
        ),
        gate.source_contract_cache_identity(
            {**contract_seed, "target": "https://example.test/#:~:text=beta"},
            "alpha beta", False,
        ),
        gate.source_contract_cache_identity({
            **contract_seed,
            "sourceWordIntervals": [{"quoteIndex": 0, "start": 6, "end": 10,
                                      "firstWord": 1, "lastWord": 1}],
        }, "alpha beta", False),
        gate.source_contract_cache_identity(contract_seed, "alpha gamma", False),
    ]
    original_source_contract_version = gate.SOURCE_CONTRACT_CACHE_VERSION
    gate.SOURCE_CONTRACT_CACHE_VERSION = original_source_contract_version + "-changed"
    try:
        changed.append(gate.source_contract_cache_identity(
            contract_seed, "alpha beta", False,
        ))
    finally:
        gate.SOURCE_CONTRACT_CACHE_VERSION = original_source_contract_version
    assert all(item["fingerprint"] != identity["fingerprint"] for item in changed)
    assert all(gate.read_source_contract_cache(item, source_dir) is None for item in changed)
    source_cache_file = next(source_dir.iterdir())
    source_cache_file.write_text("{broken", encoding="utf-8")
    assert gate.read_source_contract_cache(identity, source_dir) is None
    range_dir = directory / "range-proofs"
    range_seed = {**addition_seed, "_sourceIdentities": [{"before": [], "after": []}]}
    range_identity = gate.range_proof_cache_identity(range_seed, "a" * 64)
    gate.write_range_proof_cache(
        range_identity, addition_quotes, addition_ranges, range_dir,
    )
    assert gate.read_range_proof_cache(range_identity, range_dir) == json.loads(
        json.dumps([addition_quotes, addition_ranges]),
    )
    assert gate.range_proof_cache_identity(
        {**range_seed, "target": range_seed["target"] + "x"}, "a" * 64,
    )["fingerprint"] != range_identity["fingerprint"]
    assert gate.range_proof_cache_identity(
        range_seed, "b" * 64,
    )["fingerprint"] != range_identity["fingerprint"]
offset_image = gate.Image.new("RGB", (130, 120), "white")
gate.ImageDraw.Draw(offset_image).rectangle((40, 40, 60, 50), fill=(230, 205, 250))
offset_viewport = {**natural_viewport, "size": {"width": 100, "height": 100}}
offset_geometry = gate.pdf_natural_landing_geometry_proof(
    {"components": [{"pixels": 5, "bounds": [40, 40, 60, 50]}], "deltaPixels": 5},
    offset_image, {1: expected_line}, offset_viewport, 1, expected_line,
)
assert offset_geometry["status"] == "pdf-natural-landing-geometry-exact", offset_geometry
assert offset_geometry["viewportOrigin"] == [30.0, 20.0], offset_geometry
wrong_natural_image = gate.Image.new("RGB", (100, 100), "white")
gate.ImageDraw.Draw(wrong_natural_image).rectangle(
    (10, 50, 30, 60), fill=(230, 205, 250),
)
same_page_wrong_y = gate.pdf_natural_landing_geometry_proof(
    {"components": [{"pixels": 5, "bounds": [10, 50, 30, 60]}], "deltaPixels": 5},
    wrong_natural_image, {1: expected_line}, natural_viewport, 1, expected_line,
)
assert same_page_wrong_y["status"] == "pdf-natural-target-geometry-mismatch", same_page_wrong_y


class FakePdfOopif:
    def __init__(self):
        self.page = 1

    def evaluate(self, _script, page, prepare, navigate):
        if prepare and navigate:
            self.page = page
        return {"status": "ready", "currentPage": self.page}


page_timings = {}
assert gate.wait_pdf_page(
    FakePdfOopif(), 3, 0.1, page_timings, navigate=True,
) == {"status": "ready", "page": 3, "polls": 1}
assert page_timings["pdfPageNavigationMs"] >= 0

natural = gate.wait_pdf_page(FakePdfOopif(), 3, 0.01, {}, navigate=False)
assert natural["status"] == "pdf-page-not-reached"

class AlreadyGoneProcess:
    pid = 12345

    def __init__(self):
        self.returncode = None
        self.waits = []

    def poll(self):
        return self.returncode

    def wait(self, timeout):
        self.waits.append(timeout)
        self.returncode = 1
        return self.returncode

    def terminate(self):
        raise AssertionError("already-exited process was terminated")

    def kill(self):
        raise AssertionError("already-exited process was killed")


original_run = gate.subprocess.run
taskkill_commands = []
try:
    gate.subprocess.run = lambda command, **_options: (
        taskkill_commands.append(command) or subprocess.CompletedProcess(command, 128)
    )
    already_gone = AlreadyGoneProcess()
    gate.stop_process_tree(already_gone)
finally:
    gate.subprocess.run = original_run
assert taskkill_commands == [["taskkill", "/PID", "12345", "/T", "/F"]]
assert already_gone.waits == [1]

# Profile cleanup never enumerates global processes, so CIM access denial cannot
# turn an already-owned Job/Popen cleanup into a worker failure.
original_run = gate.subprocess.run
original_remove = gate.remove_profile_dir
try:
    gate.subprocess.run = lambda *_args, **_options: (_ for _ in ()).throw(
        PermissionError("Get-CimInstance Win32_Process: Access denied")
    )
    gate.remove_profile_dir = lambda _profile: None
    assert gate.cleanup_owned_profile(Path("owned-profile")) == []
finally:
    gate.subprocess.run = original_run
    gate.remove_profile_dir = original_remove

with tempfile.TemporaryDirectory() as directory:
    journal = Path(directory) / "attempt.jsonl"
    journal.write_text("".join((
        json.dumps({"label": "kept", "verdict": "exact-match", "inputHash": "current"}) + "\n",
        json.dumps({"label": "retry", "verdict": "error", "inputHash": "current"}) + "\n",
        json.dumps({"label": "stale", "verdict": "exact-match", "inputHash": "old"}) + "\n",
        '{"label":"interrupted"',
    )), encoding="utf-8")
    kept = gate.compact_reusable_jsonl(
        journal,
        {"kept": "current", "retry": "current", "stale": "current"},
        lambda row: row.get("verdict") == "exact-match",
    )
    assert list(kept) == ["kept"], kept
    assert gate.read_jsonl(journal) == [kept["kept"]]
    assert journal.read_bytes().endswith(b"\n")


class HealthyDriver:
    current_url = "about:blank"


class DeadDriver:
    @property
    def current_url(self):
        raise RuntimeError("invalid session")


assert gate.browser_session_failed(HealthyDriver(), RuntimeError("tab crashed"))
assert gate.browser_session_failed(DeadDriver(), RuntimeError("seed failure"))
assert not gate.browser_session_failed(HealthyDriver(), RuntimeError("seed failure"))

original_remove = gate.remove_profile_dir
cleanup_events = []
try:
    def fail_remove(_profile):
        cleanup_events.append("remove")
        raise PermissionError("transient profile lock")
    gate.remove_profile_dir = fail_remove
    warnings = gate.cleanup_owned_profile(Path("owned-profile"))
    assert len(warnings) == 1
finally:
    gate.remove_profile_dir = original_remove
assert cleanup_events == ["remove"]

parallel_lifecycle = subprocess.run(
    [sys.executable, str(HERE / "webdriver-exact-parallel.py"), "--lifecycle-self-check"],
    check=False, capture_output=True, text=True,
    creationflags=getattr(subprocess, "BELOW_NORMAL_PRIORITY_CLASS", 0),
)
assert parallel_lifecycle.returncode == 0, (
    parallel_lifecycle.stdout, parallel_lifecycle.stderr,
)
assert "parallel Chrome lifecycle checks passed" in parallel_lifecycle.stdout

print("strict fragment gate checks passed")
