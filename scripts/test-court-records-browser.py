from __future__ import annotations

import argparse
import hashlib
import json
import tempfile
import threading
import time
from datetime import datetime, timezone
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlsplit

import fitz
from selenium import webdriver
from selenium.webdriver.common.by import By
from selenium.webdriver.chrome.service import Service
from selenium.webdriver.common.keys import Keys
from selenium.webdriver.support.ui import Select, WebDriverWait


ROOT = Path(__file__).resolve().parents[1]
CHROME = next((path for path in (
    Path(r"C:\Program Files\Google\Chrome\Application\chrome.exe"),
    Path(r"C:\Program Files (x86)\Google\Chrome\Application\chrome.exe"),
) if path.is_file()), None)
CHROMEDRIVER = next(iter(sorted(Path.home().parent.glob(
    r"*/.cache/selenium/chromedriver/win64/*/chromedriver.exe"
), reverse=True)), None)


class QuietStaticHandler(SimpleHTTPRequestHandler):
    def log_message(self, _format: str, *_args: object) -> None:
        pass

    def do_GET(self) -> None:
        if self.path == "/favicon.ico":
            self.send_response(204)
            self.end_headers()
            return
        super().do_GET()


def sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def make_pdf(path: Path, lines: list[str]) -> None:
    document = fitz.open()
    page = document.new_page(width=612, height=792)
    remaining = page.insert_textbox(
        fitz.Rect(72, 64, 540, 735), "\n".join(lines),
        fontsize=11, fontname="Times-Roman", lineheight=1.25,
    )
    assert remaining >= 0, f"Fixture text overflowed {path.name}."
    document.set_metadata({"title": lines[0], "author": "Beaver live proof"})
    document.save(path)
    document.close()


def make_fixtures(directory: Path) -> dict[str, Path]:
    directory.mkdir()
    fixtures = {
        "affidavit": directory / "Affidavit-of-Alexandra-Smith.pdf",
        "exhibit_b": directory / "Project-ledger.pdf",
        "ambiguous": directory / "Service-agreement.pdf",
        "notice": directory / "Notice-of-motion.pdf",
        "representations": directory / "Written-representations.pdf",
    }
    make_pdf(fixtures["affidavit"], [
        "COURT OF KING'S BENCH OF ALBERTA",
        "COURT FILE NUMBER: 2401-12345",
        "JUDICIAL CENTRE: CALGARY",
        "BETWEEN:",
        "NORTH PRAIRIE LTD.",
        "PLAINTIFF",
        "- and -",
        "RIVERSTONE INC.",
        "DEFENDANT",
        "2nd Affidavit of Alexandra Smith",
        "I, Alexandra Smith, of Calgary, Alberta, SWEAR AND SAY THAT:",
        "1. I am a director of the Plaintiff and have personal knowledge of these facts.",
        "2. The signed service agreement is attached and marked as Exhibit A.",
        "3. The project ledger is attached and marked as Exhibit B.",
        "SWORN BEFORE ME AT THE CITY OF CALGARY",
        "IN THE PROVINCE OF ALBERTA",
        "THIS 29TH DAY OF AUGUST, 2026",
        "A Commissioner for Oaths in and for Alberta",
    ])
    make_pdf(fixtures["exhibit_b"], [
        'This is Exhibit "B" referred to in the Affidavit.',
        "PROJECT LEDGER",
        "August 2026",
        "The ledger records the project invoices relied on by the deponent.",
    ])
    make_pdf(fixtures["ambiguous"], [
        "SERVICE AGREEMENT",
        "Executed January 15, 2026",
        "North Prairie Ltd. and Riverstone Inc. agree to the following services.",
    ])
    make_pdf(fixtures["notice"], [
        "FEDERAL COURT",
        "COURT FILE NUMBER: T-982-19",
        "BETWEEN:",
        "NORTH PRAIRIE LTD.",
        "APPLICANT",
        "- and -",
        "RIVERSTONE INC.",
        "RESPONDENT",
        "NOTICE OF MOTION",
        "The Applicant moves for procedural directions.",
    ])
    make_pdf(fixtures["representations"], [
        "WRITTEN REPRESENTATIONS OF THE APPLICANT",
        "The requested directions are just and proportionate.",
    ])
    return fixtures


