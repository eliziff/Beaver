"""Independently invented inputs; corpus text never becomes a public fixture."""
from contextlib import closing, redirect_stdout
import io
import json
from pathlib import Path
import sqlite3
import tempfile
import unittest

from mine import Engine, ROOT, Scanner, chunks, extract_document, mine, normalize, observations, reusable
from analyze import assign_splits, paired_comparison, party_selection, token_retention, weak_prefixes
from evidence import clean_alias, usable_alias
from lookup import lookup, lookup_style
from shortform import FEATURES, caption_profile, disambiguate, generate, generate_case, load_model, party_type
from verify import verify
from prepare import court_forms, court_marker_forms, owner, prepare, declaration_origin, refresh_shortforms, usable_case_alias
from party_alias import learn_party_names, matches_party
from training_data import encoding_views
from quality import audit as quality_audit
from review import annotation_flag, prepare_gold_sample
from operations import self_check as check_naming_operations


class MiningTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.engine = Engine()
        cls.scanner = Scanner(cls.engine)
        cls.courts = court_forms(cls.engine)
        cls.court_markers = court_marker_forms(cls.engine)

    @classmethod
    def tearDownClass(cls):
        cls.engine.close()

    def scan(self, text):
        return self.scanner.scan(text)["citations"]

    def test_authored_definitions_and_offsets_survive_unicode_and_boundaries(self):
        text = "Quiet prose. " * 1994 + "😀 Orion Marine Ltd v Aster, 2032 SCC 241 [Orion].\nOrion, supra note 4 at para 7."
        citations = self.scan(text)
        found = observations(citations, lambda citation: citation["key"])
        self.assertIn("definition", [row[2] for row in found])
        self.assertIn("named_reference", [row[2] for row in found])
        for _, name, _, start, end in found:
            self.assertIn(name, text[start:end])
        native = extract_document(self.engine, text)
        self.assertEqual({(c["key"], c["explicit"]) for c in native if c.get("explicit")},
                         {(c["key"], c["explicit"]) for c in citations if c.get("explicit")})

    def test_generated_full_style_is_not_a_discovered_alias(self):
        text = "Orion Marine Ltd v Aster, 2032 SCC 242."
        self.assertEqual([], observations(self.scan(text), lambda citation: citation["key"]))

    def test_native_string_reply_can_contain_error_as_a_word(self):
        name = self.engine.call("supraHint", {"text": "Quantum error, supra note 1", "aggressive": True})
        self.assertEqual("Quantum error", name)

    def test_complete_reporter_year_owns_nested_volume_match(self):
        text = "Orion v Aster, [2032] 1 SCR 7890 [Orion]."
        rows = [c for c in self.scan(text) if c.get("explicit")]
        self.assertEqual(1, len(rows))
        self.assertEqual("[2032] 1 SCR 7890", rows[0]["core"]["text"])

    def test_quoted_declaration_and_parallel_alias_closure(self):
        text = 'Orion v Aster, 2032 SCC 243 ("Starlight"). Starlight, supra note 1. '
        rows = observations(self.scan(text), lambda citation: "one-closed-authority")
        self.assertEqual({"Starlight"}, {row[1] for row in rows})
        self.assertEqual({"definition", "named_reference"}, {row[2] for row in rows})

    def test_two_cases_sharing_a_name_abstain(self):
        text = ("Orion v Aster, 2032 SCC 244 [Orion]. "
                "Orion v Clover, 2032 SCC 245 [Orion]. Orion, supra note 8 at para 9.")
        rows = observations(self.scan(text), lambda citation: citation["key"])
        self.assertEqual(2, sum(row[2] == "definition" for row in rows))
        self.assertFalse(any(row[2] == "named_reference" for row in rows))

    def test_references_before_first_citation_are_not_evidence(self):
        text = "Starlight, supra note 3. Orion v Aster, 2032 SCC 246 [Starlight]."
        rows = observations(self.scan(text), lambda citation: citation["key"])
        self.assertFalse(any(row[2] == "named_reference" for row in rows))

    def test_local_roles_are_stored_but_not_globally_recommended(self):
        text = "Orion v Aster, 2032 SCC 247 [Trial Reasons]."
        rows = observations(self.scan(text), lambda citation: citation["key"])
        self.assertEqual("Trial Reasons", rows[0][1])
        self.assertFalse(reusable(rows[0][1]))
        self.assertTrue(reusable("Orion Trial Decision"))
        self.assertEqual(normalize("Étoile S.A."), normalize("ÉTOILE SA"))
        self.assertNotEqual(normalize("Étoile"), normalize("Etoile"))

    def test_every_character_has_exactly_one_chunk_owner(self):
        owners = [(start, stop) for _, start, stop, _ in chunks("A" * 50001)]
        self.assertEqual([(0, 24000), (24000, 48000), (48000, 50001)], owners)

    def test_history_declaration_follows_main_decision_unless_court_is_named(self):
        for label, expected in (("Starlight", 1), ("Starlight ONCA", 2)):
            text = f"2032 SCC 241, affirming 2031 ONCA 882 [{label}]"
            citations = self.engine.extract(text)
            keys = {"3:neutral:2032:scc:241": (1, 11), "3:neutral:2031:onca:882": (2, 12)}
            start = text.index("[")
            self.assertEqual((expected, "accepted"), owner(citations, start, len(text), label, keys, text, self.courts))
            self.assertEqual(0, declaration_origin(text, start))

    def test_french_leave_wording_preserves_the_underlying_authority(self):
        text = ("2034 QCCA 613, autorisation de pourvoi devant la CSC refusée "
                "[2035] SCCA No. 414 [Juniper]")
        citations = self.engine.extract(text)
        keys = {c["key"]: (index + 1, index + 11) for index, c in enumerate(citations) if c.get("key")}
        self.assertEqual((1, "accepted"),
            owner(citations, text.index("[Juniper]"), len(text), "Juniper", keys, text, self.courts))
        self.assertEqual(0, declaration_origin(text, text.index("[Juniper]")))

    def test_bare_court_markers_require_a_matching_party_name(self):
        markers = self.court_markers
        commercial = ("Juniper Tools Ltd v Marigold", "Juniper Tools Ltd", "Marigold")
        anonymous = ("R v C.A.", "R", "C.A.")
        acronym = ("Cedar Alder Ltd v Marigold", "Cedar Alder Ltd", "Marigold")
        self.assertFalse(usable_case_alias("C.A.", commercial, markers))
        self.assertTrue(usable_case_alias("C.A.", anonymous, markers))
        self.assertTrue(usable_case_alias("C.A.", acronym, markers))
        self.assertTrue(usable_case_alias("Juniper C.A.", commercial, markers))
        text = "R v C.A., 2034 QCCS 613, affirmed 2035 QCCA 414 [C.A.]"
        citations = self.engine.extract(text)
        keys = {c["key"]: (index + 1, index + 11) for index, c in enumerate(citations) if c.get("key")}
        self.assertEqual((1, "accepted"),
            owner(citations, text.index("[C.A.]"), len(text), "C.A.", keys, text, self.courts))

    def test_conflicting_parallel_authorities_cannot_supply_a_global_alias(self):
        text = "2032 SCC 241, [2032] 1 SCR 7890 [Starlight]"
        citations = self.engine.call("extract", {"text": text, "offsetUnit": "char",
            "options": {"resolve": False, "parallel": True}})["citations"]
        keys = {c["key"]: (index + 1, index + 11) for index, c in enumerate(citations) if c.get("key")}
        self.assertEqual((None, "conflicting_provider_citations"),
                         owner(citations, text.index("[Starlight]"), len(text), "Starlight", keys, text, self.courts))
        keys = {key: (1, 11) for key in keys}
        self.assertEqual((1, "accepted"), owner(citations, text.index("[Starlight]"), len(text), "Starlight", keys, text, self.courts))

    def test_unkeyed_history_parent_cannot_silently_become_its_leave_decision(self):
        text = "[2032] 1 C.N.L.R. 991, leave to appeal to SCC denied [2032] C.S.C.R. No. 882 [Orion]"
        citations = self.engine.extract(text)
        # Missing canonical keys are a rare native edge; keep its actual history/span structure.
        citations[0].pop("key", None)
        keys = {c["key"]: (2, 12) for c in citations if c.get("key")}
        self.assertEqual((None, "unindexed_owner"),
                         owner(citations, text.index("[Orion]"), len(text), "Orion", keys, text, self.courts))

    def test_translated_and_dotted_court_labels_select_the_named_appeal(self):
        for label in ("Starlight CAF", "Starlight F.C.A."):
            text = f"2032 FC 241, affirmed 2033 FCA 882 [{label}]"
            citations = self.engine.extract(text)
            keys = {"3:neutral:2032:fc:241": (1, 11), "3:neutral:2033:fca:882": (2, 12)}
            self.assertEqual((2, "accepted"), owner(citations, text.index("["), len(text), label, keys, text, self.courts))

    def test_sqlite_evidence_closes_aliases_deduplicates_and_keeps_unknown_cases(self):
        scratch = ROOT / ".tmp"
        scratch.mkdir(exist_ok=True)
        with tempfile.TemporaryDirectory(prefix="case-shortform-test-", dir=scratch) as directory:
            base = Path(directory)
            a2aj, journal, output = base / "cases.sqlite", base / "journals.sqlite", base / "shortforms.sqlite"
            with closing(sqlite3.connect(a2aj)) as c, c:
                c.executescript("CREATE TABLE meta(key,value); INSERT INTO meta VALUES ('citation_key_version','3');"
                    "CREATE TABLE citation_lookup(citation_key,document_id);"
                    "CREATE TABLE document(id,doc_type,citation_en,citation_fr,citation2_en,citation2_fr,"
                    "name_en,name_fr,unofficial_text_en,unofficial_text_fr);")
                for case_id, number, name in [(1, 241, "Orion Marine Ltd v Aster"), (2, 242, "R v Clover"),
                                             (3, 299, "Maple v Grove"), (4, 299, "Palm v Dune")]:
                    text = ("R v Clover, 2032 SCC 242 [Clover]. Clover, supra note 1. " * 2 if case_id == 1 else "")
                    c.execute("INSERT INTO document VALUES (?,?,?,?,?,?,?,?,?,?)",
                              (case_id, "cases", f"2032 SCC {number}", None, None, None, name, None, text, text))
                    c.execute("INSERT INTO citation_lookup VALUES (?,?)", (f"3:neutral:2032:scc:{number}", case_id))
                c.execute("INSERT INTO citation_lookup VALUES (?,?)", ("3:reporter:scr:77:188", 2))
                c.execute("UPDATE document SET unofficial_text_fr=? WHERE id=3", ("2032 SCC 242 [Clover procedural classification ruling].",))
            with closing(sqlite3.connect(journal)) as c, c:
                c.executescript("CREATE TABLE export_metadata(key,value); CREATE TABLE articles(article_id,text);")
                c.execute("INSERT INTO articles VALUES (?,?)", (7,
                    "R v Clover, 2032 SCC 242 [Clover]. Maple v Grove, 2032 SCC 299 [Maple]. "
                    "Aster v Beacon, 2032 SCC 301 [Aster]. "
                    "Orion Marine Ltd v Aster, 2032 SCC 241 [2041 Reasons]."))
            with redirect_stdout(io.StringIO()):
                mine(journal, a2aj, output)
                prepare(output, base / "preparation.json")
            with closing(sqlite3.connect(output)) as c:
                self.assertEqual(1, c.execute("SELECT count(*) FROM source WHERE duplicate_of IS NOT NULL").fetchone()[0])
                self.assertEqual(2, c.execute("SELECT count(*) FROM case_key WHERE case_id=2").fetchone()[0])
                self.assertEqual(2, c.execute("SELECT occurrences FROM observation WHERE case_id=2 AND kind='definition'"
                                             " ORDER BY occurrences DESC LIMIT 1").fetchone()[0])
                self.assertEqual(1, c.execute("SELECT ambiguous FROM case_record WHERE identity='3:neutral:2032:scc:299'").fetchone()[0])
                self.assertIsNone(c.execute("SELECT provider_id FROM case_record WHERE identity='3:neutral:2032:scc:301'").fetchone()[0])
                self.assertEqual("Clover", c.execute("SELECT defendant FROM case_name WHERE case_id=2 AND language='en'").fetchone()[0])
                result = lookup(c, "3:neutral:2032:scc:242")
                self.assertEqual(("Clover", "observed", 2),
                                 (result["shortform"], result["method"], result["definition_documents"]))
                self.assertEqual(("ambiguous", 2), (lookup(c, "3:neutral:2032:scc:299")["status"],
                    len(lookup(c, "3:neutral:2032:scc:299")["candidates"])))
                recovered = lookup(c, "3:neutral:2032:scc:301")
                self.assertEqual(("Aster", "Aster v Beacon"), (recovered["shortform"], recovered["style"]))
                self.assertEqual("en", lookup(c, "3:neutral:2032:scc:242", language="fr")["language"])
                self.assertEqual("citation_fallback", c.execute("SELECT method FROM case_shortform WHERE case_id=2 AND language='fr'").fetchone()[0])
                # Simulate an older qualification policy on this independently invented document.
                c.execute("UPDATE clean_observation SET case_id=original_case_id,normalized=?,status='accepted'"
                          " WHERE spelling='2041 Reasons'", (normalize("2041 Reasons"),))
                c.execute("INSERT INTO case_alias VALUES (1,'en',?,'2041 Reasons',1,0,1,1)",
                          (normalize("2041 Reasons"),))
                c.execute("UPDATE case_shortform SET shortform='2041 Reasons',method='observed_single'"
                          " WHERE case_id=1 AND language='en'")
                c.commit()
                with redirect_stdout(io.StringIO()):
                    refresh_shortforms(output, base / "preparation.json")
                self.assertEqual(0, c.execute("SELECT count(*) FROM case_alias WHERE spelling='2041 Reasons'").fetchone()[0])
                self.assertNotEqual("2041 Reasons", lookup(c, "3:neutral:2032:scc:241")["shortform"])
                c.execute("DELETE FROM observation WHERE source_id IN (SELECT id FROM source WHERE provider='journal')")
                c.commit()
            with redirect_stdout(io.StringIO()):
                prepare(output, base / "preparation.json")
            with closing(sqlite3.connect(output)) as c:
                result = lookup(c, "3:neutral:2032:scc:242")
                self.assertEqual(("Clover", "observed_single", 1),
                                 (result["shortform"], result["method"], result["definition_documents"]))
                fresh = lookup_style(c, "R v Larkspur", load_model())
                self.assertEqual(("Larkspur", "generated_from_caption"), (fresh["shortform"], fresh["status"]))
            with redirect_stdout(io.StringIO()):
                quality = quality_audit(output, base / "quality.json", count=2)
            self.assertEqual(0, quality["counts"]["generated_over_30_chars"])
            self.assertGreater(quality["lookup"]["queries"], 0)
            receipt = base / "verification.json"
            with redirect_stdout(io.StringIO()):
                refresh_shortforms(output, base / "preparation.json")
                verified = verify(output, receipt)
            self.assertEqual(4, sum(row["texts"] for row in verified["sources"].values()))
            with redirect_stdout(io.StringIO()):
                content = verify(output, receipt, check_engine=False)
            self.assertIsNone(content["current_engine_matches"])
            self.assertEqual("verified_source_content_and_code", content["status"])
            with closing(sqlite3.connect(journal)) as c, c:
                c.execute("UPDATE articles SET text=replace(text,'Aster','Basil')")
            with redirect_stdout(io.StringIO()), self.assertRaisesRegex(ValueError, "full text changed"):
                verify(output, receipt, check_engine=False)
            self.assertFalse(output.with_name(output.name + ".building").exists())


