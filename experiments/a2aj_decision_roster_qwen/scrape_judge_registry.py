#!/usr/bin/env python3
"""Build a source-stamped judge/court service registry from official pages.

Every fetched page is retained by content hash beside the ignored output. Every
service keeps compact supporting text and points to its page record. The output
and source-attempt receipts are updated after every source so an interrupted run
stays usable.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import re
import sys
import unicodedata
from concurrent.futures import ThreadPoolExecutor, as_completed
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Callable, Iterable
from urllib.parse import urljoin
from urllib.request import Request, urlopen

from bs4 import BeautifulSoup, Tag


USER_AGENT = "Beaver legal-data experiment/1.0"
DATE_RE = re.compile(r"\b(\d{4}-\d{2}-\d{2})\b")
YEAR_RANGE_RE = re.compile(r"\b(\d{4})\s*[-–—]\s*(\d{4})\b")
MONTHS = (
    "January|February|March|April|May|June|July|August|September|October|November|December"
)
HUMAN_DAY_RE = re.compile(rf"\b({MONTHS})\s+(\d{{1,2}}),?\s+(\d{{4}})\b", re.I)
HUMAN_MONTH_RE = re.compile(rf"\b({MONTHS})\s+(\d{{4}})\b", re.I)


# One entity for every current A2AJ dataset. RPD and the RLLR reporter are
# deliberately one court because both datasets contain RPD decisions.
COURTS = {
    "scc": ("Supreme Court of Canada", ["SCC", "CSC"], ["SCC"]),
    "fca": ("Federal Court of Appeal", ["FCA", "CAF"], ["FCA"]),
    "bcca": ("Court of Appeal for British Columbia", ["BCCA", "BC Court of Appeal"], ["BCCA"]),
    "onca": ("Court of Appeal for Ontario", ["ONCA", "Ontario Court of Appeal"], ["ONCA"]),
    "nsca": ("Nova Scotia Court of Appeal", ["NSCA", "Court of Appeal of Nova Scotia"], ["NSCA"]),
    "ykca": ("Court of Appeal of Yukon", ["YKCA", "Yukon Court of Appeal"], ["YKCA"]),
    "fc": ("Federal Court", ["FC"], ["FC"]),
    "tcc": ("Tax Court of Canada", ["TCC", "CCI"], ["TCC"]),
    "cmac": ("Court Martial Appeal Court of Canada", ["CMAC", "CACM"], ["CMAC"]),
    "bcsc": ("Supreme Court of British Columbia", ["BCSC", "BC Supreme Court"], ["BCSC"]),
    "nssc": ("Supreme Court of Nova Scotia", ["NSSC", "Nova Scotia Supreme Court"], ["NSSC"]),
    "nspc": ("Provincial Court of Nova Scotia", ["NSPC", "Nova Scotia Provincial Court"], ["NSPC"]),
    "nsfc": ("Family Court for the Province of Nova Scotia", ["NSFC", "Nova Scotia Family Court"], ["NSFC"]),
    "nssm": ("Small Claims Court of Nova Scotia", ["NSSM", "Nova Scotia Small Claims Court"], ["NSSM"]),
    "chrt": ("Canadian Human Rights Tribunal", ["CHRT", "HRTC", "TCDP"], ["CHRT"]),
    "cirb": ("Canada Industrial Relations Board", ["CIRB"], ["CIRB"]),
    "citt": ("Canadian International Trade Tribunal", ["CITT"], ["CITT"]),
    "ct": ("Competition Tribunal", ["CT", "RCT", "TC"], ["CT"]),
    "fpslreb": ("Federal Public Sector Labour Relations and Employment Board", ["FPSLREB", "PSLREB"], ["FPSLREB"]),
    "ohstc": ("Occupational Health and Safety Tribunal Canada", ["OHSTC"], ["OHSTC"]),
    "oic": ("Office of the Information Commissioner of Canada", ["OIC"], ["OIC"]),
    "psdpt": ("Public Servants Disclosure Protection Tribunal", ["PSDPT", "PSDPTC"], ["PSDPT"]),
    "rad": ("Refugee Appeal Division", ["RAD", "SAR"], ["RAD"]),
    "rpd": ("Refugee Protection Division", ["RPD", "SPR"], ["RPD", "RLLR"]),
    "sst": ("Social Security Tribunal of Canada", ["SST", "TSS"], ["SST"]),
    "tatc": ("Transportation Appeal Tribunal of Canada", ["TATC"], ["TATC"]),
    "cart": ("Canada Agricultural Review Tribunal", ["CART"], ["CART"]),
    "sct": ("Specific Claims Tribunal", ["SCT", "SCTC"], ["SCT"]),
}

SOURCE_URLS = {
    "scc": "https://www.scc-csc.ca/about-apropos/judges-juges/list-liste/",
    "bcca": "https://www.bccourts.ca/Court_of_Appeal/about_the_court_of_appeal/justices_of_the_court_of_appeal.aspx",
    "bcsc": "https://www.bccourts.ca/supreme_court/about_the_supreme_court/Judges_and_Associate_Judges_of_the_Supreme_Court.aspx",
    "onca-current": "https://www.ontariocourts.ca/coa/judges-of-the-court/",
    "onca-former": "https://www.ontariocourts.ca/coa/judges-of-the-court/former-judges/",
    "fca": "https://www.fca-caf.ca/en/pages/about-the-court/judges",
    "fc": "https://www.fct-cf.gc.ca/en/pages/about-the-court/members-of-the-court",
    "fc-former": "https://www.fct-cf.gc.ca/en/pages/about-the-court/members-of-the-court/former-members-of-the-court",
    "tcc": "https://www.tcc-cci.ca/en/pages/about/judges",
    "cmac": "https://www.cmac-cacm.ca/en/pages/about-the-court/members-of-the-court",
    "nova-scotia-current": "https://www.courts.ns.ca/courts/judges",
    "irb-current": "https://www.irb-cisr.gc.ca/en/members/Pages/list-of-members-liste-des-membres.aspx",
}

FEDERAL_PROFILES = {
    "sst": ("SST", lambda role: "sst"),
    "irb": ("IRB", lambda role: "rad" if "refugee appeal division" in role else None),
    "citt": ("CITT", lambda role: "citt"),
    "fpslreb": ("PSLREB", lambda role: "fpslreb"),
    "chrt": ("HRTC", lambda role: "chrt"),
    "cirb": ("CIRB", lambda role: "cirb"),
    "ct": ("RCT", lambda role: "ct"),
    "tatc": ("TATC", lambda role: "tatc"),
    "cart": ("CART", lambda role: "cart"),
    "sct": ("SCT", lambda role: "sct"),
    "psdpt": ("PSDPTC", lambda role: "psdpt"),
    "oic": ("OOIC", lambda role: "oic"),
}


def compact(value: str) -> str:
    return re.sub(r"\s+", " ", value).strip()


def slug(value: str) -> str:
    plain = unicodedata.normalize("NFKD", value).encode("ascii", "ignore").decode().lower()
    return re.sub(r"[^a-z0-9]+", "-", plain).strip("-") or "record"


def clean_name(value: str) -> str:
    value = compact(value).replace("﹡", "").replace("*", "").strip()
    value = re.sub(r"\s*\([^()]*\)\s*$", "", value)
    value = re.sub(r"^(?:the\s+)?(?:right\s+)?honou?rable\s+", "", value, flags=re.I)
    value = re.sub(
        r"^(?:(?:mr|madam|madame)\.?\s+)?(?:associate\s+chief\s+justice|chief\s+justice|justice|judge)\s+",
        "",
        value,
        flags=re.I,
    )
    value = re.sub(r",\s*(?:P\.?C\.?|C\.?C\.?|K\.?C\.?|Q\.?C\.?)(?:\s*,.*)?$", "", value, flags=re.I)
    if value.count(",") == 1:
        family, given = [part.strip() for part in value.split(",")]
        if family and given and not re.search(r"\d", value):
            value = f"{given} {family}"
    return compact(value).strip(" ,")


def position_type(role: str) -> str:
    return slug(compact(role) or "member").replace("-", "_")


def date_value(value: str, precision: str) -> dict[str, str]:
    return {"value": value, "precision": precision}


def first_date(text: str) -> dict[str, str] | None:
    if match := DATE_RE.search(text):
        return date_value(match.group(1), "day")
    if match := HUMAN_DAY_RE.search(text):
        parsed = datetime.strptime(" ".join(match.groups()), "%B %d %Y")
        return date_value(parsed.strftime("%Y-%m-%d"), "day")
    if match := HUMAN_MONTH_RE.search(text):
        parsed = datetime.strptime(" ".join(match.groups()), "%B %Y")
        return date_value(parsed.strftime("%Y-%m"), "month")
    if match := re.search(r"\b(1[89]\d{2}|20\d{2})\b", text):
        return date_value(match.group(1), "year")
    return None


def all_iso_dates(text: str) -> list[dict[str, str]]:
    return [date_value(value, "day") for value in DATE_RE.findall(text)]


def nearest_date(text: str, anchor: re.Pattern[str]) -> dict[str, str] | None:
    anchors = list(anchor.finditer(text))
    if not anchors:
        return None
    candidates: list[tuple[int, int, dict[str, str]]] = []
    for pattern in (DATE_RE, HUMAN_DAY_RE, HUMAN_MONTH_RE, re.compile(r"\b(?:1[89]\d{2}|20\d{2})\b")):
        for match in pattern.finditer(text):
            parsed = first_date(match.group(0))
            if parsed:
                candidates.append((match.start(), match.end(), parsed))
    if not candidates:
        return None

    def distance(candidate: tuple[int, int, dict[str, str]]) -> int:
        start, end, _ = candidate
        return min(max(anchor_match.start() - end, start - anchor_match.end(), 0) for anchor_match in anchors)

    return min(candidates, key=distance)[2]


def label_text(value: str) -> str:
    return compact("".join(character for character in value if unicodedata.category(character) != "Cf"))


def source_role(table: Tag) -> str:
    caption = table.find("caption")
    if caption and compact(caption.get_text(" ", strip=True)):
        return compact(caption.get_text(" ", strip=True))
    heading = table.find_previous(["h2", "h3", "h4", "h5", "h6"])
    return compact(heading.get_text(" ", strip=True)) if heading else "Member"


def table_rows(table: Tag) -> Iterable[tuple[list[str], list[str]]]:
    header_row = table.find("tr")
    if not header_row:
        return
    headers = [compact(cell.get_text(" ", strip=True)).lower() for cell in header_row.find_all(["th", "td"])]
    for row in table.find_all("tr")[1:]:
        cells = [compact(cell.get_text(" ", strip=True)) for cell in row.find_all(["th", "td"], recursive=False)]
        if cells:
            yield headers, cells


def column(headers: list[str], *needles: str) -> int | None:
    for index, header in enumerate(headers):
        if all(needle in header for needle in needles):
            return index
    return None


@dataclass
class Page:
    source_id: str
    url: str
    html: bytes
    soup: BeautifulSoup


class Builder:
    def __init__(self, raw_dir: Path | None = None) -> None:
        self.generated_at = datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
        self.raw_dir = raw_dir
        self.sources: dict[str, dict] = {}
        self.people: dict[str, dict] = {}
        self.positions: dict[str, dict] = {}
        self.roster_observations: dict[str, dict] = {}

    def page(self, source_id: str, url: str, html: bytes) -> Page:
        retrieved = datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
        digest = hashlib.sha256(html).hexdigest()
        if self.raw_dir:
            self.raw_dir.mkdir(parents=True, exist_ok=True)
            raw_path = self.raw_dir / f"{digest}.html"
            if not raw_path.exists():
                raw_path.write_bytes(html)
        self.sources[source_id] = {
            "id": source_id,
            "url": url,
            "retrievedAt": retrieved,
            "sha256": digest,
        }
        return Page(source_id, url, html, BeautifulSoup(html, "html.parser"))

    def person(self, source_name: str, source_id: str) -> tuple[str, str]:
        name = clean_name(source_name)
        if len(name) < 2 or "vacant" in name.lower():
            return "", ""
        name_key = compact(unicodedata.normalize("NFKD", name).encode("ascii", "ignore").decode()).lower()
        identity_key = f"{source_id}\0{name_key}"
        person_id = f"person-{slug(name)}-{hashlib.sha1(identity_key.encode()).hexdigest()[:8]}"
        person = self.people.setdefault(person_id, {"id": person_id, "canonicalName": name, "aliases": []})
        source_name = compact(source_name).replace("﹡", "").replace("*", "").strip()
        if source_name != name and source_name not in person["aliases"]:
            person["aliases"].append(source_name)
        return person_id, name

    @staticmethod
    def evidence(page: Page, quote: str) -> dict[str, str]:
        return {"sourceId": page.source_id, "sourceQuote": compact(quote)}

    def add_position(
        self,
        name: str,
        court_id: str,
        start: dict[str, str] | None,
        end: dict[str, str] | None,
        role: str,
        assignment: str,
        page: Page,
        quote: str,
    ) -> None:
        person_id, canonical_name = self.person(name, page.source_id)
        if not person_id:
            return
        role = compact(role) or "Member"
        role_key = position_type(role)
        interval = f"{start['value'] if start else 'open'}-{end['value'] if end else 'open'}"
        record_id = f"position-{court_id}-{slug(canonical_name)}-{role_key}-{slug(interval)}-{person_id.rsplit('-', 1)[-1]}"
        claim = self.evidence(page, quote)
        if record_id in self.positions:
            if claim not in self.positions[record_id]["evidence"]:
                self.positions[record_id]["evidence"].append(claim)
            return
        self.positions[record_id] = {
            "id": record_id,
            "personId": person_id,
            "courtId": court_id,
            "dateStart": start,
            "dateTermination": end,
            "positionType": role_key,
            "role": role,
            "assignmentType": assignment,
            "evidence": [claim],
        }

    def add_observation(
        self,
        name: str,
        court_id: str,
        role: str,
        page: Page,
        quote: str,
    ) -> None:
        person_id, canonical_name = self.person(name, page.source_id)
        if not person_id:
            return
        role = compact(role) or "Member"
        role_key = position_type(role)
        observed_on = self.sources[page.source_id]["retrievedAt"][:10]
        record_id = f"observation-{court_id}-{slug(canonical_name)}-{role_key}-{observed_on}-{person_id.rsplit('-', 1)[-1]}"
        claim = self.evidence(page, quote)
        if record_id in self.roster_observations:
            if claim not in self.roster_observations[record_id]["evidence"]:
                self.roster_observations[record_id]["evidence"].append(claim)
            return
        self.roster_observations[record_id] = {
            "id": record_id,
            "personId": person_id,
            "courtId": court_id,
            "observedOn": observed_on,
            "positionType": role_key,
            "role": role,
            "evidence": [claim],
        }

    def value(self) -> dict:
        courts = [
            {
                "id": court_id,
                "canonicalName": name,
                "aliases": aliases,
                "datasetAliases": dataset_aliases,
            }
            for court_id, (name, aliases, dataset_aliases) in COURTS.items()
        ]
        return {
            "version": 1,
            "generatedAt": self.generated_at,
            "sources": sorted(self.sources.values(), key=lambda item: item["id"]),
            "people": sorted(self.people.values(), key=lambda item: item["canonicalName"]),
            "courts": courts,
            "positions": sorted(self.positions.values(), key=lambda item: item["id"]),
            "rosterObservations": sorted(self.roster_observations.values(), key=lambda item: item["id"]),
        }

    def write(self, output: Path) -> None:
        output.parent.mkdir(parents=True, exist_ok=True)
        temporary = output.with_suffix(output.suffix + ".tmp")
        temporary.write_text(json.dumps(self.value(), ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        temporary.replace(output)


def fetch(url: str) -> bytes:
    request = Request(url, headers={"User-Agent": USER_AGENT, "Accept": "text/html"})
    with urlopen(request, timeout=60) as response:
        return response.read()


def parse_scc(builder: Builder, page: Page) -> None:
    for heading in page.soup.find_all("h2"):
        label = compact(heading.get_text(" ", strip=True)).lower()
        if label not in {"current judges", "former judges"}:
            continue
        table = heading.find_next("table")
        if not table:
            continue
        current = label == "current judges"
        for row in table.find_all("tr")[1:]:
            cells = row.find_all(["th", "td"], recursive=False)
            if len(cells) < 2:
                continue
            name_text = compact(cells[0].get_text(" ", strip=True))
            dates = all_iso_dates(" | ".join(cell.get_text(" ", strip=True) for cell in cells[1:]))
            if not dates:
                continue
            role = "Chief Justice" if "chief justice" in name_text.lower() else "Justice"
            builder.add_position(name_text, "scc", dates[0], None if current else dates[-1], role, "permanent", page, row.get_text(" | ", strip=True))


def section_entries(root: Tag) -> Iterable[tuple[str, Tag, Tag]]:
    section = ""
    for tag in root.find_all(["span", "h4", "h5", "h6", "b", "strong"]):
        text = compact(tag.get_text(" ", strip=True))
        classes = tag.get("class") or []
        if "sub-title" in classes or tag.name in {"h4", "h5"}:
            section = text.lower()
            continue
        if tag.name not in {"b", "strong"} or not re.search(r"\b(?:justice|judge|master)\b", text, re.I):
            continue
        details = tag.find_next("ul")
        if details:
            yield section, tag, details


def parse_bc(builder: Builder, page: Page, court_id: str) -> None:
    content = page.soup.select_one(".quick-link-wrap") or page.soup
    for section, name_tag, details in section_entries(content):
        name_text = compact(name_tag.get_text(" ", strip=True))
        detail_text = compact(details.get_text(" | ", strip=True))
        if any(word in section for word in ("registrar", "location", "seniority")):
            continue
        is_former = "former" in section
        if court_id == "bcca":
            if not ("current justices" in section or "former" in section or "chief justice" in name_text.lower()):
                continue
            if is_former:
                match = YEAR_RANGE_RE.search(detail_text)
                start, end = (date_value(match.group(1), "year"), date_value(match.group(2), "year")) if match else (None, None)
            else:
                lines = [compact(item.get_text(" ", strip=True)) for item in details.find_all("li")]
                direct = [line for line in lines if re.search(r"appointed (?:to )?(?:the )?court of appeal", line, re.I)]
                start, end = (first_date(direct[-1]) if direct else None), None
            role = "Chief Justice" if "chief justice" in name_text.lower() else "Justice of Appeal"
        else:
            allowed = "judge" in section or "justice" in section or "associate judge" in section or "master" in section
            if not allowed and not re.search(r"chief justice", name_text, re.I):
                continue
            if is_former:
                match = YEAR_RANGE_RE.search(detail_text)
                start, end = (date_value(match.group(1), "year"), date_value(match.group(2), "year")) if match else (None, None)
            else:
                lines = [compact(item.get_text(" ", strip=True)) for item in details.find_all("li")]
                direct = [line for line in lines if re.search(r"appointed .*(?:supreme court|associate judge|master)", line, re.I) and "court of appeal" not in line.lower()]
                start, end = (first_date(direct[-1]) if direct else None), None
            role = "Associate Judge" if re.search(r"associate judge|master", section + " " + name_text, re.I) else "Chief Justice" if "chief justice" in name_text.lower() else "Justice"
        if not start:
            continue
        assignment = "supernumerary" if "*" in name_tag.get_text() else "other" if role == "Associate Judge" else "permanent"
        builder.add_position(name_text, court_id, start, end, role, assignment, page, f"{name_text} | {detail_text}")


def parse_onca_current(builder: Builder, page: Page) -> None:
    for profile in page.soup.select(".su-spoiler"):
        title = profile.select_one(".su-spoiler-title")
        body = profile.select_one(".su-spoiler-content")
        if not title or not body:
            continue
        name = compact(title.get_text(" ", strip=True))
        text = compact(body.get_text(" ", strip=True))
        sentences = re.split(r"(?<=[.!?])\s+", text)
        appointments = [sentence for sentence in sentences if re.search(r"appointed .*?(?:court of appeal for ontario|ontario court of appeal)", sentence, re.I)]
        start = first_date(appointments[0]) if appointments else None
        if start:
            builder.add_position(name, "onca", start, None, "Justice of Appeal", "permanent", page, f"{name} | {appointments[0]}")


def parse_simple_tenure_tables(builder: Builder, page: Page, court_id: str, default_role: str) -> None:
    for table in page.soup.find_all("table"):
        role = source_role(table) or default_role
        for headers, cells in table_rows(table):
            name_index = column(headers, "name")
            start_index = column(headers, "appointment")
            end_index = column(headers, "departure")
            tenure_index = column(headers, "tenure")
            if tenure_index is None:
                tenure_index = column(headers, "years", "court")
            if name_index is None or name_index >= len(cells):
                continue
            start = end = None
            if start_index is not None and start_index < len(cells):
                start = first_date(cells[start_index])
            if end_index is not None and end_index < len(cells):
                end = first_date(cells[end_index])
            if tenure_index is not None and tenure_index < len(cells):
                if match := YEAR_RANGE_RE.search(cells[tenure_index]):
                    start, end = date_value(match.group(1), "year"), date_value(match.group(2), "year")
            if start:
                builder.add_position(cells[name_index], court_id, start, end, role, "permanent", page, " | ".join(cells))


def parse_fca(builder: Builder, page: Page) -> None:
    for details in page.soup.find_all("details"):
        summary = details.find("summary")
        if not summary:
            continue
        title = compact(summary.get_text(" ", strip=True))
        if title.lower() == "former judges":
            temporary = Page(page.source_id, page.url, page.html, BeautifulSoup(str(details), "html.parser"))
            parse_simple_tenure_tables(builder, temporary, "fca", "Justice of Appeal")
            continue
        if not title.lower().startswith("the honourable"):
            continue
        text = compact(details.get_text(" ", strip=True))
        sentences = re.split(r"(?<=[.!?])\s+", text)
        direct = [sentence for sentence in sentences if re.search(r"appointed .*?judge of (?:the )?federal court of appeal", sentence, re.I) and "ex officio" not in sentence.lower()]
        start = first_date(direct[0]) if direct else None
        if start:
            heading = details.find_previous("h2")
            role = "Chief Justice" if heading and "chief justice" in heading.get_text(" ", strip=True).lower() else "Justice of Appeal"
            assignment = "supernumerary" if "﹡" in title or "*" in title else "permanent"
            builder.add_position(title, "fca", start, None, role, assignment, page, f"{title} | {direct[0]}")


def parse_fc_current(builder: Builder, page: Page, output: Path, workers: int) -> None:
    links: dict[str, str] = {}
    for anchor in page.soup.select('a[href*="/members-of-the-court/"]'):
        href = anchor.get("href")
        if not href or not re.search(r"/(?:judges|associate-judges)/", href):
            continue
        links[urljoin(page.url, href)] = "Associate Judge" if "/associate-judges/" in href else "Justice"
    print(f"  fc profiles: {len(links)} (parallel={workers})", file=sys.stderr, flush=True)
    with ThreadPoolExecutor(max_workers=workers) as pool:
        futures = {pool.submit(fetch, url): (url, role) for url, role in links.items()}
        for completed, future in enumerate(as_completed(futures), 1):
            url, role = futures[future]
            try:
                html = future.result()
                profile = builder.page(f"fc-profile-{hashlib.sha1(url.encode()).hexdigest()[:12]}", url, html)
                title = profile.soup.find("h1")
                name = compact(title.get_text(" ", strip=True)) if title else ""
                text = compact((profile.soup.select_one("main") or profile.soup).get_text(" ", strip=True))
                sentences = re.split(r"(?<=[.!?])\s+", text)
                direct = [sentence for sentence in sentences if re.search(r"appointed .*?(?:judge|justice|associate judge) (?:of|to) (?:the )?federal court", sentence, re.I) and "appeal" not in sentence.lower()]
                start = first_date(direct[0]) if direct else None
                if name and start:
                    assignment = "supernumerary" if re.search(r"supernumerary", text[:1000], re.I) else "other" if role == "Associate Judge" else "permanent"
                    builder.add_position(name, "fc", start, None, role, assignment, profile, f"{name} | {direct[0]}")
            except Exception as error:
                print(f"  fc profile failed: {url}: {error}", file=sys.stderr, flush=True)
            if completed % 5 == 0 or completed == len(futures):
                builder.write(output)
                print(f"  fc profiles: {completed}/{len(futures)}", file=sys.stderr, flush=True)


def parse_tcc(builder: Builder, page: Page) -> None:
    for modal in page.soup.select(".modal"):
        title = modal.select_one(".modal-title")
        body = modal.select_one(".modal-body")
        if not title or not body:
            continue
        name = compact(title.get_text(" ", strip=True))
        text = compact(body.get_text(" ", strip=True))
        sentences = re.split(r"(?<=[.!?])\s+", text)
        direct = [sentence for sentence in sentences if re.search(r"appointed .*?(?:judge|justice|associate judge).*?tax court of canada", sentence, re.I)]
        start = first_date(direct[0]) if direct else None
        if start:
            role = "Associate Judge" if "associate judge" in direct[0].lower() else "Justice"
            builder.add_position(name, "tcc", start, None, role, "other" if role == "Associate Judge" else "permanent", page, f"{name} | {direct[0]}")
    parse_simple_tenure_tables(builder, page, "tcc", "Justice")


CMAC_RE = re.compile(r"\bCourt Martial Appeal Court(?: of Canada)?\b", re.I)


def parse_cmac(builder: Builder, page: Page) -> None:
    for item in page.soup.find_all("li"):
        if item.find_parent("li"):
            continue
        strings = [compact(value) for value in item.stripped_strings if compact(value)]
        if not strings or not re.match(r"The Honou?rable\b", strings[0], re.I):
            continue
        text = compact(item.get_text(" ", strip=True))
        start = nearest_date(text, CMAC_RE)
        if not start:
            continue
        sentences = re.split(r"(?<=[.!?])\s+", text)
        claim = next((sentence for sentence in sentences if CMAC_RE.search(sentence)), text)
        heading = item.find_previous(["h2", "h3"])
        heading_text = compact(heading.get_text(" ", strip=True)).lower() if heading else ""
        if "deputy" in claim.lower() or "*" in strings[0]:
            role, assignment = "Deputy Judge", "deputy"
        elif "chief justice" in heading_text:
            role, assignment = "Chief Justice", "permanent"
        else:
            role, assignment = "Judge", "permanent"
        builder.add_position(strings[0], "cmac", start, None, role, assignment, page, f"{strings[0]} | {claim}")


def parse_nova_scotia_current(builder: Builder, page: Page) -> None:
    court_id: str | None = None
    court_by_heading = {
        "court of appeal": "nsca",
        "supreme court": "nssc",
        "supreme court (family division)": "nssc",
        "provincial court": "nspc",
    }
    for tag in page.soup.find_all(["h2", "h4", "p", "li"]):
        text = label_text(tag.get_text(" ", strip=True))
        if tag.name == "h2":
            court_id = court_by_heading.get(text.lower())
            continue
        if not court_id:
            continue
        if tag.name == "h4":
            next_tag = tag.find_next(["p", "div"])
            role_text = label_text(next_tag.get_text(" ", strip=True)) if next_tag else ""
            if re.search(r"\b(?:chief|associate chief)\s+(?:justice|judge)\b", role_text, re.I):
                role = re.search(r"\b((?:associate )?chief (?:justice|judge)(?: of [^|]+)?)", role_text, re.I)
                builder.add_observation(text, court_id, role.group(1) if role else "Chief Justice", page, f"{text} | {role_text}")
            continue
        if tag.find_parent(["p", "li"]):
            continue
        for source_name in tag.stripped_strings:
            source_name = compact(source_name)
            if not re.match(r"^(?:Justice|Judge)\s+", source_name, re.I) or source_name.endswith(":"):
                continue
            marked = "*" in source_name
            if court_id == "nspc":
                role = "Part-time Judge" if marked else "Judge"
            else:
                role = "Supernumerary Justice" if marked else "Justice"
            builder.add_observation(source_name, court_id, role, page, source_name)


def split_irb_member(value: str) -> tuple[str, str] | None:
    value = label_text(value)
    if not value or value.startswith(","):
        return None
    role_match = re.search(
        r",\s*((?:Acting\s+)?(?:Assistant\s+)?Deputy Chairperson(?:,.*)?|Director(?:,.*)?)$",
        value,
        re.I,
    )
    if role_match:
        role = compact(role_match.group(1))
        if role.lower().startswith("director"):
            return None
        return value[: role_match.start()].strip(), role
    return value, "Part-time Member" if "part-time" in value.lower() else "Member"


def parse_irb_current(builder: Builder, page: Page) -> None:
    court_id: str | None = None
    division_by_label = {
        "refugee protection division": "rpd",
        "refugee appeal division": "rad",
    }
    for node in page.soup.descendants:
        if isinstance(node, str):
            lower = label_text(node).lower()
            if lower in division_by_label:
                court_id = division_by_label[lower]
            elif lower in {"immigration division", "immigration appeal division"}:
                court_id = None
            continue
        if not isinstance(node, Tag) or node.name != "li" or node.find_parent("li") or not court_id:
            continue
        text = label_text(node.get_text(" ", strip=True))
        member = split_irb_member(text)
        if member:
            name, role = member
            builder.add_observation(name, court_id, role, page, f"{COURTS[court_id][0]} | {text}")


def parse_federal_profile(builder: Builder, page: Page, route: Callable[[str], str | None]) -> None:
    for table in page.soup.find_all("table"):
        role = source_role(table)
        court_id = route(role.lower())
        if not court_id:
            continue
        for headers, cells in table_rows(table):
            name_index = column(headers, "name")
            current_index = column(headers, "current", "appointment")
            expiry_index = column(headers, "expiry")
            if name_index is None or name_index >= len(cells):
                continue
            # The displayed role begins with the current appointment, not the
            # person's earlier original appointment to the organization.
            start_text = cells[current_index] if current_index is not None and current_index < len(cells) else ""
            end_text = cells[expiry_index] if expiry_index is not None and expiry_index < len(cells) else ""
            start, end = first_date(start_text), first_date(end_text)
            if start:
                builder.add_position(cells[name_index], court_id, start, end, role, "other", page, f"{role} | {' | '.join(cells)}")


def selected_sources(requested: list[str]) -> list[str]:
    available = list(SOURCE_URLS) + list(FEDERAL_PROFILES)
    if not requested or requested == ["all"]:
        return available
    unknown = sorted(set(requested) - set(available))
    if unknown:
        raise SystemExit(f"unknown sources: {', '.join(unknown)}; choose from {', '.join(available)}")
    return requested


def parse_source(builder: Builder, key: str, page: Page, route: Callable[[str], str | None] | None, output: Path, workers: int) -> None:
    if key == "scc":
        parse_scc(builder, page)
    elif key in {"bcca", "bcsc"}:
        parse_bc(builder, page, key)
    elif key == "onca-current":
        parse_onca_current(builder, page)
    elif key == "onca-former":
        parse_simple_tenure_tables(builder, page, "onca", "Justice of Appeal")
    elif key == "fca":
        parse_fca(builder, page)
    elif key == "fc":
        parse_fc_current(builder, page, output, workers)
    elif key == "fc-former":
        parse_simple_tenure_tables(builder, page, "fc", "Justice")
    elif key == "tcc":
        parse_tcc(builder, page)
    elif key == "cmac":
        parse_cmac(builder, page)
    elif key == "nova-scotia-current":
        parse_nova_scotia_current(builder, page)
    elif key == "irb-current":
        parse_irb_current(builder, page)
    elif route:
        parse_federal_profile(builder, page, route)


def append_attempt(output: Path, value: dict) -> None:
    with output.open("a", encoding="utf-8") as stream:
        stream.write(json.dumps(value, ensure_ascii=False) + "\n")


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--source", action="append", default=[], help="source key; repeat, or use all")
    parser.add_argument("--out", type=Path, default=Path(__file__).with_name("runs") / "judge-court-service.json")
    parser.add_argument("--workers", type=int, default=10)
    args = parser.parse_args()
    sources = selected_sources(args.source)
    raw_dir = args.out.with_suffix(args.out.suffix + ".sources")
    attempts = args.out.with_suffix(args.out.suffix + ".sources.jsonl")
    attempts.parent.mkdir(parents=True, exist_ok=True)
    attempts.write_text("", encoding="utf-8")
    builder = Builder(raw_dir)
    jobs = []
    for index, key in enumerate(sources, 1):
        if key in FEDERAL_PROFILES:
            org_id, route = FEDERAL_PROFILES[key]
            url = f"https://federal-organizations.canada.ca/profil.php?OrgID={org_id}&lang=en"
        else:
            route = None
            url = SOURCE_URLS[key]
        jobs.append((index, key, url, route))
    worker_count = max(1, min(16, args.workers))
    with ThreadPoolExecutor(max_workers=worker_count) as pool:
        futures = {pool.submit(fetch, url): (index, key, url, route) for index, key, url, route in jobs}
        for completed, future in enumerate(as_completed(futures), 1):
            index, key, url, route = futures[future]
            print(f"[{completed}/{len(sources)}; source {index}] {key}: {url}", file=sys.stderr, flush=True)
            status, error_text = "success", None
            before = (len(builder.people), len(builder.positions), len(builder.roster_observations))
            try:
                page = builder.page(key, url, future.result())
                parse_source(builder, key, page, route, args.out, worker_count)
            except Exception as error:
                status, error_text = "failed", str(error)
                print(f"  failed: {error}", file=sys.stderr, flush=True)
            builder.write(args.out)
            after = (len(builder.people), len(builder.positions), len(builder.roster_observations))
            append_attempt(attempts, {
                "source": key,
                "url": url,
                "status": status,
                "error": error_text,
                "people_added": after[0] - before[0],
                "positions_added": after[1] - before[1],
                "observations_added": after[2] - before[2],
                "snapshot": str(args.out),
            })
            print(
                f"  totals: {after[0]} people, {after[1]} positions, {after[2]} roster observations",
                file=sys.stderr,
                flush=True,
            )
    print(args.out)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