def start_browser(profile: Path, headed: bool) -> webdriver.Chrome:
    if not CHROME:
        raise RuntimeError("Google Chrome is required for this live test.")
    options = webdriver.ChromeOptions()
    options.binary_location = str(CHROME)
    if not headed:
        options.add_argument("--headless=new")
    for argument in ("--disable-gpu", "--no-sandbox", "--disable-dev-shm-usage",
                     "--disable-crash-reporter", "--no-first-run"):
        options.add_argument(argument)
    options.add_argument(f"--user-data-dir={profile}")
    options.set_capability("goog:loggingPrefs", {"browser": "ALL"})
    options.add_experimental_option("prefs", {
        "download.prompt_for_download": False,
        "plugins.always_open_pdf_externally": True,
    })
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
    driver.set_window_size(1440, 1000)
    return driver


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


def chooser_contract(
    driver: webdriver.Chrome, dialog, output: Path, slug: str
) -> dict[str, object]:
    result: dict[str, object] = {}
    for width, height in ((1440, 1000), (320, 800)):
        driver.execute_cdp_cmd("Emulation.setDeviceMetricsOverride", {
            "width": width, "height": height, "deviceScaleFactor": 1, "mobile": False,
        })
        WebDriverWait(driver, 5).until(
            lambda item: item.execute_script("return innerWidth") == width
        )
        metrics = driver.execute_script("""
const d=arguments[0],r=d.getBoundingClientRect(),id=d.getAttribute('aria-labelledby'),
  controls=[...d.querySelectorAll('button,input')].filter(n=>n.getBoundingClientRect().width>1);
return {name:document.getElementById(id)?.textContent?.trim(),left:r.left,right:r.right,
  top:r.top,bottom:r.bottom,overflow:document.documentElement.scrollWidth-innerWidth,
  active:document.activeElement?.getAttribute('aria-label')||document.activeElement?.textContent?.trim(),
  smallTargets:controls.filter(n=>{const x=n.getBoundingClientRect();return x.width<24||x.height<24})
    .map(n=>n.getAttribute('aria-label')||n.textContent.trim()),
  smallFormText:controls.filter(n=>n.tagName==='INPUT'&&parseFloat(getComputedStyle(n).fontSize)<16)
    .map(n=>getComputedStyle(n).fontSize)};
""", dialog)
        assert metrics["name"] and metrics["overflow"] <= 1, metrics
        assert metrics["left"] >= 0 and metrics["right"] <= width, metrics
        assert metrics["top"] >= 0 and metrics["bottom"] <= height, metrics
        assert not metrics["smallTargets"], metrics
        if width == 320:
            assert not metrics["smallFormText"], metrics
        assert driver.save_screenshot(str(output / f"chooser-{slug}-{width}.png"))
        result[str(width)] = metrics
    driver.execute_cdp_cmd("Emulation.clearDeviceMetricsOverride", {})
    driver.set_window_size(1440, 1000)
    return result


