from __future__ import annotations

import argparse
import base64
import hashlib
import json
import tempfile
import time
import xml.etree.ElementTree as ET
import zipfile
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import urlparse

import fitz
from docx import Document
from selenium import webdriver
from selenium.webdriver.chrome.service import Service
from selenium.webdriver.common.by import By
from selenium.webdriver.common.keys import Keys
from selenium.webdriver.support.ui import WebDriverWait


CITATIONS = ("2099 ABKB 998", "2099 ABKB 999")
CANLII_PDF = (
    "https://www.canlii.org/en/ab/abkb/doc/2099/"
    "2099abkb998/2099abkb998.pdf"
)
WORD_NS = "http://schemas.openxmlformats.org/wordprocessingml/2006/main"
CHROME = next(
    (
        path
        for path in (
            Path(r"C:\Program Files\Google\Chrome\Application\chrome.exe"),
            Path(r"C:\Program Files (x86)\Google\Chrome\Application\chrome.exe"),
        )
        if path.is_file()
    ),
    None,
)
CHROMEDRIVER = next(
    iter(
        sorted(
            Path.home().parent.glob(
                r"*/.cache/selenium/chromedriver/win64/*/chromedriver.exe"
            ),
            reverse=True,
        )
    ),
    None,
)


def sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def make_fixtures(directory: Path) -> tuple[Path, Path]:
    source = directory / "authorities-smoke.docx"
    document = Document()
    document.add_heading("Written argument", level=1)
    document.add_paragraph(
        f"Synthetic Applicant v Synthetic Respondent, {CITATIONS[0]}."
    )
    document.add_paragraph(
        f"Synthetic Appellant v Synthetic Respondent, {CITATIONS[1]}."
    )
    document.save(source)

    authority = directory / "manually-downloaded-authority.pdf"
    pdf = fitz.open()
    page = pdf.new_page(width=612, height=792)
    page.insert_text((72, 96), "Attached authority proof", fontsize=16)
    page.insert_textbox(
        fitz.Rect(72, 130, 540, 700),
        "A valid one-page PDF supplied by the user through the CanLII handoff.",
        fontsize=12,
    )
    pdf.set_metadata({"title": "Attached authority proof"})
    pdf.save(authority)
    pdf.close()
    return source, authority


def browser(profile: Path, headed: bool) -> webdriver.Chrome:
    if not CHROME:
        raise RuntimeError("Google Chrome is required for the live smoke.")
    options = webdriver.ChromeOptions()
    options.binary_location = str(CHROME)
    if not headed:
        options.add_argument("--headless=new")
    for flag in (
        "--disable-gpu",
        "--no-sandbox",
        "--disable-dev-shm-usage",
        "--disable-crash-reporter",
        "--no-first-run",
    ):
        options.add_argument(flag)
    options.add_argument(f"--user-data-dir={profile}")
    options.add_experimental_option(
        "prefs",
        {
            "download.prompt_for_download": False,
            "plugins.always_open_pdf_externally": True,
        },
    )
    options.set_capability(
        "goog:loggingPrefs", {"browser": "ALL", "performance": "ALL"}
    )
    driver = webdriver.Chrome(
        options=options,
        service=Service(str(CHROMEDRIVER)) if CHROMEDRIVER else None,
    )
    driver.execute_cdp_cmd("Network.enable", {})
    driver.execute_cdp_cmd("Network.setCacheDisabled", {"cacheDisabled": True})
    driver.execute_cdp_cmd("Page.addScriptToEvaluateOnNewDocument", {
        "source": """
Object.defineProperty(window,'showOpenFilePicker',{value:undefined});
window.__beaverLongTasks=[];
try { window.__beaverLongTaskObserver=new PerformanceObserver(list =>
  window.__beaverLongTasks.push(...list.getEntries().map(({name,startTime,duration}) =>
    ({name,startTime,duration}))));
  window.__beaverLongTaskObserver.observe({type:'longtask',buffered:true}); } catch {}
""",
    })
    return driver


def performance_events(driver: webdriver.Chrome) -> list[dict[str, object]]:
    events: list[dict[str, object]] = []
    for record in driver.get_log("performance"):
        try:
            events.append(json.loads(record["message"])["message"])
        except (KeyError, TypeError, json.JSONDecodeError):
            continue
    return events


