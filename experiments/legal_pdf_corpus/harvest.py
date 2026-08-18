"""Small, resumable harvester for the requested public legal-PDF corpus."""

from __future__ import annotations

import argparse
import hashlib
import html
import json
import os
import re
import shutil
import sys
import time
from collections import Counter, defaultdict
from datetime import datetime, timezone
from html.parser import HTMLParser
from pathlib import Path
from urllib.parse import parse_qs, quote, urlencode, urljoin, urlsplit, urlunsplit
from urllib.error import HTTPError
from urllib.request import Request, urlopen


ROOT = Path(__file__).resolve().parent
STATE = ROOT / "state"
CANDIDATES = STATE / "candidates.jsonl"
LEDGER = ROOT / "ledger.jsonl"
INVENTORY = STATE / "source_inventory.json"
PDF_ROOT = ROOT / "pdfs"
TMP_ROOT = STATE / "tmp"
USER_AGENT = os.environ.get(
    "LEGAL_PDF_USER_AGENT",
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 BeaverLegalPdfCorpus/1.0 (public legal PDF research)",
)

JURISDICTION_TARGETS = {"ca": 975, "us": 150, "uk": 225, "au": 75, "nz": 75}
GENERATION_TARGETS = {"digitalborn": 750, "non_digital": 750}
TOTAL_TARGET = sum(JURISDICTION_TARGETS.values())

SOURCE_URLS = {
    "scc": "https://www.scc-csc.ca/cases-dossiers/records-documents/",
    "cullen_commission": "https://www.cullencommission.ca/exhibits/",
    "foreign_interference_commission": "https://foreigninterferencecommission.ca/documents/exhibits-and-presentations",
    "post_office_horizon_inquiry": "https://www.postofficehorizoninquiry.org.uk/",
    "australian_parliament_submissions": "https://www.aph.gov.au/Parliamentary_Business/Committees/",
    "australian_royal_commission": "https://defenceveteransuicide.royalcommission.gov.au/publications/evidence",
    "waitangi_tribunal": "https://www.waitangitribunal.govt.nz/en/reports-and-documents",
    "air_india_inquiry": "https://www.majorcomm.ca/en/submissions.html",
    "poec_submissions": "https://publicorderemergencycommission.ca/documents/closing-submissions/",
    "poec_exhibits": "https://publicorderemergencycommission.ca/documents/presentations-overview-reports-and-exhibits/",
    "driskell_inquiry": "https://www.driskellinquiry.ca/submissions.html",
    "uk_gov_legal_workflow": "https://www.gov.uk/government/publications/investigation-into-the-death-of-nadheem-abdullah",
    "nz_abuse_in_care": "https://www.abuseincare.org.nz/research-and-engagement/evidence-library",
    "nz_judicial_conduct_panel": "https://www.justice.govt.nz/tribunals/judicial-conduct-panels/",
    "cnsc_meeting_documents": "https://www.cnsc-ccsn.gc.ca/eng/the-commission/hearings-meetings/search-meeting-documents/",
    "cnsc_hearing_documents": "https://www.cnsc-ccsn.gc.ca/eng/the-commission/hearings-meetings/download-meeting-documents/",
    "canada_commission_archive": "https://www.canada.ca/en/privy-council/services/commissions-inquiry.html",
    "canada_publication_commissions": "https://publications.gc.ca/site/eng/search/search.html?text=commission+of+inquiry&format1=Electronic",
    "canadiana_legal_monographs": "https://www.canadiana.ca/search?q=law",
    "uk_legal_monographs": "https://archive.org/advancedsearch.php?q=subject%3A%22English%20law%22%20AND%20mediatype%3Atexts",
    "walkerton_inquiry": "https://www.archives.gov.on.ca/en/e_records/walkerton/",
    "canada_competition_bureau": "https://competition-bureau.canada.ca/how-we-foster-competition/education-and-outreach/publications",
    "crtc_public_proceedings": "https://crtc.gc.ca/eng/consultation/index.htm",
    "crtc_legislative_review": "https://ised-isde.canada.ca/site/broadcasting-telecommunications-legislative-review/en/broadcasting-and-telecommunications-legislative-review-submissions",
    "cer_workflow": "https://www.cer-rec.gc.ca/en/applications-hearings/submit-applications-documents/",
    "canada_justice_research": "https://www.justice.gc.ca/eng/rp-pr/",
    "canada_federal_tenders": "https://canadabuys.canada.ca/en/tender-opportunities",
    "federal_judicial_forms": "https://www.fja.gc.ca/appointments-nominations/forms-formulaires/ar-ac/index-eng.html",
    "ontario_court_forms": "https://ontariocourtforms.on.ca/en/rules-of-civil-procedure-forms/",
    "alberta_court_forms": "https://albertacourts.ca/kb/areas-of-law/civil/forms",
    "manitoba_court_forms": "https://www.manitobacourts.mb.ca/provincial-court/legal-resources-and-links/forms/",
    "bc_court_forms": "https://www.bccourts.ca/supreme_court/practice_and_procedure/acts_rules_and_forms/",
    "quebec_justice_forms": "https://www.quebec.ca/justice-et-etat-civil/systeme-judiciaire/formulaires-modeles",
    "ontario_cfr_forms": "https://forms.mgcs.gov.on.ca/dataset/?organization=ministry-of-the-attorney-general&q=ontario+court+forms",
    "nova_scotia_court_forms": "https://www.courts.ns.ca/operations/forms-documents/civil-procedure-rules-forms",
    "saskatchewan_court_procedure": "https://sasklawcourts.ca/court-of-appeal/rules-practice-directives/",
    "new_brunswick_court_forms": "https://www.courtsnb-coursnb.ca/content/cour/en/forms.html",
    "newfoundland_court_forms": "https://www.court.nl.ca/supreme/rules-practice-notes-and-forms/family/general/",
    "pei_court_forms": "https://www.courts.pe.ca/forms",
    "yukon_court_forms": "https://www.yukoncourts.ca/en/supreme-court/rules-forms",
    "nwt_court_rules": "https://www.justice.gov.nt.ca/en/court-rules/",
    "nunavut_court_forms": "https://www.nunavutcourts.ca/index.php/forms/category/98-civil-rules",
    "federal_court_canada_forms": "https://www.fct-cf.ca/en/online-access/forms",
    "federal_court_canada_practice": "https://www.fct-cf.ca/en/online-access/practice-guidelines",
    "tax_court_canada_forms": "https://www.tcc-cci.gc.ca/en/pages/forms",
    "chrt_forms": "https://www.chrt-tcdp.gc.ca/en/human-rights/human-rights-forms",
    "competition_tribunal_workflow": "https://www.ct-tc.gc.ca/en/procedure/notices-practice-directions.html",
    "citt_workflow": "https://www.citt-tcce.gc.ca/en/about-tribunal/forms-practices-and-procedures",
    "canada_immigration_workflow": "https://www.irb-cisr.gc.ca/en/legal-policy/Pages/index.aspx",
    "canada_transport_agency": "https://otc-cta.gc.ca/eng/publications",
    "alberta_procurement": "https://www.alberta.ca/find-and-compete-for-government-contracts",
    "bc_procurement": "https://www2.gov.bc.ca/gov/content/bc-procurement-resources/buy-for-government/solicitation-processes-and-templates",
    "ontario_procurement": "https://www.ontario.ca/files/2024-02/tbs-bps-procurement-directive-en-2024-02-08.pdf",
    "quebec_procurement": "https://www.quebec.ca/gouvernement/gestion-administrative/marches-publics",
    "canada_federal_rfps": "https://canadabuys.canada.ca/en/tender-opportunities",
    "canada_federal_rfis": "https://canadabuys.canada.ca/en/tender-opportunities",
    "bc_procurement_rfp": "https://www2.gov.bc.ca/gov/content/bc-procurement-resources/buy-for-government/solicitation-processes-and-templates",
    "uk_infected_blood_inquiry": "https://www.infectedbloodinquiry.org.uk/evidence",
    "uk_infected_blood_workflow": "https://www.infectedbloodinquiry.org.uk/statements-approach",
    "uk_ipo_tribunal_workflow": "https://www.gov.uk/government/publications/filing-evidence-about-an-application-or-in-tribunal-proceedings",
    "uk_grenfell_inquiry": "https://www.grenfelltowerinquiry.org.uk/evidence",
    "uk_judiciary_workflow": "https://www.judiciary.uk/publications/",
    "uk_covid_inquiry": "https://covid19.public-inquiry.uk/documents/",
    "uk_justice_civil_rules": "https://www.justice.gov.uk/courts/procedure-rules/civil",
    "uk_justice_civil_forms": "https://www.justice.gov.uk/courts/procedure-rules/civil/forms",
    "uk_justice_family_rules": "https://www.justice.gov.uk/courts/procedure-rules/family",
    "uk_justice_family_forms": "https://www.justice.gov.uk/courts/procedure-rules/family/formspage",
    "uk_justice_criminal_rules": "https://www.justice.gov.uk/courts/procedure-rules/criminal",
    "uk_justice_criminal_forms": "https://www.justice.gov.uk/courts/procedure-rules/criminal/docs/forms",
    "uk_justice_form_n1": "https://www.gov.uk/government/publications/form-n1-claim-form-cpr-part-7",
    "uk_hmcts_forms": "https://www.gov.uk/government/collections/court-and-tribunal-forms",
    "uk_manchester_arena_inquiry": "https://www.gov.uk/government/collections/manchester-arena-inquiry-reports",
    "uk_thirlwall_inquiry": "https://thirlwall.public-inquiry.uk/evidence/",
    "uk_iicsa_inquiry": "https://www.iicsa.org.uk/investigations",
    "uk_windrush_lessons": "https://www.gov.uk/government/collections/windrush-lessons-learned-review",
    "uk_gosport_inquiry": "https://www.gosportinquiry.org/",
    "uk_daniel_morgan_inquiry": "https://www.danielmorganinquiry.org.uk/",
    "uk_crown_commercial_service": "https://www.gov.uk/government/collections/crown-commercial-service-guidance-and-policies",
    "uk_covid_inquiry_evidence": "https://covid19.public-inquiry.uk/documents/",
    "uk_grenfell_key_documents": "https://www.grenfelltowerinquiry.org.uk/key-documents",
    "uk_fuller_inquiry": "https://www.gov.uk/government/collections/david-fuller-inquiry",
    "uk_public_inquiry_responses": "https://www.gov.uk/government/collections/public-inquiries-recommendations-and-the-government-response",
    "us_gao_legal": "https://www.gao.gov/legal/decisions",
    "us_ftc_cases": "https://www.ftc.gov/legal-library/browse/cases-proceedings",
    "us_doj_antitrust": "https://www.justice.gov/atr/cases-and-matters",
    "us_osc_public_files": "https://osc.gov/cases/",
    "us_sec_litigation": "https://www.sec.gov/enforcement-litigation/litigation-releases",
    "us_cftc_enforcement": "https://www.cftc.gov/LawRegulation/Enforcement/Orders",
    "us_cfpb_enforcement": "https://www.consumerfinance.gov/enforcement/actions/",
    "us_epa_enforcement": "https://www.epa.gov/enforcement/enforcement-cases",
    "us_supreme_briefs": "https://www.supremecourt.gov/meritsbriefs/meritsbriefs.aspx",
    "us_supreme_transcripts": "https://www.supremecourt.gov/oral_arguments/argument_transcript/2024",
    "us_court_forms": "https://www.uscourts.gov/forms-rules/forms",
    "us_federal_circuit_forms": "https://www.cafc.uscourts.gov/home/rules-procedures-forms/court-forms/",
    "us_court_forms_civil_prose": "https://www.uscourts.gov/forms-rules/forms/civil-pro-se-forms",
    "us_court_forms_criminal": "https://www.uscourts.gov/forms-rules/forms/criminal-forms",
    "us_court_forms_subpoena": "https://www.uscourts.gov/forms-rules/forms/subpoena-forms",
    "us_court_forms_bankruptcy": "https://www.uscourts.gov/forms-rules/forms/bankruptcy-forms",
    "us_gao_bid_protests": "https://www.gao.gov/legal/bid-protests/recent",
    "us_gao_appropriations": "https://www.gao.gov/legal/appropriations-law/search",
    "us_gao_bid_protest_decisions": "https://www.gao.gov/legal/bid-protests/recent",
    "us_uscourts_civil_forms": "https://www.uscourts.gov/forms-rules/forms/civil-forms",
    "us_uscourts_bankruptcy_forms": "https://www.uscourts.gov/forms-rules/forms/bankruptcy-forms",
    "us_justice_employment_litigation": "https://www.justice.gov/crt/employment-litigation-section-cases",
    "us_nlrb_workflow": "https://www.nlrb.gov/reports-guidance/manuals",
    "us_court_federal_claims": "https://www.uscfc.uscourts.gov/forms",
    "us_doj_civil_rights": "https://www.justice.gov/crt/cases-and-matters",
    "us_dol_litigation": "https://www.dol.gov/agencies/sol/briefs",
    "au_alrc": "https://www.alrc.gov.au/publications/",
    "au_accc": "https://www.accc.gov.au/publications",
    "au_solicitor_general": "https://www.ag.gov.au/about-us/who-we-are/office-solicitor-general",
    "au_ombudsman": "https://www.ombudsman.gov.au/publications",
    "au_human_rights": "https://humanrights.gov.au/our-work/legal",
    "au_federal_court_files": "https://www.fedcourt.gov.au/services/access-to-files-and-transcripts/online-files",
    "au_nsw_law_reform": "https://www.nswlrc.org.au/publications",
    "au_high_court_forms": "https://www.hcourt.gov.au/court-procedures/forms-and-resources",
    "au_federal_court_forms": "https://www.fedcourt.gov.au/forms-and-fees/forms",
    "au_nsw_local_forms": "https://localcourt.nsw.gov.au/locations--lists-and-forms/forms-and-fees/forms.html",
    "au_nsw_practice_notes": "https://lpab.nsw.gov.au/content/dcj/ctsd/localcourt/local-court/practice-publications/practice-notes.html",
    "au_nsw_ucpr_forms": "https://dcj.nsw.gov.au/content/dcj/ctsd/ucpr/ucpr.html",
    "au_qld_court_workflow": "https://www.courts.qld.gov.au/the-courts/supreme-court/supreme-court-pathway?a=866158",
    "au_wa_court_forms": "https://www.districtcourt.wa.gov.au/C/civil_procedures_forms_print.aspx",
    "au_vic_court_forms": "https://www.supremecourt.vic.gov.au/forms-fees-and-services/forms-templates-and-guidelines",
    "au_procurement_workflow": "https://www.finance.gov.au/government/procurement",
    "au_aat_forms": "https://www.aat.gov.au/apply-to-the-aat/forms-and-guides",
    "nz_covid_inquiry": "https://www.covid19lessons.royalcommission.nz/reports-lessons-learned",
    "nz_christchurch_inquiry": "https://christchurchattack.royalcommission.nz/publications",
    "nz_law_commission": "https://www.lawcom.govt.nz/our-work/publications",
    "nz_commerce_commission": "https://www.comcom.govt.nz/about-us/publications",
    "nz_parliament_submissions": "https://www.parliament.nz/en/pb/sc/",
    "nz_justice_publications": "https://www.justice.govt.nz/about/order-a-printed-publication/",
    "nz_criminal_forms": "https://www.justice.govt.nz/about/lawyers-and-service-providers/criminal-procedure-act/forms-and-documents/",
    "nz_family_forms": "https://www.justice.govt.nz/family/separation-divorce/divide-relationship-property/forms-and-fees/",
    "nz_family_workflow": "https://www.justice.govt.nz/family/powers-to-make-decisions/the-court-and-enduring-power-of-attorney-epa/",
    "nz_courts_judgments": "https://www.courtsofnz.govt.nz/judgments",
    "nz_procurement_templates": "https://www.procurement.govt.nz/templates/",
    "nz_local_government_bylaws": "https://www.lgnz.co.nz/our-work/submissions/",
    "canada_federal_tenders": "https://canadabuys.canada.ca/en/tender-opportunities",
    "edmonton_zoning": "https://www.edmonton.ca/city_government/bylaws/zoning-bylaw",
    "calgary_zoning": "https://www.calgary.ca/planning/land-use.html?redirect=%2Flandusebylaws",
    "winnipeg_zoning": "https://www.winnipeg.ca/ppd/zoning-and-permits/zoning-bylaw",
    "toronto_zoning": "https://www.toronto.ca/city-government/planning-development/zoning-by-law-preliminary-zoning-reviews/zoning-by-law-569-2013-2/",
    "vancouver_zoning": "https://vancouver.ca/home-property-development/zoning-and-land-use-policies-document-library.aspx",
    "ottawa_zoning": "https://ottawa.ca/en/planning-development-and-construction/official-plan-and-master-plans/zoning-law",
    "mississauga_zoning": "https://www.mississauga.ca/services-and-programs/building-and-renovating/zoning-information/zoning-by-law/",
    "hamilton_zoning": "https://www.hamilton.ca/build-invest-grow/planning-development/zoning/zoning-by-law-05-200",
    "brampton_zoning": "https://www.brampton.ca/EN/City-Hall/Zoning-By-law-Review/Pages/zoning-by-laws.aspx",
    "markham_zoning": "https://www.markham.ca/economic-development-business/planning-development-services/zoning-and-development-law-information",
    "london_zoning": "https://london.ca/business-development/planning-development-applications/zoning",
    "halifax_zoning": "https://www.halifax.ca/city-hall/municipal-government/municipal-planning-strategy-land-use-bylaws",
    "regina_zoning": "https://www.regina.ca/export/sites/Regina.ca/home-property/property/.galleries/pdfs/Bylaw-2019-19-Zoning-Bylaw.pdf",
    "saskatoon_zoning": "https://www.saskatoon.ca/business-development/development-regulation/zoning",
    "surrey_zoning": "https://www.surrey.ca/renovating-building-development/zoning",
    "richmond_zoning": "https://www.richmond.ca/services/planning-land-use/zoning.htm",
    "toronto_zoning_documents": "https://www.toronto.ca/city-government/planning-development/zoning-by-law-preliminary-zoning-reviews/zoning-by-law-569-2013-2/",
    "ottawa_zoning_documents": "https://documents.ottawa.ca/en/home",
    "vancouver_zoning_documents": "https://vancouver.ca/home-property-development/zoning-and-land-use-policies-document-library.aspx",
    "uk_contracts_finder": "https://www.contractsfinder.service.gov.uk/Search",
    "au_tenders": "https://www.tenders.gov.au/",
    "nz_gets": "https://www.gets.govt.nz/",
}

# These are intentionally ceilings rather than targets. They prevent one
# inquiry, URL family, or semantic document kind from supplying the corpus.
MAX_SOURCE_ACCEPTED = 80
MAX_KIND_ACCEPTED = 40
MAX_FALLBACK_KIND_ACCEPTED = 160
MAX_SOURCE_KIND_ACCEPTED = 12
KIND_ACCEPTED_LIMITS = {
    # Canadiana contributes distinct scanned volumes and municipal/legal
    # records; the explicit ceiling keeps that broad archive bounded without
    # forcing the final Canadian scan quota into generic modern forms.
    "legal_monograph": 100,
}
SOURCE_ACCEPTED_LIMITS = {
    "canada_commission_archive": 120,
    "canadiana_legal_monographs": 240,
}
SOURCE_KIND_LIMITS = {
    "canada_commission_archive": 40,
    "canadiana_legal_monographs": 100,
    "uk_legal_monographs": 80,
    "uk_gov_legal_workflow": 40,
    "us_justice_employment_litigation": 20,
    "us_sec_litigation": 20,
    "us_osc_public_files": 20,
    "cnsc_hearing_documents": 20,
    "cnsc_meeting_documents": 20,
    "crtc_legislative_review": 20,
    "saskatchewan_court_procedure": 20,
}