def reset_workspace(
    driver: webdriver.Chrome, url: str, profile_id: str, chooser_output: Path | None = None
) -> tuple[float, dict[str, object], dict[str, object]]:
    started = time.perf_counter()
    parsed = urlsplit(url)
    driver.get("about:blank")
    driver.execute_cdp_cmd("Storage.clearDataForOrigin", {
        "origin": f"{parsed.scheme}://{parsed.netloc}",
        "storageTypes": "indexeddb,local_storage",
    })
    driver.get(url)
    wait = WebDriverWait(driver, 20)
    chooser = wait.until(lambda item: item.find_element(
        By.CSS_SELECTOR, "#court-record-workspace:not([inert]) [data-court-record-chooser]"
    ))
    timing = navigation_timing(driver)
    drafts = driver.find_element(By.CSS_SELECTOR, "[data-draft-menu]")
    drafts.find_element(By.TAG_NAME, "summary").click()
    drafts.find_element(By.XPATH, ".//button[normalize-space()='New']").click()
    wait.until(lambda item: item.find_element(
        By.CSS_SELECTOR, "[data-court-record-chooser]"
    ).get_attribute("data-selected-profile") == "general-affidavit-exhibits")
    wait.until(lambda item: not item.find_element(By.ID, "cover-courtFileNumber")
               .get_attribute("value"))
    chooser = driver.find_element(By.CSS_SELECTOR, "[data-court-record-chooser]")
    documents = {
        "ab-kb-affidavit-exhibits": "Affidavit with exhibits",
        "fc-motion-record-moving": "Motion record",
    }
    formats = {
        "ab-kb-affidavit-exhibits": ".//button[normalize-space()='ABKB']",
        "fc-motion-record-moving": ".//button[starts-with(normalize-space(),'FC ') and contains(normalize-space(),'Moving party')]",
    }
    chooser.find_element(By.CSS_SELECTOR, "button[aria-label^='Document:']").click()
    dialog = wait.until(lambda item: item.find_element(By.CSS_SELECTOR, "dialog[open]"))
    chooser_proof = ({"document": chooser_contract(
        driver, dialog, chooser_output, "document"
    )} if chooser_output else {})
    choice = dialog.find_element(
        By.XPATH, f".//button[normalize-space()='{documents[profile_id]}']"
    )
    if choice.get_attribute("aria-pressed") == "true":
        driver.switch_to.active_element.send_keys(Keys.ESCAPE)
        wait.until(lambda item: not item.find_elements(By.CSS_SELECTOR, "dialog[open]"))
        chooser.find_element(By.CSS_SELECTOR, "button[aria-label^='Format:']").click()
    else:
        choice.click()
    dialog = wait.until(lambda item: item.find_element(By.CSS_SELECTOR, "dialog[open]"))
    if chooser_output:
        chooser_proof["format"] = chooser_contract(driver, dialog, chooser_output, "format")
    choice = dialog.find_element(By.XPATH, formats[profile_id])
    if choice.get_attribute("aria-pressed") == "true":
        driver.switch_to.active_element.send_keys(Keys.ESCAPE)
    else:
        choice.click()
    wait.until(lambda item: item.find_element(
        By.CSS_SELECTOR, "[data-court-record-chooser]"
    ).get_attribute("data-selected-profile") == profile_id)
    return round((time.perf_counter() - started) * 1000, 1), timing, chooser_proof


def field(driver: webdriver.Chrome, field_id: str):
    return driver.find_element(By.ID, f"cover-{field_id}")


def enter(element, value: str) -> None:
    element.clear()
    element.send_keys(value)


def reveal(driver: webdriver.Chrome, element) -> None:
    driver.execute_script(
        "for(let n=arguments[0];n;n=n.parentElement) if(n.tagName==='DETAILS') n.open=true;"
        "arguments[0].scrollIntoView({block:'center'});", element,
    )


def upload(driver: webdriver.Chrome, kind_id: str, path: Path) -> None:
    selector = f"[data-kind-id='{kind_id}']"
    before = len(driver.find_elements(By.CSS_SELECTOR, f"{selector} [data-entry-id]"))
    driver.find_element(By.CSS_SELECTOR, f"{selector} input[type=file]").send_keys(
        str(path.resolve())
    )

    def prepared(item: webdriver.Chrome) -> bool:
        rows = item.find_elements(By.CSS_SELECTOR, f"{selector} [data-entry-id]")
        return len(rows) > before and all(row.get_attribute("aria-busy") != "true" for row in rows)

    WebDriverWait(driver, 30).until(prepared)


def article(driver: webdriver.Chrome, filename: str):
    return driver.find_element(
        By.XPATH, f"//span[@title={json.dumps(filename)}]/ancestor::article[1]"
    )