def request_urls(events: list[dict[str, object]]) -> list[str]:
    return [
        str(event.get("params", {}).get("request", {}).get("url", ""))
        for event in events
        if event.get("method") == "Network.requestWillBeSent"
    ]


def navigation_timing(driver: webdriver.Chrome) -> dict[str, object]:
    timing = driver.execute_script("""
const n=performance.getEntriesByType('navigation')[0];
return n&&{type:n.type,duration:n.duration,responseStart:n.responseStart,
  domContentLoaded:n.domContentLoadedEventEnd,load:n.loadEventEnd,
  transferSize:n.transferSize,decodedBodySize:n.decodedBodySize,
  resources:performance.getEntriesByType('resource').map(r=>({name:r.name,
    transferSize:r.transferSize,duration:r.duration})).sort((a,b)=>b.duration-a.duration).slice(0,8),
  longTaskCount:(window.__beaverLongTasks||[]).length,
  longTasks:(window.__beaverLongTasks||[]).sort((a,b)=>b.duration-a.duration).slice(0,5)};
""")
    assert timing and timing["duration"] > 0, timing
    return timing


def build_response(
    driver: webdriver.Chrome, events: list[dict[str, object]]
) -> dict[str, object]:
    for event in reversed(events):
        if event.get("method") != "Network.responseReceived":
            continue
        params = event.get("params", {})
        response = params.get("response", {})
        path = urlparse(str(response.get("url", ""))).path.rstrip("/")
        if not path.endswith("/build") or "/authorities/" not in path:
            continue
        assert response.get("status") == 200, response
        payload = driver.execute_cdp_cmd(
            "Network.getResponseBody", {"requestId": params["requestId"]}
        )
        body = payload["body"]
        if payload.get("base64Encoded"):
            body = base64.b64decode(body).decode("utf-8")
        return json.loads(body)
    raise AssertionError("The Authorities build response was not captured.")


def start_new(driver: webdriver.Chrome) -> None:
    if driver.find_elements(
        By.XPATH, "//h2[normalize-space()='Start with a document']"
    ):
        return
    menu = driver.find_element(By.CSS_SELECTOR, "[data-draft-menu]")
    menu.find_element(By.TAG_NAME, "summary").click()
    WebDriverWait(driver, 5).until(
        lambda item: item.find_element(
            By.XPATH, "//*[@data-draft-menu]//button[normalize-space()='New']"
        )
    ).click()
    WebDriverWait(driver, 5).until(
        lambda item: item.find_elements(
            By.XPATH, "//h2[normalize-space()='Start with a document']"
        )
    )


def authority_row(driver: webdriver.Chrome, citation: str):
    return driver.find_element(
        By.XPATH, f"//article[contains(normalize-space(.), '{citation}')]"
    )


def wait_for_authorities(driver: webdriver.Chrome) -> None:
    WebDriverWait(driver, 90).until(
        lambda item: all(
            item.find_elements(
                By.XPATH, f"//article[contains(normalize-space(.), '{citation}')]"
            )
            for citation in CITATIONS
        )
    )


def add_menu_probe(driver: webdriver.Chrome) -> str:
    citation = "2099 ABCA 997"
    driver.find_element(By.XPATH, "//summary[normalize-space()='Add authority']").click()
    driver.find_element(By.CSS_SELECTOR, "input[aria-label='Citation']").send_keys(citation)
    driver.find_element(By.XPATH, "//button[normalize-space()='Add']").click()
    WebDriverWait(driver, 30).until(lambda item: authority_row(item, citation))
    return citation