SCAN_SOURCE_HINTS = frozenset({
    "canada_commission_archive", "cullen_commission", "driskell_inquiry",
    "foreign_interference_commission", "poec_exhibits", "scc",
    "uk_gov_legal_workflow", "us_osc_public_files", "waitangi_tribunal",
    "nz_judicial_conduct_panel", "nwt_court_rules", "nunavut_court_forms",
    "yukon_court_forms", "toronto_zoning", "ottawa_zoning_documents",
    "vancouver_zoning_documents", "us_justice_employment_litigation",
    "canada_commission_archive", "canadiana_legal_monographs", "uk_legal_monographs",
})
SCAN_TITLE_HINTS = (
    "scanned", "scan", "facsimile", "image-only", "image only",
    "handwritten", "manuscript", "original rules", "poster",
)

SOURCE_METADATA = {
    "canada_commission_archive": {
        "repository_size_signal": "The Privy Council Office commission index lists hundreds of historical Canadian inquiries; the harvester follows a bounded prefix of the linked Library and Archives Canada pages.",
        "size_basis": "official commission index and bounded linked-page crawl",
    },
    "canada_publication_commissions": {
        "repository_size_signal": "The Government of Canada Publications catalogue returned nine electronic result pages for the commission-of-inquiry search during reconnaissance.",
        "size_basis": "official catalogue search result pages",
    },
    "canadiana_legal_monographs": {
        "repository_size_signal": "Canadiana search exposes hundreds of thousands of public scanned items; discovery is restricted to bounded legal, court, inquiry, statute, municipal, and regulatory result pages.",
        "size_basis": "official Canadiana search result pages and item-level signed-download resolver",
    },
    "uk_legal_monographs": {
        "repository_size_signal": "Internet Archive advanced search returned 132 items for the English-law subject query during reconnaissance; discovery is restricted to bounded historical English, British, Welsh, Scottish, and Great Britain law results.",
        "size_basis": "public metadata API result count and item-level PDF file metadata",
    },
    "scc": {
        "repository_size_signal": "42,463 English case-page URLs were visible in the Court sitemap during reconnaissance.",
        "size_basis": "sitemap case-page count; the PDF subset is smaller and case-dependent",
    },
    "cullen_commission": {
        "repository_size_signal": "The inquiry exhibit index exposed approximately 1,063 exhibit slots; 1,018 unique PDF candidates were found in the first 11 pages.",
        "size_basis": "public exhibit index and partial crawl",
    },
    "foreign_interference_commission": {
        "repository_size_signal": "170 unique PDFs were found in the first 12 paginated public-document pages.",
        "size_basis": "partial paginated crawl",
    },
    "post_office_horizon_inquiry": {
        "repository_size_signal": "478 public sitemap URLs were visible; only hearing/evidence/key-document pages are treated as leads.",
        "size_basis": "public sitemap; PDF subset is page-dependent",
    },
    "waitangi_tribunal": {
        "repository_size_signal": "The public Type=documents search exposed pagination through approximately 29,370 records.",
        "size_basis": "public search pagination; not every record is a PDF",
    },
}


def now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def ensure_dirs() -> None:
    for path in (STATE, TMP_ROOT, PDF_ROOT):
        path.mkdir(parents=True, exist_ok=True)


def fetch(url: str, *, timeout: int = 60, max_bytes: int = 20_000_000) -> bytes:
    request = Request(
        url,
        headers={
            "User-Agent": USER_AGENT,
            "Accept": "text/html,application/json,application/pdf,*/*;q=0.1",
        },
    )
    with urlopen(request, timeout=timeout) as response:
        chunks: list[bytes] = []
        total = 0
        while True:
            chunk = response.read(256 * 1024)
            if not chunk:
                break
            total += len(chunk)
            if total > max_bytes:
                raise ValueError(f"response exceeds {max_bytes} bytes")
            chunks.append(chunk)
        return b"".join(chunks)


def fetch_text(url: str, *, timeout: int = 60) -> str:
    return fetch(url, timeout=timeout).decode("utf-8", "replace")


def quote_url(url: str) -> str:
    parts = urlsplit(url)
    return urlunsplit((parts.scheme, parts.netloc, quote(parts.path, safe="/%:@"), parts.query, parts.fragment))


class LinkParser(HTMLParser):
    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.links: list[tuple[str, str]] = []
        self._href: str | None = None
        self._text: list[str] = []

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        if tag.lower() != "a":
            return
        values = dict(attrs)
        self._href = values.get("href")
        self._text = []

    def handle_data(self, data: str) -> None:
        if self._href is not None:
            self._text.append(data)

    def handle_endtag(self, tag: str) -> None:
        if tag.lower() == "a" and self._href is not None:
            self.links.append((self._href, re.sub(r"\s+", " ", " ".join(self._text)).strip()))
            self._href = None
            self._text = []


def links_from(url: str, *, timeout: int = 20) -> list[tuple[str, str]]:
    parser = LinkParser()
    parser.feed(fetch_text(url, timeout=timeout))
    return [(quote_url(urljoin(url, href)), title) for href, title in parser.links if href]


def slug(value: str, limit: int = 90) -> str:
    value = html.unescape(value or "").lower()
    value = re.sub(r"[^a-z0-9]+", "-", value).strip("-")
    return (value[:limit].rstrip("-") or "document")


def is_pdf_candidate(url: str, title: str = "") -> bool:
    lowered = url.lower()
    return ".pdf" in lowered or "documentstore.ashx" in lowered or "upload_pdf" in lowered or "/fileadmin/" in lowered or ("/file/" in lowered and "/download" in lowered and title.lower().endswith(".pdf")) or ("canadiana.ca/files/get/" in lowered and lowered.endswith("/item"))


def likely_non_digital(row: dict) -> bool:
    text = f"{row.get('title', '')} {row.get('url', '')}".lower()
    return row.get("source") in SCAN_SOURCE_HINTS or any(hint in text for hint in SCAN_TITLE_HINTS)


def likely_uk_legal_monograph(row: dict) -> bool:
    """Reject obvious non-UK false positives from broad English-law searches."""
    if row.get("source") != "uk_legal_monographs":
        return True
    text = f"{row.get('title', '')} {row.get('repository_item', '')}".lower()
    excluded = (
        "hindu law", "bombay", "india", "indian", "roman civil",
        "new england", "massachusetts", "united states", "american",
        "spanish", "french law", "german law",
    )
    return not any(needle in text for needle in excluded)


def kind_limit(kind: str) -> int:
    if kind in KIND_ACCEPTED_LIMITS:
        return KIND_ACCEPTED_LIMITS[kind]
    return MAX_FALLBACK_KIND_ACCEPTED if kind == "other" else MAX_KIND_ACCEPTED


def source_limit(source: str) -> int:
    return SOURCE_ACCEPTED_LIMITS.get(source, MAX_SOURCE_ACCEPTED)


def source_kind_limit(source: str, kind: str) -> int:
    return SOURCE_KIND_LIMITS.get(source, MAX_SOURCE_KIND_ACCEPTED)


def infer_type(title: str, url: str = "") -> str:
    text = f"{title} {url}".lower()
    rules = (
        ("affidavit", ("affidavit", "affirmed", "sworn")),
        ("witness_statement", ("witness statement", "witness_statement", "statement of")),
        ("brief_or_submission", ("factum", "skeleton", "submission", "submissions", "memorandum of counsel", "closing argument", "opening statement", "written argument", "outline of submissions", "brief of evidence")),
        ("exhibit", ("exhibit", "annexure", "annex", "appendix", "bundle", "attachment")),
        ("pleading_or_order", ("complaint", "claim", "defence", "defense", "originating", "application", "motion", "notice of", "order", "directions", "ruling")),
        ("transcript", ("transcript", "hearing transcript", "evidence of")),
        ("contract", ("agreement", "contract", "lease", "indenture", "terms of", "memorandum of understanding", "purchase order")),
        ("procedural", ("procedural", "protocol", "minute", "decision on", "directions")),
        ("work_product", ("report", "research", "review", "analysis", "briefing", "position paper", "consultation", "presentation", "policy")),
    )
    for document_type, needles in rules:
        if any(needle in text for needle in needles):
            return document_type
    return "other"


def infer_kind(title: str, url: str = "") -> str:
    """Return a narrower semantic kind used for diversity sampling."""
    raw_text = f"{title} {url}".lower()
    text = re.sub(r"\s+", " ", re.sub(r"[^a-z0-9]+", " ", raw_text)).strip()
    compact = text.replace(" ", "")
    if re.search(r"(?:[/_ -])fm\d{3}(?:[_-]|\.pdf)", raw_text):
        return "factum"
    if re.search(r"(?:[/_ -])mm\d{3}(?:[_-]|\.pdf)", raw_text):
        return "memorandum"
    if "witnessstatement" in compact:
        return "witness_statement"
    if "transcript" in compact:
        return "transcript"
    if "deathcertificate" in compact or "birthcertificate" in compact:
        return "certificate"
    if "rulesofengagement" in compact:
        return "rules_or_regulations"
    if "evidence" in compact and ("hearing" in compact or "statement" in compact or "witness" in compact):
        return "evidence_record"
    rules = (
        ("law_report", ("law report", "law reports", "weekly notes", "weekly reporter", "report of cases", "reports of cases", "court reports", "cases adjudged", "law journal", "law review", "legal reports", "reports of decisions")),
        ("english_legal_history", ("history of the english law", "history of english law", "english law of conspiracy")),
        ("conveyancing_manual", ("conveyancing",)),
        ("family_law_treatise", ("divorce and matrimonial", "matrimonial jurisdiction")),
        ("company_law_compilation", ("companies acts", "joint-stock companies", "joint stock companies")),
        ("commercial_law_treatise", ("bills of exchange", "promissory notes", "factors and brokers")),
        ("trusts_treatise", ("uses and trusts", "nature and operation of conveyances")),
        ("statute_compilation", ("statute", "statutes", "act of", "acts of", "legislation", "legislative", "bill ", "bills ")),
        ("inquiry_report", ("commission of inquiry", "report of a commission", "report of the commission", "report of commission", "government commissions", "court of inquiry", "inquiry into")),
        ("commission_report", ("royal commission", "report of commissioners", "commission report", "commission to inquire", "report for the canadian commission", "market commission", "special fishery commission")),
        ("committee_report", ("committee report", "committee of inquiry", "committee on", "preliminary report", "interim report", "first report", "second report", "third report")),
        ("legal_statement", ("statement of facts", "statement of the case")),
        ("arbitration_record", ("arbitration", "tribunal of arbitration", "arbitration commission")),
        ("municipal_report", ("municipal report", "municipal matters", "municipal manual", "municipal assessment", "municipal affairs", "municipal electric", "municipal research", "city government", "city improvement", "public utilities")),
        ("agency_report", ("agency report", "whistleblower comments", "supplemental agency report")),
        ("directive", ("directive", "aide memoire", "aide-memoire")),
        ("appointment_record", ("appointment", "terms of reference")),
        ("undertaking", ("undertaking",)),
        ("photograph_record", ("photograph", "photographs")),
        ("training_material", ("training", "pre-deployment")),
        ("rules_or_regulations", ("rules", "regulation", "regulations", "ordinance", "code of", "manual comprising")),
        ("legal_treatise", ("treatise", "commentaries", "commentary on", "law of", "principles of law", "digest of")),
        ("practice_direction", ("practice direction", "practice-direction")),
        ("practice_note", ("practice note", "practice-note")),
        ("skeleton_argument", ("skeleton argument", "skeleton-argument", "skeleton_argument")),
        ("factum", ("factum", "facta")),
        ("memorandum", ("memorandum", "memo ", "memoranda")),
        ("condensed_book", ("condensed book", "condensed-book", "condensedbook")),
        ("closing_submission", ("closing submission", "closing submissions", "closing-submission")),
        ("opening_submission", ("opening submission", "opening submissions", "opening-submission")),
        ("legal_submission", ("submission", "submissions", "written argument", "outline of submissions")),
        ("affidavit", ("affidavit", "affirmed", "sworn")),
        ("witness_statement", ("witness statement", "witness_statement", "statement-")),
        ("expert_report", ("expert report", "expert evidence", "expert-report")),
        ("brief_of_evidence", ("brief of evidence", "brief-of-evidence")),
        ("research_report", ("research report", "research-report", "research paper")),
        ("evaluation_report", ("evaluation", "assessment report", "review report")),
        ("briefing_note", ("briefing note", "briefing-note", "briefing")),
        ("agenda", ("agenda", "agendas")),
        ("interview_note", ("interview note", "notes of interview", "interview record")),
        ("incident_report", ("incident report", "incident-report", "occurrence report")),
        ("investigation_report", ("investigation report", "investigative report", "inquiry report")),
        ("technical_report", ("technical report", "technical-report", "engineering report")),
        ("risk_assessment", ("risk assessment", "risk-assessment", "risk analysis")),
        ("audit_report", ("audit report", "audit-report", "auditor report")),
        ("legal_opinion", ("legal opinion", "opinion of counsel", "counsel opinion")),
        ("protocol", ("protocol", "protocols")),
        ("policy_procedure", ("policy and procedure", "policies and procedures", "operational procedure")),
        ("policy_document", ("policy", "position paper", "policy paper")),
        ("consultation_response", ("consultation", "consultation response")),
        ("presentation", ("presentation", "slides", "slide deck")),
        ("transcript", ("transcript", "hearing transcript", "evidence of")),
        ("hearing_bundle", ("hearing bundle", "hearing-bundle", "bundle of documents")),
        ("exhibit_bundle", ("exhibit bundle", "exhibit-bundle", "document bundle")),
        ("exhibit", ("exhibit", "exhibits", "annexure", "annex", "appendix")),
        ("correspondence", ("correspondence", "letter from", "letter to", "letter-")),
        ("email_record", ("email", "e-mail", "email chain")),
        ("minutes", ("minutes", "meeting record", "minute of")),
        ("complaint", ("complaint", "complaints")),
        ("claim", ("statement of claim", "claim form", "claim-")),
        ("summons", ("summons",)),
        ("subpoena", ("subpoena",)),
        ("petition", ("petition",)),
        ("waiver", ("waiver",)),
        ("certificate", ("certificate",)),
        ("cover_sheet", ("cover sheet", "cover-sheet")),
        ("requisition", ("requisition",)),
        ("request_form", ("request form",)),
        ("information_request", ("information request", "information-request")),
        ("financial_form", ("financial disclosure", "financial form")),
        ("defence", ("defence", "defense")),
        ("pleading", ("pleading", "originating application", "originating notice")),
        ("application", ("application", "application-", "applicant")),
        ("motion", ("motion", "motion-")),
        ("notice", ("notice of", "notice-")),
        ("order", ("order", "orders")),
        ("directions", ("directions", "direction")),
        ("ruling", ("ruling", "decision", "determination")),
        ("judgment", ("judgment", "judgement")),
        ("contract", ("contract", "contracts")),
        ("agreement", ("agreement", "memorandum of understanding", "mou")),
        ("request_for_quotation", ("request for quotation", "request-for-quotation", "rfq")),
        ("lease", ("lease", "leasing")),
        ("request_for_proposal", ("request for proposal", "request-for-proposal", "rfp", "rfp-", "rfp ")),
        ("request_for_information", ("request for information", "request-for-information", "rfi", "rfi-", "rfi ")),
        ("tender", ("tender", "tenders", "request for tenders", "invitation to tender", "invitation-to-tender")),
        ("solicitation", ("solicitation", "solicitations", "invitation to bid", "invitation-to-bid", "bid solicitation")),
        ("statement_of_work", ("statement of work", "statement-of-work", "scope of work")),
        ("standing_offer", ("standing offer", "standing-offer", "supply arrangement")),
        ("procurement", ("procurement", "purchase order")),
        ("zoning_bylaw", ("zoning bylaw", "zoning by law", "zoning-bylaw", "zoning by-law", "land use bylaw", "land use by law", "land-use-bylaw", "official plan")),
        ("zoning_map", ("zoning map", "zoning-map", "land use map", "land-use map")),
        ("development_plan", ("development plan", "official development plan", "area structure plan")),
        ("bylaw_amendment", ("bylaw amendment", "by law amendment", "by-law amendment", "amending bylaw", "amending by law", "amending by-law")),
        ("municipal_bylaw", ("bylaw", "by law", "by-law", "ordinance", "municipal code")),
        ("financial_filing", ("financial filing", "financial report", "financial statements")),
        ("prospectus", ("prospectus", "offering memorandum")),
        ("regulatory_order", ("enforcement order", "regulatory order", "consent order")),
        ("enforcement_notice", ("enforcement notice", "notice of violation", "penalty notice")),
        ("guidance", ("guidance", "guideline")),
        ("evidence_record", ("evidence", "record of evidence")),
        ("court_form", ("court form", "court forms", "court-forms", "forms", "form-")),
    )
    for kind, needles in rules:
        if any(needle in text for needle in needles):
            return kind
    return "other"


def effective_kind(row: dict) -> str:
    """Recompute legacy fallback kinds when a narrower rule now applies."""
    stored = row.get("kind")
    inferred = infer_kind(row.get("title", ""), row.get("url", ""))
    if row.get("source") == "canadiana_legal_monographs" and (stored == "inquiry_report" or inferred == "inquiry_report"):
        return "historical_inquiry_report"
    if row.get("source") == "uk_legal_monographs":
        if inferred != "other":
            return inferred
        return str(stored or "legal_monograph")
    if stored and stored != "other":
        return str(stored)
    if inferred != "other":
        return inferred
    source_fallbacks = {
        "canada_commission_archive": "commission_record",
        "canadiana_legal_monographs": "legal_monograph",
        "uk_gov_legal_workflow": "inquiry_record",
        "us_justice_employment_litigation": "case_record",
        "us_osc_public_files": "agency_record",
    }
    return source_fallbacks.get(row.get("source"), "other")


def wanted(title: str, url: str) -> bool:
    text = f"{title} {url}".lower()
    excluded = (
        "sitemap", "accessibility", "privacy policy", "cookie", "newsletter",
        "how to", "guide to", "terms of reference", "media release", "press release",
        "annual report", "financial statements", "job description",
    )
    return not any(needle in text for needle in excluded)


def append_jsonl(path: Path, rows: list[dict]) -> None:
    if not rows:
        return
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("a", encoding="utf-8", newline="\n") as handle:
        for row in rows:
            handle.write(json.dumps(row, ensure_ascii=False, sort_keys=True) + "\n")


def read_jsonl(path: Path) -> list[dict]:
    if not path.exists():
        return []
    rows: list[dict] = []
    with path.open("r", encoding="utf-8") as handle:
        for line in handle:
            try:
                row = json.loads(line)
            except json.JSONDecodeError:
                continue
            if isinstance(row, dict):
                rows.append(row)
    return rows