def exhibit_slot(driver: webdriver.Chrome, label: str):
    return driver.find_element(By.CSS_SELECTOR, f"[aria-label='Exhibit {label} slot']")


def unassigned_pool(driver: webdriver.Chrome):
    return driver.find_element(
        By.XPATH, "//h4[normalize-space()='Unassigned files']/parent::*"
    )


def contains_file(container, filename: str) -> bool:
    return bool(container.find_elements(By.CSS_SELECTOR, f"span[title='{filename}']"))


def drag(driver: webdriver.Chrome, source, target) -> None:
    driver.execute_script("""
const source=arguments[0], target=arguments[1], data=new DataTransfer();
source.dispatchEvent(new DragEvent('dragstart',{bubbles:true,dataTransfer:data}));
target.dispatchEvent(new DragEvent('dragover',{bubbles:true,cancelable:true,dataTransfer:data}));
target.dispatchEvent(new DragEvent('drop',{bubbles:true,cancelable:true,dataTransfer:data}));
source.dispatchEvent(new DragEvent('dragend',{bubbles:true,dataTransfer:data}));
""", source, target)


def keyboard_contract(driver: webdriver.Chrome) -> dict[str, object]:
    driver.execute_script(
        "document.activeElement?.blur();document.body.tabIndex=-1;document.body.focus();"
    )
    driver.find_element(By.TAG_NAME, "body").send_keys(Keys.TAB)
    focus = driver.execute_script("""
const node=document.activeElement, rect=node.getBoundingClientRect(), style=getComputedStyle(node);
return {tag:node.tagName,text:node.textContent.trim(),width:rect.width,height:rect.height,
  outline:style.outlineWidth,shadow:style.boxShadow};
""")
    assert focus["tag"] == "A" and focus["text"] in {
        "Skip to builder", "Skip to content",
    }, focus
    assert focus["width"] >= 24 and focus["height"] >= 24, focus
    assert focus["outline"] != "0px" or focus["shadow"] != "none", focus
    driver.switch_to.active_element.send_keys(Keys.ENTER)
    if focus["text"] == "Skip to builder":
        WebDriverWait(driver, 5).until(
            lambda item: item.switch_to.active_element.get_attribute("id") == "court-record-workspace"
        )
    else:
        WebDriverWait(driver, 5).until(
            lambda item: urlsplit(item.current_url).fragment == "main-content"
        )
    driver.execute_script("document.body.removeAttribute('tabindex')")
    return focus