class GenerationTests(unittest.TestCase):
    def test_caption_noise_is_removed_without_destroying_numbered_parties(self):
        self.assertEqual(("Orion", "Aster"), caption_profile("83.\nOrion v. Aster")[1:])
        self.assertEqual(("Orion", "Aster"), caption_profile("83  Orion v. Aster")[1:])
        self.assertEqual(("8746129 Ontario Inc", "Aster"), caption_profile("8746129 Ontario Inc v. Aster")[1:])
        self.assertEqual(("R", "A.B."), caption_profile("R.v. A.B.")[1:])
        self.assertEqual(("Orion Marine Ltd", "Aster"), caption_profile("See Orion Marine Ltd v Aster")[1:])
        self.assertEqual(("See's Gardens Ltd", "Aster"), caption_profile("See's Gardens Ltd v Aster")[1:])
        self.assertEqual(("Orion Marine", "Aster"), caption_profile("March 2032\nAppeal reasons\nOrion Marine\nv. Aster")[1:])

    def test_generated_names_avoid_weak_fragments_and_remain_short(self):
        model = load_model()
        for left, right in (("New Cedar Homes Ltd", "Aster"), ("Orion Marine ULC", "801 Beacon Inc"),
                            ("R", "S.L. & T. Orion Enterprises Ltd")):
            generated = generate(left, right, model)["shortform"]
            self.assertNotIn(generated, ("New", "801", "S.L."))
            self.assertLessEqual(len(generated), 30)
        long_title = generate_case("Reference re Environmental Administration Act", None, None, model)["shortform"]
        self.assertLessEqual(len(long_title), 30)
        self.assertEqual("International Ferries", generate_case("Re International and International Regional Ferries",
            None, None, model)["shortform"])
        aliases = {normalize("A.B."): {"shortform": "AB", "definition_documents": 5}}
        self.assertEqual("A.B.", generate("R", "A.B.", model, party_aliases=aliases)["shortform"])

    def test_name_evidence_competes_with_other_valid_shortforms(self):
        party = "Beryl Harbour Services Ltd"
        learned = {normalize(party): {"shortform": "Beryl Harbour", "definition_documents": 12,
                                     "case_count": 4, "vote_share": 0.9}}
        prefer_word = {"trees": [[FEATURES.index("first_party"), 0.5, 0, 2],
                                 [FEATURES.index("one_word"), 0.5, 0, 2]]}
        self.assertEqual("Beryl", generate(party, "Flint", prefer_word, party_aliases=learned)["shortform"])
        prefer_attested = {"trees": [[FEATURES.index("memory_match"), 0.5, 0, 2]]}
        selected = generate(party, "Flint", prefer_attested, party_aliases=learned)
        self.assertEqual(("Beryl Harbour", "generated_attested_party"),
                         (selected["shortform"], selected["method"]))

    def test_compact_parenthesized_initials_remain_complete_and_do_not_transfer(self):
        self.assertEqual("Q. (TZ)", generate("R", "Q. (TZ)", {"trees": []})["shortform"])
        self.assertTrue(matches_party("QTZ", "Q. (TZ)"))
        records = [{"id": index, "left": "Q. (TZ)", "right": "Flint", "aliases": {
            "qtz": {"text": "QTZ", "document_ids": [("journal", index)]}}} for index in (19, 47)]
        self.assertEqual({}, learn_party_names(records))

    def test_a_weak_opening_word_can_be_a_complete_surname(self):
        model = {"trees": [[FEATURES.index("surname"), 0.5, 0, 2]], "weak_heads": ["silver"]}
        self.assertEqual("Silver", generate("R", "Anika Silver", model)["shortform"])
        self.assertNotEqual("Silver", generate("R", "Silver Aperture Works Ltd", model)["shortform"])

    def test_word_context_distinguishes_an_organization_from_a_person(self):
        records = []
        for index in range(6):
            for party, label in ((f"Cedar Amber{index} Ltd", "Cedar"),
                                 (f"Cedar Laurel{index}", f"Laurel{index}")):
                norm = normalize(label)
                records.append({"id": len(records), "left": party, "right": "Flint", "modal": {norm},
                                "aliases": {norm: {"text": label}}})
        model = {"trees": [[FEATURES.index("typed_fit"), 0.75, 0, 2]],
                 "token_retention": token_retention(records)}
        self.assertEqual("Cedar", generate("Cedar Mauve Ltd", "R", model)["shortform"])
        self.assertEqual("Mauve", generate("Cedar Mauve", "R", model)["shortform"])

    def test_phrase_evidence_transfers_across_different_full_party_names(self):
        records = []
        for index in range(6):
            label = "Copper Meadow"
            norm = normalize(label)
            records.append({"id": index, "left": f"Copper Meadow Freight {index} Ltd", "right": "Larch",
                            "modal": {norm}, "aliases": {norm: {"text": label}}})
        model = {"trees": [[FEATURES.index("phrase_rate"), 0.5, 0, 2]],
                 "token_retention": token_retention(records)}
        self.assertEqual("Copper Meadow", generate("Copper Meadow Shipping Ltd", "R", model)["shortform"])

    def test_neighbor_evidence_learns_where_a_new_name_stops(self):
        records = []
        for index in range(8):
            first = "Amber" if index % 2 else "Violet"
            label = first + " Orchard"
            norm = normalize(label)
            records.append({"id": index, "left": label + " Fabrication Ltd", "right": "Larch",
                            "modal": {norm}, "aliases": {norm: {"text": label}}})
        model = {"trees": [[FEATURES.index("end_after"), 0.5, 0, 2],
                           [FEATURES.index("prefix"), 0.5, 0, 1]],
                 "token_retention": token_retention(records)}
        self.assertEqual("Teal Orchard", generate("Teal Orchard Fabrication Ltd", "R", model)["shortform"])

    def test_weak_openings_need_independent_cases_and_different_parties(self):
        records = []
        for index in range(6):
            name = "Bright Solar Panels Ltd" if index % 2 else "Bright Mercury Works Ltd"
            alias = "Bright Solar" if index % 2 else "Bright Mercury"
            key = normalize(alias)
            records.append({"id": index, "left": name, "right": "Laurel", "modal": {key},
                            "aliases": {key: {"text": alias}}})
        self.assertIn("bright", weak_prefixes(records))
        self.assertNotIn("bright", weak_prefixes([{**record, "id": 0} for record in records]))
        self.assertNotIn("bright", weak_prefixes([records[0]] * 6))

    def test_word_retention_generalizes_to_a_new_party(self):
        name = "Cedar Indigo Fabrication Ltd"
        alias = normalize("Cedar Indigo")
        records = [{"id": index, "left": name, "right": f"Laurel {index}", "modal": {alias},
                    "aliases": {alias: {"text": "Cedar Indigo"}}} for index in range(6)]
        learned = token_retention(records)
        model = {"trees": [[FEATURES.index("first_party"), 0.5, 0, 2],
                           [FEATURES.index("token_fit"), 0.8, -2, 2]], "token_retention": learned}
        result = generate("Willow Indigo Fabrication Ltd", "Grove", model)
        self.assertEqual("Willow Indigo", result["shortform"])
        self.assertLessEqual(len(result["shortform"]), 30)

    def test_acronyms_do_not_count_as_dropping_every_word(self):
        records = []
        for index in range(12):
            party, label = (("Deepwater Pulsar Institute Ltd", "DPI") if index < 6 else
                            ("Bracken Pulsar Institute Ltd", "Bracken Pulsar"))
            key = normalize(label)
            records.append({"id": index, "left": party, "right": "R", "modal": {key},
                            "aliases": {key: {"text": label}}})
        learned = token_retention(records)
        self.assertEqual(1., learned["priors"]["corporate:first"])
        self.assertEqual([6., 6], learned["tokens"]["first:bracken"])
        self.assertEqual(6, learned["context"]["alias_frequency"]["dpi"])
        self.assertEqual(1., learned["party_selection"]["priors"]["0:corporate"])

    def test_component_learning_keeps_the_authored_target_unchanged(self):
        label = "Council 2044 TXA"
        key = normalize(label)
        source = {"id": 1, "left": "The Marshfield Engineers Council", "right": "R",
                  "courts": ["TXA"], "years": ["2044"], "modal": {key},
                  "aliases": {key: {"text": label, "votes": 2, "document_ids": [("invented", 7), ("invented", 9)]}}}
        views, _ = encoding_views([source], True)
        self.assertEqual({key}, source["modal"])
        self.assertEqual(label, source["aliases"][key]["text"])
        self.assertEqual({"council"}, views[0]["modal"])
        self.assertEqual(2, views[0]["aliases"]["council"]["votes"])
        self.assertEqual(source["aliases"][key]["document_ids"], views[0]["aliases"]["council"]["document_ids"])

    def test_background_word_counts_help_choose_a_distinctive_name(self):
        model = {"trees": [[FEATURES.index("shape_label_body_max"), 0.5, 4., -4.]],
                 "background_statistics": {"word_documents": {"marina": 80},
                                           "name_word_frequency": {}, "person_name_cases": {}}}
        self.assertEqual("Zircon", generate("Zircon Marina Ltd", "R", model)["shortform"])

    def test_compound_surnames_remain_available_as_one_name(self):
        model = {"trees": [[FEATURES.index("suffix"), 0.5, 0, 2]]}
        self.assertEqual("de Vallon", generate("R", "Mira de Vallon", model)["shortform"])
        self.assertEqual("A.B.", generate("R", "A.B.", model)["shortform"])

    def test_learned_party_selection_transfers_role_words_to_new_names(self):
        records = []
        for index in range(12):
            left = "Willow Board" if index < 6 else f"Orion {index}"
            right = f"Juno {index}"
            label = right if index < 6 else left
            norm = normalize(label)
            records.append({"id": index, "left": left, "right": right, "modal": {norm},
                            "aliases": {norm: {"text": label}}})
        learned = party_selection(records)
        model = {"trees": [[FEATURES.index("selection_mean"), 0.4, -1, 1]],
                 "token_retention": {"party_selection": learned}}
        self.assertEqual("Flint", generate("Aster Board", "Flint", model)["shortform"])
        duplicate = party_selection([{**record, "id": 0} for record in records])
        self.assertNotIn("0:board", duplicate["tokens"])

    def test_reserved_audit_keeps_groups_and_leaves_other_holdouts_unchanged(self):
        records = [{"id": index, "identity": f"invented-{index}", "left": f"Sable {index}",
                    "right": f"Dune {index}", "language": language}
                   for index in range(200) for language in ("en", "fr")]
        assign_splits(records)
        original = {record["id"]: record["split"] for record in records}
        assign_splits(records, reserve_audit=True)
        audit = [record for record in records if record["split"] == "audit"]
        self.assertTrue(audit)
        self.assertEqual({"train"}, {original[record["id"]] for record in audit})
        for record in records:
            if original[record["id"]] in {"development", "test"}:
                self.assertEqual(original[record["id"]], record["split"])
            self.assertEqual(1, len({row["split"] for row in records if row["id"] == record["id"]}))

    def test_attested_party_acronyms_require_independent_cases_and_documents(self):
        def row(case_id, document, label="OMC"):
            return {"id": case_id, "left": "Orion Marine Company", "right": "Aster", "aliases": {
                normalize(label): {"text": label, "document_ids": [("journal", document)]}}}
        self.assertEqual({}, learn_party_names([row(1, 7), row(2, 7)]))
        self.assertEqual({}, learn_party_names([row(1, 7), row(1, 8)]))
        learned = learn_party_names([row(1, 7), row(2, 8)])
        self.assertEqual("OMC", learned[normalize("Orion Marine Company")]["shortform"])
        learned = learn_party_names([row(1, 7, "OM"), row(2, 8, "OM")])
        prefer_attested = {"trees": [[FEATURES.index("memory_match"), 0.5, 0, 2]]}
        self.assertEqual("OM", generate("Orion Marine Company", "Beacon", prefer_attested, party_aliases=learned)["shortform"])
        self.assertEqual({}, learn_party_names([row(1, 7, "Harbour ruling"), row(2, 8, "Harbour ruling")]))

    def test_nonadversarial_titles_supply_names_without_inventing_a_party(self):
        generated = generate_case("Reference re Cedar Safety Act", None, None, load_model())
        self.assertEqual(("Cedar Safety Act Reference", "title_generated"), (generated["shortform"], generated["method"]))
        self.assertEqual("A.B.", generate_case("A.B.", None, None, load_model())["shortform"])
        self.assertEqual("Cedar Commission", generate_case("Cedar Commission (Re), 2032 OIC 318",
            None, None, load_model(), "2032 OIC 318")["shortform"])

    def test_native_metadata_is_not_an_authored_shortform(self):
        for value in ("TRADUCTION FRANÇAISE", "UNREVISED CERTIFIED ENGLISH TRANSLATION", "en anglais seulement",
                      "TRADUCTION FRANCAISE", "la décision", "Merits Decision", "emphasis added",
                      "cited to Appendix Z", "with references to Annex Q", "2041 Reasons", "Tax Decision"):
            self.assertFalse(usable_alias(value), value)
        self.assertTrue(usable_alias("Translation Harbour"))
        self.assertTrue(usable_alias("Starlight 2041"))
        self.assertEqual("", clean_alias("cited to Appendix Z"))
        self.assertTrue(usable_alias("l’arrêt Starlight"))
        for value in ("hereinafter “Starlight”", "ci-après “Starlight”", "Starlight cited to SCR"):
            self.assertEqual("Starlight", clean_alias(value))
            self.assertTrue(usable_alias(value))

    def test_annotation_review_preserves_brands_and_declared_local_names(self):
        for value in ("Translation Harbour", "Award", "May Reasons", "Cedar page 18", "P123", "Auteur Français"):
            self.assertIsNone(annotation_flag(value))
            self.assertTrue(usable_alias(value))
        self.assertEqual("page_reference", annotation_flag("pp. 47-49"))
        self.assertEqual("publication_status", annotation_flag("not reported"))
        self.assertEqual("translation_notice", annotation_flag("English translation revised by editor"))
        self.assertEqual("judge_attribution", annotation_flag("per Rowan CJ"))
        for value in ("page 47", "pp. 47-49", "per Rowan CJ", "juge d’appel Marigold",
                      "English translation revised by editor", "not reported", "page47"):
            self.assertFalse(usable_alias(value))

    def test_cached_parties_cannot_absorb_citations_or_lose_caption_words(self):
        self.assertEqual(("Garden of Rain", "Stone"),
            caption_profile("Garden of Rain v Stone", "Garden Rain", "Stone, [2046]")[1:])
        self.assertEqual(("R", "C.(L.)"),
            caption_profile("R v C.(L.)", "R", "C.(L.) [2046]")[1:])
        self.assertEqual(("Garden", "Stone"), caption_profile(None, "Garden", "Stone")[1:])
        self.assertEqual(("Elin Rook", "Stone"),
            caption_profile("Rook v Stone", "Elin Rook", "Stone")[1:])
        self.assertEqual(("Fieldstone", "Alder"),
            caption_profile("Fieldstone v Alder", "Fieldstone", "Alder, 913 U.S. 4201, 4203")[1:])
        self.assertEqual(("Fieldstone", "Alder"),
            caption_profile("Fieldstone v Alder", "Fieldstone", "Alder 2039 ABKB 741")[1:])
        self.assertEqual(("Fieldstone", "Alder, Trading Ltd"),
            caption_profile("Fieldstone v Alder", "Fieldstone", "Alder, Trading Ltd")[1:])

    def test_judge_suffixes_keep_names_while_editorial_notes_are_rejected(self):
        for value in ("Fern, per Hazel J", "Fern, la juge Hazel", "Fern, per Hazel J as she then was"):
            self.assertEqual("Fern", clean_alias(value))
            self.assertTrue(usable_alias(value))
        for value in ("le juge Hazel", "per Justice Hazel", "per Hazel J as she then was",
                      "OFFICIAL ENGLISH TRANSLATION", "TRADUCTION FRANÇAISE OFFICIELLE, NON RÉVISÉE",
                      "references omitted", "underlining added", "souligné dans l’original"):
            self.assertFalse(usable_alias(value), value)
        for value in ("Reference", "River Reference", "Official French", "Auteur Français", "J.A.", "T.J."):
            self.assertTrue(usable_alias(value), value)
        self.assertEqual("Fern, Hazel", clean_alias("Fern, Hazel"))

    def test_naming_operations_preserve_words_initials_and_qualifiers(self):
        check_naming_operations()

    def test_rebuilding_a_gold_packet_preserves_completed_source_judgments(self):
        with tempfile.TemporaryDirectory() as directory:
            packet = Path(directory) / "review.json"
            original = json.dumps({"items": [{"judgment": "valid_declared_name", "note": "review retained"}]})
            packet.write_text(original, encoding="utf-8")
            with self.assertRaisesRegex(ValueError, "reviewed gold packet already exists"):
                prepare_gold_sample(Path(directory) / "absent.sqlite", packet)
            self.assertEqual(original, packet.read_text(encoding="utf-8"))

    def test_frozen_generator_selects_distinctive_parties_and_preserves_initials(self):
        model = load_model()
        for left, right, expected in (("R", "Clover", "Clover"), ("Canada (Attorney General)", "Aster", "Aster"),
                                     ("8746129 Ontario Inc", "Beacon", "Beacon"), ("R", "A.B.", "A.B."),
                                     ("Her Majesty the Queen in Right of Ontario", "Larkspur", "Larkspur"),
                                     ("Sa Majesté du chef de la province de l'Alberta", "Larkspur", "Larkspur")):
            first = generate(left, right, model)
            self.assertEqual(expected, first["shortform"])
            self.assertEqual(first, generate(left, right, model))
        corporate = generate("Orion Marine Company Ltd", "Aster", model)["shortform"]
        self.assertTrue(corporate.startswith("Orion"))
        self.assertNotIn("Ltd", corporate)
        self.assertNotIn("Company", corporate)
        self.assertEqual("government", party_type("Regina (City)"))
        self.assertEqual("government", party_type("Procureure générale du Canada"))
        self.assertEqual("Regina", generate("Regina (City)", None, model)["shortform"])
        self.assertEqual("2032 SCC 241", generate(None, None, model, "2032 SCC 241")["shortform"])

    def test_colliding_labels_keep_distinct_authority_identities(self):
        records = [{"identity": "case-a", "shortform": "Orion", "citation": "2032 SCC 241"},
                   {"identity": "case-b", "shortform": "Orion", "citation": "2032 SCC 242"}]
        self.assertEqual({"case-a": "Orion (2032 SCC 241)", "case-b": "Orion (2032 SCC 242)"}, disambiguate(records))
        records[1]["citation"] = records[0]["citation"]
        with self.assertRaises(ValueError):
            disambiguate(records)

    def test_paired_comparison_uses_current_labels_and_excludes_old_training_groups(self):
        def record(identity, group, alias, left="Lumen Yard Ltd"):
            norm = normalize(alias)
            return {"identity": identity, "language": "en", "split_group": group, "left": left,
                    "aliases": {norm: {"text": alias}}, "modal": {norm}}
        records = [record("unseen-a", "group-a", "Lumen"),
                   record("trained", "group-b", "Lumen"),
                   record("merged-with-training", "group-b", "Lumen"),
                   record("new-only", "group-c", "Lumen"),
                   record("unseen-d", "group-d", "Fern", "Fern")]
        def prediction(identity, text):
            return {"identity": identity, "language": "en", "shortform": text}
        previous = {"test_predictions": [prediction("unseen-a", "Lumen Yard"),
                    prediction("merged-with-training", "Lumen Yard"), prediction("unseen-d", "Fern")],
                    "non_test_identities": ["trained"]}
        current = [prediction("unseen-a", "Lumen"), prediction("merged-with-training", "Lumen"),
                   prediction("new-only", "Lumen"), prediction("unseen-d", "Fern Harbor")]
        result = paired_comparison(records, current, previous)
        self.assertEqual((2, 2, 2), (result["rows"], result["case_identities"], result["case_party_groups"]))
        self.assertEqual(1, result["before"]["any_authored_matches"])
        self.assertEqual(1, result["after"]["any_authored_matches"])
        self.assertEqual((1, 1), (result["any_authored_gains"], result["any_authored_losses"]))

    def test_split_keeps_languages_and_repeated_parties_together(self):
        records = [{"id": case_id, "identity": identity, "left": left, "right": right}
                   for case_id, identity, left, right in [(1,"case-a","Orion","Aster"),
                       (1,"case-a","Orion","Aster"), (2,"case-b","Orion","Aster"),
                       (2,"case-b","Étoile","Trèfle"), (3,"case-c","Étoile","Trèfle")]]
        assign_splits(records)
        self.assertEqual(1, len({record["split"] for record in records}))
        original = [record["split"] for record in records]
        assign_splits(records)
        self.assertEqual(original, [record["split"] for record in records])


if __name__ == "__main__":
    unittest.main()