def menu_keyboard_contract(
    driver: webdriver.Chrome, citation: str, output: Path
) -> dict[str, object]:
    result: dict[str, object] = {}
    for width, height in ((1440, 1000), (320, 800)):
        driver.execute_cdp_cmd("Emulation.setDeviceMetricsOverride", {
            "width": width, "height": height, "deviceScaleFactor": 1, "mobile": False,
        })
        trigger = authority_row(driver, citation).find_element(
            By.CSS_SELECTOR, "button[aria-haspopup='menu']"
        )
        driver.execute_script("arguments[0].scrollIntoView({block:'center'});arguments[0].focus()", trigger)
        trigger.send_keys(Keys.ENTER)
        menu = WebDriverWait(driver, 5).until(
            lambda item: item.find_element(By.CSS_SELECTOR, "[role='menu']")
        )
        items = [item.text.strip() for item in menu.find_elements(By.CSS_SELECTOR, "[role='menuitem']")]
        assert items == ["Move up", "Edit label", "Remove"], items
        assert driver.switch_to.active_element.text.strip() == items[0]
        driver.switch_to.active_element.send_keys(Keys.ARROW_DOWN)
        assert driver.switch_to.active_element.text.strip() == items[1]
        driver.switch_to.active_element.send_keys(Keys.HOME)
        assert driver.switch_to.active_element.text.strip() == items[0]
        metrics = driver.execute_script("""
const t=arguments[0],m=arguments[1],r=t.getBoundingClientRect(),q=m.getBoundingClientRect(),s=getComputedStyle(t);
return {expanded:t.getAttribute('aria-expanded'),triggerWidth:r.width,triggerHeight:r.height,
  menuLeft:q.left,menuRight:q.right,overflow:document.documentElement.scrollWidth-innerWidth,
  outline:s.outlineWidth,shadow:s.boxShadow};
""", trigger, menu)
        assert metrics["expanded"] == "true" and metrics["overflow"] <= 1, metrics
        assert metrics["menuLeft"] >= 0 and metrics["menuRight"] <= width, metrics
        assert metrics["triggerWidth"] >= 24 and metrics["triggerHeight"] >= 24, metrics
        assert driver.save_screenshot(str(output / f"authorities-menu-{width}.png"))
        driver.switch_to.active_element.send_keys(Keys.ESCAPE)
        WebDriverWait(driver, 5).until(lambda item: not item.find_elements(By.CSS_SELECTOR, "[role='menu']"))
        assert driver.switch_to.active_element == trigger
        result[str(width)] = metrics
    driver.execute_cdp_cmd("Emulation.clearDeviceMetricsOverride", {})
    driver.set_window_size(1440, 1000)
    trigger = authority_row(driver, citation).find_element(By.CSS_SELECTOR, "button[aria-haspopup='menu']")
    trigger.send_keys(Keys.ENTER)
    WebDriverWait(driver, 5).until(lambda item: item.find_element(By.CSS_SELECTOR, "[role='menu']"))
    driver.switch_to.active_element.send_keys(Keys.END, Keys.ENTER)
    WebDriverWait(driver, 30).until(
        lambda item: not item.find_elements(By.XPATH, f"//article[contains(normalize-space(.), '{citation}')]")
    )
    return result


def standalone_state(driver: webdriver.Chrome) -> dict[str, object]:
    state = driver.execute_async_script("""
const done=arguments[arguments.length-1],id=new URL(location.href).searchParams.get('draft'),
  open=indexedDB.open('beaver-work-products');
open.onerror=()=>done({error:open.error?.message||'open failed'});
open.onsuccess=()=>{const get=open.result.transaction('drafts').objectStore('drafts').get(id);
  get.onerror=()=>done({error:get.error?.message||'read failed'});
  get.onsuccess=()=>done(get.result?{outputs:get.result.outputs,
    insertIntoDocument:get.result.state.insertIntoDocument}:{error:'draft missing'});};
""")
    assert state and not state.get("error"), state
    return state


def canlii_handoff(driver: webdriver.Chrome) -> str:
    row = authority_row(driver, CITATIONS[0])
    links = row.find_elements(By.LINK_TEXT, "Download from CanLII")
    if not links:
        row.find_element(By.XPATH, ".//button[normalize-space()='CanLII']").click()
        links = WebDriverWait(driver, 30).until(
            lambda item: authority_row(item, CITATIONS[0]).find_elements(
                By.LINK_TEXT, "Download from CanLII"
            )
        )
    href = links[0].get_attribute("href")
    assert href == CANLII_PDF, href
    return href