def viewport_contract(
    driver: webdriver.Chrome, output: Path, slug: str, focus_selector: str
) -> dict[str, object]:
    results: dict[str, object] = {}
    script = """
const visible=node=>{const s=getComputedStyle(node),r=node.getBoundingClientRect();
  return s.display!=='none'&&s.visibility!=='hidden'&&r.width>1&&r.height>1&&!node.classList.contains('sr-only')};
const name=node=>node.getAttribute('aria-label')||[...(node.labels||[])].map(x=>x.textContent).join(' ').trim()||node.textContent.trim()||node.title;
const controls=[...document.querySelectorAll("button,summary,select,input:not([type=file]),textarea,label:has(input[type=file]),a[href]")].filter(visible);
const ids=[...document.querySelectorAll('[id]')].map(node=>node.id);
return {width:innerWidth,overflow:document.documentElement.scrollWidth-document.documentElement.clientWidth,
  duplicateIds:[...new Set(ids.filter((id,index)=>ids.indexOf(id)!==index))],
  unnamed:controls.filter(node=>!name(node)).map(node=>node.outerHTML.slice(0,120)),
  smallTargets:controls.filter(node=>{const r=node.getBoundingClientRect();return r.width<24||r.height<24})
    .map(node=>`${node.tagName}:${name(node)}:${Math.round(node.getBoundingClientRect().width)}x${Math.round(node.getBoundingClientRect().height)}`),
  smallFormText:[...document.querySelectorAll('input:not([type=file]),select,textarea')].filter(visible)
    .filter(node=>parseFloat(getComputedStyle(node).fontSize)<16).map(node=>`${node.tagName}:${getComputedStyle(node).fontSize}`),
  positiveTabindex:[...document.querySelectorAll('[tabindex]')].filter(node=>Number(node.tabIndex)>0).map(node=>node.outerHTML.slice(0,120)),
  crampedEntryFields:[...document.querySelectorAll('[data-entry-id] > div:first-of-type label input')]
    .filter(visible).filter(node=>node.getBoundingClientRect().width<120)
    .map(node=>`${name(node)}:${Math.round(node.getBoundingClientRect().width)}px`),
  wideNodes:[...document.querySelectorAll('body *')].filter(visible)
    .filter(node=>node.getBoundingClientRect().right>document.documentElement.clientWidth+1)
    .map(node=>{const r=node.getBoundingClientRect(),s=getComputedStyle(node);return `${node.tagName}.${node.className}:left=${Math.round(r.left)},width=${Math.round(r.width)},right=${Math.round(r.right)},min=${s.minWidth}`}).slice(0,12)};
"""
    for width, height in ((1440, 1000), (320, 800)):
        driver.execute_cdp_cmd("Emulation.setDeviceMetricsOverride", {
            "width": width, "height": height, "deviceScaleFactor": 1, "mobile": False,
        })
        WebDriverWait(driver, 5).until(
            lambda item: item.execute_script("return innerWidth") == width
        )
        metrics = driver.execute_script(script)
        driver.execute_script("scrollTo(0,0)")
        driver.save_screenshot(str(output / f"{slug}-{width}-top.png"))
        reveal(driver, driver.find_element(By.CSS_SELECTOR, focus_selector))
        driver.save_screenshot(str(output / f"{slug}-{width}-documents.png"))
        assert metrics["overflow"] <= 1, metrics
        assert not metrics["duplicateIds"], metrics
        assert not metrics["unnamed"], metrics
        assert not metrics["smallTargets"], metrics
        assert not metrics["smallFormText"], metrics
        assert not metrics["positiveTabindex"], metrics
        assert not metrics["crampedEntryFields"], metrics
        results[str(width)] = metrics
    driver.execute_cdp_cmd("Emulation.clearDeviceMetricsOverride", {})
    driver.set_window_size(1440, 1000)
    return results


def build_and_download(
    driver: webdriver.Chrome, directory: Path, slug: str, page_count: int
) -> dict[str, Path]:
    button = driver.find_element(By.CSS_SELECTOR, "[data-court-record-build]")
    panel = button.find_element(By.XPATH, "ancestor::aside[1]")
    reveal(driver, button)
    button.click()
    WebDriverWait(driver, 45).until(lambda _item: "Build complete" in panel.text)
    preview = driver.find_element(By.CSS_SELECTOR, "[aria-label='Built court record preview']")
    WebDriverWait(driver, 20).until(
        lambda _item: len(preview.find_elements(By.CSS_SELECTOR, "[data-page-number]")) == page_count
    )
    assert not panel.find_elements(By.TAG_NAME, "iframe")
    directory.mkdir(parents=True)
    driver.execute_cdp_cmd("Page.setDownloadBehavior", {
        "behavior": "allow", "downloadPath": str(directory.resolve()),
    })
    for width, height in ((1440, 1000), (320, 800)):
        driver.execute_cdp_cmd("Emulation.setDeviceMetricsOverride", {
            "width": width, "height": height, "deviceScaleFactor": 1, "mobile": False,
        })
        reveal(driver, preview)
        driver.save_screenshot(str(directory.parent / f"{slug}-{width}-built-preview.png"))
        assert driver.execute_script(
            "return document.documentElement.scrollWidth-document.documentElement.clientWidth"
        ) <= 1
    downloaded: dict[str, Path] = {}
    for candidate in panel.find_elements(By.CSS_SELECTOR, "button"):
        names = [span.text.strip() for span in candidate.find_elements(By.CSS_SELECTOR, "span")]
        filename = next((name for name in names if name.lower().endswith((".pdf", ".docx"))), "")
        if not filename:
            continue
        driver.execute_script("arguments[0].click()", candidate)
        target = directory / filename
        WebDriverWait(driver, 20).until(
            lambda _item: target.is_file() and not list(directory.glob("*.crdownload"))
        )
        downloaded[filename] = target
    assert downloaded, "The live build exposed no downloadable artifacts."
    driver.execute_cdp_cmd("Emulation.clearDeviceMetricsOverride", {})
    driver.set_window_size(1440, 1000)
    return downloaded


