from __future__ import annotations

import argparse
import base64
import hashlib
import json
import tempfile
import time
import zipfile
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import parse_qs, urlparse

import fitz
from docx import Document
from selenium import webdriver
from selenium.webdriver import ActionChains
from selenium.webdriver.chrome.service import Service
from selenium.webdriver.common.by import By
from selenium.webdriver.common.keys import Keys
from selenium.webdriver.support.ui import Select
from selenium.webdriver.support.wait import WebDriverWait


REAL_CITATIONS = ("2009 SCC 32", "2016 SCC 27")
CHROME = next((path for path in (
    Path(r"C:\Program Files\Google\Chrome\Application\chrome.exe"),
    Path(r"C:\Program Files (x86)\Google\Chrome\Application\chrome.exe"),
) if path.is_file()), None)
CHROMEDRIVER = next(iter(sorted(Path.home().parent.glob(
    r"*/.cache/selenium/chromedriver/win64/*/chromedriver.exe"), reverse=True)), None)


def digest(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def pdf_fixture(path: Path, title: str, detail: str) -> Path:
    pdf = fitz.open()
    page = pdf.new_page(width=612, height=792)
    page.insert_text((72, 86), title, fontsize=18)
    page.insert_textbox(fitz.Rect(72, 125, 540, 700), detail, fontsize=11)
    pdf.set_metadata({"title": title, "subject": detail})
    pdf.save(path)
    pdf.close()
    return path


def fixtures(directory: Path) -> tuple[Path, list[Path], dict[str, Path]]:
    source = directory / "real-authorities-smoke.docx"
    document = Document()
    document.add_heading("Written argument", level=1)
    document.add_paragraph("The governing framework is stated in R v Grant, 2009 SCC 32 at para 29.")
    document.add_paragraph("The proportionality analysis originates in R v Oakes, [1986] 1 SCR 103, 1986 CanLII 46 (SCC).")
    document.add_paragraph("Delay is addressed in R v Jordan, 2016 SCC 27 at para 47.")
    document.save(source)
    pdfs = []
    for filename, title, citation in (
        ("R v Grant.pdf", "R v Grant", "2009 SCC 32\n\n[29] The governing framework is stated here."),
        ("R v Oakes.pdf", "R v Oakes", "[1986] 1 SCR 103"),
        ("R v Jordan.pdf", "R v Jordan", "2016 SCC 27"),
    ):
        pdfs.append(pdf_fixture(directory / filename, title,
            f"{citation}\n\nValid local source PDF used by the Authorities production smoke."))
    parts = {name: pdf_fixture(directory / filename, title, detail)
        for name, filename, title, detail in (
            ("cover", "custom-cover.pdf", "Custom Filing Cover", "Filed for the browser smoke."),
            ("index", "custom-index.pdf", "Custom Filing Index", "Custom index supplied by counsel."),
            ("alpha", "supplement-alpha.pdf", "Supplement Alpha", "First supplemental document."),
            ("beta", "supplement-beta.pdf", "Supplement Beta", "Second supplemental document."),
        )}
    return source, pdfs, parts


def chrome(profile: Path, headed: bool) -> webdriver.Chrome:
    if not CHROME:
        raise RuntimeError("Google Chrome is required.")
    options = webdriver.ChromeOptions()
    options.binary_location = str(CHROME)
    if not headed:
        options.add_argument("--headless=new")
    for flag in ("--disable-gpu", "--no-sandbox", "--disable-dev-shm-usage",
                 "--disable-crash-reporter", "--no-first-run"):
        options.add_argument(flag)
    options.add_argument(f"--user-data-dir={profile}")
    options.set_capability("goog:loggingPrefs", {"browser": "ALL", "performance": "ALL"})
    driver = webdriver.Chrome(options=options,
        service=Service(str(CHROMEDRIVER)) if CHROMEDRIVER else None)
    driver.execute_cdp_cmd("Network.enable", {})
    driver.execute_cdp_cmd("Network.setCacheDisabled", {"cacheDisabled": True})
    driver.execute_cdp_cmd("Page.addScriptToEvaluateOnNewDocument", {"source": r"""
window.__authoritiesSmoke={cls:0,shifts:[],longTasks:[],canliiClicks:[],fakeCanlii:null,
  errors:[],builds:0,lastBuild:null,lastPrepared:null};
try { new PerformanceObserver(list => list.getEntries().forEach(e => {
  if (!e.hadRecentInput) { window.__authoritiesSmoke.cls += e.value;
    window.__authoritiesSmoke.shifts.push({value:e.value,time:e.startTime}); }
})).observe({type:'layout-shift',buffered:true}); } catch {}
try { new PerformanceObserver(list => list.getEntries().forEach(e =>
  window.__authoritiesSmoke.longTasks.push({duration:e.duration,time:e.startTime})
)).observe({type:'longtask',buffered:true}); } catch {}
try { Object.defineProperty(window,'showOpenFilePicker',{configurable:true,value:undefined}); } catch {}
try { Object.defineProperty(window,'showDirectoryPicker',{configurable:true,value:async()=>{let scans=0;return ({
  requestPermission:async()=> 'granted',
  async *values() {
    const item=window.__authoritiesSmoke.fakeCanlii;
    if (!item || scans++ === 0) return;
    yield {kind:'file',name:item.name,getFile:async()=>new File([
      Uint8Array.from(atob(item.base64),character=>character.charCodeAt(0))
    ],item.name,{type:'application/pdf',lastModified:item.lastModified||1700000000000})};
  }
})}}); } catch {}
const nativeOpen=window.open;
window.open=(url,target,features)=>url==='about:blank'
  ? {opener:null,location:{replace:value=>window.__authoritiesSmoke.canliiClicks.push(value)},close(){}}
  : nativeOpen.call(window,url,target,features);
addEventListener('click',event=>{
  const link=event.target.closest?.('a[href*="canlii.org"]');
  if (link) event.preventDefault();
},true);
const nativeFetch=window.fetch;
window.fetch=async(...args)=>{
  const body=args[1]?.body,target=typeof args[0]==='string' ? args[0] : args[0]?.url||'';
  if (target.includes('/authorities-runtime/build') && body instanceof FormData) {
    const draft=JSON.parse(body.get('draft'));
    window.__authoritiesSmoke.lastBuild={importKind:draft.import.kind,settings:draft.settings,
      sources:draft.authorityOrder.map(id=>draft.authorities[id].source.kind),
      sourceOrigins:draft.authorityOrder.map(id=>draft.authorities[id].source.origin||null),
      bookParts:draft.bookParts,roles:JSON.parse(body.get('roles')),
      files:body.getAll('files').map(file=>({name:file.name,size:file.size,type:file.type}))};
  }
  const response=await nativeFetch(...args);
  if (response.ok && /\/api\/authorities\/[^/]+\/sources$/.test(response.url)) {
    const product=await response.clone().json(),draft=product.state;
    window.__authoritiesSmoke.lastPrepared={settings:draft.settings,
      sources:draft.authorityOrder.map(id=>draft.authorities[id].source.kind),
      sourceOrigins:draft.authorityOrder.map(id=>draft.authorities[id].source.origin||null)};
  }
  if (!response.ok) window.__authoritiesSmoke.errors.push({url:response.url,
    status:response.status,body:await response.clone().text()});
  if (response.url.includes('/authorities-runtime/build') ||
      /\/authorities\/[^/]+\/build$/.test(response.url)) window.__authoritiesSmoke.builds++;
  return response;
};
const nativeClick=HTMLInputElement.prototype.click;
HTMLInputElement.prototype.click=function() {
  if (this.type==='file' && !this.isConnected) {
    this.dataset.authoritiesSmokePicker='true';
    Object.assign(this.style,{position:'fixed',left:'-9999px',top:'0'});
    document.documentElement.append(this);
    this.addEventListener('change',()=>setTimeout(()=>this.remove()),{once:true});
    return;
  }
  return nativeClick.call(this);
};
"""})
    return driver


def wait(driver: webdriver.Chrome, seconds: int = 60) -> WebDriverWait:
    return WebDriverWait(driver, seconds)


def idle(driver: webdriver.Chrome) -> None:
    wait(driver, 120).until(lambda item: not item.find_elements(By.CSS_SELECTOR, "[class*='animate-spin']"))


def tab(driver: webdriver.Chrome, name: str):
    return driver.find_element(By.XPATH,
        f"//*[@role='tablist' and @aria-label='Authorities sections']//*[@role='tab' and normalize-space(.)='{name}']")


def click_button(driver: webdriver.Chrome, name: str, root=None):
    owner = root or driver
    return owner.find_element(By.XPATH, f".//button[normalize-space(.)='{name}']").click()


def choose(driver: webdriver.Chrome, label: str, option: str, root=None) -> None:
    owner = root or driver
    field = owner.find_element(By.XPATH,
        f".//label[.//select and starts-with(normalize-space(.), '{label}')]/select")
    Select(field).select_by_visible_text(option)


def upload(driver: webdriver.Chrome, label: str, paths: list[Path], root=None) -> None:
    owner = root or driver
    inputs = owner.find_elements(By.XPATH,
        f".//label[normalize-space(.)='{label}']/input[@type='file']")
    if inputs:
        picker = inputs[0]
    else:
        click_button(driver, label, owner)
        picker = wait(driver, 5).until(lambda item: item.find_element(
            By.CSS_SELECTOR, "input[type='file'][data-authorities-smoke-picker]"))
    picker.send_keys("\n".join(str(path.resolve()) for path in paths))


def fixture_proof(source: Path, pdfs: list[Path], parts: dict[str, Path]) -> dict[str, object]:
    text = "\n".join(paragraph.text for paragraph in Document(source).paragraphs)
    assert all(citation in text for citation in REAL_CITATIONS)
    files = [*pdfs, *parts.values()]
    for path in files:
        with fitz.open(path) as pdf:
            assert pdf.is_pdf and not pdf.is_encrypted and pdf.page_count == 1 and pdf[0].get_text().strip()
    return {"source": source.name, "pdfs": [path.name for path in files]}


def book_contents(driver: webdriver.Chrome):
    heading = driver.find_element(By.XPATH, "//h3[normalize-space(.)='Book contents']")
    return heading.find_element(By.XPATH, "ancestor::div[contains(@class,'border-t')][1]")


def book_part(driver: webdriver.Chrome, name: str):
    return book_contents(driver).find_element(By.XPATH,
        f".//span[normalize-space(.)='{name}']/parent::div")


def supplement_rows(driver: webdriver.Chrome):
    return book_contents(driver).find_elements(By.XPATH,
        ".//label[.//span[normalize-space(.)='Document title']]/parent::div")


def supplement_title(row) -> str:
    return row.find_element(By.XPATH,
        ".//label[.//span[normalize-space(.)='Document title']]/input").get_attribute("value")


def replace_input(field, value: str) -> None:
    field.click(); field.send_keys(Keys.CONTROL, "a", Keys.NULL, value, Keys.TAB)


def edit_supplement(driver: webdriver.Chrome, old: str, title: str, tab_label: str) -> None:
    row = next(row for row in supplement_rows(driver) if supplement_title(row) == old)
    field = row.find_element(By.XPATH,
        ".//label[.//span[normalize-space(.)='Document title']]/input")
    replace_input(field, title); idle(driver)
    row = next(row for row in supplement_rows(driver) if supplement_title(row) == title)
    field = row.find_element(By.XPATH,
        ".//label[.//span[normalize-space(.)='Tab label']]/input")
    replace_input(field, tab_label); idle(driver)


def select_text(driver: webdriver.Chrome, surface, needle: str) -> None:
    found = driver.execute_script(r"""
const root=arguments[0],needle=arguments[1],walker=document.createTreeWalker(root,NodeFilter.SHOW_TEXT);
let nodes=[],text='',node; while(node=walker.nextNode()){nodes.push([node,text.length]);text+=node.data;}
const start=text.indexOf(needle); if(start<0)return false; const end=start+needle.length,range=document.createRange();
const a=nodes.findLast(([,offset])=>offset<=start),b=nodes.findLast(([,offset])=>offset<end);
range.setStart(a[0],start-a[1]); range.setEnd(b[0],end-b[1]);
const selection=getSelection();selection.removeAllRanges();selection.addRange(range);
root.dispatchEvent(new MouseEvent('mouseup',{bubbles:true}));return true;
""", surface, needle)
    assert found, surface.text


def automatic_review(driver: webdriver.Chrome, source: Path, output: Path) -> dict[str, object]:
    upload(driver, "Add file", [source])
    setup = wait(driver, 5).until(lambda item: item.find_element(
        By.CSS_SELECTOR, "dialog[open]"))
    click_button(driver, "Import and review", setup)
    citations = wait(driver, 120).until(lambda item: item.find_element(
        By.CSS_SELECTOR, "[role='listbox'][aria-label='Citations']"))
    options = citations.find_elements(By.CSS_SELECTOR, "[role='option']")
    labels = [option.text for option in options]
    assert all(any(citation in label for label in labels) for citation in REAL_CITATIONS), labels
    next(option for option in options if REAL_CITATIONS[0] in option.text).click()
    surface = wait(driver).until(lambda item: item.find_element(
        By.CSS_SELECTOR, "[role='textbox'][aria-label$='citation context']"))
    assert surface.get_attribute("aria-label") in {"In-text citation context", "Footnote context"}
    kind_labels = [span.text for span in driver.find_elements(By.TAG_NAME, "span")
                   if span.text.startswith(("In-text citation ", "Footnote "))]
    assert kind_labels, driver.find_element(By.TAG_NAME, "body").text
    select_text(driver, surface, REAL_CITATIONS[0])
    correction = driver.find_element(By.XPATH, "//button[normalize-space(.)='Use selection as authority']")
    wait(driver, 5).until(lambda _item: correction.is_enabled())
    correction.click()
    idle(driver)
    choose(driver, "Create", "Book and Table")
    driver.find_element(By.XPATH, "//summary[normalize-space(.)='Options']").click()
    choose(driver, "Missing sources", "Leave out of book"); idle(driver)
    choose(driver, "Missing sources", "Add labelled pages"); idle(driver)
    build(driver)
    built_sources = driver.execute_script(
        "return window.__authoritiesSmoke.lastBuild||window.__authoritiesSmoke.lastPrepared")
    assert built_sources["settings"]["sourceMode"] == "automatic", built_sources
    assert built_sources["settings"]["missingSourcePolicy"] == "placeholder", built_sources
    assert "attached" in built_sources["sources"], built_sources
    assert any(origin in ("original", "reconstructed")
               for origin in built_sources["sourceOrigins"]), built_sources
    files = downloads(driver, output / "automatic")
    table_file = next(path for path in files if path.suffix.lower() == ".docx")
    book_file = next(path for path in files if path.suffix.lower() == ".pdf")
    assert driver.save_screenshot(str(output / "automatic-desktop.png"))
    book = inspect_book(book_file, output / "automatic-first-page.png")
    with fitz.open(book_file) as built:
        marked = next(page for page in built if "[29]" in page.get_text())
        target = marked.search_for("[29]")[0]
        bars = [drawing["rect"] for drawing in marked.get_drawings()
                if 2 < drawing["rect"].height < 100]
        assert any(bar.y0 <= target.y1 and bar.y1 >= target.y0 for bar in bars), \
            "The cited paragraph did not receive a bounded margin mark."
    return {"labels": kind_labels, "citations": labels, "table": inspect_table(table_file),
            "placeholderBook": book, "markedParagraph": 29,
            "sourceOrigins": built_sources["sourceOrigins"]}


def build(driver: webdriver.Chrome) -> None:
    control = driver.find_element(By.XPATH, "//button[normalize-space(.)='Build']")
    wait(driver, 30).until(lambda _item: control.is_enabled())
    completed = driver.execute_script("return window.__authoritiesSmoke.builds")
    failures = len(driver.execute_script("return window.__authoritiesSmoke.errors"))
    control.click()
    wait(driver, 120).until(lambda _item: driver.execute_script(
        "return window.__authoritiesSmoke.builds") > completed)
    idle(driver)
    errors = driver.execute_script("return window.__authoritiesSmoke.errors")
    assert len(errors) == failures, {"errors": errors[failures:],
        "request": driver.execute_script("return window.__authoritiesSmoke.lastBuild")}
    assert driver.find_elements(By.CSS_SELECTOR, "button[aria-label^='Download ']"), [
        [status.text for status in driver.find_elements(By.CSS_SELECTOR, "[role='status']") if status.text],
        driver.execute_script("return window.__authoritiesSmoke.errors")]


def downloads(driver: webdriver.Chrome, directory: Path) -> list[Path]:
    directory.mkdir(parents=True, exist_ok=True)
    driver.execute_cdp_cmd("Page.setDownloadBehavior",
                           {"behavior": "allow", "downloadPath": str(directory.resolve())})
    result = []
    for control in driver.find_elements(By.CSS_SELECTOR, "button[aria-label^='Download ']"):
        filename = control.get_attribute("aria-label").removeprefix("Download ")
        target = directory / filename
        control.click()
        wait(driver, 60).until(lambda _item: target.is_file() and target.stat().st_size > 0
            and not list(directory.glob("*.crdownload")))
        result.append(target)
    assert result, "No built files were offered for download."
    return result


def manual_book(driver: webdriver.Chrome, pdfs: list[Path], parts: dict[str, Path],
                output: Path) -> dict[str, object]:
    tab(driver, "Manual").click()
    title = driver.find_element(By.XPATH, "//label[starts-with(normalize-space(.), 'Book title')]/input")
    title.clear()
    title.send_keys("Authorities Smoke Book")
    upload(driver, "Add PDFs", pdfs[:2])
    wait(driver, 120).until(lambda item: len(item.find_elements(By.TAG_NAME, "article")) == 2)
    draft_id = parse_qs(urlparse(driver.current_url).query)["draft"][0]
    rows = driver.find_elements(By.TAG_NAME, "article")
    for index, value in enumerate(("A", "B")):
        field = driver.find_elements(By.CSS_SELECTOR, "input[aria-label^='Tab for ']")[index]
        replace_input(field, value)
        idle(driver)
    tabs = [field.get_attribute("value") for field in driver.find_elements(
        By.CSS_SELECTOR, "input[aria-label^='Tab for '")]
    assert tabs == ["A", "B"], tabs
    first_title, second_title = (row.find_element(By.TAG_NAME, "h3").text for row in rows)
    handle = rows[0].find_element(By.CSS_SELECTOR, "button[aria-keyshortcuts]")
    handle.click()
    ActionChains(driver).key_down(Keys.ALT).send_keys(Keys.ARROW_DOWN).key_up(Keys.ALT).perform()
    wait(driver).until(lambda item: item.find_elements(By.TAG_NAME, "article")[0]
                       .find_element(By.TAG_NAME, "h3").text == second_title)
    assert driver.find_elements(By.TAG_NAME, "article")[1].find_element(By.TAG_NAME, "h3").text == first_title

    assert all("Generated" in book_part(driver, name).text for name in ("Cover", "Index"))
    upload(driver, "Add file", [parts["cover"]], book_part(driver, "Cover")); idle(driver)
    wait(driver).until(lambda _item: parts["cover"].name in book_part(driver, "Cover").text)
    upload(driver, "Add file", [parts["index"]], book_part(driver, "Index")); idle(driver)
    wait(driver).until(lambda _item: parts["index"].name in book_part(driver, "Index").text)
    upload(driver, "Add files", [parts["alpha"], parts["beta"]], book_contents(driver))
    wait(driver, 120).until(lambda _item: len(supplement_rows(driver)) == 2); idle(driver)
    edit_supplement(driver, "supplement-alpha", "Appendix Alpha", "S1")
    edit_supplement(driver, "supplement-beta", "Appendix Beta", "S2")
    assert [supplement_title(row) for row in supplement_rows(driver)] == ["Appendix Alpha", "Appendix Beta"]
    move = supplement_rows(driver)[0].find_element(By.CSS_SELECTOR, "button[aria-label^='Move ']")
    move.click()
    ActionChains(driver).key_down(Keys.ALT).send_keys(Keys.ARROW_DOWN).key_up(Keys.ALT).perform()
    wait(driver).until(lambda _item: [supplement_title(row) for row in supplement_rows(driver)] ==
                       ["Appendix Beta", "Appendix Alpha"])
    idle(driver)

    click_button(driver, "Add authority without a PDF")
    dialog = wait(driver, 5).until(lambda item: item.find_element(By.CSS_SELECTOR, "dialog[open]"))
    choose(driver, "Type", "Case", dialog)
    citation = dialog.find_element(By.XPATH,
        ".//label[starts-with(normalize-space(.), 'Citation')]/input")
    citation.send_keys("R v Jordan, 2016 SCC 27")
    click_button(driver, "Add", dialog)
    wait(driver, 120).until(lambda item: len(item.find_elements(By.TAG_NAME, "article")) == 3)
    jordan = next(row for row in driver.find_elements(By.TAG_NAME, "article")
                  if "2016 SCC 27" in row.text)
    handoffs = jordan.find_elements(By.LINK_TEXT, "Download from CanLII")
    assert len(handoffs) == 1 and urlparse(handoffs[0].get_attribute("href")).hostname == "www.canlii.org"
    assert handoffs[0].get_attribute("href").endswith(".pdf")
    handoff = handoffs[0].get_attribute("href")
    assert jordan.find_element(By.XPATH,
        ".//*[self::button or self::label][normalize-space(.)='Add PDF']").is_displayed()
    click_button(driver, "Connect downloads folder")
    wait(driver, 5).until(lambda item: item.find_element(By.XPATH,
        "//button[normalize-space(.)='Change downloads folder']").get_attribute("aria-pressed") == "true")
    expected = Path(urlparse(handoff).path).name
    driver.execute_script("window.__authoritiesSmoke.fakeCanlii=arguments[0]", {
        "name": expected, "base64": base64.b64encode(pdfs[2].read_bytes()).decode("ascii")})
    page_url, handles = driver.current_url, len(driver.window_handles)
    jordan = next(row for row in driver.find_elements(By.TAG_NAME, "article")
                  if "2016 SCC 27" in row.text)
    jordan.find_element(By.LINK_TEXT, "Download from CanLII").click()
    wait(driver, 120).until(lambda _item: any(expected in row.text for row in
        driver.find_elements(By.TAG_NAME, "article") if "2016 SCC 27" in row.text))
    idle(driver)
    assert driver.current_url == page_url and len(driver.window_handles) == handles
    assert driver.execute_script("return window.__authoritiesSmoke.canliiClicks") == [handoff]
    assert not driver.find_elements(By.CSS_SELECTOR, "a[href*='canlii.org']")

    build(driver)
    first = next(path for path in downloads(driver, output / "manual-first")
                 if path.suffix.lower() == ".pdf")
    custom_text = ("Custom Filing Cover", "Custom Filing Index", "Supplement Alpha", "Supplement Beta")
    first_proof = inspect_book(first, output / "manual-first-page.png",
        required_text=custom_text, required_outline=("Authorities Smoke Book", "Table of Contents"),
        minimum_links=0)
    tab(driver, "Automatic").click()
    tab(driver, "Drafts").click()
    saved = wait(driver).until(lambda item: [button for button in item.find_elements(By.TAG_NAME, "button")
        if "Authorities Smoke Book" in button.text])
    saved[0].click()
    wait(driver).until(lambda item: parse_qs(urlparse(item.current_url).query).get("draft") == [draft_id])

    row = driver.find_elements(By.TAG_NAME, "article")[0]
    row.find_element(By.CSS_SELECTOR, "button[aria-haspopup='menu']").click()
    wait(driver, 5).until(lambda item: item.find_element(By.XPATH,
        "//*[@role='menuitem' and normalize-space(.)='Edit title']")).click()
    name = row.find_element(By.CSS_SELECTOR, "input[aria-label='Authority title']")
    name.clear()
    name.send_keys("Revised authority title")
    click_button(driver, "Save", row)
    wait(driver).until(lambda _item: "Revised authority title" in row.text)
    idle(driver)
    build(driver)
    rebuilt = next(path for path in downloads(driver, output / "manual-rebuilt")
                   if path.suffix.lower() == ".pdf")
    rebuilt_proof = inspect_book(rebuilt, output / "manual-rebuilt-page.png",
        required_text=custom_text, required_outline=("Authorities Smoke Book", "Table of Contents"),
        minimum_links=0)
    assert digest(first) != digest(rebuilt)
    assert "Revised authority title" in "\n".join(rebuilt_proof["outline"])
    responsive = book_viewport_proof(driver, output, parts)
    assert driver.save_screenshot(str(output / "manual-desktop.png"))
    return {"draft": draft_id, "handoff": handoff,
            "canliiCapture": {"filename": expected, "clicks": 1, "requests": 0},
            "first": first_proof, "rebuilt": rebuilt_proof, "contents": responsive}


def inspect_table(path: Path) -> dict[str, object]:
    with zipfile.ZipFile(path) as package:
        assert package.testzip() is None
        assert {"[Content_Types].xml", "word/document.xml"}.issubset(package.namelist())
    document = Document(path)
    text = "\n".join([paragraph.text for paragraph in document.paragraphs] +
        [cell.text for table in document.tables for row in table.rows for cell in row.cells])
    assert document.tables and "Table of Authorities" in text
    assert all(citation in text for citation in REAL_CITATIONS), text
    return {"file": path.name, "sha256": digest(path), "tables": len(document.tables)}


def link_page(link: dict[str, object]) -> int:
    try:
        return int(link.get("page", -1))
    except (TypeError, ValueError):
        return -1


def inspect_book(path: Path, preview: Path, *,
                 required_text: tuple[str, ...] = ("Book of Authorities", "Table of Contents"),
                 required_outline: tuple[str, ...] = ("Book of Authorities", "Table of Contents"),
                 minimum_links: int = 3) -> dict[str, object]:
    pdf = fitz.open(path)
    try:
        text = "\n".join(page.get_text() for page in pdf)
        toc = pdf.get_toc()
        outline = [item[1] for item in toc]
        links = [link for page in pdf for link in page.get_links() if link_page(link) >= 0]
        assert pdf.is_pdf and not pdf.is_encrypted and pdf.page_count >= 5
        assert all(value in text for value in required_text), text
        assert len(links) >= minimum_links and set(required_outline).issubset(set(outline))
        pdf[0].get_pixmap(matrix=fitz.Matrix(1.2, 1.2), alpha=False).save(preview)
        return {"file": path.name, "sha256": digest(path), "pages": pdf.page_count,
                "bookmarks": len(toc), "outline": outline, "links": len(links),
                "textCharacters": len(text),
                "textSha256": hashlib.sha256(text.encode("utf-8")).hexdigest()}
    finally:
        pdf.close()


def book_viewport_proof(driver: webdriver.Chrome, output: Path,
                        parts: dict[str, Path]) -> dict[str, object]:
    proof = {}
    for name, width, height, scale in (("desktop", 1440, 1000, 1), ("320", 320, 900, 1),
                                        ("320-200-percent", 320, 900, 2)):
        driver.execute_cdp_cmd("Emulation.setDeviceMetricsOverride", {
            "width": width, "height": height, "deviceScaleFactor": scale, "mobile": False})
        contents = book_contents(driver)
        driver.execute_script("arguments[0].scrollIntoView({block:'start'})", contents)
        assert parts["cover"].name in book_part(driver, "Cover").text
        assert parts["index"].name in book_part(driver, "Index").text
        assert ([supplement_title(row) for row in supplement_rows(driver)] ==
                ["Appendix Beta", "Appendix Alpha"])
        assert all(row.find_element(By.CSS_SELECTOR, "button[aria-label^='Move ']").is_displayed()
                   for row in supplement_rows(driver))
        if scale == 2:
            edit_supplement(driver, "Appendix Alpha", "Appendix Alpha Narrow", "S1")
            edit_supplement(driver, "Appendix Alpha Narrow", "Appendix Alpha", "S1")
            for _index in range(2):
                handle = supplement_rows(driver)[0].find_element(By.CSS_SELECTOR,
                    "button[aria-label^='Move ']")
                handle.click()
                ActionChains(driver).key_down(Keys.ALT).send_keys(Keys.ARROW_DOWN).key_up(Keys.ALT).perform()
                idle(driver)
            assert ([supplement_title(row) for row in supplement_rows(driver)] ==
                    ["Appendix Beta", "Appendix Alpha"])
        metrics = driver.execute_script("""
const root=arguments[0],box=root.getBoundingClientRect();
return {width:innerWidth,scale:devicePixelRatio,physicalWidth:innerWidth*devicePixelRatio,
  overflow:document.documentElement.scrollWidth-innerWidth,left:box.left,right:box.right};
""", book_contents(driver))
        assert metrics["width"] == width and metrics["scale"] == scale, metrics
        assert metrics["physicalWidth"] == width * scale and metrics["overflow"] <= 1, metrics
        assert metrics["left"] >= -1 and metrics["right"] <= width + 1, metrics
        assert driver.save_screenshot(str(output / f"manual-contents-{name}.png"))
        proof[name] = metrics
    driver.execute_cdp_cmd("Emulation.clearDeviceMetricsOverride", {})
    driver.set_window_size(1440, 1000)
    return proof


def keyboard_tabs(driver: webdriver.Chrome) -> None:
    automatic = tab(driver, "Automatic")
    automatic.click()
    automatic.send_keys(Keys.ARROW_RIGHT)
    wait(driver, 5).until(lambda _item: tab(driver, "Manual").get_attribute("aria-selected") == "true")
    driver.switch_to.active_element.send_keys(Keys.ARROW_LEFT)
    wait(driver, 5).until(lambda _item: automatic.get_attribute("aria-selected") == "true")


def visit_tabs(driver: webdriver.Chrome) -> list[str]:
    names = ["Automatic", "Manual", "Drafts", "Settings"]
    for name in names:
        control = tab(driver, name)
        control.click()
        panel = control.get_attribute("aria-controls")
        wait(driver, 5).until(lambda item, control=control, panel=panel:
            control.get_attribute("aria-selected") == "true" and
            item.find_element(By.ID, panel).is_displayed())
    tab(driver, "Automatic").click()
    wait(driver, 5).until(lambda _item:
        tab(driver, "Automatic").get_attribute("aria-selected") == "true")
    return names


def viewport_proof(driver: webdriver.Chrome, output: Path) -> dict[str, object]:
    proof = {}
    for name, width, height, scale in (("desktop", 1440, 1000, 1), ("320", 320, 800, 1),
                                        ("200-percent", 320, 800, 2)):
        driver.execute_script("window.__authoritiesSmoke.cls=0;window.__authoritiesSmoke.shifts=[]")
        driver.execute_cdp_cmd("Emulation.setDeviceMetricsOverride", {
            "width": width, "height": height, "deviceScaleFactor": scale, "mobile": False})
        driver.execute_script("scrollTo(0,0)")
        visited = visit_tabs(driver)
        metrics = driver.execute_script("""
const s=window.__authoritiesSmoke||{};
return {width:innerWidth,visualWidth:visualViewport?.width||innerWidth,
  deviceScale:devicePixelRatio,physicalWidth:innerWidth*devicePixelRatio,
  overflow:document.documentElement.scrollWidth-innerWidth,
  cls:s.cls||0,longTasks:(s.longTasks||[]).length,
  selectedTabs:document.querySelectorAll('[aria-label="Authorities sections"] [role=tab][aria-selected=true]').length,
  unnamed:[...document.querySelectorAll('button,a[href],input,select,[role=textbox]')]
    .filter(n=>n.getClientRects().length && !(n.getAttribute('aria-label')||n.labels?.length||n.textContent.trim()))
    .map(n=>n.outerHTML.slice(0,120))};
""")
        metrics["visitedTabs"] = visited
        assert abs(metrics["width"] - width) <= 1 and abs(metrics["visualWidth"] - width) <= 1, metrics
        assert metrics["deviceScale"] == scale and metrics["physicalWidth"] == width * scale, metrics
        assert metrics["overflow"] <= 1 and metrics["cls"] <= 0.1, metrics
        assert metrics["selectedTabs"] == 1 and visited == ["Automatic", "Manual", "Drafts", "Settings"], metrics
        assert not metrics["unnamed"], metrics
        assert driver.save_screenshot(str(output / f"authorities-{name}.png"))
        proof[name] = metrics
    driver.execute_cdp_cmd("Emulation.clearDeviceMetricsOverride", {})
    driver.set_window_size(1440, 1000)
    return proof


def network_urls(driver: webdriver.Chrome) -> list[str]:
    result = []
    for record in driver.get_log("performance"):
        try:
            message = json.loads(record["message"])["message"]
            if message["method"] == "Network.requestWillBeSent":
                result.append(message["params"]["request"]["url"])
        except (KeyError, TypeError, json.JSONDecodeError):
            pass
    return result


def main() -> int:
    parser = argparse.ArgumentParser(description="Live Chrome smoke for the shared Authorities workspace.")
    parser.add_argument("--url", default="http://127.0.0.1:3000/table-of-authorities")
    parser.add_argument("--artifacts", type=Path)
    parser.add_argument("--headed", action="store_true")
    parser.add_argument("--fixtures-only", action="store_true",
                        help="Validate the local DOCX/PDF fixtures without launching Chrome.")
    args = parser.parse_args()
    standalone = urlparse(args.url).path.rstrip("/").endswith("authorities.html")
    mode = "standalone" if standalone else "beaver"
    with tempfile.TemporaryDirectory(prefix=f"authorities-{mode}-") as temporary:
        temporary_path = Path(temporary)
        output = (args.artifacts.resolve() if args.artifacts else temporary_path / "proof") / mode
        output.mkdir(parents=True, exist_ok=True)
        fixture_dir = output / "inputs" if args.artifacts else temporary_path / "fixtures"
        fixture_dir.mkdir(parents=True)
        source, pdfs, parts = fixtures(fixture_dir)
        if args.fixtures_only:
            print(json.dumps(fixture_proof(source, pdfs, parts), indent=2))
            return 0
        driver = chrome(temporary_path / "chrome", args.headed)
        driver.set_window_size(1440, 1000)
        started = time.monotonic()
        try:
            driver.get(args.url)
            wait(driver, 30).until(lambda item: item.find_elements(By.XPATH,
                "//h1[normalize-space(.)='Authorities']"))
            navigation = driver.execute_script("""
const n=performance.getEntriesByType('navigation')[0]; return n&&{
 duration:n.duration,responseStart:n.responseStart,domContentLoaded:n.domContentLoadedEventEnd,
 load:n.loadEventEnd,transferSize:n.transferSize};
""")
            assert navigation and navigation["duration"] > 0
            cold_layout_shift = driver.execute_script("return window.__authoritiesSmoke.cls||0")
            assert cold_layout_shift <= 0.1, cold_layout_shift
            keyboard_tabs(driver)
            automatic = automatic_review(driver, source, output)
            manual = manual_book(driver, pdfs, parts, output)
            viewports = viewport_proof(driver, output)
            urls = network_urls(driver)
            canlii_requests = [url for url in urls
                if (urlparse(url).hostname or "").lower().endswith("canlii.org")]
            assert not canlii_requests, canlii_requests
            severe = [entry for entry in driver.get_log("browser") if entry.get("level") == "SEVERE"
                      and "favicon.ico" not in entry.get("message", "")]
            assert not severe, severe
            result = {"schema_version": "beaver.authorities-browser-smoke.v2",
                "created_at": datetime.now(timezone.utc).isoformat(), "mode": mode,
                "url": args.url, "cold_navigation": navigation, "cold_layout_shift": cold_layout_shift,
                "automatic": automatic,
                "manual": manual, "viewports": viewports, "canlii_requests": 0,
                "browser_severe": [], "elapsed_seconds": round(time.monotonic() - started, 3)}
            (output / "result.json").write_text(json.dumps(result, indent=2), encoding="utf-8")
            print(json.dumps(result, indent=2))
            return 0
        finally:
            driver.quit()


if __name__ == "__main__":
    raise SystemExit(main())
