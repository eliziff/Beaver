import json
import tempfile
import unittest
from pathlib import Path

from scrape_judge_registry import (
    Builder,
    COURTS,
    YEAR_RANGE_RE,
    clean_name,
    parse_cmac,
    parse_federal_profile,
    parse_irb_current,
    parse_nova_scotia_current,
)


class JudgeRegistryScraperTest(unittest.TestCase):
    def page(self, builder: Builder, source_id: str, html: str):
        page = builder.page(source_id, f"https://example.test/{source_id}", html.encode())
        builder.sources[source_id]["retrievedAt"] = "2026-08-19T12:00:00Z"
        return page

    def test_courts_cover_all_29_a2aj_datasets_without_an_iad_entity(self):
        expected = {
            "SCC", "FCA", "BCCA", "ONCA", "NSCA", "YKCA", "FC", "TCC", "CMAC",
            "BCSC", "NSSC", "NSPC", "NSFC", "NSSM", "CHRT", "CIRB", "CITT", "CT",
            "FPSLREB", "OHSTC", "OIC", "PSDPT", "RAD", "RPD", "RLLR", "SST", "TATC",
            "CART", "SCT",
        }
        datasets = {dataset for _, _, aliases in COURTS.values() for dataset in aliases}
        self.assertEqual(datasets, expected)
        self.assertNotIn("iad", COURTS)
        self.assertEqual(COURTS["rpd"][2], ["RPD", "RLLR"])

    def test_unicode_tenure_dashes_and_source_ornament_are_cleaned(self):
        for separator in ("-", "–", "—"):
            self.assertEqual(YEAR_RANGE_RE.search(f"2001 {separator} 2009").groups(), ("2001", "2009"))
        self.assertEqual(clean_name("The Honourable Justice Jane Doe ﹡"), "Jane Doe")

    def test_federal_profile_uses_current_role_appointment_and_role_in_id(self):
        builder = Builder()
        page = self.page(builder, "federal", """
            <table><caption>Refugee Appeal Division</caption>
              <tr><th>Name</th><th>Original appointment date</th><th>Current appointment date</th><th>Expiry date</th></tr>
              <tr><td>Doe, Jane</td><td>January 2, 2017</td><td>March 4, 2022</td><td>March 3, 2027</td></tr>
            </table>
        """)
        parse_federal_profile(builder, page, lambda role: "rad")
        position = next(iter(builder.positions.values()))
        self.assertEqual(position["dateStart"], {"value": "2022-03-04", "precision": "day"})
        self.assertIn(position["positionType"], position["id"])
        self.assertEqual(position["evidence"][0]["sourceId"], "federal")
        self.assertIn("January 2, 2017", position["evidence"][0]["sourceQuote"])

    def test_current_nova_scotia_names_are_observations_not_fake_intervals(self):
        builder = Builder()
        page = self.page(builder, "nova-scotia", """
            <h2>Court of Appeal</h2>
            <h4>Michael J. Wood</h4><p>Chief Justice of the Court of Appeal</p>
            <p>Judges of the Court of Appeal:<br>Justice Carole A. Beaton<br>Justice Joel E. Fichaud *</p>
            <h2>Supreme Court (Family Division)</h2>
            <p>Judges of the Supreme Court (Family Division):<br>Justice Jillian Barrington (Halifax)</p>
            <h2>Provincial Court</h2>
            <p>Judges of the Provincial Court:<br>Judge Del W. Atwood *<br>Judge Alain Bégin (Truro)</p>
        """)
        parse_nova_scotia_current(builder, page)
        self.assertFalse(builder.positions)
        observations = list(builder.roster_observations.values())
        self.assertEqual({item["courtId"] for item in observations}, {"nsca", "nssc", "nspc"})
        self.assertEqual({item["observedOn"] for item in observations}, {"2026-08-19"})
        self.assertIn("supernumerary_justice", {item["positionType"] for item in observations})
        self.assertIn("part_time_judge", {item["positionType"] for item in observations})

    def test_cmac_date_is_the_date_nearest_the_cmac_appointment(self):
        builder = Builder()
        page = self.page(builder, "cmac", """
            <h2>Judges</h2><ul><li><strong>The Honourable Mary J.L. Gleason</strong>
              <p>She was appointed to the Federal Court on December 15, 2011, appointed a judge of the
              Court Martial Appeal Court of Canada on March 7, 2013, and appointed to the Federal Court
              of Appeal on June 19, 2015.</p></li></ul>
        """)
        parse_cmac(builder, page)
        position = next(iter(builder.positions.values()))
        self.assertEqual(position["dateStart"], {"value": "2013-03-07", "precision": "day"})
        self.assertEqual(position["courtId"], "cmac")

    def test_irb_rpd_and_rad_lists_become_dated_observations(self):
        builder = Builder()
        page = self.page(builder, "irb-current", """
            <p>Refugee Protection Division</p><ul>
              <li>Roula Eatrides, Deputy Chairperson</li><li>Jennifer Friberg, Director, Member Support</li>
              <li>Aber, Imad</li></ul>
            <p>Refugee Appeal Division</p><ul><li>Doyle, Elaine (Part-time)</li></ul>
            <p>Immigration Division</p><ul><li>Ignored, Person</li></ul>
        """)
        parse_irb_current(builder, page)
        observations = list(builder.roster_observations.values())
        people = {person["id"]: person["canonicalName"] for person in builder.people.values()}
        self.assertEqual({people[item["personId"]] for item in observations}, {"Roula Eatrides", "Imad Aber", "Elaine Doyle"})
        self.assertEqual({item["courtId"] for item in observations}, {"rpd", "rad"})
        self.assertTrue(all(item["evidence"] for item in observations))

    def test_writes_a_valid_replaceable_partial_snapshot(self):
        builder = Builder()
        page = self.page(builder, "source", "<p>source</p>")
        builder.add_position(
            "Jane Doe", "scc", {"value": "2020", "precision": "year"}, None,
            "Justice", "permanent", page, "Jane Doe appointed 2020",
        )
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory) / "registry.json"
            builder.write(output)
            self.assertEqual(len(json.loads(output.read_text(encoding="utf-8"))["positions"]), 1)
            builder.add_observation("John Doe", "rad", "Member", page, "John Doe")
            builder.write(output)
            self.assertEqual(len(json.loads(output.read_text(encoding="utf-8"))["rosterObservations"]), 1)

    def test_retains_raw_pages_and_does_not_merge_people_by_name_across_sources(self):
        with tempfile.TemporaryDirectory() as directory:
            raw_dir = Path(directory) / "sources"
            builder = Builder(raw_dir)
            first = self.page(builder, "first", "<p>Jane Doe first source</p>")
            second = self.page(builder, "second", "<p>Jane Doe second source</p>")
            builder.add_position(
                "Jane Doe", "scc", {"value": "2020", "precision": "year"}, None,
                "Justice", "permanent", first, "Jane Doe first source",
            )
            builder.add_position(
                "Jane Doe", "scc", {"value": "2020", "precision": "year"}, None,
                "Justice", "permanent", second, "Jane Doe second source",
            )
            self.assertEqual(len(builder.people), 2)
            self.assertEqual(len(builder.positions), 2)
            self.assertEqual(len(list(raw_dir.glob("*.html"))), 2)


if __name__ == "__main__":
    unittest.main()