def inspect_affidavit(path: Path, output: Path) -> dict[str, object]:
    document = fitz.open(path)
    try:
        pages = [page.get_text() for page in document]
        toc = [row[1] for row in document.get_toc()]
        assert document.page_count == 5, pages
        assert [page.get_label() for page in document] == ["1", "2", "3", "4", "5"]
        assert not document.is_encrypted and all(text.strip() for text in pages)
        assert 'This is Exhibit "A" referred to in the Affidavit of:' in pages[1]
        assert "SERVICE AGREEMENT" in pages[2]
        assert 'This is Exhibit "B" referred to in the Affidavit of:' in pages[3]
        assert "PROJECT LEDGER" in pages[4]
        assert toc.index("Exhibit A certificate") < toc.index("Exhibit B certificate"), toc
        for page_number, name in ((0, "affidavit-output"), (1, "exhibit-a-certificate"),
                                  (3, "exhibit-b-certificate")):
            document[page_number].get_pixmap(
                matrix=fitz.Matrix(1.5, 1.5), alpha=False
            ).save(output / f"{name}.png")
        return {"filename": path.name, "sha256": sha256(path), "bytes": path.stat().st_size,
                "pages": document.page_count, "bookmarks": toc}
    finally:
        document.close()


def inspect_federal(path: Path, output: Path) -> dict[str, object]:
    document = fitz.open(path)
    try:
        text = "\n".join(page.get_text() for page in document)
        toc = [row[1] for row in document.get_toc()]
        links = sum(len(page.get_links()) for page in document)
        assert document.page_count == 4, text
        assert [page.get_label() for page in document] == ["1", "2", "3", "4"]
        assert not document.is_encrypted
        for value in ("FEDERAL COURT", "MOTION RECORD", "INDEX", "NOTICE OF MOTION",
                      "WRITTEN REPRESENTATIONS OF THE APPLICANT"):
            assert value in text, value
        assert links >= 2 and len(toc) >= 3, (links, toc)
        for page_number, name in ((0, "federal-motion-cover"), (1, "federal-motion-index")):
            document[page_number].get_pixmap(
                matrix=fitz.Matrix(1.5, 1.5), alpha=False
            ).save(output / f"{name}.png")
        return {"filename": path.name, "sha256": sha256(path), "bytes": path.stat().st_size,
                "pages": document.page_count, "bookmarks": toc, "internal_links": links}
    finally:
        document.close()