def select_mode(driver: webdriver.Chrome, value: str) -> None:
    radio = driver.find_element(
        By.CSS_SELECTOR, f"input[name='authorities-output'][value='{value}']"
    )
    radio.find_element(By.XPATH, "parent::label").click()
    WebDriverWait(driver, 30).until(
        lambda item: (
            item.find_element(
                By.CSS_SELECTOR,
                f"input[name='authorities-output'][value='{value}']",
            ).is_selected()
            and item.find_element(
                By.CSS_SELECTOR,
                f"input[name='authorities-output'][value='{value}']",
            ).is_enabled()
        )
    )


def enable_word_copy_with_keyboard(driver: webdriver.Chrome) -> dict[str, object]:
    both = driver.find_element(
        By.CSS_SELECTOR, "input[name='authorities-output'][value='both']"
    )
    both.send_keys(Keys.TAB)
    active = driver.switch_to.active_element
    label = active.find_element(By.XPATH, "ancestor::label[1]")
    assert "Create Word copy with table" in label.text, label.text
    focus = driver.execute_script(
        "const n=arguments[0],s=getComputedStyle(n),r=n.getBoundingClientRect();"
        "return {tag:n.tagName,width:r.width,height:r.height,outline:s.outlineWidth,"
        "shadow:s.boxShadow};",
        label,
    )
    assert focus["outline"] != "0px" or focus["shadow"] != "none", focus
    active.send_keys(Keys.SPACE)
    WebDriverWait(driver, 30).until(
        lambda item: item.find_element(
            By.XPATH, "//label[contains(., 'Create Word copy with table')]/input"
        ).is_selected()
    )
    return focus


UI_CONTRACT = r"""
const visible = (node) => {
  const style = getComputedStyle(node), rect = node.getBoundingClientRect();
  return (!node.checkVisibility || node.checkVisibility({
    contentVisibilityAuto: true, opacityProperty: true, visibilityProperty: true
  })) && style.display !== 'none' && style.visibility !== 'hidden' &&
    rect.width > 1 && rect.height > 1 && !node.classList.contains('sr-only');
};
const name = (node) => node.getAttribute('aria-label') ||
  (node.getAttribute('aria-labelledby') || '').split(/\s+/).map(
    id => document.getElementById(id)?.textContent || '').join(' ').trim() ||
  [...(node.labels || [])].map(label => label.textContent).join(' ').trim() ||
  node.innerText?.trim() || node.textContent?.trim() || node.title;
const controls = [...document.querySelectorAll(
  "button,summary,select,input:not([type=file]),textarea,label:has(input[type=file]),a[href]"
)].filter(visible);
const ids = [...document.querySelectorAll('[id]')].map(node => node.id);
const mojibake = document.body.innerText.match(/\u00e2[\u20ac\u2122\u0153\u201d\u201c]|\ufffd/iu);
return {
  width: innerWidth,
  overflow: document.documentElement.scrollWidth - innerWidth,
  h1: document.querySelectorAll('h1').length,
  main: document.querySelectorAll('main').length,
  duplicateIds: [...new Set(ids.filter((id, index) => ids.indexOf(id) !== index))],
  mojibake: mojibake?.[0] || '',
  unnamed: controls.filter(node => !name(node)).map(node => node.outerHTML.slice(0, 160)),
  smallTargets: controls.filter(node => { const proxy=node.matches('input[type=checkbox],input[type=radio]')
    ? node.closest('label') : node; const r=proxy.getBoundingClientRect(); return r.width<24||r.height<24; })
    .map(node => `${node.tagName}:${name(node)}`),
  smallFormText: [...document.querySelectorAll('input:not([type=file]):not([type=checkbox]):not([type=radio]),select,textarea')]
    .filter(visible).filter(node => parseFloat(getComputedStyle(node).fontSize)<16)
    .map(node => `${name(node)}:${getComputedStyle(node).fontSize}`),
  wideNodes: [...document.querySelectorAll('body *')].filter(visible).filter(
    node => node.getBoundingClientRect().right > innerWidth + 1
  ).map(node => { const rect = node.getBoundingClientRect(); return {
    tag: node.tagName, className: String(node.className), left: Math.round(rect.left),
    right: Math.round(rect.right), width: Math.round(rect.width)
  }; }).slice(0, 12),
};
"""