def refresh_inventory() -> None:
    """Record the size of every discovered source pool and useful leads."""
    candidates = read_jsonl(CANDIDATES)
    latest = load_ledger() if LEDGER.exists() else {}
    by_source: dict[str, list[dict]] = defaultdict(list)
    for row in candidates:
        by_source[str(row.get("source", "unknown"))].append(row)
    inventory: dict[str, object] = {
        "updated_at": now(),
        "corpus_target": {
            "total": TOTAL_TARGET,
            "jurisdictions": JURISDICTION_TARGETS,
            "generations": GENERATION_TARGETS,
        },
        "sources": {},
    }
    source_data: dict[str, dict] = {}
    for source, source_rows in sorted(by_source.items()):
        statuses = Counter(latest.get(row.get("candidate_id"), {}).get("status", "undownloaded") for row in source_rows)
        source_data[source] = {
            "source_url": SOURCE_URLS.get(source),
            **SOURCE_METADATA.get(source, {}),
            "discovered_pdf_urls": len({row.get("url") for row in source_rows}),
            "status_counts": dict(statuses),
            "document_types": dict(Counter(row.get("document_type") for row in source_rows)),
            "kinds": dict(Counter(infer_kind(str(row.get("title", "")), str(row.get("url", ""))) for row in source_rows)),
            "jurisdictions": dict(Counter(row.get("jurisdiction") for row in source_rows)),
            "lead_landing_urls": sorted({row.get("landing_url") for row in source_rows if row.get("landing_url")})[:12],
            "lead_pdf_urls": [
                {"title": row.get("title"), "url": row.get("url"), "landing_url": row.get("landing_url")}
                for row in source_rows[:12]
            ],
        }
    inventory["sources"] = source_data
    INVENTORY.write_text(json.dumps(inventory, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def candidate(source: str, jurisdiction: str, url: str, title: str, landing: str, terms: str, **extra: object) -> dict:
    url = quote_url(url)
    return {
        "candidate_id": hashlib.sha256(url.encode()).hexdigest()[:24],
        "source": source,
        "jurisdiction": jurisdiction,
        "title": html.unescape(title).strip() or Path(urlsplit(url).path).name,
        "url": url,
        "landing_url": landing,
        "document_type": infer_type(title, url),
        "kind": infer_kind(title, url),
        "terms_note": terms,
        "discovered_at": now(),
        **extra,
    }


def write_candidates(rows: list[dict]) -> int:
    existing = {row.get("url") for row in read_jsonl(CANDIDATES)}
    fresh = []
    for row in rows:
        if row.get("url") in existing or not wanted(row["title"], row["url"]):
            continue
        existing.add(row["url"])
        fresh.append(row)
    append_jsonl(CANDIDATES, fresh)
    refresh_inventory()
    print(f"discovered {len(fresh)} new candidates (total {len(existing)})")
    return len(fresh)


def discover_scc(max_cases: int) -> int:
    sitemap = "https://www.scc-csc.ca/en/sitemap.xml"
    text = fetch_text(sitemap, timeout=120)
    all_ids = list(dict.fromkeys(re.findall(r"/cases-dossiers/search-recherche/(\d+)/", text)))
    if len(all_ids) <= max_cases:
        ids = all_ids
    else:
        positions = {(index * len(all_ids)) // max_cases for index in range(max_cases)}
        ids = [all_ids[position] for position in sorted(positions)]
    rows: list[dict] = []
    for index, case_no in enumerate(ids, 1):
        try:
            data = json.loads(fetch_text(f"https://www.scc-csc.ca/data/case-documents/{case_no}.json"))
        except Exception as exc:  # one old/missing case must not stop the crawl
            if index % 100 == 0:
                print(f"scc metadata {index}/{len(ids)}; last failure {exc}", flush=True)
            continue
        for group, document_type in (("factums", "brief_or_submission"), ("memorandums", "brief_or_submission"), ("condensedBooks", "exhibit")):
            for filename in data.get(group, []) or []:
                url = f"https://www.scc-csc.ca/pdf/case-documents/{case_no}/{quote(str(filename))}"
                rows.append(candidate("scc", "ca", url, str(filename), f"https://www.scc-csc.ca/cases-dossiers/search-recherche/{case_no}/", "Supreme Court of Canada public court record; consult the Court’s access and use terms.", case_no=case_no, document_type=document_type))
        if index % 100 == 0:
            print(f"scc metadata {index}/{len(ids)}", flush=True)
    return write_candidates(rows)


def discover_cullen(pages: int) -> int:
    rows: list[dict] = []
    for page in range(1, pages + 1):
        landing = f"https://www.cullencommission.ca/exhibits/?page={page}"
        try:
            links = links_from(landing)
        except Exception as exc:
            print(f"cullen page {page} failed: {exc}", flush=True)
            continue
        for url, title in links:
            if ".pdf" not in url.lower():
                continue
            rows.append(candidate("cullen_commission", "ca", url, title, landing, "Public exhibit released by the Cullen Commission of Inquiry into Money Laundering in British Columbia."))
        print(f"cullen page {page}/{pages}", flush=True)
    return write_candidates(rows)


def discover_foreign_interference(pages: int) -> int:
    rows: list[dict] = []
    for page in range(pages):
        query = urlencode({"tx_kesearch_pi1[page]": page})
        landing = f"https://foreigninterferencecommission.ca/documents/exhibits-and-presentations?{query}"
        try:
            links = links_from(landing)
        except Exception as exc:
            print(f"foreign-interference page {page} failed: {exc}", flush=True)
            continue
        for url, title in links:
            if ".pdf" not in url.lower():
                continue
            rows.append(candidate("foreign_interference_commission", "ca", url, title, landing, "Public document published by the Public Inquiry into Foreign Interference in Federal Electoral Processes and Democratic Institutions."))
    return write_candidates(rows)


def discover_waitangi(pages: int) -> int:
    rows: list[dict] = []
    for page in range(pages):
        start = page * 10
        for kind in ("documents", "evidence"):
            query = urlencode({"Type": kind, "start": start})
            landing = f"https://www.waitangitribunal.govt.nz/en/reports-and-documents?{query}"
            try:
                links = links_from(landing)
            except Exception as exc:
                print(f"waitangi {kind} {page} failed: {exc}", flush=True)
                continue
            for url, title in links:
                if "/Documents/WT/" not in url or ".pdf" not in url.lower():
                    continue
                rows.append(candidate("waitangi_tribunal", "nz", url, title, landing, "Public inquiry document published by the Waitangi Tribunal; consult the Tribunal’s access terms."))
    return write_candidates(rows)


def discover_canada_commission_archive(max_pages: int) -> int:
    index = SOURCE_URLS["canada_commission_archive"]
    try:
        index_links = links_from(index, timeout=30)
    except Exception as exc:
        print(f"canada commission index failed: {exc}", flush=True)
        return 0
    archive_pages = [
        url for url, _title in index_links
        if "epe.lac-bac.gc.ca/100/" in url.lower()
        and "disclaimer" not in url.lower()
    ]
    rows: list[dict] = []
    limit = min(max_pages, len(archive_pages))
    for number, landing in enumerate(archive_pages[:limit], 1):
        try:
            links = links_from(f"{landing}?nodisclaimer=1", timeout=20)
        except Exception as exc:
            print(f"canada commission page {number}/{limit} failed: {exc}", flush=True)
            continue
        for url, title in links:
            if ".pdf" not in url.lower():
                continue
            rows.append(candidate(
                "canada_commission_archive",
                "ca",
                url,
                title,
                landing,
                "Public historical Canadian commission or inquiry report preserved by Library and Archives Canada.",
            ))
        if number == 1 or number % 20 == 0:
            print(f"canada commission pages {number}/{limit}", flush=True)
    return write_candidates(rows)


def discover_canada_publication_commissions(max_pages: int) -> int:
    rows: list[dict] = []
    seen_publications: set[str] = set()
    for page in range(1, max_pages + 1):
        landing = (
            "https://publications.gc.ca/site/eng/search/search.html?"
            f"text=commission+of+inquiry&format1=Electronic&page={page}"
            "&results_per_page=10&sort=relevance&order=descending"
        )
        try:
            search_links = links_from(landing, timeout=30)
        except Exception as exc:
            print(f"canada publications search page {page}/{max_pages} failed: {exc}", flush=True)
            continue
        publications = []
        for url, title in search_links:
            if "/site/eng/" not in url or "/publication.html" not in url:
                continue
            if url in seen_publications:
                continue
            seen_publications.add(url)
            publications.append((url, title))
        for publication, publication_title in publications:
            try:
                pdf_links = links_from(publication, timeout=30)
            except Exception as exc:
                print(f"canada publication record failed: {publication}: {exc}", flush=True)
                continue
            for url, title in pdf_links:
                if not is_pdf_candidate(url, title):
                    continue
                combined_title = f"{publication_title} — {title or 'PDF'}"
                rows.append(candidate(
                    "canada_publication_commissions",
                    "ca",
                    url,
                    combined_title,
                    publication,
                    "Public electronic commission or inquiry publication from the Government of Canada Publications catalogue.",
                ))
        print(f"canada publications pages {page}/{max_pages} records={len(publications)}", flush=True)
    return write_candidates(rows)


def discover_canadiana_legal_monographs(max_pages: int) -> int:
    """Discover a bounded legal subset of Canadiana's scanned item corpus."""
    queries = (
        "law", "court", "statute", "municipal", "by-law", "inquiry",
        "commission", "tribunal", "ordinance", "regulation", "tender",
    )
    legal_terms = (
        "law", "legal", "court", "statute", "municipal", "by-law", "bylaw",
        "inquiry", "commission", "tribunal", "ordinance", "regulation", "judicial",
        "justice", "evidence", "case", "rules", "notes", "tender", "contract",
    )
    rows: list[dict] = []
    seen_items: set[str] = set()
    for query in queries:
        for page in range(1, max_pages + 1):
            query_string = urlencode({"q0.0": f"ti:{query}"})
            landing = (
                f"https://www.canadiana.ca/search/browsable?{query_string}"
                if page == 1
                else f"https://www.canadiana.ca/search/browsable/{page}?{query_string}"
            )
            try:
                links = links_from(landing, timeout=30)
            except Exception as exc:
                print(f"canadiana {query} page {page}/{max_pages} failed: {exc}", flush=True)
                continue
            page_items = 0
            for view_url, title in links:
                path = urlsplit(view_url).path
                if not path.startswith("/view/") or not title:
                    continue
                normalized_title = re.sub(r"\s+", " ", title).strip()
                if not any(term in normalized_title.lower() for term in legal_terms):
                    continue
                item_id = path.removeprefix("/view/").strip("/")
                if not item_id or item_id in seen_items:
                    continue
                seen_items.add(item_id)
                page_items += 1
                rows.append(candidate(
                    "canadiana_legal_monographs",
                    "ca",
                    f"https://www.canadiana.ca/files/get/{item_id}/item",
                    normalized_title,
                    view_url,
                    "Public scanned legal or government document from the Canadiana repository; item page and signed full-document resolver are recorded for provenance.",
                    repository_item=item_id,
                ))
            print(f"canadiana {query} page {page}/{max_pages} items={page_items}", flush=True)
    return write_candidates(rows)


def discover_uk_legal_monographs(max_pages: int) -> int:
    """Discover a bounded set of scanned historical English-law PDF volumes."""
    queries = (
        'subject:"English law" AND mediatype:texts AND year:[* TO 1935]',
        'subject:"Law -- Great Britain" AND mediatype:texts AND year:[* TO 1935]',
        'title:(England OR English OR British OR Chancery OR "King s Bench") AND mediatype:texts AND year:[* TO 1935]',
        'title:("law reports" OR statutes OR commentaries) AND mediatype:texts AND year:[* TO 1935]',
    )
    strong_uk_terms = (
        "england", "english law", "laws of england", "great britain",
        "british law", "england and wales", "wales", "scotland",
        "court of chancery", "king's bench", "kings bench",
    )
    rows: list[dict] = []
    seen_items: set[str] = set()
    for query in queries:
        for page in range(1, max_pages + 1):
            params = [
                ("q", query),
                ("fl[]", "identifier"),
                ("fl[]", "title"),
                ("fl[]", "year"),
                ("fl[]", "creator"),
                ("fl[]", "subject"),
                ("rows", "12"),
                ("page", str(page)),
                ("output", "json"),
            ]
            search_url = "https://archive.org/advancedsearch.php?" + urlencode(params)
            try:
                payload = json.loads(fetch_text(search_url, timeout=45))
            except Exception as exc:
                print(f"uk archive search page {page}/{max_pages} failed: {exc}", flush=True)
                continue
            documents = payload.get("response", {}).get("docs", []) or []
            page_items = 0
            for item in documents:
                identifier = str(item.get("identifier", "")).strip()
                title = str(item.get("title", "")).strip()
                subjects = " ".join(str(value) for value in (item.get("subject") or []))
                metadata_text = f"{title} {subjects} {item.get('creator', '')}".lower()
                if not identifier or identifier in seen_items or not any(term in metadata_text for term in strong_uk_terms):
                    continue
                seen_items.add(identifier)
                metadata_url = f"https://archive.org/metadata/{quote(identifier, safe='')}"
                try:
                    metadata = json.loads(fetch_text(metadata_url, timeout=15))
                except Exception as exc:
                    print(f"uk archive item {identifier} failed: {exc}", flush=True)
                    continue
                pdf_files = []
                for file_info in metadata.get("files", []) or []:
                    name = str(file_info.get("name", ""))
                    file_format = str(file_info.get("format", "")).lower()
                    if not name.lower().endswith(".pdf") or "pdf" not in file_format:
                        continue
                    try:
                        size = int(file_info.get("size", 0) or 0)
                    except (TypeError, ValueError):
                        size = 0
                    if size and size > 39_500_000:
                        continue
                    pdf_files.append((name, size))
                if not pdf_files:
                    continue
                landing = f"https://archive.org/details/{quote(identifier, safe='')}"
                for name, size in sorted(pdf_files)[:12]:
                    file_url = f"https://archive.org/download/{quote(identifier, safe='')}/{quote(name, safe='')}"
                    rows.append(candidate(
                        "uk_legal_monographs",
                        "uk",
                        file_url,
                        f"{title} — {name}",
                        landing,
                        "Publicly downloadable scanned historical English-law volume from Internet Archive; item-level rights statement and archive terms govern reuse.",
                        repository_item=identifier,
                        repository_file=name,
                        repository_size=size,
                    ))
                    page_items += 1
            if rows:
                write_candidates(rows)
                rows = []
            print(f"uk archive query {queries.index(query) + 1}/{len(queries)} page {page}/{max_pages} pdfs={page_items}", flush=True)
    return write_candidates(rows)


def discover_postoffice(max_pages: int) -> int:
    sitemap = fetch_text("https://www.postofficehorizoninquiry.org.uk/sitemap.xml", timeout=120)
    pages = list(dict.fromkeys(re.findall(r"<loc>([^<]+)</loc>", sitemap)))
    relevant = [url for url in pages if re.search(r"/(hearings|evidence|key-documents|phase-)", url)]
    rows: list[dict] = []
    for index, landing in enumerate(relevant[:max_pages], 1):
        try:
            links = links_from(landing)
        except Exception as exc:
            print(f"post-office page {index}/{min(max_pages, len(relevant))} failed: {exc}", flush=True)
            continue
        for url, title in links:
            if "/file/" not in url or "/download" not in url or not title.lower().endswith(".pdf"):
                continue
            rows.append(candidate("post_office_horizon_inquiry", "uk", url, title, landing, "Public evidence document published by the Post Office Horizon IT Inquiry under its public document scheme."))
        if index % 20 == 0:
            print(f"post-office pages {index}/{min(max_pages, len(relevant))}", flush=True)
    return write_candidates(rows)


SEED_PAGES = (
    (
        "air_india_inquiry",
        "ca",
        "https://www.majorcomm.ca/en/submissions.html",
        "Public submission or inquiry record published by the Commission of Inquiry into the Investigation of the Bombing of Air India Flight 182.",
    ),
    (
        "poec_submissions",
        "ca",
        "https://publicorderemergencycommission.ca/documents/closing-submissions/",
        "Public closing submission published by the Public Order Emergency Commission of Canada.",
    ),
    (
        "poec_exhibits",
        "ca",
        "https://publicorderemergencycommission.ca/documents/presentations-overview-reports-and-exhibits/",
        "Public report, presentation, or exhibit published by the Public Order Emergency Commission of Canada.",
    ),
    (
        "driskell_inquiry",
        "ca",
        "https://www.driskellinquiry.ca/submissions.html",
        "Public inquiry submission published by the Commission of Inquiry into Certain Aspects of the Trial and Conviction of James Driskell.",
    ),
    (
        "uk_gov_legal_workflow",
        "uk",
        "https://www.gov.uk/government/publications/investigation-into-the-death-of-nadheem-abdullah",
        "Public investigation document published on GOV.UK by a UK government department.",
    ),
    (
        "uk_gov_legal_workflow",
        "uk",
        "https://www.gov.uk/government/publications/investigation-into-the-death-of-hassan-abbas-said",
        "Public investigation document published on GOV.UK by a UK government department.",
    ),
    (
        "uk_gov_legal_workflow",
        "uk",
        "https://www.gov.uk/government/publications/form-n163-skeleton-arguments",
        "Public UK court-workflow document published on GOV.UK.",
    ),
    (
        "uk_ipo_tribunal_workflow",
        "uk",
        "https://www.gov.uk/government/publications/filing-evidence-about-an-application-or-in-tribunal-proceedings",
        "Public tribunal evidence template or legal-workflow document published by the UK Intellectual Property Office.",
    ),
    (
        "uk_infected_blood_workflow",
        "uk",
        "https://www.infectedbloodinquiry.org.uk/statements-approach",
        "Public witness, legal-representation, or inquiry-procedure document published by the UK Infected Blood Inquiry.",
    ),
    (
        "uk_infected_blood_workflow",
        "uk",
        "https://www.infectedbloodinquiry.org.uk/requesting-medical-evidence",
        "Public evidence-request or correspondence document published by the UK Infected Blood Inquiry.",
    ),
    (
        "nz_abuse_in_care",
        "nz",
        "https://www.abuseincare.org.nz/research-and-engagement/evidence-library/beautiful-children-lake-alice",
        "Public evidence document published by the Royal Commission of Inquiry into Historical Abuse in State Care and in the Care of Faith-based Institutions.",
    ),
    (
        "nz_judicial_conduct_panel",
        "nz",
        "https://www.justice.govt.nz/tribunals/judicial-conduct-panels/inquiry-into-the-conduct-of-judge-e-aitken/",
        "Public ruling or procedural document published by a New Zealand Judicial Conduct Panel.",
    ),
    (
        "cnsc_meeting_documents",
        "ca",
        "https://www.cnsc-ccsn.gc.ca/eng/the-commission/hearings-meetings/search-meeting-documents/",
        "Public meeting submission or record published by the Canadian Nuclear Safety Commission.",
    ),
    (
        "cnsc_hearing_documents",
        "ca",
        "https://www.cnsc-ccsn.gc.ca/eng/the-commission/hearings-meetings/download-meeting-documents/",
        "Public hearing document published by the Canadian Nuclear Safety Commission.",
    ),
    (
        "canada_commission_archive",
        "ca",
        "https://www.canada.ca/en/privy-council/services/commissions-inquiry.html",
        "Public report or record from a Canadian commission of inquiry listed by the Privy Council Office.",
    ),
    (
        "walkerton_inquiry",
        "ca",
        "https://www.archives.gov.on.ca/en/e_records/walkerton/",
        "Public inquiry record from the Walkerton Inquiry preserved by the Archives of Ontario.",
    ),
    (
        "canada_competition_bureau",
        "ca",
        "https://competition-bureau.canada.ca/how-we-foster-competition/education-and-outreach/publications",
        "Public legal, compliance, or market-work document published by the Competition Bureau of Canada.",
    ),
    (
        "crtc_public_proceedings",
        "ca",
        "https://crtc.gc.ca/eng/consultation/index.htm",
        "Public intervention, notice, application, letter, or transcript from a Canadian Radio-television and Telecommunications Commission proceeding.",
    ),
    (
        "crtc_legislative_review",
        "ca",
        "https://ised-isde.canada.ca/site/broadcasting-telecommunications-legislative-review/en/broadcasting-and-telecommunications-legislative-review-submissions",
        "Public stakeholder submission to a Canadian broadcasting and telecommunications legislative review.",
    ),
    (
        "cer_workflow",
        "ca",
        "https://www.cer-rec.gc.ca/en/applications-hearings/submit-applications-documents/",
        "Public filing manual, application form, or regulatory-hearing workflow document published by the Canada Energy Regulator.",
    ),
    (
        "canada_justice_research",
        "ca",
        "https://www.justice.gc.ca/eng/rp-pr/",
        "Public legal research, evaluation, or justice-system work product published by the Department of Justice Canada.",
    ),
    (
        "federal_judicial_forms",
        "ca",
        "https://www.fja.gc.ca/appointments-nominations/forms-formulaires/ar-ac/index-eng.html",
        "Public federal judicial-appointment authorization form published by Canada’s Federal Judicial Affairs office.",
    ),
    (
        "ontario_court_forms",
        "ca",
        "https://ontariocourtforms.on.ca/en/rules-of-civil-procedure-forms/",
        "Public Ontario civil-procedure court form published by Ontario Court Services.",
    ),
    (
        "alberta_court_forms",
        "ca",
        "https://albertacourts.ca/kb/areas-of-law/civil/forms",
        "Public Alberta Court of King’s Bench civil court form.",
    ),
    (
        "manitoba_court_forms",
        "ca",
        "https://www.manitobacourts.mb.ca/provincial-court/legal-resources-and-links/forms/",
        "Public Manitoba court form published by the Manitoba Courts.",
    ),
    (
        "bc_court_forms",
        "ca",
        "https://www.bccourts.ca/supreme_court/practice_and_procedure/acts_rules_and_forms/",
        "Public British Columbia court form, rule, or practice document.",
    ),
    (
        "quebec_justice_forms",
        "ca",
        "https://www.quebec.ca/justice-et-etat-civil/systeme-judiciaire/formulaires-modeles",
        "Public Quebec justice-system form or legal workflow template.",
    ),
    (
        "ontario_cfr_forms",
        "ca",
        "https://forms.mgcs.gov.on.ca/dataset/?organization=ministry-of-the-attorney-general&q=ontario+court+forms",
        "Public Ontario court form from the provincial Central Forms Repository.",
    ),
    (
        "ontario_court_forms",
        "ca",
        "https://ontariocourtforms.on.ca/en/",
        "Public Ontario family, civil, small-claims, or other court form.",
    ),
    (
        "alberta_court_forms",
        "ca",
        "https://albertacourts.ca/ca/filing-information/fees-and-forms",
        "Public Alberta Court of Appeal filing or court form.",
    ),
    (
        "bc_court_forms",
        "ca",
        "https://www.bccourts.ca/supreme_court/practice_and_procedure/acts_rules_and_forms/",
        "Public British Columbia Supreme Court filing or court form.",
    ),
    (
        "federal_judicial_forms",
        "ca",
        "https://www.fja.gc.ca/appointments-nominations/forms-formulaires/ar-ac/index-eng.html",
        "Public Canadian federal judicial-appointment form.",
    ),
    (
        "uk_infected_blood_inquiry",
        "uk",
        "https://www.infectedbloodinquiry.org.uk/evidence",
        "Public evidence document published by the UK Infected Blood Inquiry.",
    ),
    (
        "uk_grenfell_inquiry",
        "uk",
        "https://www.grenfelltowerinquiry.org.uk/evidence",
        "Public evidence document published by the Grenfell Tower Inquiry.",
    ),
    (
        "uk_judiciary_workflow",
        "uk",
        "https://www.judiciary.uk/publications/",
        "Public court practice, procedure, or legal-workflow document published by the Courts and Tribunals Judiciary of England and Wales.",
    ),
    (
        "uk_covid_inquiry",
        "uk",
        "https://covid19.public-inquiry.uk/documents/",
        "Public evidence or procedural document published by the UK Covid-19 Inquiry.",
    ),
    (
        "us_gao_legal",
        "us",
        "https://www.gao.gov/legal/decisions",
        "Public legal decision, opinion, bid-protest record, or appropriations-law work product published by the US Government Accountability Office.",
    ),
    (
        "us_ftc_cases",
        "us",
        "https://www.ftc.gov/legal-library/browse/cases-proceedings",
        "Public complaint, order, filing, or enforcement work product published by the US Federal Trade Commission.",
    ),
    (
        "us_doj_antitrust",
        "us",
        "https://www.justice.gov/atr/cases-and-matters",
        "Public antitrust complaint, settlement, or litigation document published by the US Department of Justice.",
    ),
    (
        "us_osc_public_files",
        "us",
        "https://osc.gov/cases/",
        "Public investigative report, referral, submission, or exhibit published by the US Office of Special Counsel.",
    ),
    (
        "us_sec_litigation",
        "us",
        "https://www.sec.gov/enforcement-litigation/litigation-releases",
        "Public enforcement complaint, order, or litigation work product published by the US Securities and Exchange Commission.",
    ),
    (
        "us_cftc_enforcement",
        "us",
        "https://www.cftc.gov/LawRegulation/Enforcement/Orders",
        "Public enforcement order or settlement document published by the US Commodity Futures Trading Commission.",
    ),
    (
        "us_cfpb_enforcement",
        "us",
        "https://www.consumerfinance.gov/enforcement/actions/",
        "Public enforcement or compliance document published by the US Consumer Financial Protection Bureau.",
    ),
    (
        "us_epa_enforcement",
        "us",
        "https://www.epa.gov/enforcement/enforcement-cases",
        "Public consent decree, complaint, or enforcement document published by the US Environmental Protection Agency.",
    ),
    (
        "us_supreme_briefs",
        "us",
        "https://www.supremecourt.gov/meritsbriefs/meritsbriefs.aspx",
        "Public merits brief or filing published by the Supreme Court of the United States.",
    ),
    (
        "us_supreme_transcripts",
        "us",
        "https://www.supremecourt.gov/oral_arguments/argument_transcript/2024",
        "Public oral-argument transcript published by the Supreme Court of the United States.",
    ),
    (
        "us_court_forms",
        "us",
        "https://www.uscourts.gov/forms-rules/forms",
        "Public national court form published by the Administrative Office of the US Courts.",
    ),
    (
        "us_federal_circuit_forms",
        "us",
        "https://www.cafc.uscourts.gov/home/rules-procedures-forms/court-forms/",
        "Public appellate court form published by the US Court of Appeals for the Federal Circuit.",
    ),
    (
        "au_alrc",
        "au",
        "https://www.alrc.gov.au/publications/",
        "Public law-reform report, consultation paper, or submission published by the Australian Law Reform Commission.",
    ),
    (
        "au_alrc",
        "au",
        "https://www.alrc.gov.au/publication/corporate-criminal-responsibility/",
        "Public law-reform report, consultation paper, or data appendix published by the Australian Law Reform Commission.",
    ),
    (
        "au_alrc",
        "au",
        "https://www.alrc.gov.au/publication/fsl-report-141/",
        "Public corporations and financial-services law-reform report published by the Australian Law Reform Commission.",
    ),
    (
        "au_alrc",
        "au",
        "https://www.alrc.gov.au/publication/pathways-to-justice-inquiry-into-the-incarceration-rate-of-aboriginal-and-torres-strait-islander-peoples-alrc-133-summary/summary-report-7/",
        "Public law-reform summary report published by the Australian Law Reform Commission.",
    ),
    (
        "au_accc",
        "au",
        "https://www.accc.gov.au/publications",
        "Public competition, consumer, or enforcement work product published by the Australian Competition and Consumer Commission.",
    ),
    (
        "au_accc",
        "au",
        "https://www.accc.gov.au/about-us/publications/guidelines-on-the-use-of-infringement-notices-by-the-accc",
        "Public competition-law compliance or enforcement guidance published by the Australian Competition and Consumer Commission.",
    ),
    (
        "au_solicitor_general",
        "au",
        "https://www.ag.gov.au/about-us/who-we-are/office-solicitor-general",
        "Public legal opinion or constitutional-law work product published by the Australian Government Solicitor-General.",
    ),
    (
        "au_ombudsman",
        "au",
        "https://www.ombudsman.gov.au/publications",
        "Public investigation report or administrative-law work product published by the Commonwealth Ombudsman of Australia.",
    ),
    (
        "au_human_rights",
        "au",
        "https://humanrights.gov.au/our-work/legal",
        "Public legal submission, report, or policy work product published by the Australian Human Rights Commission.",
    ),
    (
        "au_federal_court_files",
        "au",
        "https://www.fedcourt.gov.au/services/access-to-files-and-transcripts/online-files",
        "Public court filing, affidavit, pleading, submission, or transcript published in an Australian Federal Court online file.",
    ),
    (
        "au_nsw_law_reform",
        "au",
        "https://www.nswlrc.org.au/publications",
        "Public law-reform report, consultation paper, or submission published by the NSW Law Reform Commission.",
    ),
    (
        "nz_covid_inquiry",
        "nz",
        "https://www.covid19lessons.royalcommission.nz/reports-lessons-learned",
        "Public report, procedural minute, or evidence-related work product published by the New Zealand Royal Commission of Inquiry into COVID-19 Lessons Learned.",
    ),
    (
        "nz_christchurch_inquiry",
        "nz",
        "https://christchurchattack.royalcommission.nz/publications",
        "Public submission, report, or evidence-related document published by the Christchurch mosques attack Royal Commission of Inquiry.",
    ),
    (
        "nz_law_commission",
        "nz",
        "https://www.lawcom.govt.nz/our-work/publications",
        "Public law-reform report, issues paper, or consultation document published by the New Zealand Law Commission.",
    ),
    (
        "nz_commerce_commission",
        "nz",
        "https://www.comcom.govt.nz/about-us/publications",
        "Public competition, consumer, or regulatory work product published by the New Zealand Commerce Commission.",
    ),
    (
        "nz_parliament_submissions",
        "nz",
        "https://www.parliament.nz/en/pb/sc/",
        "Public committee submission or parliamentary inquiry document published by the New Zealand Parliament.",
    ),
    (
        "canada_federal_tenders",
        "ca",
        "https://canadabuys.canada.ca/en/tender-opportunities",
        "Public Canadian federal tender, RFP, RFI, solicitation, or procurement attachment.",
    ),
    (
        "edmonton_zoning",
        "ca",
        "https://www.edmonton.ca/city_government/bylaws/zoning-bylaw",
        "Public municipal zoning bylaw or land-use workflow document published by the City of Edmonton.",
    ),
    (
        "calgary_zoning",
        "ca",
        "https://www.calgary.ca/planning/land-use.html?redirect=%2Flandusebylaws",
        "Public municipal zoning bylaw or land-use workflow document published by the City of Calgary.",
    ),
    (
        "winnipeg_zoning",
        "ca",
        "https://www.winnipeg.ca/ppd/zoning-and-permits/zoning-bylaw",
        "Public municipal zoning bylaw or land-use workflow document published by the City of Winnipeg.",
    ),
    (
        "toronto_zoning",
        "ca",
        "https://www.toronto.ca/city-government/planning-development/zoning-by-law-preliminary-zoning-reviews/zoning-by-law-569-2013-2/",
        "Public municipal zoning bylaw or land-use workflow document published by the City of Toronto.",
    ),
    (
        "vancouver_zoning",
        "ca",
        "https://vancouver.ca/home-property-development/zoning-and-land-use-policies-document-library.aspx",
        "Public municipal zoning bylaw or land-use workflow document published by the City of Vancouver.",
    ),
    (
        "ottawa_zoning",
        "ca",
        "https://ottawa.ca/en/planning-development-and-construction/official-plan-and-master-plans/zoning-law",
        "Public municipal zoning bylaw or land-use workflow document published by the City of Ottawa.",
    ),
    (
        "uk_contracts_finder",
        "uk",
        "https://www.contractsfinder.service.gov.uk/Search",
        "Public UK government contract notice or procurement attachment.",
    ),
    (
        "au_tenders",
        "au",
        "https://www.tenders.gov.au/",
        "Public Australian tender, RFP, RFI, or procurement attachment.",
    ),
    (
        "nz_gets",
        "nz",
        "https://www.gets.govt.nz/",
        "Public New Zealand tender, RFP, RFI, or procurement attachment.",
    ),
    (
        "nova_scotia_court_forms",
        "ca",
        "https://www.courts.ns.ca/operations/forms-documents/civil-procedure-rules-forms",
        "Public Nova Scotia civil-procedure court form published by the Courts of Nova Scotia.",
    ),
    (
        "nova_scotia_court_forms",
        "ca",
        "https://courts.ns.ca/Provincial_Court/NSPC_criminal_rules_forms.htm",
        "Public Nova Scotia Provincial Court criminal or youth court form.",
    ),
    (
        "saskatchewan_court_procedure",
        "ca",
        "https://sasklawcourts.ca/court-of-appeal/rules-practice-directives/",
        "Public Saskatchewan Court of Appeal practice direction or filing document.",
    ),
    (
        "saskatchewan_court_procedure",
        "ca",
        "https://sasklawcourts.ca/kings-bench/rules-practice-directives/",
        "Public Saskatchewan Court of King’s Bench rule, form, or practice directive.",
    ),
    (
        "new_brunswick_court_forms",
        "ca",
        "https://www.courtsnb-coursnb.ca/content/cour/en/provincial.html",
        "Public New Brunswick Provincial Court rule, form, or legal workflow document.",
    ),
    (
        "new_brunswick_court_forms",
        "ca",
        "https://www.courtsnb-coursnb.ca/content/cour/en/appeal/content/forms-of-court.html",
        "Public New Brunswick Court of King’s Bench rule, form, or legal workflow document.",
    ),
    (
        "new_brunswick_court_forms",
        "ca",
        "https://www.courtsnb-coursnb.ca/content/cour/en/provincial/content/template-forms.html",
        "Public New Brunswick Provincial Court template form.",
    ),
    (
        "newfoundland_court_forms",
        "ca",
        "https://www.court.nl.ca/supreme/rules-practice-notes-and-forms/family/general/",
        "Public Newfoundland and Labrador Supreme Court form or practice document.",
    ),
    (
        "newfoundland_court_forms",
        "ca",
        "https://www.court.nl.ca/provincial/",
        "Public Newfoundland and Labrador Provincial Court form or practice document.",
    ),
    (
        "pei_court_forms",
        "ca",
        "https://www.courts.pe.ca/forms",
        "Public Prince Edward Island court form or filing document.",
    ),
    (
        "pei_court_forms",
        "ca",
        "https://www.courts.pe.ca/index.php/provincial-court/policies-and-forms",
        "Public Prince Edward Island Provincial Court policy or form.",
    ),
    (
        "yukon_court_forms",
        "ca",
        "https://www.yukoncourts.ca/en/supreme-court/rules-forms",
        "Public Yukon Supreme Court rule, form, or legal workflow document.",
    ),
    (
        "nwt_court_rules",
        "ca",
        "https://www.justice.gov.nt.ca/en/court-rules/",
        "Public Northwest Territories court rule, form, or legal workflow document.",
    ),
    (
        "nunavut_court_forms",
        "ca",
        "https://www.nunavutcourts.ca/index.php/forms/category/98-civil-rules",
        "Public Nunavut Court of Justice rule, form, or legal workflow document.",
    ),
    (
        "federal_court_canada_forms",
        "ca",
        "https://www.fct-cf.ca/en/online-access/forms",
        "Public Federal Court of Canada form or filing document.",
    ),
    (
        "federal_court_canada_practice",
        "ca",
        "https://www.fct-cf.ca/en/online-access/practice-guidelines",
        "Public Federal Court of Canada practice guideline or procedural document.",
    ),
    (
        "tax_court_canada_forms",
        "ca",
        "https://www.tcc-cci.gc.ca/en/pages/forms",
        "Public Tax Court of Canada form or filing document.",
    ),
    (
        "chrt_forms",
        "ca",
        "https://www.chrt-tcdp.gc.ca/en/human-rights/human-rights-forms",
        "Public Canadian Human Rights Tribunal complaint, hearing, or registry form.",
    ),
    (
        "competition_tribunal_workflow",
        "ca",
        "https://www.ct-tc.gc.ca/en/procedure/notices-practice-directions.html",
        "Public Competition Tribunal notice, practice direction, or filing document.",
    ),
    (
        "citt_workflow",
        "ca",
        "https://www.citt-tcce.gc.ca/en/about-tribunal/forms-practices-and-procedures",
        "Public Canadian International Trade Tribunal form or practice document.",
    ),
    (
        "canada_immigration_workflow",
        "ca",
        "https://www.irb-cisr.gc.ca/en/legal-policy/Pages/index.aspx",
        "Public Immigration and Refugee Board of Canada practice or legal-workflow document.",
    ),
    (
        "canada_transport_agency",
        "ca",
        "https://otc-cta.gc.ca/eng/publications",
        "Public Canadian Transportation Agency decision, guideline, or regulatory-workflow document.",
    ),
    (
        "alberta_procurement",
        "ca",
        "https://www.alberta.ca/find-and-compete-for-government-contracts",
        "Public Alberta government procurement, tender, RFP, or supplier-workflow document.",
    ),
    (
        "bc_procurement",
        "ca",
        "https://www2.gov.bc.ca/gov/content/bc-procurement-resources/buy-for-government/solicitation-processes-and-templates",
        "Public British Columbia government procurement, tender, RFP, or supplier-workflow document.",
    ),
    (
        "ontario_procurement",
        "ca",
        "https://www.ontario.ca/page/government-procurement",
        "Public Ontario government procurement, tender, RFP, or supplier-workflow document.",
    ),
    (
        "quebec_procurement",
        "ca",
        "https://www.quebec.ca/gouvernement/gestion-administrative/marches-publics",
        "Public Quebec government procurement, tender, RFP, or supplier-workflow document.",
    ),
    (
        "canada_federal_rfps",
        "ca",
        "https://canadabuys.canada.ca/en/tender-opportunities",
        "Public Canadian federal request for proposal or procurement attachment.",
    ),
    (
        "bc_procurement_rfp",
        "ca",
        "https://www2.gov.bc.ca/gov/content/bc-procurement-resources/buy-for-government/solicitation-processes-and-templates",
        "Public British Columbia government RFP template or solicitation workflow document.",
    ),
    (
        "mississauga_zoning",
        "ca",
        "https://www.mississauga.ca/services-and-programs/building-and-renovating/zoning-information/zoning-by-law/",
        "Public City of Mississauga zoning bylaw, amendment, or land-use document.",
    ),
    (
        "hamilton_zoning",
        "ca",
        "https://www.hamilton.ca/build-invest-grow/planning-development/zoning/zoning-by-law-05-200",
        "Public City of Hamilton zoning bylaw or land-use workflow document.",
    ),
    (
        "brampton_zoning",
        "ca",
        "https://www.brampton.ca/EN/City-Hall/Zoning-By-law-Review/Pages/zoning-by-laws.aspx",
        "Public City of Brampton zoning bylaw or planning document.",
    ),
    (
        "markham_zoning",
        "ca",
        "https://www.markham.ca/economic-development-business/planning-development-services/zoning-and-development-law-information",
        "Public City of Markham zoning bylaw or planning document.",
    ),
    (
        "london_zoning",
        "ca",
        "https://london.ca/business-development/planning-development-applications/zoning",
        "Public City of London Ontario zoning bylaw or planning document.",
    ),
    (
        "halifax_zoning",
        "ca",
        "https://www.halifax.ca/city-hall/municipal-government/municipal-planning-strategy-land-use-bylaws",
        "Public Halifax Regional Municipality land-use bylaw or zoning document.",
    ),
    (
        "saskatoon_zoning",
        "ca",
        "https://www.saskatoon.ca/business-development/development-regulation/zoning",
        "Public City of Saskatoon zoning bylaw or land-use document.",
    ),
    (
        "surrey_zoning",
        "ca",
        "https://www.surrey.ca/renovating-building-development/zoning",
        "Public City of Surrey zoning bylaw or land-use document.",
    ),
    (
        "richmond_zoning",
        "ca",
        "https://www.richmond.ca/services/planning-land-use/zoning.htm",
        "Public City of Richmond British Columbia zoning bylaw or land-use document.",
    ),
    (
        "toronto_zoning_documents",
        "ca",
        "https://www.toronto.ca/city-government/planning-development/zoning-by-law-preliminary-zoning-reviews/zoning-by-law-569-2013-2/",
        "Public Toronto zoning bylaw volume or amendment document.",
    ),
    (
        "ottawa_zoning_documents",
        "ca",
        "https://documents.ottawa.ca/en/home",
        "Public Ottawa zoning bylaw or official-plan document.",
    ),
    (
        "vancouver_zoning_documents",
        "ca",
        "https://vancouver.ca/home-property-development/zoning-and-land-use-policies-document-library.aspx",
        "Public Vancouver zoning bylaw, map, or development-plan document.",
    ),
    (
        "uk_justice_civil_rules",
        "uk",
        "https://www.justice.gov.uk/courts/procedure-rules/civil",
        "Public England and Wales civil procedure rule or practice direction.",
    ),
    (
        "uk_justice_civil_forms",
        "uk",
        "https://www.justice.gov.uk/courts/procedure-rules/civil/forms",
        "Public England and Wales civil court form or model order.",
    ),
    (
        "uk_justice_family_rules",
        "uk",
        "https://www.justice.gov.uk/courts/procedure-rules/family",
        "Public England and Wales family procedure rule or practice direction.",
    ),
    (
        "uk_justice_family_forms",
        "uk",
        "https://www.justice.gov.uk/courts/procedure-rules/family/formspage",
        "Public England and Wales family court form.",
    ),
    (
        "uk_justice_criminal_rules",
        "uk",
        "https://www.justice.gov.uk/courts/procedure-rules/criminal",
        "Public England and Wales criminal procedure rule or practice direction.",
    ),
    (
        "uk_justice_criminal_forms",
        "uk",
        "https://www.justice.gov.uk/courts/procedure-rules/criminal/docs/forms",
        "Public England and Wales criminal court form.",
    ),
    (
        "uk_hmcts_forms",
        "uk",
        "https://www.gov.uk/government/collections/court-and-tribunal-forms",
        "Public HM Courts and Tribunals Service legal form or filing document.",
    ),
    (
        "uk_manchester_arena_inquiry",
        "uk",
        "https://www.gov.uk/government/collections/manchester-arena-inquiry-reports",
        "Public Manchester Arena Inquiry report or evidence-related document.",
    ),
    (
        "uk_thirlwall_inquiry",
        "uk",
        "https://thirlwall.public-inquiry.uk/evidence/",
        "Public Thirlwall Inquiry evidence or witness document.",
    ),
    (
        "uk_iicsa_inquiry",
        "uk",
        "https://www.iicsa.org.uk/investigations",
        "Public Independent Inquiry into Child Sexual Abuse report or evidence document.",
    ),
    (
        "uk_windrush_lessons",
        "uk",
        "https://www.gov.uk/government/collections/windrush-lessons-learned-review",
        "Public Windrush Lessons Learned Review document.",
    ),
    (
        "uk_gosport_inquiry",
        "uk",
        "https://www.gosportinquiry.org/",
        "Public Gosport Independent Panel or inquiry document.",
    ),
    (
        "uk_daniel_morgan_inquiry",
        "uk",
        "https://www.danielmorganinquiry.org.uk/",
        "Public Daniel Morgan Independent Panel or inquiry document.",
    ),
    (
        "uk_crown_commercial_service",
        "uk",
        "https://www.gov.uk/government/collections/crown-commercial-service-guidance-and-policies",
        "Public UK Crown Commercial Service procurement, tender, or contract-workflow document.",
    ),
    (
        "us_court_forms_civil_prose",
        "us",
        "https://www.uscourts.gov/forms-rules/forms/civil-pro-se-forms",
        "Public United States federal civil pro se court form.",
    ),
    (
        "us_court_forms_criminal",
        "us",
        "https://www.uscourts.gov/forms-rules/forms/criminal-forms",
        "Public United States federal criminal court form.",
    ),
    (
        "us_court_forms_subpoena",
        "us",
        "https://www.uscourts.gov/forms-rules/forms/subpoena-forms",
        "Public United States federal subpoena form.",
    ),
    (
        "us_court_forms_bankruptcy",
        "us",
        "https://www.uscourts.gov/forms-rules/forms/bankruptcy-forms",
        "Public United States federal bankruptcy court form.",
    ),
    (
        "us_gao_bid_protests",
        "us",
        "https://www.gao.gov/legal/bid-protests/recent",
        "Public US Government Accountability Office bid-protest decision or procurement-law document.",
    ),
    (
        "us_gao_appropriations",
        "us",
        "https://www.gao.gov/legal/appropriations-law/search",
        "Public US Government Accountability Office appropriations-law decision or opinion.",
    ),
    (
        "us_nlrb_workflow",
        "us",
        "https://www.nlrb.gov/reports-guidance/manuals",
        "Public National Labor Relations Board procedure, manual, or legal-workflow document.",
    ),
    (
        "us_court_federal_claims",
        "us",
        "https://www.uscfc.uscourts.gov/forms",
        "Public US Court of Federal Claims form or filing document.",
    ),
    (
        "us_doj_civil_rights",
        "us",
        "https://www.justice.gov/crt/cases-and-matters",
        "Public US Department of Justice civil-rights complaint, settlement, or litigation document.",
    ),
    (
        "us_dol_litigation",
        "us",
        "https://www.dol.gov/agencies/sol/briefs",
        "Public US Department of Labor solicitor legal brief or litigation document.",
    ),
    (
        "au_high_court_forms",
        "au",
        "https://www.hcourt.gov.au/court-procedures/forms-and-resources",
        "Public High Court of Australia form, practice direction, or filing resource.",
    ),
    (
        "au_federal_court_forms",
        "au",
        "https://www.fedcourt.gov.au/forms-and-fees/forms",
        "Public Federal Court of Australia form or filing resource.",
    ),
    (
        "au_nsw_local_forms",
        "au",
        "https://localcourt.nsw.gov.au/locations--lists-and-forms/forms-and-fees/forms.html",
        "Public Local Court of New South Wales form or legal-workflow document.",
    ),
    (
        "au_nsw_practice_notes",
        "au",
        "https://lpab.nsw.gov.au/content/dcj/ctsd/localcourt/local-court/practice-publications/practice-notes.html",
        "Public Local Court of New South Wales practice note or annexure.",
    ),
    (
        "au_nsw_ucpr_forms",
        "au",
        "https://dcj.nsw.gov.au/content/dcj/ctsd/ucpr/ucpr.html",
        "Public New South Wales Uniform Civil Procedure Rules form.",
    ),
    (
        "au_qld_court_workflow",
        "au",
        "https://www.courts.qld.gov.au/the-courts/supreme-court/supreme-court-pathway?a=866158",
        "Public Queensland civil-court procedure or litigant resource.",
    ),
    (
        "au_wa_court_forms",
        "au",
        "https://www.districtcourt.wa.gov.au/C/civil_procedures_forms_print.aspx",
        "Public District Court of Western Australia form or procedural document.",
    ),
    (
        "au_vic_court_forms",
        "au",
        "https://www.supremecourt.vic.gov.au/forms-fees-and-services/forms-templates-and-guidelines",
        "Public Supreme Court of Victoria form, template, or guideline.",
    ),
    (
        "au_procurement_workflow",
        "au",
        "https://www.finance.gov.au/government/procurement",
        "Public Australian Government procurement, tender, RFP, or contract-workflow document.",
    ),
    (
        "au_aat_forms",
        "au",
        "https://www.aat.gov.au/apply-to-the-aat/forms-and-guides",
        "Public Australian Administrative Appeals Tribunal form or procedural guide.",
    ),
    (
        "nz_justice_publications",
        "nz",
        "https://www.justice.govt.nz/about/order-a-printed-publication/",
        "Public New Zealand Ministry of Justice court or legal-workflow publication.",
    ),
    (
        "nz_criminal_forms",
        "nz",
        "https://www.justice.govt.nz/about/lawyers-and-service-providers/criminal-procedure-act/forms-and-documents/",
        "Public New Zealand criminal-procedure court form or document.",
    ),
    (
        "nz_family_forms",
        "nz",
        "https://www.justice.govt.nz/family/separation-divorce/divide-relationship-property/forms-and-fees/",
        "Public New Zealand Family Court form or filing document.",
    ),
    (
        "nz_family_workflow",
        "nz",
        "https://www.justice.govt.nz/family/powers-to-make-decisions/the-court-and-enduring-power-of-attorney-epa/",
        "Public New Zealand Family Court application or legal-workflow document.",
    ),
    (
        "nz_courts_judgments",
        "nz",
        "https://www.courtsofnz.govt.nz/judgments",
        "Public judgment or court-workflow document from the Courts of New Zealand.",
    ),
    (
        "nz_procurement_templates",
        "nz",
        "https://www.procurement.govt.nz/templates/",
        "Public New Zealand Government procurement, RFP, tender, or contract template.",
    ),
    (
        "nz_local_government_bylaws",
        "nz",
        "https://www.lgnz.co.nz/our-work/submissions/",
        "Public New Zealand local-government bylaw or local-authority legal-workflow document.",
    ),
    (
        "uk_covid_inquiry_evidence",
        "uk",
        "https://covid19.public-inquiry.uk/documents/",
        "Public UK Covid-19 Inquiry evidence, request, or procedural document.",
    ),
    (
        "uk_grenfell_key_documents",
        "uk",
        "https://www.grenfelltowerinquiry.org.uk/key-documents",
        "Public Grenfell Tower Inquiry key document or evidence protocol.",
    ),
    (
        "uk_fuller_inquiry",
        "uk",
        "https://www.gov.uk/government/collections/david-fuller-inquiry",
        "Public David Fuller Inquiry report or procedural document.",
    ),
    (
        "uk_public_inquiry_responses",
        "uk",
        "https://www.gov.uk/government/collections/public-inquiries-recommendations-and-the-government-response",
        "Public UK public-inquiry recommendation or government-response document.",
    ),
    (
        "uk_justice_form_n1",
        "uk",
        "https://www.gov.uk/government/publications/form-n1-claim-form-cpr-part-7",
        "Public England and Wales civil claim form and notes.",
    ),
    (
        "us_gao_bid_protest_decisions",
        "us",
        "https://www.gao.gov/legal/bid-protests/recent",
        "Public US GAO bid-protest decision or procurement-law document.",
    ),
    (
        "us_uscourts_civil_forms",
        "us",
        "https://www.uscourts.gov/forms-rules/forms/civil-forms",
        "Public US federal civil court form.",
    ),
    (
        "us_uscourts_bankruptcy_forms",
        "us",
        "https://www.uscourts.gov/forms-rules/forms/bankruptcy-forms",
        "Public US federal bankruptcy court form.",
    ),
    (
        "us_justice_employment_litigation",
        "us",
        "https://www.justice.gov/crt/employment-litigation-section-cases",
        "Public US Department of Justice employment-litigation pleading or order.",
    ),
)


def discover_seed_pages(selected_sources: set[str] | None = None) -> int:
    rows: list[dict] = []
    for source, jurisdiction, landing, terms in SEED_PAGES:
        if selected_sources and source not in selected_sources:
            continue
        print(f"seed page fetching {source}: {landing}", flush=True)
        try:
            links = links_from(landing)
        except Exception as exc:
            print(f"seed page failed: {landing}: {exc}", flush=True)
            continue
        for url, title in links:
            lowered = url.lower()
            if not is_pdf_candidate(url, title):
                continue
            rows.append(candidate(source, jurisdiction, url, title, landing, terms))
        print(f"seed page {source}: {landing}", flush=True)
    return write_candidates(rows)


DIRECT_PDFS = (
    (
        "canada_federal_tenders",
        "ca",
        "https://canadabuys.canada.ca/documents/pub/att/2022/11/28/6f97842c2e270be6ea72440f55291340/100021925-0-en.pdf",
        "Request for Proposal 100021925",
        "https://canadabuys.canada.ca/en/tender-opportunities",
        "Public Canadian federal procurement attachment published through CanadaBuys.",
    ),
    (
        "canada_federal_tenders",
        "ca",
        "https://canadabuys.canada.ca/documents/pub/att/2023/01/10/4c35dbf5e8d3af7fc8b8c999137a7d76/rfp_sen-060_22-23_final_e_c.pdf",
        "Request for Proposal SEN-060 22/23",
        "https://canadabuys.canada.ca/en/tender-opportunities",
        "Public Canadian federal procurement attachment published through CanadaBuys.",
    ),
    (
        "canada_federal_tenders",
        "ca",
        "https://canadabuys.canada.ca/documents/pub/att/2020/06/25/9bdd6c28c9f344bd8729c5170dcf0f17/rfp_01r11-21-c007_-_e.pdf",
        "Request for Proposal 01R11-21-C007",
        "https://canadabuys.canada.ca/en/tender-opportunities",
        "Public Canadian federal procurement attachment published through CanadaBuys.",
    ),
    (
        "canada_federal_tenders",
        "ca",
        "https://canadabuys.canada.ca/documents/pub/att/2023/01/09/a07c1441847cc666d55f2e0fcc1e147b/invitation_to_tender_01b46-22-156.pdf",
        "Invitation to Tender 01B46-22-156",
        "https://canadabuys.canada.ca/en/tender-opportunities",
        "Public Canadian federal procurement attachment published through CanadaBuys.",
    ),
    (
        "canada_federal_tenders",
        "ca",
        "https://canadabuys.canada.ca/documents/pub/att/2015/02/09/0af5140b6cff1e1c55cf2f456db9b2ef/14-1284_itt.pdf",
        "Invitation to Tender 14-1284",
        "https://canadabuys.canada.ca/en/tender-opportunities",
        "Public Canadian federal procurement attachment published through CanadaBuys.",
    ),
    (
        "canada_federal_tenders",
        "ca",
        "https://canadabuys.canada.ca/documents/pub/att/2022/03/04/9851240c82ef5d1ba549013f7447afba/100020004-rfp-final.pdf",
        "Request for Proposal 100020004",
        "https://canadabuys.canada.ca/en/tender-opportunities",
        "Public Canadian federal procurement attachment published through CanadaBuys.",
    ),
    (
        "crtc_public_proceedings",
        "ca",
        "https://crtc.gc.ca/eng/archive/2025/2025-94.pdf",
        "Broadcasting and Telecom Notice of Consultation CRTC 2025-94",
        "https://crtc.gc.ca/eng/archive/2025/2025-94.htm",
        "Public Canadian regulatory proceeding document published by the CRTC.",
    ),
    (
        "crtc_public_proceedings",
        "ca",
        "https://crtc.gc.ca/eng/archive/2024/2024-111.pdf",
        "Online News Notice of Consultation CRTC 2024-111",
        "https://crtc.gc.ca/eng/archive/2024/2024-111.htm",
        "Public Canadian regulatory proceeding document published by the CRTC.",
    ),
    (
        "crtc_public_proceedings",
        "ca",
        "https://crtc.gc.ca/eng/archive/2025/2025-2-4.pdf",
        "Broadcasting Notice of Consultation CRTC 2025-2-4",
        "https://crtc.gc.ca/eng/archive/2025/2025-2-4.htm",
        "Public Canadian regulatory proceeding document published by the CRTC.",
    ),
    (
        "cer_workflow",
        "ca",
        "https://www.cer-rec.gc.ca/en/applications-hearings/submit-applications-documents/filing-manuals/filing-manual/filing-manual.pdf",
        "Canada Energy Regulator Filing Manual",
        "https://www.cer-rec.gc.ca/en/applications-hearings/submit-applications-documents/",
        "Public Canadian regulatory filing manual published by the Canada Energy Regulator.",
    ),
    (
        "cer_workflow",
        "ca",
        "https://www.cer-rec.gc.ca/en/applications-hearings/regulatory-document/rgdcsgttngstrtddc-eng.pdf",
        "REGDOCS Getting Started Guide",
        "https://www.cer-rec.gc.ca/en/applications-hearings/regulatory-document/help-browsing-regulatory-documents.html",
        "Public Canadian regulatory-record workflow document published by the Canada Energy Regulator.",
    ),
    (
        "cer_workflow",
        "ca",
        "https://www.cer-rec.gc.ca/en/consultation-engagement/form/compensation-hearing-application.pdf",
        "Compensation Hearing Application",
        "https://www.cer-rec.gc.ca/en/applications-hearings/submit-applications-documents/",
        "Public Canadian regulatory application form published by the Canada Energy Regulator.",
    ),
    (
        "au_accc",
        "au",
        "https://www.accc.gov.au/system/files/ce-policy_0.pdf",
        "ACCC Compliance and Enforcement Policy",
        "https://www.accc.gov.au/about-us/publications/guidelines-on-the-use-of-infringement-notices-by-the-accc",
        "Public Australian competition-law compliance policy published by the ACCC.",
    ),
    (
        "au_accc",
        "au",
        "https://www.accc.gov.au/system/files/ACCC%20compliance%20and%20enforcement%20guide%20for%20infrastructure%20operators%2C%20Water%20Market%20and%20Water%20Charge%20Rules.pdf",
        "ACCC Compliance and Enforcement Guide for Infrastructure Operators",
        "https://www.accc.gov.au/publications",
        "Public Australian competition-law compliance guide published by the ACCC.",
    ),
    (
        "au_alrc",
        "au",
        "https://www.alrc.gov.au/wp-content/uploads/2019/08/alrc_132_whole_with_cover.compressed.pdf",
        "ALRC Annual Report 2016-17",
        "https://www.alrc.gov.au/publications/",
        "Public Australian law-reform work product published by the ALRC.",
    ),
    (
        "uk_gov_legal_workflow",
        "uk",
        "https://assets.publishing.service.gov.uk/media/64a57ca6c531eb001364fed0/n163.pdf",
        "Form N163 Skeleton Argument",
        "https://www.gov.uk/government/publications/form-n163-skeleton-arguments",
        "Public UK court-workflow form published on GOV.UK.",
    ),
    (
        "uk_gov_legal_workflow",
        "uk",
        "https://assets.publishing.service.gov.uk/media/607d6bfae90e076f546614df/Ms_T_Tgahane_vs_Palladium_International_Limited.pdf",
        "Employment Tribunal public preliminary-hearing record",
        "https://www.gov.uk/government/publications/employment-tribunal-decisions",
        "Public UK employment-tribunal document published on GOV.UK.",
    ),
    (
        "uk_gov_legal_workflow",
        "uk",
        "https://assets.publishing.service.gov.uk/media/628cd2c48fa8f55622a9c927/Skeleton_Served_on_behalf_of_the_Sixth_Defendant.pdf",
        "HS2 v Persons Unknown Skeleton Argument",
        "https://www.gov.uk/government/publications/hs2-v-persons-unknown",
        "Public UK court filing published on GOV.UK.",
    ),
    (
        "uk_infected_blood_workflow",
        "uk",
        "https://www.infectedbloodinquiry.org.uk/sites/default/files/2018-11-01%20Amended%20Statement%20of%20Approach%20-%20Evidence%202.pdf",
        "Amended Statement of Approach - Evidence 2",
        "https://www.infectedbloodinquiry.org.uk/statements-approach",
        "Public inquiry evidence-procedure document published by the UK Infected Blood Inquiry.",
    ),
    (
        "uk_infected_blood_workflow",
        "uk",
        "https://www.infectedbloodinquiry.org.uk/sites/default/files/2025-03/Witness%20Statement%20Extracts.pdf",
        "Witness Statement Extracts",
        "https://www.infectedbloodinquiry.org.uk/public-hearings",
        "Public inquiry witness-work product published by the UK Infected Blood Inquiry.",
    ),
    (
        "australian_parliament_submissions",
        "au",
        "https://www.aph.gov.au/DocumentStore.ashx?id=54b9fe58-d823-4ccf-8512-d4da3cb43e42",
        "Australian Senate inquiry submission on psychology training",
        "https://www.aph.gov.au/Parliamentary_Business/Committees/Senate/",
        "Public Australian parliamentary inquiry submission published by the Parliament of Australia.",
    ),
    (
        "australian_parliament_submissions",
        "au",
        "https://www.aph.gov.au/DocumentStore.ashx?id=c9ac1c86-0ca7-467f-8682-b0142c7a9f61",
        "Australian Senate submission on superannuation reform",
        "https://www.aph.gov.au/Parliamentary_Business/Committees/Senate/",
        "Public Australian parliamentary inquiry submission published by the Parliament of Australia.",
    ),
    (
        "australian_parliament_submissions",
        "au",
        "https://www.aph.gov.au/DocumentStore.ashx?id=16cb34f3-1320-4ce6-b0aa-ebcf98f5c0d5",
        "Australian Senate submission on extreme weather events",
        "https://www.aph.gov.au/Parliamentary_Business/Committees/Senate/",
        "Public Australian parliamentary inquiry submission published by the Parliament of Australia.",
    ),
    (
        "australian_parliament_submissions",
        "au",
        "https://www.aph.gov.au/DocumentStore.ashx?id=326a4a79-41e1-40df-9174-8bdebc9f6b60&subId=302469",
        "Australian parliamentary submission on agricultural levies",
        "https://www.aph.gov.au/Parliamentary_Business/Committees/Senate/",
        "Public Australian parliamentary inquiry submission published by the Parliament of Australia.",
    ),
    (
        "australian_parliament_submissions",
        "au",
        "https://www.aph.gov.au/DocumentStore.ashx?id=19f1b9b1-f0bd-4d5c-a71d-658bda24a4c7",
        "Australian parliamentary submission on personal property securities",
        "https://www.aph.gov.au/Parliamentary_Business/Committees/Senate/",
        "Public Australian parliamentary inquiry submission published by the Parliament of Australia.",
    ),
    (
        "australian_parliament_submissions",
        "au",
        "https://www.aph.gov.au/DocumentStore.ashx?id=877339c8-56f6-4316-abfd-542d84df9514&subId=781802",
        "Australian parliamentary submission on antisemitism, hate, and extremism legislation",
        "https://www.aph.gov.au/Parliamentary_Business/Committees/Senate/",
        "Public Australian parliamentary inquiry submission published by the Parliament of Australia.",
    ),
    (
        "australian_parliament_submissions",
        "au",
        "https://www.aph.gov.au/DocumentStore.ashx?id=43be7067-3145-494a-a6c3-9af7a66ffce0",
        "Australian parliamentary submission on marriage equality",
        "https://www.aph.gov.au/Parliamentary_Business/Committees/Senate/",
        "Public Australian parliamentary inquiry submission published by the Parliament of Australia.",
    ),
    (
        "australian_parliament_submissions",
        "au",
        "https://www.aph.gov.au/DocumentStore.ashx?id=bf2e826d-36eb-4e8e-ab73-553905db8fb3",
        "Australian parliamentary submission from a community legal centre",
        "https://www.aph.gov.au/Parliamentary_Business/Committees/Senate/",
        "Public Australian parliamentary inquiry submission published by the Parliament of Australia.",
    ),
    (
        "tax_court_canada_forms",
        "ca",
        "https://www.tcc-cci.gc.ca/Content/assets/forms/base/general_appeal_form21%281%29%28a%29_e.pdf",
        "Tax Court of Canada Form 21(1)(a) Notice of Appeal - General Procedure",
        "https://www.tcc-cci.gc.ca/en/pages/forms",
        "Public Tax Court of Canada filing form.",
    ),
    (
        "tax_court_canada_forms",
        "ca",
        "https://www.tcc-cci.gc.ca/Content/assets/forms/base/informal_appeal_form4_e.pdf",
        "Tax Court of Canada Schedule 4 Notice of Appeal - Informal Procedure",
        "https://www.tcc-cci.gc.ca/en/pages/forms",
        "Public Tax Court of Canada filing form.",
    ),
    (
        "federal_court_canada_practice",
        "ca",
        "https://www.fct-cf.ca/Content/assets/pdf/base/2025-06-20_Amended-Consolidated-General-Practice-Guidelines.pdf",
        "Federal Court of Canada Amended Consolidated General Practice Guidelines",
        "https://www.fct-cf.ca/en/online-access/forms",
        "Public Federal Court of Canada practice guideline.",
    ),
    (
        "federal_court_canada_practice",
        "ca",
        "https://www.fct-cf.ca/content/assets/pdf/base/E-filing-Guide-May-7-2020-Final-EN.pdf",
        "Federal Court of Canada E-Filing Guide",
        "https://www.fct-cf.ca/en/online-access/e-filing",
        "Public Federal Court of Canada filing guide.",
    ),
    (
        "newfoundland_court_forms",
        "ca",
        "https://www.court.nl.ca/supreme/files/Generic-Affidavit.pdf",
        "Newfoundland and Labrador Supreme Court Generic Affidavit",
        "https://www.court.nl.ca/supreme/rules-practice-notes-and-forms/family/general/",
        "Public Newfoundland and Labrador Supreme Court form.",
    ),
    (
        "newfoundland_court_forms",
        "ca",
        "https://www.court.nl.ca/provincial/files/Com_FORM4.pdf",
        "Newfoundland and Labrador Provincial Court Form 4 Response",
        "https://www.court.nl.ca/provincial/",
        "Public Newfoundland and Labrador Provincial Court form.",
    ),
    (
        "newfoundland_court_forms",
        "ca",
        "https://www.court.nl.ca/supreme/files/form_1001a_defence.pdf",
        "Newfoundland and Labrador Supreme Court Form 10.01A Defence",
        "https://www.court.nl.ca/supreme/",
        "Public Newfoundland and Labrador Supreme Court form.",
    ),
    (
        "pei_court_forms",
        "ca",
        "https://www.courts.pe.ca/sites/www.courts.pe.ca/files/Forms%20and%20Rules/16a.pdf",
        "Prince Edward Island Supreme Court Form 16A Notice of Trial",
        "https://www.courts.pe.ca/forms",
        "Public Prince Edward Island court form.",
    ),
    (
        "hamilton_zoning",
        "ca",
        "https://www.hamilton.ca/sites/default/files/2026-03/hamilton-zoning-by-law-6593-consolidation-mar2026.pdf",
        "Hamilton Zoning By-law 6593 Consolidation",
        "https://www.hamilton.ca/build-invest-grow/planning-development/zoning/zoning-by-law-05-200",
        "Public City of Hamilton zoning bylaw.",
    ),
    (
        "hamilton_zoning",
        "ca",
        "https://www.hamilton.ca/sites/default/files/2024-12/24-072-consolidated.pdf",
        "Hamilton Zoning By-law Amendment 24-072 Consolidated",
        "https://www.hamilton.ca/build-invest-grow/planning-development/zoning/zoning-by-law-05-200",
        "Public City of Hamilton zoning bylaw amendment.",
    ),
    (
        "markham_zoning",
        "ca",
        "https://www.markham.ca/sites/default/files/2024-06/Comprehensive%2BZoning%2BBy-law%2BNew%2BMapping%2BLink%2B-%2BJune%2B2024%2BReduced%2BFile%2BSize.pdf",
        "Markham Comprehensive Zoning By-law 2024-19",
        "https://www.markham.ca/economic-development-business/planning-development-services/zoning-and-development-law-information",
        "Public City of Markham zoning bylaw.",
    ),
    (
        "markham_zoning",
        "ca",
        "https://www.markham.ca/sites/default/files/about-city-markham/new-zoning-bylaw/phase1/Appendix%20D%20Existing%20Zoning%20By-laws.pdf",
        "Markham Existing Zoning By-laws Appendix D",
        "https://www.markham.ca/economic-development-business/planning-development-services/zoning-and-development-law-information",
        "Public City of Markham zoning bylaw record.",
    ),
    (
        "halifax_zoning",
        "ca",
        "https://www.halifax.ca/sites/default/files/documents/about-the-city/regional-community-planning/DowntownHalifax-LUB-Eff-21Nov27-RegCentre-PkgB-TOCLinked.pdf",
        "Downtown Halifax Land Use By-law",
        "https://www.halifax.ca/city-hall/municipal-government/municipal-planning-strategy-land-use-bylaws",
        "Public Halifax Regional Municipality land-use bylaw.",
    ),
    (
        "canada_federal_tenders",
        "ca",
        "https://canadabuys.canada.ca/documents/pub/att/2023/01/27/aa9b1a4219ca4be3589b5c2b7051a835/t5013220263_-_request_for_proposal.pdf",
        "CanadaBuys Request for Proposal T5013220263",
        "https://canadabuys.canada.ca/en/tender-opportunities",
        "Public Canadian federal procurement attachment published through CanadaBuys.",
    ),
    (
        "canada_federal_tenders",
        "ca",
        "https://canadabuys.canada.ca/sites/default/files/webform/tender_notice/71470/rfp-25260002---project-management-software-solution.pdf",
        "CanadaBuys Request for Proposal 25260002 Project Management Software",
        "https://canadabuys.canada.ca/en/tender-opportunities",
        "Public Canadian federal procurement attachment published through CanadaBuys.",
    ),
    (
        "alberta_procurement",
        "ca",
        "https://www.alberta.ca/system/files/custom_downloaded_images/tr-biddocumentchecklist.pdf",
        "Alberta Request for Proposal and Bid Document Review Checklist",
        "https://www.alberta.ca/find-and-compete-for-government-contracts",
        "Public Alberta government procurement workflow document.",
    ),
    (
        "bc_procurement",
        "ca",
        "https://www2.gov.bc.ca/assets/gov/buying-and-selling/procurement-and-contracting-for-government/solicitation-processes-and-templates/rfp_guide.pdf",
        "British Columbia Ministry Guide to the Request for Proposals",
        "https://www2.gov.bc.ca/gov/content/bc-procurement-resources/buy-for-government/solicitation-processes-and-templates",
        "Public British Columbia government procurement workflow document.",
    ),
    (
        "ontario_procurement",
        "ca",
        "https://www.ontario.ca/files/2024-02/tbs-bps-procurement-directive-en-2024-02-08.pdf",
        "Ontario Broader Public Sector Procurement Directive",
        "https://www.ontario.ca/page/government-procurement",
        "Public Ontario government procurement workflow document.",
    ),
    (
        "uk_justice_civil_forms",
        "uk",
        "https://www.gov.uk/government/uploads/system/uploads/attachment_data/file/489360/n1-eng.pdf",
        "HMCTS Form N1 Claim Form",
        "https://www.justice.gov.uk/courts/procedure-rules/civil/forms",
        "Public England and Wales civil court form.",
    ),
    (
        "uk_justice_family_forms",
        "uk",
        "https://www.justice.gov.uk/courts/procedure-rules/family/fpr_forms/a4.pdf",
        "Family Procedure Rules Form A4 Application for Revocation of an Order",
        "https://www.justice.gov.uk/courts/procedure-rules/family/formspage",
        "Public England and Wales family court form.",
    ),
    (
        "uk_justice_criminal_forms",
        "uk",
        "https://www.justice.gov.uk/courts/procedure-rules/criminal/docs/crimpr-part6-rule6-32app.pdf",
        "Criminal Procedure Rules Application Form",
        "https://www.justice.gov.uk/courts/procedure-rules/criminal",
        "Public England and Wales criminal court form.",
    ),
    (
        "au_high_court_forms",
        "au",
        "https://www.hcourt.gov.au/sites/default/files/assets/registry/practice-directions/Practice_Direction_No_1_of_2024_Approved_Forms_20_December_2024-2.pdf",
        "High Court of Australia Practice Direction No 1 of 2024 Approved Forms",
        "https://www.hcourt.gov.au/court-procedures/forms-and-resources",
        "Public High Court of Australia approved court forms practice direction.",
    ),
    (
        "au_federal_court_files",
        "au",
        "https://www.fedcourt.gov.au/services/access-to-files-and-transcripts/online-files/forum-finance/exhibits-tendered/Exhibit-CMM-29.pdf",
        "Federal Court of Australia Exhibit CMM-29",
        "https://www.fedcourt.gov.au/services/access-to-files-and-transcripts/online-files",
        "Public Federal Court of Australia online-file exhibit.",
    ),
    (
        "nz_procurement_templates",
        "nz",
        "https://web-assets.education.govt.nz/s3fs-public/2024-03/1314275-Appendix-A.pdf?VersionId=tk_sBaoCaISrzPJOhWX5BX3Fr1WhAULh",
        "New Zealand Government Model Request for Proposal Template",
        "https://www.procurement.govt.nz/templates/",
        "Public New Zealand Government procurement template.",
    ),
    (
        "nz_procurement_templates",
        "nz",
        "https://www.eeca.govt.nz/assets/Urban-bi-directional-charging-trial-RFP-document.pdf",
        "New Zealand Government Model Request for Proposal Document",
        "https://www.procurement.govt.nz/templates/",
        "Public New Zealand Government procurement document.",
    ),
    (
        "yukon_court_forms",
        "ca",
        "https://www.yukoncourts.ca/sites/default/files/2024-07/general-31_amended_forms_10_and_23.pdf",
        "Supreme Court of Yukon Amended Forms 10 and 23",
        "https://www.yukoncourts.ca/en/supreme-court/rules-forms",
        "Public Yukon court form document.",
    ),
    (
        "yukon_court_forms",
        "ca",
        "https://www.yukoncourts.ca/sites/default/files/documents/en/GENERAL_19_availability_of_supreme_court_rules_and_forms.pdf",
        "Supreme Court of Yukon Availability of Rules and Forms",
        "https://www.yukoncourts.ca/en/supreme-court/rules-forms",
        "Public Yukon court workflow document.",
    ),
    (
        "yukon_court_forms",
        "ca",
        "https://www.yukoncourts.ca/sites/default/files/documents/en/Summary_Conviction_Appeal_Rules_2009.pdf",
        "Yukon Summary Conviction Appeal Rules and Forms",
        "https://www.yukoncourts.ca/en/supreme-court/summary-conviction-appeal-rules-2009",
        "Public Yukon criminal appeal rules and forms.",
    ),
    (
        "yukon_court_forms",
        "ca",
        "https://www.yukoncourts.ca/sites/default/files/documents/en/CRIMINAL_4_applications_in_criminal_law_matters.pdf",
        "Yukon Criminal Applications in Criminal Law Matters",
        "https://www.yukoncourts.ca/en/supreme-court/criminal-forms",
        "Public Yukon criminal court form document.",
    ),
    (
        "nwt_court_rules",
        "ca",
        "https://www.justice.gov.nt.ca/en/files/court-rules/Territorial%20Court%20Act/Territorial%20Court%20Civil%20Claims%20Rules/Civil%20Claims%20Rules.pdf",
        "Northwest Territories Civil Claims Rules and Forms",
        "https://www.justice.gov.nt.ca/en/court-rules/",
        "Public Northwest Territories civil court rules and forms.",
    ),
    (
        "nwt_court_rules",
        "ca",
        "https://www.justice.gov.nt.ca/en/files/court-rules/Judicature%20Act/Rules%20of%20the%20Supreme%20Court%20of%20the%20Northwest%20Territories/Current%20Consolidation%20Table%20of%20Contents.pdf",
        "Northwest Territories Supreme Court Rules Table of Contents",
        "https://www.justice.gov.nt.ca/en/court-rules/",
        "Public Northwest Territories Supreme Court rules document.",
    ),
    (
        "nunavut_court_forms",
        "ca",
        "https://www.nunavutcourts.ca/index.php/forms/category/98-civil-rules?download=1",
        "Nunavut Court of Justice Civil Rules and Forms",
        "https://www.nunavutcourts.ca/index.php/forms/category/98-civil-rules",
        "Public Nunavut court rules and forms collection.",
    ),
    (
        "toronto_zoning_documents",
        "ca",
        "https://www.toronto.ca/wp-content/uploads/2018/07/97ec-City-Planning-Zoning-Zoning-By-law-Part-1.pdf",
        "Toronto Zoning By-law 569-2013 Volume 1",
        "https://www.toronto.ca/city-government/planning-development/zoning-by-law-preliminary-zoning-reviews/zoning-by-law-569-2013-2/",
        "Public City of Toronto zoning bylaw volume.",
    ),
    (
        "toronto_zoning_documents",
        "ca",
        "https://www.toronto.ca/wp-content/uploads/2018/07/9067-City-Planning-Zoning-Zoning-By-law-Part-2.pdf",
        "Toronto Zoning By-law 569-2013 Volume 2",
        "https://www.toronto.ca/city-government/planning-development/zoning-by-law-preliminary-zoning-reviews/zoning-by-law-569-2013-2/",
        "Public City of Toronto zoning bylaw volume.",
    ),
    (
        "toronto_zoning_documents",
        "ca",
        "https://www.toronto.ca/wp-content/uploads/2018/07/90a5-City-Planning-Zoning-Zoning-By-law-Part-3.pdf",
        "Toronto Zoning By-law 569-2013 Volume 3",
        "https://www.toronto.ca/city-government/planning-development/zoning-by-law-preliminary-zoning-reviews/zoning-by-law-569-2013-2/",
        "Public City of Toronto zoning bylaw volume.",
    ),
    (
        "toronto_zoning_documents",
        "ca",
        "https://www.toronto.ca/wp-content/uploads/2026/04/8fb7-City-Planning-Zoning-Zoning-By-law-Part-4.pdf",
        "Toronto Zoning By-law 569-2013 Volume 4",
        "https://www.toronto.ca/city-government/planning-development/zoning-by-law-preliminary-zoning-reviews/zoning-by-law-569-2013-2/",
        "Public City of Toronto zoning bylaw volume.",
    ),
    (
        "vancouver_zoning_documents",
        "ca",
        "https://bylaws.vancouver.ca/zoning/zoning-by-law-section-1.pdf",
        "Vancouver Zoning and Development By-law Section 1",
        "https://vancouver.ca/home-property-development/zoning-and-land-use-policies-document-library.aspx",
        "Public City of Vancouver zoning bylaw section.",
    ),
    (
        "vancouver_zoning_documents",
        "ca",
        "https://bylaws.vancouver.ca/zoning/zoning-by-law-section-6.pdf",
        "Vancouver Zoning and Development By-law Section 6 Amendments",
        "https://vancouver.ca/home-property-development/zoning-and-land-use-policies-document-library.aspx",
        "Public City of Vancouver zoning bylaw section.",
    ),
    (
        "vancouver_zoning_documents",
        "ca",
        "https://bylaws.vancouver.ca/zoning/zoning-by-law-schedule-d.pdf",
        "Vancouver Zoning and Development By-law Schedule D Zoning District Plan",
        "https://vancouver.ca/home-property-development/zoning-and-land-use-policies-document-library.aspx",
        "Public City of Vancouver zoning map document.",
    ),
    (
        "vancouver_zoning_documents",
        "ca",
        "https://bylaws.vancouver.ca/odp/odp-arbutus-corridor.pdf",
        "Vancouver Arbutus Corridor Official Development Plan",
        "https://vancouver.ca/home-property-development/zoning-and-land-use-policies-document-library.aspx",
        "Public City of Vancouver official development plan.",
    ),
    (
        "canada_federal_rfps",
        "ca",
        "https://canadabuys.canada.ca/sites/default/files/webform/tender_notice/77147/1000267139_complete-rfp-%28final-%28english.pdf",
        "CanadaBuys Complete Request for Proposal 1000267139",
        "https://canadabuys.canada.ca/en/tender-opportunities",
        "Public Canadian federal request for proposal attachment.",
    ),
    (
        "bc_procurement_rfp",
        "ca",
        "https://www2.gov.bc.ca/assets/gov/bc-procurement-resources/ministry_guide_to_the_request_for_proposals_2025-04-23.pdf",
        "British Columbia Ministry Guide to the Request for Proposals 2025",
        "https://www2.gov.bc.ca/gov/content/bc-procurement-resources/buy-for-government/solicitation-processes-and-templates",
        "Public British Columbia government RFP workflow guide.",
    ),
    (
        "bc_procurement_rfp",
        "ca",
        "https://www2.gov.bc.ca/assets/gov/bc-procurement-resources/solicitation-and-contract-options/at_a_glance_sco_overview.pdf",
        "British Columbia Solicitation and Contract Options Overview",
        "https://www2.gov.bc.ca/gov/content/bc-procurement-resources/buy-for-government/solicitation-processes-and-templates",
        "Public British Columbia government solicitation workflow document.",
    ),
    (
        "uk_covid_inquiry_evidence",
        "uk",
        "https://covid19.public-inquiry.uk/wp-content/uploads/2025/10/08102449/INQ000651520.pdf",
        "UK Covid-19 Inquiry Evidence INQ000651520",
        "https://covid19.public-inquiry.uk/documents/",
        "Public UK Covid-19 Inquiry evidence document.",
    ),
    (
        "uk_covid_inquiry_evidence",
        "uk",
        "https://covid19.public-inquiry.uk/wp-content/uploads/2026/01/19090822/INQ000653406.pdf",
        "UK Covid-19 Inquiry Module 9 Request for Evidence",
        "https://covid19.public-inquiry.uk/documents/",
        "Public UK Covid-19 Inquiry request for evidence.",
    ),
    (
        "uk_covid_inquiry_evidence",
        "uk",
        "https://covid19.public-inquiry.uk/wp-content/uploads/2024/09/09164237/C-19-Inquiry-6-September-2024-Mod-8-prelim-Amended.pdf",
        "UK Covid-19 Inquiry Module 8 Preliminary Amended Document",
        "https://covid19.public-inquiry.uk/documents/",
        "Public UK Covid-19 Inquiry procedural/evidence document.",
    ),
    (
        "uk_covid_inquiry_evidence",
        "uk",
        "https://covid19.public-inquiry.uk/wp-content/uploads/2023/05/24111635/Covid-Inquiry-GLD-S21-Application.pdf",
        "UK Covid-19 Inquiry Government Legal Department Section 21 Application",
        "https://covid19.public-inquiry.uk/documents/",
        "Public UK Covid-19 Inquiry application document.",
    ),
    (
        "uk_covid_inquiry_evidence",
        "uk",
        "https://covid19.public-inquiry.uk/wp-content/uploads/2023/05/C19-Inq-1-November-2022-Module-2A.pdf",
        "UK Covid-19 Inquiry Module 2A Document",
        "https://covid19.public-inquiry.uk/documents/",
        "Public UK Covid-19 Inquiry document.",
    ),
    (
        "uk_grenfell_key_documents",
        "uk",
        "https://assets.grenfelltowerinquiry.org.uk/CAB00006940_Cabinet%20Office%20Position%20Statement%20dated%209%20February%202018.pdf",
        "Grenfell Tower Inquiry Cabinet Office Position Statement",
        "https://www.grenfelltowerinquiry.org.uk/key-documents",
        "Public Grenfell Tower Inquiry key document.",
    ),
    (
        "us_gao_bid_protest_decisions",
        "us",
        "https://www.gao.gov/assets/890/882920.pdf",
        "GAO Bid Protest Decision B-423475.3 CORE DC LLC",
        "https://www.gao.gov/products/b-423475.3",
        "Public US GAO bid-protest procurement-law decision.",
    ),
    (
        "us_gao_bid_protest_decisions",
        "us",
        "https://www.gao.gov/assets/125550.pdf",
        "GAO Bid Protest Decision B-411842.6",
        "https://www.gao.gov/legal/bid-protests/recent",
        "Public US GAO bid-protest procurement-law decision.",
    ),
    (
        "us_gao_bid_protest_decisions",
        "us",
        "https://www.gao.gov/assets/gao-25-108652-highlights.pdf",
        "GAO Bid Protests Key Features and Trends Highlights",
        "https://www.gao.gov/products/gao-25-108652",
        "Public US GAO procurement-law report.",
    ),
    (
        "us_gao_bid_protest_decisions",
        "us",
        "https://www.gao.gov/assets/gao-06-797sp.pdf",
        "GAO Bid Protests at GAO Descriptive Guide",
        "https://www.gao.gov/legal/bid-protests/reference-materials",
        "Public US GAO bid-protest procedure guide.",
    ),
    (
        "us_uscourts_civil_forms",
        "us",
        "https://www.uscourts.gov/sites/default/files/ao088.pdf",
        "US Federal Court Form AO 88 Civil Hearing Subpoena",
        "https://www.uscourts.gov/forms-rules/forms/civil-forms",
        "Public US federal civil court form.",
    ),
    (
        "us_uscourts_civil_forms",
        "us",
        "https://www.uscourts.gov/sites/default/files/ao450.pdf",
        "US Federal Court Form AO 450 Judgment in a Civil Case",
        "https://www.uscourts.gov/forms-rules/forms/civil-forms",
        "Public US federal civil court form.",
    ),
    (
        "us_uscourts_civil_forms",
        "us",
        "https://www.uscourts.gov/sites/default/files/ao451.pdf",
        "US Federal Court Form AO 451 Clerk Certification of Judgment",
        "https://www.uscourts.gov/forms-rules/forms/civil-forms",
        "Public US federal civil court form.",
    ),
    (
        "us_uscourts_civil_forms",
        "us",
        "https://www.uscourts.gov/sites/default/files/js_44.pdf",
        "US Federal Court JS 44 Civil Cover Sheet",
        "https://www.uscourts.gov/forms-rules/forms/civil-forms",
        "Public US federal civil court form.",
    ),
    (
        "us_uscourts_civil_forms",
        "us",
        "https://www.uscourts.gov/sites/default/files/complaint_for_a_civil_case.pdf",
        "US Federal Court Pro Se 1 Complaint for a Civil Case",
        "https://www.uscourts.gov/forms-rules/forms/civil-forms",
        "Public US federal civil pleading form.",
    ),
    (
        "us_uscourts_bankruptcy_forms",
        "us",
        "https://www.uscourts.gov/sites/default/files/form_b2570_0.pdf",
        "US Bankruptcy Form B2570 Subpoena to Produce Documents",
        "https://www.uscourts.gov/forms-rules/forms/bankruptcy-forms",
        "Public US federal bankruptcy court form.",
    ),
    (
        "us_uscourts_bankruptcy_forms",
        "us",
        "https://www.uscourts.gov/sites/default/files/form_b2560_0.pdf",
        "US Bankruptcy Form B2560 Deposition Subpoena",
        "https://www.uscourts.gov/forms-rules/forms/bankruptcy-forms",
        "Public US federal bankruptcy court form.",
    ),
    (
        "canada_federal_rfis",
        "ca",
        "https://canadabuys.canada.ca/sites/default/files/webform/tender_notice/22589/rfi-1000433066---en.pdf",
        "CanadaBuys Request for Information 1000433066",
        "https://canadabuys.canada.ca/en/tender-opportunities",
        "Public Canadian federal request for information attachment.",
    ),
    (
        "canada_federal_rfis",
        "ca",
        "https://canadabuys.canada.ca/sites/default/files/webform/tender_notice/47398/rfi-1000515852_bi_advanced_analytics_en.pdf",
        "CanadaBuys Request for Information Advanced Analytics",
        "https://canadabuys.canada.ca/en/tender-opportunities",
        "Public Canadian federal request for information attachment.",
    ),
    (
        "canada_federal_rfis",
        "ca",
        "https://canadabuys.canada.ca/sites/default/files/webform/tender_notice/73854/30007050---rfi_en.pdf",
        "CanadaBuys Request for Information 30007050",
        "https://canadabuys.canada.ca/en/tender-opportunities",
        "Public Canadian federal request for information attachment.",
    ),
    (
        "canada_federal_rfis",
        "ca",
        "https://canadabuys.canada.ca/sites/default/files/webform/tender_notice/6061/dc-2023-cd-06-rfi-brand-love-research-addendum-1.pdf",
        "CanadaBuys Request for Information Brand Love Research Addendum",
        "https://canadabuys.canada.ca/en/tender-opportunities",
        "Public Canadian procurement request-for-information addendum.",
    ),
    (
        "canada_federal_rfis",
        "ca",
        "https://canadabuys.canada.ca/sites/default/files/webform/tender_notice/89756/request-for-information---en.pdf",
        "CanadaBuys Request for Information 89756",
        "https://canadabuys.canada.ca/en/tender-opportunities",
        "Public Canadian federal request for information attachment.",
    ),
)


def discover_direct_pdfs() -> int:
    rows = [candidate(source, jurisdiction, url, title, landing, terms) for source, jurisdiction, url, title, landing, terms in DIRECT_PDFS]
    return write_candidates(rows)


APH_SEEDS = (
    "https://www.aph.gov.au/Parliamentary_Business/Committees/Senate/Legal_and_Constitutional_Affairs/RepealingOffences2026/Submissions",
    "https://www.aph.gov.au/Parliamentary_Business/Committees/Senate/Legal_and_Constitutional_Affairs/Completed_inquiries/2010-13/actterritoryselfgovernment/submissions",
    "https://www.aph.gov.au/Parliamentary_Business/Committees/Senate/Legal_and_Constitutional_Affairs/Completed_inquiries/2008-10/same_sex_general_law_reform/submissions/sublist",
    "https://www.aph.gov.au/Parliamentary_Business/Committees/Senate/Legal_and_Constitutional_Affairs/Completed_inquiries/2010-13/trademarksamendment/submissions",
    "https://www.aph.gov.au/Parliamentary_Business/Committees/Senate/Legal_and_Constitutional_Affairs/Completed_inquiries/2008-10/sex_discrim/submissions/sublist",
    "https://www.aph.gov.au/Parliamentary_Business/Committees/Senate/Legal_and_Constitutional_Affairs/Completed_inquiries/2004-07/national_sec/submissions/sublist",
    "https://www.aph.gov.au/Parliamentary_Business/Committees/Senate/Legal_and_Constitutional_Affairs/UNDRIP/Submissions",
)


def discover_aph() -> int:
    rows: list[dict] = []
    for landing in APH_SEEDS:
        try:
            links = links_from(landing)
        except Exception as exc:
            print(f"aph page failed: {landing}: {exc}")
            continue
        for url, title in links:
            if not ("documentstore.ashx" in url.lower() or ".pdf" in url.lower() or "upload_pdf" in url.lower()):
                continue
            rows.append(candidate("australian_parliament_submissions", "au", url, title, landing, "Submission authorised for publication by a committee of the Parliament of Australia; parliamentary publication terms apply."))
    return write_candidates(rows)


def discover_au_royal_commission() -> int:
    seeds = (
        "https://defenceveteransuicide.royalcommission.gov.au/publications/evidence",
        "https://disability.royalcommission.gov.au/public-hearings/public-hearing-5-sydney-exhibits-tendered-chambers",
    )
    rows: list[dict] = []
    for landing in seeds:
        try:
            links = links_from(landing)
        except Exception as exc:
            print(f"au inquiry page failed: {landing}: {exc}")
            continue
        for url, title in links:
            if ".pdf" not in url.lower() and "/document" not in url.lower():
                continue
            rows.append(candidate("australian_royal_commission", "au", url, title, landing, "Public exhibit or evidence document published by an Australian Royal Commission."))
    return write_candidates(rows)


def discover_all(args: argparse.Namespace) -> None:
    ensure_dirs()
    sources = args.source
    if sources in ("all", "seeds"):
        discover_direct_pdfs()
        selected = {item.strip() for item in args.seed_sources.split(",") if item.strip()}
        discover_seed_pages(selected or None)
    if sources in ("all", "scc"):
        discover_scc(args.scc_cases)
    if sources in ("all", "cullen"):
        discover_cullen(args.cullen_pages)
    if sources in ("all", "foreign"):
        discover_foreign_interference(args.foreign_pages)
    if sources in ("all", "postoffice"):
        discover_postoffice(args.postoffice_pages)
    if sources in ("all", "aph"):
        discover_aph()
    if sources in ("all", "au-inquiry"):
        discover_au_royal_commission()
    if sources in ("all", "waitangi"):
        discover_waitangi(args.waitangi_pages)
    if sources in ("all", "canada-commissions"):
        discover_canada_commission_archive(args.commission_pages)
    if sources in ("all", "canada-publications"):
        discover_canada_publication_commissions(args.publication_pages)
    if sources in ("all", "canadiana"):
        discover_canadiana_legal_monographs(args.canadiana_pages)
    if sources in ("all", "internet-archive"):
        discover_uk_legal_monographs(args.internet_archive_pages)


def pdf_features(path: Path) -> dict:
    try:
        import fitz  # type: ignore
    except ImportError as exc:
        raise RuntimeError("PyMuPDF (fitz) is required for PDF classification") from exc
    with fitz.open(path) as document:
        page_count = len(document)
        text_lengths: list[int] = []
        image_pages = 0
        image_coverage_pages = 0
        for page in document:
            text_lengths.append(len(page.get_text("text").strip()))
            images = page.get_images(full=True)
            if images:
                image_pages += 1
            page_area = page.rect.width * page.rect.height
            image_coverage = 0.0
            if page_area:
                for info in page.get_image_info():
                    bbox = info.get("bbox")
                    if bbox:
                        image_coverage += (bbox[2] - bbox[0]) * (bbox[3] - bbox[1]) / page_area
            if min(image_coverage, 1.0) >= 0.5:
                image_coverage_pages += 1
        text_chars = sum(text_lengths)
        sparse_pages = sum(length < 120 for length in text_lengths)
        image_ratio = image_pages / max(page_count, 1)
        sparse_ratio = sparse_pages / max(page_count, 1)
        image_coverage_ratio = image_coverage_pages / max(page_count, 1)
        # ponytail: keep this bounded heuristic until a labelled mixed-scan set
        # justifies a more elaborate classifier.
        if image_coverage_ratio >= 0.5:
            generation = "non_digital"
            detail = "image_dominant_or_ocr"
        elif image_ratio >= 0.5 and sparse_ratio >= 0.5:
            generation = "non_digital"
            detail = "scanned_or_mixed"
        elif text_chars / max(page_count, 1) < 120 and sparse_ratio >= 0.8:
            generation = "non_digital"
            detail = "image_or_low_text"
        else:
            generation = "digitalborn"
            detail = "text_layer"
        return {
            "page_count": page_count,
            "text_chars": text_chars,
            "image_pages": image_pages,
            "image_coverage_pages": image_coverage_pages,
            "image_coverage_ratio": image_coverage_ratio,
            "sparse_pages": sparse_pages,
            "generation": generation,
            "generation_detail": detail,
        }


def resolve_download_url(url: str, timeout: int) -> str:
    if "canadiana.ca/files/get/" not in url.lower() or not url.lower().endswith("/item"):
        return url
    request = Request(url, headers={"User-Agent": USER_AGENT, "Accept": "application/json"})
    with urlopen(request, timeout=timeout) as response:
        payload = json.loads(response.read().decode("utf-8", "replace"))
    resolved = payload.get("download_uri")
    if not resolved:
        raise ValueError("Canadiana did not return a signed download URL")
    return str(resolved)


def remote_content_length(url: str, timeout: int) -> int | None:
    try:
        request = Request(url, method="HEAD", headers={"User-Agent": USER_AGENT, "Accept": "application/pdf,*/*;q=0.1"})
        with urlopen(request, timeout=timeout) as response:
            value = response.headers.get("Content-Length")
        return int(value) if value else None
    except Exception:
        return None


def download(url: str, part: Path, max_bytes: int, timeout: int) -> tuple[int, str]:
    start = part.stat().st_size if part.exists() else 0
    if start and part.read_bytes()[:4] != b"%PDF":
        part.unlink(missing_ok=True)
        start = 0
    headers = {"User-Agent": USER_AGENT, "Accept": "application/pdf,*/*;q=0.1"}
    if start:
        headers["Range"] = f"bytes={start}-"
    request_url = resolve_download_url(url, timeout)
    if "epe.lac-bac.gc.ca/100/" in url.lower() and "nodisclaimer" not in url.lower():
        parts = urlsplit(url)
        query = f"{parts.query}&nodisclaimer=1" if parts.query else "nodisclaimer=1"
        request_url = urlunsplit((parts.scheme, parts.netloc, parts.path, query, parts.fragment))
    if request_url != url:
        remote_size = remote_content_length(request_url, timeout)
        if remote_size is not None and remote_size > max_bytes:
            raise ValueError(f"PDF exceeds {max_bytes} bytes (remote size {remote_size})")
    request = Request(request_url, headers=headers)
    try:
        response_context = urlopen(request, timeout=timeout)
    except HTTPError as exc:
        if exc.code == 416 and start:
            part.unlink(missing_ok=True)
            return download(url, part, max_bytes, timeout)
        raise
    with response_context as response:
        append = start and getattr(response, "status", 200) == 206
        if not append:
            start = 0
        mode = "ab" if append else "wb"
        total = start
        with part.open(mode) as handle:
            while True:
                chunk = response.read(256 * 1024)
                if not chunk:
                    break
                total += len(chunk)
                if total > max_bytes:
                    raise ValueError(f"PDF exceeds {max_bytes} bytes")
                handle.write(chunk)
    return total, hashlib.sha256(part.read_bytes()).hexdigest()


def load_ledger() -> dict[str, dict]:
    latest: dict[str, dict] = {}
    for row in read_jsonl(LEDGER):
        if row.get("candidate_id"):
            latest[row["candidate_id"]] = row
    return latest


def existing_pdf_hashes() -> set[str]:
    hashes: set[str] = set()
    old_root = Path(__file__).resolve().parents[2] / "benchmarks" / "legal-generalization-corpus" / "raw"
    if not old_root.exists():
        return hashes
    for path in old_root.glob("*.pdf"):
        digest = hashlib.sha256(path.read_bytes()).hexdigest()
        hashes.add(digest)
    return hashes


def choose_candidate(
    rows: list[dict],
    ledger: dict[str, dict],
    accepted: Counter,
    sources: Counter,
    types: Counter,
    kinds: Counter,
    source_kinds: Counter,
    generations: Counter,
    source_generations: Counter,
    prefer_scan: bool,
    retry_visual_ids: set[str] | None = None,
) -> dict | None:
    retry_visual_ids = retry_visual_ids or set()
    available = [
        row for row in rows
        if row.get("jurisdiction") in JURISDICTION_TARGETS
        and likely_uk_legal_monograph(row)
        and is_pdf_candidate(row.get("url", ""), row.get("title", ""))
        and (row.get("candidate_id") not in ledger or row.get("candidate_id") in retry_visual_ids)
        and accepted[row["jurisdiction"]] < JURISDICTION_TARGETS[row["jurisdiction"]]
        and sources[row["source"]] < source_limit(row["source"])
        and kinds[effective_kind(row)] < kind_limit(effective_kind(row))
        and source_kinds[(row["source"], effective_kind(row))] < source_kind_limit(row["source"], effective_kind(row))
    ]
    if not available:
        return None
    def scan_rate(row: dict) -> float:
        source = row["source"]
        non_digital = source_generations[(source, "non_digital")]
        digitalborn = source_generations[(source, "digitalborn")]
        return non_digital / max(non_digital + digitalborn, 1)

    scan_first = prefer_scan and generations["non_digital"] < generations["digitalborn"]
    if scan_first:
        scan_available = [
            row for row in available
            if row.get("candidate_id") in retry_visual_ids
            or (likely_non_digital(row) and source_generations[(row["source"], "non_digital")] + source_generations[(row["source"], "digitalborn")] == 0)
            or source_generations[(row["source"], "non_digital")] > 0
        ]
        if scan_available:
            available = scan_available
        else:
            return None
    return min(
        available,
        key=lambda row: (
            0 if scan_first and likely_non_digital(row) and source_generations[(row["source"], "non_digital")] + source_generations[(row["source"], "digitalborn")] == 0 else 1,
            -scan_rate(row) if scan_first else 0,
            sources[row["source"]] / source_limit(row["source"]),
            kinds[effective_kind(row)] / kind_limit(effective_kind(row)),
            source_kinds[(row["source"], effective_kind(row))] / source_kind_limit(row["source"], effective_kind(row)),
            accepted[row["jurisdiction"]] / JURISDICTION_TARGETS[row["jurisdiction"]],
            types[row["document_type"]],
            hashlib.sha256(row["url"].encode()).hexdigest(),
        ),
    )


def append_ledger(row: dict) -> None:
    append_jsonl(LEDGER, [row])


def refresh_inventory_command() -> None:
    ensure_dirs()
    refresh_inventory()
    print(INVENTORY)


def run_download(args: argparse.Namespace) -> None:
    ensure_dirs()
    rows = read_jsonl(CANDIDATES)
    ledger = load_ledger()
    accepted_rows = [row for row in ledger.values() if row.get("status") == "accepted"]
    accepted = Counter(row.get("jurisdiction") for row in accepted_rows)
    generations = Counter(row.get("generation") for row in accepted_rows)
    sources = Counter(row.get("source") for row in accepted_rows)
    types = Counter(row.get("document_type") for row in accepted_rows)
    kinds = Counter(effective_kind(row) for row in accepted_rows)
    source_kinds = Counter((row.get("source"), effective_kind(row)) for row in accepted_rows)
    hashes = existing_pdf_hashes() | {row.get("sha256") for row in accepted_rows if row.get("sha256")}
    retry_visual_ids = {
        candidate_id
        for candidate_id, row in ledger.items()
        if args.retry_visual
        and row.get("status") == "discarded_generation_quota"
        and row.get("generation") == "digitalborn"
        and row.get("image_pages", 0) / max(row.get("page_count", 1), 1) >= 0.5
    }
    retry_archive_ids = {
        candidate_id
        for candidate_id, row in ledger.items()
        if args.retry_archive
        and row.get("status") == "failed"
        and row.get("source") == "canada_commission_archive"
    }
    source_generations = Counter(
        (row.get("source"), row.get("generation"))
        for row in ledger.values()
        if row.get("generation") in GENERATION_TARGETS
    )
    attempts = 0
    while sum(accepted.values()) < TOTAL_TARGET and attempts < args.max_new:
        retry_ids = retry_visual_ids | retry_archive_ids
        row = choose_candidate(rows, ledger, accepted, sources, types, kinds, source_kinds, generations, source_generations, args.prefer_scan, retry_ids)
        if row is None:
            break
        attempts += 1
        cid = row["candidate_id"]
        retry_visual_ids.discard(cid)
        retry_archive_ids.discard(cid)
        row["kind"] = effective_kind(row)
        part = TMP_ROOT / f"{cid}.pdf.part"
        started = time.monotonic()
        base = {**row, "attempted_at": now()}
        try:
            size, digest = download(row["url"], part, args.max_bytes, args.timeout)
            if part.read_bytes()[:4] != b"%PDF":
                raise ValueError("response is not a PDF")
            if digest in hashes:
                part.unlink(missing_ok=True)
                result = {**base, "status": "duplicate", "sha256": digest, "bytes": size}
            else:
                features = pdf_features(part)
                generation = features["generation"]
                source_generations[(row["source"], generation)] += 1
                if generations[generation] >= GENERATION_TARGETS[generation]:
                    part.unlink(missing_ok=True)
                    result = {**base, **features, "status": "discarded_generation_quota", "sha256": digest, "bytes": size}
                else:
                    target_dir = PDF_ROOT / row["jurisdiction"] / generation / row["kind"] / slug(row["source"])
                    target_dir.mkdir(parents=True, exist_ok=True)
                    filename = f"{row['jurisdiction']}-{slug(row['title'])}-{digest[:12]}.pdf"
                    target = target_dir / filename
                    shutil.move(str(part), target)
                    result = {**base, **features, "status": "accepted", "sha256": digest, "bytes": size, "relative_path": str(target.relative_to(ROOT)).replace("\\", "/")}
                    accepted[row["jurisdiction"]] += 1
                    generations[generation] += 1
                    sources[row["source"]] += 1
                    types[row["document_type"]] += 1
                    kinds[row["kind"]] += 1
                    source_kinds[(row["source"], row["kind"])] += 1
                    hashes.add(digest)
            ledger[cid] = result
            append_ledger(result)
        except Exception as exc:
            part.unlink(missing_ok=True)
            result = {**base, "status": "failed", "failure": f"{type(exc).__name__}: {exc}"}
            ledger[cid] = result
            append_ledger(result)
        if attempts == 1 or attempts % 10 == 0:
            print(f"attempts={attempts} accepted={sum(accepted.values())}/{TOTAL_TARGET} jurisdictions={dict(accepted)} generations={dict(generations)} elapsed={time.monotonic()-started:.1f}s")
    print(json.dumps({"attempts": attempts, "accepted": dict(accepted), "generations": dict(generations), "sources": dict(sources), "kinds": dict(kinds), "ledger": str(LEDGER)}, indent=2))


def reclassify_visual() -> None:
    """Move accepted raster-backed PDFs into the non-digital partition."""
    latest = load_ledger()
    candidates = [
        row for row in latest.values()
        if row.get("status") == "accepted"
        and row.get("generation") == "digitalborn"
        and row.get("relative_path")
        and (
            float(row.get("image_coverage_ratio", 0) or 0) >= 0.5
            or int(row.get("image_pages", 0) or 0) / max(int(row.get("page_count", 1) or 1), 1) >= 0.5
        )
    ]
    moved = 0
    skipped = 0
    for index, row in enumerate(candidates, 1):
        current = ROOT / row["relative_path"]
        if not current.exists():
            skipped += 1
            print(f"missing {row['candidate_id']}: {current}", flush=True)
            continue
        features = pdf_features(current)
        if features["generation"] != "non_digital":
            continue
        kind = row.get("kind") or infer_kind(row.get("title", ""), row.get("url", ""))
        target_dir = PDF_ROOT / row["jurisdiction"] / "non_digital" / kind / slug(row["source"])
        target_dir.mkdir(parents=True, exist_ok=True)
        target = target_dir / current.name
        if target.exists():
            if hashlib.sha256(target.read_bytes()).hexdigest() == row.get("sha256"):
                current.unlink()
            else:
                skipped += 1
                print(f"collision {row['candidate_id']}: {target}", flush=True)
                continue
        else:
            shutil.move(str(current), target)
        updated = {
            **row,
            **features,
            "generation": "non_digital",
            "relative_path": str(target.relative_to(ROOT)).replace("\\", "/"),
            "reclassified_at": now(),
            "reclassified_from": "digitalborn",
        }
        append_ledger(updated)
        moved += 1
        if moved == 1 or moved % 10 == 0:
            print(f"reclassified {moved}/{len(candidates)} candidates", flush=True)
    print(json.dumps({"candidates": len(candidates), "moved": moved, "skipped": skipped}, indent=2))


def reclassify_kinds() -> None:
    """Move accepted generic documents when a narrower semantic rule applies."""
    latest = load_ledger()
    candidates = [
        row for row in latest.values()
        if row.get("status") == "accepted" and row.get("kind") == "other" and row.get("relative_path")
    ]
    moved = 0
    skipped = 0
    for row in candidates:
        kind = effective_kind(row)
        if kind == "other":
            continue
        current = ROOT / row["relative_path"]
        if not current.exists():
            skipped += 1
            print(f"missing {row['candidate_id']}: {current}", flush=True)
            continue
        target_dir = PDF_ROOT / row["jurisdiction"] / row["generation"] / kind / slug(row["source"])
        target_dir.mkdir(parents=True, exist_ok=True)
        target = target_dir / current.name
        if target.exists():
            if hashlib.sha256(target.read_bytes()).hexdigest() == row.get("sha256"):
                current.unlink()
            else:
                skipped += 1
                print(f"collision {row['candidate_id']}: {target}", flush=True)
                continue
        else:
            shutil.move(str(current), target)
        updated = {
            **row,
            "kind": kind,
            "relative_path": str(target.relative_to(ROOT)).replace("\\", "/"),
            "reclassified_at": now(),
            "reclassified_from_kind": "other",
        }
        append_ledger(updated)
        moved += 1
        if moved == 1 or moved % 10 == 0:
            print(f"reclassified kinds {moved}/{len(candidates)}", flush=True)
    print(json.dumps({"candidates": len(candidates), "moved": moved, "skipped": skipped}, indent=2))


def verify() -> None:
    latest = load_ledger()
    accepted = [row for row in latest.values() if row.get("status") == "accepted"]
    kinds_counter = Counter(effective_kind(row) for row in accepted)
    source_kinds_counter = Counter((row.get("source"), effective_kind(row)) for row in accepted)
    counts = {
        "total": len(accepted),
        "jurisdictions": dict(Counter(row.get("jurisdiction") for row in accepted)),
        "generations": dict(Counter(row.get("generation") for row in accepted)),
        "sources": dict(Counter(row.get("source") for row in accepted)),
        "document_types": dict(Counter(row.get("document_type") for row in accepted)),
        "kinds": dict(kinds_counter),
        "source_kind_pairs": dict(Counter(f"{source}:{kind}" for (source, kind), value in source_kinds_counter.items() for _ in range(value))),
        "bytes": sum(int(row.get("bytes", 0)) for row in accepted),
        "pages": sum(int(row.get("page_count", 0)) for row in accepted),
    }
    missing = []
    for key, target in JURISDICTION_TARGETS.items():
        if counts["jurisdictions"].get(key, 0) != target:
            missing.append({"jurisdiction": key, "target": target, "actual": counts["jurisdictions"].get(key, 0)})
    for key, target in GENERATION_TARGETS.items():
        if counts["generations"].get(key, 0) != target:
            missing.append({"generation": key, "target": target, "actual": counts["generations"].get(key, 0)})
    integrity = {
        "path_count": 0,
        "missing_paths": [],
        "out_of_root_paths": [],
        "bad_magic": [],
        "byte_mismatches": [],
        "hash_mismatches": [],
        "missing_hashes": [],
        "duplicate_hashes": {},
    }
    accepted_hashes: dict[str, list[str]] = defaultdict(list)
    root_resolved = ROOT.resolve()
    for row in accepted:
        candidate_id = str(row.get("candidate_id"))
        relative_path = row.get("relative_path")
        if not relative_path:
            integrity["missing_paths"].append(candidate_id)
            continue
        path = (ROOT / str(relative_path)).resolve()
        try:
            in_root = path.is_relative_to(root_resolved)
        except AttributeError:
            in_root = str(path).lower().startswith(str(root_resolved).lower())
        if not in_root:
            integrity["out_of_root_paths"].append(candidate_id)
            continue
        if not path.exists():
            integrity["missing_paths"].append(candidate_id)
            continue
        integrity["path_count"] += 1
        with path.open("rb") as handle:
            magic = handle.read(4)
            digest_builder = hashlib.sha256()
            handle.seek(0)
            while chunk := handle.read(1024 * 1024):
                digest_builder.update(chunk)
        if magic != b"%PDF":
            integrity["bad_magic"].append(candidate_id)
        actual_bytes = path.stat().st_size
        try:
            expected_bytes = int(row.get("bytes", 0))
        except (TypeError, ValueError):
            expected_bytes = -1
        if actual_bytes != expected_bytes:
            integrity["byte_mismatches"].append(candidate_id)
        digest = digest_builder.hexdigest()
        expected_hash = str(row.get("sha256") or "")
        if not expected_hash:
            integrity["missing_hashes"].append(candidate_id)
        elif digest != expected_hash:
            integrity["hash_mismatches"].append(candidate_id)
        accepted_hashes[digest].append(candidate_id)
    integrity["duplicate_hashes"] = {
        digest: ids for digest, ids in accepted_hashes.items() if len(ids) > 1
    }
    cap_violations = {
        "sources": {
            source: count for source, count in Counter(row.get("source") for row in accepted).items()
            if count > source_limit(source)
        },
        "kinds": {
            kind: count for kind, count in kinds_counter.items()
            if count > kind_limit(kind)
        },
        "source_kind_pairs": {
            f"{source}:{kind}": count for (source, kind), count in source_kinds_counter.items()
            if count > source_kind_limit(source, kind)
        },
    }
    counts["integrity"] = integrity
    counts["cap_violations"] = cap_violations
    counts["requirements_met"] = (
        not missing
        and counts["total"] == TOTAL_TARGET
        and integrity["path_count"] == counts["total"]
        and not any(integrity[key] for key in ("missing_paths", "out_of_root_paths", "bad_magic", "byte_mismatches", "hash_mismatches", "missing_hashes", "duplicate_hashes"))
        and not any(cap_violations.values())
    )
    counts["gaps"] = missing
    print(json.dumps(counts, ensure_ascii=False, indent=2, sort_keys=True))


def self_test() -> None:
    assert infer_type("First Affidavit of Jane Doe.pdf") == "affidavit"
    assert infer_type("Appellant's Factum") == "brief_or_submission"
    assert infer_type("Exhibit A - Contract.pdf") == "exhibit"
    assert infer_kind("First Affidavit of Jane Doe.pdf") == "affidavit"
    assert infer_kind("N163 Skeleton Argument") == "skeleton_argument"
    assert infer_kind("Court Form 12") == "court_form"
    assert infer_kind("Request for Proposal - Legal Services.pdf") == "request_for_proposal"
    assert infer_kind("Calgary Zoning By-law.pdf") == "zoning_bylaw"
    assert infer_kind("witnessstatementofandrewwareing_mod-83-.pdf") == "witness_statement"
    assert infer_kind("Reports of cases adjudged in the Court of Chancery") == "law_report"
    assert effective_kind({"source": "canadiana_legal_monographs", "kind": "inquiry_report", "title": "Historical inquiry report"}) == "historical_inquiry_report"
    assert not wanted("Accessibility statement", "https://example.test/a.pdf")
    assert slug("A witness statement: Québec 2024.pdf") == "a-witness-statement-qu-bec-2024-pdf"
    print("self-test ok")


def parser() -> argparse.ArgumentParser:
    root = argparse.ArgumentParser(description=__doc__)
    sub = root.add_subparsers(dest="command", required=True)
    discover = sub.add_parser("discover")
    discover.add_argument("--source", choices=("all", "seeds", "scc", "cullen", "foreign", "postoffice", "aph", "au-inquiry", "waitangi", "canada-commissions", "canada-publications", "canadiana", "internet-archive"), default="all")
    discover.add_argument("--scc-cases", type=int, default=1200)
    discover.add_argument("--cullen-pages", type=int, default=11)
    discover.add_argument("--foreign-pages", type=int, default=12)
    discover.add_argument("--postoffice-pages", type=int, default=30)
    discover.add_argument("--waitangi-pages", type=int, default=30)
    discover.add_argument("--commission-pages", type=int, default=160)
    discover.add_argument("--publication-pages", type=int, default=9)
    discover.add_argument("--canadiana-pages", type=int, default=8)
    discover.add_argument("--internet-archive-pages", type=int, default=5)
    discover.add_argument("--seed-sources", default="", help="comma-separated seed source ids to crawl")
    discover.set_defaults(func=discover_all)
    download_parser = sub.add_parser("download")
    download_parser.add_argument("--max-new", type=int, default=100)
    download_parser.add_argument("--max-bytes", type=int, default=120_000_000)
    download_parser.add_argument("--timeout", type=int, default=180)
    download_parser.add_argument("--prefer-scan", action="store_true", help="prefer archival and image-heavy source hints while the scan quota trails digitalborn")
    download_parser.add_argument("--retry-visual", action="store_true", help="retry prior digitalborn-quota PDFs whose pages were image-heavy")
    download_parser.add_argument("--retry-archive", action="store_true", help="retry failed archived Canadian commission PDFs through their public disclaimer bypass")
    download_parser.set_defaults(func=run_download)
    reclassify_parser = sub.add_parser("reclassify-visual")
    reclassify_parser.set_defaults(func=lambda args: reclassify_visual())
    reclassify_kinds_parser = sub.add_parser("reclassify-kinds")
    reclassify_kinds_parser.set_defaults(func=lambda args: reclassify_kinds())
    inventory_parser = sub.add_parser("inventory")
    inventory_parser.set_defaults(func=lambda args: refresh_inventory_command())
    verify_parser = sub.add_parser("verify")
    verify_parser.set_defaults(func=lambda args: verify())
    test_parser = sub.add_parser("self-test")
    test_parser.set_defaults(func=lambda args: self_test())
    return root


if __name__ == "__main__":
    arguments = parser().parse_args()
    arguments.func(arguments)