def check_affidavit(
    driver: webdriver.Chrome, url: str, fixtures: dict[str, Path], output: Path
) -> dict[str, object]:
    profile_ms, cold_navigation, chooser = reset_workspace(
        driver, url, "ab-kb-affidavit-exhibits", output
    )
    body = driver.find_element(By.TAG_NAME, "body").text
    for unwanted in ("Effective ", "Preparation details", "Official sources", "Joins an affidavit"):
        assert unwanted not in body, unwanted
    for heading in ("1. Add the affidavit", "2. Case details", "3. Add exhibits or another document"):
        assert driver.find_elements(By.XPATH, f"//h2[normalize-space()='{heading}']"), heading
    for field_id in ("courtFileNumber", "registry", "affidavitNumber", "deponent", "swornDate", "swornPlace"):
        assert not field(driver, field_id).get_attribute("value"), field_id

    Select(driver.find_element(By.XPATH, "//label[contains(.,'Party style')]/select")).select_by_visible_text("Action")
    reveal(driver, field(driver, "registry"))
    enter(field(driver, "registry"), "Edmonton")
    enter(driver.find_element(By.CSS_SELECTOR, "[data-party-group='Plaintiff'] input"), "Existing Plaintiff")
    upload(driver, "affidavit", fixtures["affidavit"])
    expected = {
        "courtFileNumber": "2401-12345", "registry": "Edmonton", "affidavitNumber": "2",
        "deponent": "Alexandra Smith", "swornDate": "August 29, 2026", "swornPlace": "Calgary",
    }
    WebDriverWait(driver, 20).until(lambda item: all(
        field(item, key).get_attribute("value") == value for key, value in expected.items()
    ))
    assert driver.find_element(By.CSS_SELECTOR, "[data-party-group='Plaintiff'] input").get_attribute("value") == "Existing Plaintiff"
    assert driver.find_element(By.CSS_SELECTOR, "[data-party-group='Defendant'] input").get_attribute("value") == "Riverstone Inc."
    for label in ("A", "B"):
        WebDriverWait(driver, 10).until(lambda item, value=label: exhibit_slot(item, value))

    upload(driver, "exhibit", fixtures["exhibit_b"])
    upload(driver, "exhibit", fixtures["ambiguous"])
    assert contains_file(exhibit_slot(driver, "B"), fixtures["exhibit_b"].name)
    assert contains_file(unassigned_pool(driver), fixtures["ambiguous"].name)

    drag(driver, article(driver, fixtures["ambiguous"].name), exhibit_slot(driver, "A"))
    WebDriverWait(driver, 5).until(
        lambda item: contains_file(exhibit_slot(item, "A"), fixtures["ambiguous"].name)
    )
    article(driver, fixtures["ambiguous"].name).find_element(
        By.XPATH, ".//label[contains(normalize-space(.),'Exhibit label')]/input"
    ).send_keys(Keys.CONTROL, "a", Keys.BACKSPACE)
    WebDriverWait(driver, 5).until(
        lambda item: contains_file(unassigned_pool(item), fixtures["ambiguous"].name)
    )
    article(driver, fixtures["ambiguous"].name).find_element(
        By.XPATH, ".//label[contains(normalize-space(.),'Exhibit label')]/input"
    ).send_keys("A")
    WebDriverWait(driver, 5).until(
        lambda item: contains_file(exhibit_slot(item, "A"), fixtures["ambiguous"].name)
    )
    assert contains_file(exhibit_slot(driver, "B"), fixtures["exhibit_b"].name)

    keyboard = keyboard_contract(driver)
    viewports = viewport_contract(driver, output, "affidavit", "[data-kind-id='exhibit']")
    downloads = build_and_download(
        driver, output / "affidavit-downloads", "affidavit", 5
    )
    pdf = next(path for path in downloads.values() if path.suffix.lower() == ".pdf")
    return {"profile": "ab-kb-affidavit-exhibits", "reset_and_profile_ms": profile_ms,
            "cold_navigation": cold_navigation, "chooser": chooser,
            "propagated": expected, "keyboard_focus": keyboard, "viewports": viewports,
            "output": inspect_affidavit(pdf, output)}