def check_viewports(driver: webdriver.Chrome, output: Path) -> dict[str, object]:
    results: dict[str, object] = {}
    for name, width, height in (("desktop", 1440, 1000), ("320", 320, 800)):
        driver.execute_cdp_cmd(
            "Emulation.setDeviceMetricsOverride",
            {
                "width": width,
                "height": height,
                "deviceScaleFactor": 1,
                "mobile": False,
            },
        )
        driver.execute_script("scrollTo(0, 0)")
        metrics = driver.execute_script(UI_CONTRACT)
        assert metrics["overflow"] <= 1, metrics
        assert not metrics["wideNodes"], metrics
        assert metrics["h1"] == metrics["main"] == 1, metrics
        assert not metrics["duplicateIds"], metrics
        assert not metrics["mojibake"], metrics
        assert not metrics["unnamed"], metrics
        assert not metrics["smallTargets"], metrics
        if width == 320:
            assert not metrics["smallFormText"], metrics
        assert driver.save_screenshot(str(output / f"authorities-{name}.png"))
        results[name] = metrics
    driver.execute_cdp_cmd("Emulation.clearDeviceMetricsOverride", {})
    driver.set_window_size(1440, 1000)
    return results


def download_outputs(driver: webdriver.Chrome, directory: Path) -> dict[str, Path]:
    directory.mkdir(parents=True, exist_ok=True)
    driver.execute_cdp_cmd(
        "Page.setDownloadBehavior",
        {"behavior": "allow", "downloadPath": str(directory.resolve())},
    )
    buttons: list[tuple[str, object]] = []
    for button in driver.find_elements(
        By.CSS_SELECTOR, "aside[aria-label='Build outputs'] button"
    ):
        names = [span.text.strip() for span in button.find_elements(By.TAG_NAME, "span")]
        filename = next(
            (name for name in names if name.lower().endswith((".pdf", ".docx"))),
            "",
        )
        if filename:
            buttons.append((filename, button))
    assert len(buttons) == 3, [name for name, _ in buttons]
    downloaded: dict[str, Path] = {}
    for filename, button in buttons:
        driver.execute_script("arguments[0].click()", button)
        target = directory / filename
        WebDriverWait(driver, 30).until(
            lambda _item: target.is_file()
            and not list(directory.glob("*.crdownload"))
        )
        downloaded[filename] = target
    return downloaded


def inspect_book(path: Path, preview: Path) -> dict[str, object]:
    document = fitz.open(path)
    try:
        text = "\n".join(page.get_text() for page in document)
        toc = document.get_toc()
        links = [
            link
            for page in document
            for link in page.get_links()
            if int(link.get("page", -1)) >= 0
        ]
        page_mode = list(
            document.xref_get_key(document.pdf_catalog(), "PageMode")
        )
        assert document.is_pdf and not document.is_encrypted
        assert document.page_count == 3, document.page_count
        assert all(
            value in text
            for value in (
                "Book of Authorities",
                "Table of Contents",
                "Attached authority proof",
                CITATIONS[0],
            )
        ), text
        assert len(links) >= 1, links
        assert {"Book of Authorities", "Table of Contents"}.issubset(
            {row[1] for row in toc}
        ), toc
        assert any(CITATIONS[0] in row[1] for row in toc), toc
        assert page_mode == ["name", "/UseOutlines"], page_mode
        document[0].get_pixmap(matrix=fitz.Matrix(1.5, 1.5), alpha=False).save(
            preview
        )
        return {
            "sha256": sha256(path),
            "pages": document.page_count,
            "bookmarks": [row[1] for row in toc],
            "internal_links": len(links),
            "page_mode": page_mode,
        }
    finally:
        document.close()


def docx_text(path: Path) -> str:
    document = Document(path)
    return "\n".join(
        [paragraph.text for paragraph in document.paragraphs]
        + [cell.text for table in document.tables for row in table.rows for cell in row.cells]
    )


def inspect_table(path: Path) -> dict[str, object]:
    text = docx_text(path)
    assert "Table of Authorities" in text, text
    assert all(citation in text for citation in CITATIONS), text
    assert "Not reproduced" in text, text
    return {"sha256": sha256(path), "citations": list(CITATIONS)}