def check_federal(
    driver: webdriver.Chrome, url: str, fixtures: dict[str, Path], output: Path
) -> dict[str, object]:
    profile_ms, navigation, _chooser = reset_workspace(
        driver, url, "fc-motion-record-moving"
    )
    assert not driver.find_elements(By.CSS_SELECTOR, "[draggable='true']")
    upload(driver, "notice-motion", fixtures["notice"])
    WebDriverWait(driver, 10).until(
        lambda item: field(item, "courtFileNumber").get_attribute("value") == "T-982-19"
    )
    assert driver.find_element(By.CSS_SELECTOR, "[data-party-group='Applicant'] input").get_attribute("value") == "North Prairie Ltd."
    assert driver.find_element(By.CSS_SELECTOR, "[data-party-group='Respondent'] input").get_attribute("value") == "Riverstone Inc."
    for field_id, value in {
        "counselName": "Jordan Lee", "counselAddress": "100 Legal Avenue\nCalgary, Alberta",
        "counselPhone": "403-555-0100", "counselEmail": "jlee@example.test",
        "recordSubtitle": "Motion for procedural directions",
        "applicationUnder": "Federal Courts Act, section 18.1",
    }.items():
        reveal(driver, field(driver, field_id))
        enter(field(driver, field_id), value)
    upload(driver, "written-representations", fixtures["representations"])
    assert not driver.find_elements(By.CSS_SELECTOR, "[draggable='true']")
    assert not driver.find_elements(By.XPATH, "//label[contains(.,'Exhibit label')]")
    viewports = viewport_contract(
        driver, output, "federal-motion", "[data-kind-id='notice-motion']"
    )
    downloads = build_and_download(
        driver, output / "federal-motion-downloads", "federal-motion", 4
    )
    pdf = next(path for path in downloads.values() if path.suffix.lower() == ".pdf")
    return {"profile": "fc-motion-record-moving", "reset_and_profile_ms": profile_ms,
            "navigation": navigation,
            "generic_drag_controls": 0, "viewports": viewports,
            "output": inspect_federal(pdf, output)}


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Exercise the production Court Record Builder through Chrome."
    )
    parser.add_argument("--url", help="Optional served court-records entry point.")
    parser.add_argument("--headed", action="store_true")
    parser.add_argument("--artifacts", type=Path, help="Screenshot and proof-file directory.")
    args = parser.parse_args()

    with tempfile.TemporaryDirectory(prefix="beaver-court-record-browser-") as temporary:
        session = Path(temporary)
        output = args.artifacts.resolve() if args.artifacts else session / "artifacts"
        output.mkdir(parents=True, exist_ok=True)
        fixtures = make_fixtures(session / "fixtures")

        server = None
        thread = None
        url = args.url
        if not url:
            dist = ROOT / "frontend" / "dist"
            if not (dist / "court-records.html").is_file():
                raise RuntimeError("Build the production frontend before running this test.")
            server = ThreadingHTTPServer(("127.0.0.1", 0), partial(
                QuietStaticHandler, directory=str(dist)
            ))
            thread = threading.Thread(target=server.serve_forever, daemon=True)
            thread.start()
            url = f"http://127.0.0.1:{server.server_port}/court-records.html"

        driver = start_browser(session / "chrome-profile", args.headed)
        started = time.perf_counter()
        try:
            result = {
                "schema_version": "beaver.court-record-browser-test.v2",
                "created_at": datetime.now(timezone.utc).isoformat(),
                "url": url,
                "affidavit": check_affidavit(driver, url, fixtures, output),
                "federal_motion": check_federal(driver, url, fixtures, output),
            }
            logs = driver.get_log("browser")
            severe = [entry for entry in logs if entry["level"] == "SEVERE"]
            assert not severe, severe
            result["browser_logs"] = logs
            result["elapsed_seconds"] = round(time.perf_counter() - started, 3)
            receipt = output / "court-records-live-proof.json"
            receipt.write_text(json.dumps(result, indent=2), encoding="utf-8")
            print(json.dumps(result, indent=2))
            print(f"ARTIFACTS {output}")
            return 0
        except Exception:
            driver.save_screenshot(str(output / "failure.png"))
            print("LIVE_FAILURE", driver.current_url)
            print(driver.find_element(By.TAG_NAME, "body").text[:4000]
                  .encode("ascii", "backslashreplace").decode())
            print(json.dumps(driver.get_log("browser"), indent=2))
            raise
        finally:
            driver.quit()
            if server:
                server.shutdown()
                server.server_close()
            if thread:
                thread.join(timeout=2)


if __name__ == "__main__":
    raise SystemExit(main())