def inspect_word_copy(path: Path) -> dict[str, object]:
    with zipfile.ZipFile(path) as package:
        document_xml = package.read("word/document.xml")
        settings_xml = package.read("word/settings.xml")
        assert "[Content_Types].xml" in package.namelist()
    root = ET.fromstring(document_xml)
    instructions = [
        (node.text or "").strip()
        for node in root.findall(f".//{{{WORD_NS}}}instrText")
    ]
    ta = [value for value in instructions if value.startswith("TA ")]
    toa = [value for value in instructions if value.startswith("TOA ")]
    assert len(ta) == len(CITATIONS), instructions
    assert len(toa) == 1 and '\\h \\e "\\t"' in toa[0], instructions
    assert all(any(citation in field for field in ta) for citation in CITATIONS), ta

    settings = ET.fromstring(settings_xml)
    update = settings.find(f".//{{{WORD_NS}}}updateFields")
    assert update is not None and update.get(f"{{{WORD_NS}}}val") == "true"
    body = root.find(f".//{{{WORD_NS}}}body")
    assert body is not None
    children = list(body)
    sect = next(
        index
        for index, child in enumerate(children)
        if child.tag == f"{{{WORD_NS}}}sectPr"
    )
    toa_paragraph = next(
        index
        for index, child in enumerate(children)
        if any(
            (node.text or "").strip().startswith("TOA ")
            for node in child.findall(f".//{{{WORD_NS}}}instrText")
        )
    )
    assert toa_paragraph == sect - 1, (toa_paragraph, sect)
    text = docx_text(path)
    assert all(citation in text for citation in CITATIONS), text
    assert "Table of Authorities" in text, text
    return {
        "sha256": sha256(path),
        "ta_fields": len(ta),
        "toa_fields": len(toa),
        "update_on_open": True,
        "toa_before_section": True,
    }


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Exercise native Authorities through live Beaver and Chrome."
    )
    parser.add_argument(
        "--url",
        default="http://127.0.0.1:3000/table-of-authorities",
        help="Live Beaver Authorities URL.",
    )
    parser.add_argument("--headed", action="store_true")
    parser.add_argument(
        "--artifacts",
        type=Path,
        help="Optional directory for screenshots and downloaded proof files.",
    )
    args = parser.parse_args()

    with tempfile.TemporaryDirectory(prefix="beaver-authorities-browser-") as temporary:
        session = Path(temporary)
        output = args.artifacts.resolve() if args.artifacts else session / "proof"
        output.mkdir(parents=True, exist_ok=True)
        fixtures = session / "fixtures"
        fixtures.mkdir()
        source, authority_pdf = make_fixtures(fixtures)
        driver = browser(session / "chrome-profile", args.headed)
        driver.set_window_size(1440, 1000)
        network_urls: list[str] = []
        started = time.monotonic()
        standalone = urlparse(args.url).path.rstrip("/").endswith("authorities.html")
        try:
            driver.get(args.url)
            try:
                WebDriverWait(driver, 30).until(
                    lambda item: item.find_elements(
                        By.XPATH, "//h1[normalize-space()='Authorities']"
                    )
                )
            except Exception as error:
                raise RuntimeError(
                    "Start local Beaver with .\\scripts\\mike.ps1 start, then pass "
                    "its /table-of-authorities URL with --url."
                ) from error
            cold_navigation = navigation_timing(driver)
            start_new(driver)
            file_input = driver.find_element(
                By.XPATH,
                "//h2[normalize-space()='Start with a document']/"
                "ancestor::section[1]//input[@type='file']",
            )
            file_input.send_keys(str(source.resolve()))
            wait_for_authorities(driver)
            handoff = canlii_handoff(driver)
            menu = menu_keyboard_contract(driver, add_menu_probe(driver), output)

            row = authority_row(driver, CITATIONS[0])
            row.find_element(By.CSS_SELECTOR, "input[type='file']").send_keys(
                str(authority_pdf.resolve())
            )
            WebDriverWait(driver, 30).until(
                lambda item: authority_pdf.name in authority_row(
                    item, CITATIONS[0]
                ).text
            )
            other = authority_row(driver, CITATIONS[1])
            exclude = other.find_element(
                By.XPATH, ".//label[contains(., 'Leave out of book')]/input"
            )
            if not exclude.is_selected():
                exclude.click()
            WebDriverWait(driver, 30).until(
                lambda item: authority_row(item, CITATIONS[1])
                .find_element(
                    By.XPATH, ".//label[contains(., 'Leave out of book')]/input"
                )
                .is_selected()
            )

            for mode in ("table", "book", "both"):
                select_mode(driver, mode)
            focus = enable_word_copy_with_keyboard(driver)
            network_urls.extend(request_urls(performance_events(driver)))

            build = driver.find_element(By.XPATH, "//button[normalize-space()='Build']")
            WebDriverWait(driver, 10).until(lambda _item: build.is_enabled())
            build.click()
            WebDriverWait(driver, 90).until(
                lambda item: any(
                    "Outputs ready" in status.text
                    for status in item.find_elements(By.CSS_SELECTOR, "[role='status']")
                )
            )
            build_events = performance_events(driver)
            network_urls.extend(request_urls(build_events))
            expected_roles = {"table", "book", "annotated-document"}
            response = None if standalone else build_response(driver, build_events)
            saved = standalone_state(driver) if standalone else None
            product_outputs = saved["outputs"] if saved else response["product"]["outputs"]
            receipt_outputs = product_outputs if saved else response["receipt"]["outputs"]
            assert set(receipt_outputs) == expected_roles, receipt_outputs
            assert set(product_outputs) == expected_roles, product_outputs
            assert (saved["insertIntoDocument"] if saved else
                    response["receipt"]["draft"]["insertIntoDocument"]) is True

            viewports = check_viewports(driver, output)
            downloaded = download_outputs(driver, output / "downloads")
            network_urls.extend(request_urls(performance_events(driver)))
            assert not [
                url
                for url in network_urls
                if (urlparse(url).hostname or "").lower().endswith("canlii.org")
            ], network_urls
            console_errors = [
                entry
                for entry in driver.get_log("browser")
                if entry.get("level") == "SEVERE"
                and entry.get("source") in {"console-api", "javascript"}
            ]
            assert not console_errors, console_errors

            book = next(
                path
                for path in downloaded.values()
                if path.name.endswith(".book-of-authorities.pdf")
            )
            table = next(
                path
                for path in downloaded.values()
                if path.name.endswith(".table-of-authorities.docx")
            )
            word_copy = next(
                path
                for path in downloaded.values()
                if path.name.endswith(".with-table-of-authorities.docx")
            )
            actual_hashes = {
                filename: sha256(path) for filename, path in downloaded.items()
            }
            expected_hashes = {
                metadata["filename"]: metadata["sha256"]
                for metadata in receipt_outputs.values()
            }
            (output / "build-proof.json").write_text(
                json.dumps(
                    {
                        "receipt": response["receipt"] if response else None,
                        "product_outputs": product_outputs,
                        "expected_hashes": expected_hashes,
                        "downloaded_hashes": actual_hashes,
                        "network_urls": network_urls,
                    },
                    indent=2,
                ),
                encoding="utf-8",
            )
            assert actual_hashes == expected_hashes, {
                "expected": expected_hashes,
                "downloaded": actual_hashes,
                "requests": [url for url in network_urls if "/single-documents/" in url],
            }
            if response:
                for role, metadata in receipt_outputs.items():
                    assert product_outputs[role]["sha256"] == metadata["sha256"], (role, metadata)

            result = {
                "schema_version": "beaver.authorities-browser-test.v1",
                "created_at": datetime.now(timezone.utc).isoformat(),
                "url": args.url,
                "citations": list(CITATIONS),
                "canlii": {"pdf_url": handoff, "requests": 0},
                "mode": "standalone" if standalone else "beaver",
                "cold_navigation": cold_navigation,
                "output_roles": sorted(product_outputs),
                "downloads": {
                    filename: sha256(path) for filename, path in downloaded.items()
                },
                "book": inspect_book(book, output / "book-page-1.png"),
                "table": inspect_table(table),
                "word_copy": inspect_word_copy(word_copy),
                "ui": {"viewports": viewports, "keyboard_focus": focus,
                       "more_actions_menu": menu},
                "console_errors": [],
                "elapsed_seconds": round(time.monotonic() - started, 3),
            }
            print(json.dumps(result, indent=2))
            return 0
        finally:
            driver.quit()


if __name__ == "__main__":
    raise SystemExit(main())
