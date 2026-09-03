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
from xml.sax.saxutils import escape

import fitz
from docx import Document
from selenium import webdriver
from selenium.webdriver import ActionChains
from selenium.webdriver.chrome.service import Service
from selenium.webdriver.common.by import By
from selenium.webdriver.common.keys import Keys
from selenium.common.exceptions import StaleElementReferenceException
from selenium.webdriver.support.ui import Select
from selenium.webdriver.support.wait import WebDriverWait


OAKES = "R v Oakes, [1986] 1 SCR 103, 1986 CanLII 46 (SCC)"
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


def add_footnote(path: Path, text: str) -> None:
    with zipfile.ZipFile(path) as source:
        files = {name: source.read(name) for name in source.namelist()}
    document = files["word/document.xml"].decode()
    assert "[[FOOTNOTE]]" in document
    files["word/document.xml"] = document.replace(
        "<w:t>[[FOOTNOTE]]</w:t>", '<w:footnoteReference w:id="2"/>').encode()
    types = files["[Content_Types].xml"].decode()
    files["[Content_Types].xml"] = types.replace("</Types>",
        '<Override PartName="/word/footnotes.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.footnotes+xml"/></Types>').encode()
    rels = files["word/_rels/document.xml.rels"].decode()
    files["word/_rels/document.xml.rels"] = rels.replace("</Relationships>",
        '<Relationship Id="rIdAuthoritiesFootnote" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/footnotes" Target="footnotes.xml"/></Relationships>').encode()
    files["word/footnotes.xml"] = (f'<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        f'<w:footnotes xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">'
        f'<w:footnote w:type="separator" w:id="-1"><w:p><w:r><w:separator/></w:r></w:p></w:footnote>'
        f'<w:footnote w:type="continuationSeparator" w:id="0"><w:p><w:r><w:continuationSeparator/></w:r></w:p></w:footnote>'
        f'<w:footnote w:id="2"><w:p><w:r><w:footnoteRef/></w:r><w:r><w:t xml:space="preserve">{escape(text)}</w:t></w:r></w:p></w:footnote>'
        f'</w:footnotes>').encode()
    patched = path.with_name(f"{path.stem}-patched.docx")
    with zipfile.ZipFile(patched, "w", zipfile.ZIP_DEFLATED) as target:
        for name, content in files.items():
            target.writestr(name, content)
    patched.replace(path)


def fixtures(directory: Path) -> tuple[Path, list[Path], dict[str, Path]]:
    source = directory / "real-authorities-smoke.docx"
    document = Document()
    document.add_heading("Written argument", level=1)
    document.add_paragraph("The governing framework is stated in R v Grant, 2009 SCC 32 at para 29.")
    document.add_paragraph(f"😀 The proportionality analysis originates in {OAKES}.")
    document.add_paragraph("😀 Background context. " + "The record supplies additional context. " * 45 +
        "Delay is addressed in R v Jordan, 2016 SCC 27 at para 47. " +
        "The conclusion follows from the cited framework. " * 45)
    document.add_paragraph("[[FOOTNOTE]]")
    document.save(source)
    add_footnote(source, f"See R v Grant, 2009 SCC 32; {OAKES}; Ibid at para 31; and R v Jordan, 2016 SCC 27.")
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
            ("filing", "appeal-factum.pdf", "Appeal Factum",
             f"R v Grant, 2009 SCC 32\n\n{OAKES}\n\nR v Jordan, 2016 SCC 27"),
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
  errors:[],builds:0,buildStarts:0,gateBuild:false,releaseBuild:null,lastBuild:null,lastPrepared:null};
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
  const isBuild=target.includes('/authorities-runtime/build')||/\/authorities\/[^/]+\/build$/.test(target);
  if (isBuild) {
    window.__authoritiesSmoke.buildStarts++;
    if (window.__authoritiesSmoke.gateBuild) await new Promise(resolve=>{
      window.__authoritiesSmoke.releaseBuild=()=>{window.__authoritiesSmoke.gateBuild=false;resolve();};
    });
  }
  if (target.includes('/authorities-runtime/build') && body instanceof FormData) {
    const draft=JSON.parse(body.get('draft'));
    window.__authoritiesSmoke.lastBuild={importKind:draft.import.kind,outputMode:draft.outputMode,
      insertIntoDocument:draft.insertIntoDocument,settings:draft.settings,
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
    with zipfile.ZipFile(source) as package:
        notes = package.read("word/footnotes.xml").decode()
        assert "Ibid at para 31" in notes and OAKES in notes and package.testzip() is None
    files = [*pdfs, *parts.values()]
    for path in files:
        with fitz.open(path) as pdf:
            assert pdf.is_pdf and not pdf.is_encrypted and pdf.page_count == 1 and pdf[0].get_text().strip()
    return {"source": {"file": source.name, "sha256": digest(source)},
            "pdfs": [{"file": path.name, "sha256": digest(path)} for path in files]}


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


def citation_options(driver: webdriver.Chrome):
    return driver.find_elements(By.CSS_SELECTOR, "[role='listbox'][aria-label='Citations'] [role='option']")


def occurrence(driver: webdriver.Chrome, needle: str, location: str = ""):
    matches = [item for item in citation_options(driver)
               if needle.lower() in item.text.lower() and (not location or location in item.text)]
    assert matches, {"needle": needle, "locations": [item.text for item in citation_options(driver)]}
    return matches[0]


def review_surface(driver: webdriver.Chrome):
    return driver.find_element(By.CSS_SELECTOR,
        "[role='textbox'][aria-label='In-text citation context'],[role='textbox'][aria-label='Footnote context']")


def selection_offsets(driver: webdriver.Chrome, surface) -> dict[str, object] | None:
    return driver.execute_script(r"""
const root=arguments[0],selection=getSelection(); if(!selection?.rangeCount)return null;
const range=selection.getRangeAt(0); if(!root.contains(range.startContainer)||!root.contains(range.endContainer))return null;
const before=document.createRange();before.selectNodeContents(root);before.setEnd(range.startContainer,range.startOffset);
const through=document.createRange();through.selectNodeContents(root);through.setEnd(range.endContainer,range.endOffset);
return {start:before.toString().length,end:through.toString().length,text:range.toString(),collapsed:range.collapsed};
""", surface)


def pointer_select_text(driver: webdriver.Chrome, surface, needle: str,
                        backward: bool = False) -> dict[str, object]:
    driver.execute_script("arguments[0].scrollIntoView({block:'center',inline:'nearest'})", surface)
    geometry = driver.execute_script(r"""
const root=arguments[0],needle=arguments[1],walker=document.createTreeWalker(root,NodeFilter.SHOW_TEXT);
let nodes=[],text='',node;while(node=walker.nextNode()){nodes.push([node,text.length]);text+=node.data;}
const start=text.indexOf(needle),end=start+needle.length;if(start<0)return null;
const point=(index,right)=>{const hit=nodes.findLast(([,offset])=>offset<=index),local=index-hit[1],r=document.createRange();
  r.setStart(hit[0],local);r.setEnd(hit[0],local+1);const box=r.getClientRects()[0];
  return {x:right?box.right-1:box.left+1,y:box.top+box.height/2};};
const hits=[...root.querySelectorAll('mark')].filter(mark=>{const r=document.createRange();
  r.selectNodeContents(root);r.setEndBefore(mark);const s=r.toString().length;
  return s<end&&s+mark.textContent.length>start;}),box=root.getBoundingClientRect(),marked=hits[0]?.getBoundingClientRect();
return {start,end,a:point(start,false),b:point(end-1,true),marks:hits.length,
  visible:box.top>=0&&box.bottom<=innerHeight,
  centerDelta:marked?Math.abs((marked.top+marked.bottom-box.top*2-box.height)/2):null};
""", surface, needle)
    assert geometry and geometry["marks"] > 0 and geometry["visible"], {
        "needle": needle, "text": surface.text, "geometry": geometry}
    assert geometry["centerDelta"] is not None and geometry["centerDelta"] <= 24, geometry
    a, b = geometry["a"], geometry["b"]
    if backward:
        a, b = b, a
    driver.execute_cdp_cmd("Input.dispatchMouseEvent", {"type": "mouseMoved", **a})
    driver.execute_cdp_cmd("Input.dispatchMouseEvent", {"type": "mousePressed", "button": "left",
        "buttons": 1, "clickCount": 1, **a})
    for step in range(1, 13):
        driver.execute_cdp_cmd("Input.dispatchMouseEvent", {"type": "mouseMoved", "button": "left",
            "buttons": 1, "x": a["x"] + (b["x"] - a["x"]) * step / 12,
            "y": a["y"] + (b["y"] - a["y"]) * step / 12})
    driver.execute_cdp_cmd("Input.dispatchMouseEvent", {"type": "mouseReleased", "button": "left",
        "buttons": 0, "clickCount": 1, **b})
    actual = wait(driver, 5).until(lambda _item: selection_offsets(driver, review_surface(driver)))
    assert actual == {"start": geometry["start"], "end": geometry["end"],
                      "text": needle, "collapsed": False}, {"expected": geometry, "actual": actual}
    return {"start": actual["start"], "end": actual["end"],
            "direction": "backward" if backward else "forward", "marksCrossed": geometry["marks"]}


def set_cursor(driver: webdriver.Chrome, surface, needle: str, within: int) -> int:
    cursor = driver.execute_script(r"""
const root=arguments[0],target=arguments[1],within=arguments[2],walker=document.createTreeWalker(root,NodeFilter.SHOW_TEXT);
let nodes=[],text='',node;while(node=walker.nextNode()){nodes.push([node,text.length]);text+=node.data;}
const cursor=text.indexOf(target)+within,hit=nodes.findLast(([,offset])=>offset<=cursor);if(cursor<within||!hit)return -1;
const range=document.createRange();range.setStart(hit[0],cursor-hit[1]);range.collapse(true);
const selection=getSelection();selection.removeAllRanges();selection.addRange(range);
root.dispatchEvent(new KeyboardEvent('keyup',{bubbles:true,key:'ArrowRight'}));return cursor;
""", surface, needle, within)
    assert cursor >= 0
    return cursor


def authority_bounds(driver: webdriver.Chrome, surface, needle: str,
                     kind: str = "authority") -> dict[str, object]:
    result = driver.execute_script(r"""
const root=arguments[0],needle=arguments[1],marks=[...root.querySelectorAll(`[data-${arguments[2]}-span]`)]
  .filter(mark=>mark.textContent===needle);if(marks.length!==1)return {count:marks.length,text:root.textContent};
const before=document.createRange();before.selectNodeContents(root);before.setEndBefore(marks[0]);
return {count:1,start:before.toString().length,end:before.toString().length+marks[0].textContent.length,
  expectedStart:root.textContent.indexOf(needle),text:marks[0].textContent};
""", surface, needle, kind)
    assert result == {"count": 1, "start": result.get("expectedStart"),
        "end": result.get("expectedStart", -1) + len(needle.encode("utf-16-le")) // 2,
        "expectedStart": result.get("expectedStart"), "text": needle}, result
    return result


def header_rect(driver: webdriver.Chrome) -> dict[str, float]:
    return driver.execute_script(r"""
const header=document.querySelector('.authorities-workspace>[data-workspace-header]'),title=header?.querySelector('h1');
const h=header?.getBoundingClientRect(),t=title?.getBoundingClientRect();
return {x:h.x,y:h.y,width:h.width,height:h.height,titleX:t.x,titleY:t.y,titleHeight:t.height};
""")


def workspace_rect(driver: webdriver.Chrome) -> dict[str, object]:
    metrics = driver.execute_script(r"""
const root=document.querySelector('.authorities-workspace'),r=root.getBoundingClientRect(),
  bottom=document.elementFromPoint(r.left+2,innerHeight-2);
return {top:r.top,bottom:r.bottom,height:r.height,viewport:innerHeight,
  rootBackground:getComputedStyle(root).backgroundColor,
  bottomBackground:getComputedStyle(bottom).backgroundColor};
""")
    assert metrics["bottom"] >= metrics["viewport"] - 1, metrics
    assert metrics["rootBackground"] == metrics["bottomBackground"], metrics
    return metrics


def stable_headers(headers: dict[str, dict[str, float]]) -> None:
    values = list(headers.values()); base = values[0]
    for name, item in headers.items():
        for key in ("x", "y", "width", "height", "titleY", "titleHeight"):
            assert abs(item[key] - base[key]) <= 1, {"header": name, "field": key, "all": headers}


def header_cycle(driver: webdriver.Chrome, static: dict[str, float]) -> dict[str, dict[str, float]]:
    headers = {"static": static, "draft": header_rect(driver)}
    for name in ("Drafts", "Settings", "Automatic"):
        tab(driver, name).click()
        wait(driver, 5).until(lambda _item, name=name:
            tab(driver, name).get_attribute("aria-selected") == "true")
        headers[name.lower()] = header_rect(driver)
    stable_headers(headers)
    return headers


def assistant_header(driver: webdriver.Chrome, beaver: bool) -> dict[str, object]:
    controls = driver.find_elements(By.CSS_SELECTOR,
        ".authorities-workspace>[data-workspace-header] button[aria-label='Assistant']")
    if not beaver:
        assert not controls
        return {"available": False}
    assert len(controls) == 1
    before = header_rect(driver); controls[0].click()
    def dock_is_visible(item: webdriver.Chrome) -> bool:
        try:
            return item.find_element(
                By.CSS_SELECTOR, "aside[aria-label='Assistant dock']").is_displayed()
        except StaleElementReferenceException:
            return False
    wait(driver, 10).until(dock_is_visible)
    opened = header_rect(driver)
    for key in ("height", "titleY", "titleHeight"):
        assert abs(opened[key] - before[key]) <= 1, {"before": before, "opened": opened}
    collapse = driver.find_element(By.CSS_SELECTOR,
        "button[aria-label='Collapse assistant dock'],button[aria-label='Close assistant']")
    collapse.click()
    return {"available": True, "before": before, "opened": opened,
            "collapsedOnlyByUser": True}


def correct_parallel_citation(driver: webdriver.Chrome) -> dict[str, object]:
    before = len(citation_options(driver))
    occurrence(driver, "1986 CanLII 46").click()
    surface = review_surface(driver)
    selected = pointer_select_text(driver, surface, OAKES, backward=True)
    control = driver.find_element(By.XPATH, "//button[normalize-space(.)='Use selection as citation']")
    wait(driver, 5).until(lambda _item: control.is_enabled()); control.click(); idle(driver)
    wait(driver, 30).until(lambda _item: len(citation_options(driver)) == before - 1)
    surface = review_surface(driver)
    bounds = wait(driver, 5).until(lambda _item: authority_bounds(driver, surface, OAKES))
    surrogate_delta = bounds["start"] - surface.text.index(OAKES)
    assert surrogate_delta == 1, {"bounds": bounds, "text": surface.text}
    actions = driver.find_elements(By.XPATH,
        "//button[normalize-space(.)='Use selection as citation' or normalize-space(.)='Use selection as pinpoint']")
    assert len(actions) == 2 and all(not item.is_enabled() for item in actions), [item.is_enabled() for item in actions]
    draft_url = driver.current_url
    driver.refresh()
    wait(driver, 120).until(lambda item: item.find_elements(
        By.CSS_SELECTOR, "[role='listbox'][aria-label='Citations']"))
    occurrence(driver, "1986 CanLII 46", "In-text").click()
    persisted = authority_bounds(driver, review_surface(driver), OAKES)
    assert parse_qs(urlparse(driver.current_url).query).get("draft") == \
        parse_qs(urlparse(draft_url).query).get("draft")
    return {"pointer": selected, "utf16SurrogateDelta": surrogate_delta,
            "occurrencesBefore": before, "occurrencesAfter": before - 1,
            "stored": bounds, "persistedAfterReload": persisted, "actionsReset": True}


def correct_pinpoint(driver: webdriver.Chrome) -> dict[str, object]:
    occurrence(driver, "2009 SCC 32", "In-text").click()
    surface = review_surface(driver)
    selected = pointer_select_text(driver, surface, "para 29")
    control = driver.find_element(By.XPATH, "//button[normalize-space(.)='Use selection as pinpoint']")
    wait(driver, 5).until(lambda _item: control.is_enabled()); control.click(); idle(driver)
    stored = authority_bounds(driver, review_surface(driver), "para 29", "pinpoint")
    assert all(not button.is_enabled() for button in driver.find_elements(By.XPATH,
        "//button[normalize-space(.)='Use selection as citation' or normalize-space(.)='Use selection as pinpoint']"))
    driver.refresh()
    wait(driver, 120).until(lambda item: item.find_elements(
        By.CSS_SELECTOR, "[role='listbox'][aria-label='Citations']"))
    occurrence(driver, "2009 SCC 32", "In-text").click()
    persisted = authority_bounds(driver, review_surface(driver), "para 29", "pinpoint")
    return {"pointer": selected, "stored": stored, "persistedAfterReload": persisted,
            "actionsReset": True}


def consolidate_parallel(driver: webdriver.Chrome, location: str = "") -> dict[str, object]:
    before = len(citation_options(driver))
    occurrence(driver, "1986 CanLII 46", location).click()
    selected = pointer_select_text(driver, review_surface(driver), OAKES)
    control = driver.find_element(By.XPATH, "//button[normalize-space(.)='Use selection as citation']")
    wait(driver, 5).until(lambda _item: control.is_enabled()); control.click(); idle(driver)
    wait(driver, 30).until(lambda _item: len(citation_options(driver)) == before - 1)
    bounds = authority_bounds(driver, review_surface(driver), OAKES)
    return {"pointer": selected, "occurrencesBefore": before,
            "occurrencesAfter": before - 1, "stored": bounds}


def citation_keyboard_navigation(driver: webdriver.Chrome) -> dict[str, object]:
    items = citation_options(driver); outer = driver.execute_script("return scrollY")
    items[0].click(); driver.find_element(By.CSS_SELECTOR,
        "[role='listbox'][aria-label='Citations'] [role='option'][aria-selected='true']").send_keys(Keys.END)
    last = wait(driver, 5).until(lambda item: item.switch_to.active_element
        if item.switch_to.active_element == citation_options(item)[-1] else False)
    visible = driver.execute_script(r"""
const item=arguments[0],list=item.parentElement,a=item.getBoundingClientRect(),b=list.getBoundingClientRect();
return a.top>=b.top-1&&a.bottom<=b.bottom+1;
""", last)
    assert visible and last.get_attribute("aria-selected") == "true"
    last.send_keys(Keys.HOME)
    wait(driver, 5).until(lambda item: item.switch_to.active_element == citation_options(item)[0])
    assert driver.execute_script("return scrollY") == outer
    return {"items": len(items), "endVisible": True, "homeAndEnd": True,
            "outerScrollStable": True}


def split_merge_later_occurrence(driver: webdriver.Chrome) -> dict[str, object]:
    target = occurrence(driver, "2016 SCC 27", "Footnote")
    target.click(); options_before = citation_options(driver)
    selected_before = options_before.index(driver.find_element(By.CSS_SELECTOR,
        "[role='listbox'][aria-label='Citations'] [role='option'][aria-selected='true']"))
    cursor = set_cursor(driver, review_surface(driver), "2016 SCC 27", 5)
    split = driver.find_element(By.XPATH, "//button[normalize-space(.)='Split at cursor']")
    wait(driver, 5).until(lambda _item: split.is_enabled()); split.click(); idle(driver)
    wait(driver, 30).until(lambda _item: len(citation_options(driver)) == len(options_before) + 1)
    selected = driver.find_element(By.CSS_SELECTOR,
        "[role='listbox'][aria-label='Citations'] [role='option'][aria-selected='true']")
    split_index = citation_options(driver).index(selected)
    assert split_index == selected_before + 1 and "SCC 27" in selected.text, {
        "before": selected_before, "after": split_index, "selected": selected.text}
    merge = driver.find_element(By.XPATH, "//button[normalize-space(.)='Merge with previous']")
    wait(driver, 5).until(lambda _item: merge.is_enabled()); merge.click(); idle(driver)
    wait(driver, 30).until(lambda _item: len(citation_options(driver)) == len(options_before))
    merged = driver.find_element(By.CSS_SELECTOR,
        "[role='listbox'][aria-label='Citations'] [role='option'][aria-selected='true']")
    merged_index = citation_options(driver).index(merged)
    assert merged_index == selected_before and "2016 SCC 27" in merged.text, {
        "before": selected_before, "after": merged_index, "selected": merged.text}
    return {"cursor": cursor, "index": selected_before, "splitIndex": split_index,
            "mergedIndex": merged_index, "occurrences": len(options_before)}


def reference_keyboard_flow(driver: webdriver.Chrome) -> dict[str, object]:
    source = occurrence(driver, "Ibid", "Footnote"); source.click()
    source_index = citation_options(driver).index(source)
    link = driver.find_element(By.XPATH, "//button[normalize-space(.)='Link to authority']")
    link.click()
    focused = wait(driver, 5).until(lambda item: item.switch_to.active_element
        if item.switch_to.active_element.get_attribute("role") == "option" else False)
    focused.send_keys(Keys.ESCAPE)
    wait(driver, 5).until(lambda item: not item.find_elements(By.XPATH,
        "//*[contains(normalize-space(.), 'Choose the full citation this cross-reference points to.')]") )
    assert driver.switch_to.active_element.get_attribute("aria-selected") == "true"
    driver.find_element(By.XPATH, "//button[normalize-space(.)='Link to authority']").click()
    focused = wait(driver, 5).until(lambda item: item.switch_to.active_element
        if item.switch_to.active_element.get_attribute("role") == "option" else False)
    focused.send_keys(Keys.HOME)
    driver.switch_to.active_element.send_keys(Keys.ENTER)
    wait(driver, 30).until(lambda _item: driver.execute_script("""
return [...document.querySelectorAll('span')].some(node=>node.innerText.startsWith('Linked to '));
"""))
    selected = driver.find_element(By.CSS_SELECTOR,
        "[role='listbox'][aria-label='Citations'] [role='option'][aria-selected='true']")
    assert citation_options(driver).index(selected) == source_index
    assert driver.switch_to.active_element == selected
    click_button(driver, "Clear link"); idle(driver)
    wait(driver, 5).until(lambda _item: driver.execute_script("""
return [...document.querySelectorAll('span')].some(node=>node.innerText==='Not linked');
"""))
    assert driver.find_element(By.XPATH, "//button[normalize-space(.)='Link to authority']").is_displayed()
    return {"sourceIndex": source_index, "escapeRestoredFocus": True,
            "linkedByKeyboard": True, "sourceFocusRestored": True, "cleared": True}


def centering_proof(driver: webdriver.Chrome) -> dict[str, object]:
    outer = driver.execute_script("return scrollY")
    occurrence(driver, "2016 SCC 27", "In-text").click()
    surface = review_surface(driver)
    metrics = wait(driver, 5).until(lambda _item: driver.execute_script(r"""
const root=arguments[0],mark=root.querySelector('[data-authority-span]');if(!mark)return null;
const r=root.getBoundingClientRect(),m=mark.getBoundingClientRect(),line=parseFloat(getComputedStyle(root).lineHeight);
return {scrollTop:root.scrollTop,centerDelta:Math.abs((m.top+m.height/2)-(r.top+r.height/2)),
  lineHeight:line,outerScroll:scrollY,rootTop:r.top,markTop:m.top};
""", surface))
    assert metrics["scrollTop"] > 0 and metrics["centerDelta"] <= metrics["lineHeight"], metrics
    assert metrics["outerScroll"] == outer, {"before": outer, "after": metrics}
    return metrics


def active_review_viewports(driver: webdriver.Chrome, output: Path) -> dict[str, object]:
    proof = {}
    for name, scale in (("320", 1), ("320-200-percent", 2)):
        driver.execute_cdp_cmd("Emulation.setDeviceMetricsOverride", {
            "width": 320, "height": 900, "deviceScaleFactor": scale, "mobile": False})
        occurrence(driver, "2016 SCC 27", "Footnote").click()
        control = driver.find_element(By.XPATH, "//button[normalize-space(.)='Merge with previous']")
        assert control.is_enabled()
        metrics = driver.execute_script(r"""
const control=arguments[0],review=control.closest('.authorities-review'),surface=review.querySelector('[role=textbox]'),
  list=review.querySelector('[role=listbox]');let editor=control;while(editor.parentElement!==review)editor=editor.parentElement;
editor.scrollTop=editor.scrollHeight;const rect=n=>{const r=n.getBoundingClientRect();return {left:r.left,right:r.right,top:r.top,bottom:r.bottom}};
return {width:innerWidth,scale:devicePixelRatio,overflow:document.documentElement.scrollWidth-innerWidth,
  review:rect(review),list:rect(list),surface:rect(surface),action:rect(control),editorScroll:editor.scrollTop,
  selected:document.querySelectorAll('[aria-label="Citations"] [aria-selected=true]').length};
""", control)
        assert metrics["width"] == 320 and metrics["scale"] == scale and metrics["overflow"] <= 1, metrics
        for key in ("review", "list", "surface", "action"):
            assert metrics[key]["left"] >= -1 and metrics[key]["right"] <= 321, metrics
        assert metrics["editorScroll"] > 0 and metrics["selected"] == 1, metrics
        assert driver.save_screenshot(str(output / f"automatic-review-{name}.png"))
        proof[name] = metrics
    driver.execute_cdp_cmd("Emulation.clearDeviceMetricsOverride", {})
    driver.set_window_size(1440, 1000)
    return proof


def automatic_review(driver: webdriver.Chrome, source: Path, pdfs: list[Path], filing: Path,
                     output: Path, static_header: dict[str, float], beaver: bool) -> dict[str, object]:
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
    surface = wait(driver).until(lambda _item: review_surface(driver))
    assert surface.get_attribute("aria-label") in {"In-text citation context", "Footnote context"}
    kind_labels = [span.text for span in driver.find_elements(By.TAG_NAME, "span")
                   if span.text.startswith(("In-text citation ", "Footnote "))]
    assert kind_labels and any(label.startswith("Footnote 1") for label in labels), \
        driver.find_element(By.TAG_NAME, "body").text
    correction = correct_parallel_citation(driver)
    headers = header_cycle(driver, static_header)
    assistant = assistant_header(driver, beaver)
    pinpoint = correct_pinpoint(driver)
    footnote_parallel = consolidate_parallel(driver, "Footnote")
    keyboard = citation_keyboard_navigation(driver)
    split_merge = split_merge_later_occurrence(driver)
    reference = reference_keyboard_flow(driver)
    centering = centering_proof(driver)
    responsive = active_review_viewports(driver, output)
    choose(driver, "Create", "Book and Table")
    driver.find_element(By.XPATH, "//summary[normalize-space(.)='Options']").click()
    choose(driver, "Missing sources", "Leave out of book"); idle(driver)
    choose(driver, "Missing sources", "Add labelled pages"); idle(driver)
    occurrence(driver, "2016 SCC 27", "Footnote").click()
    busy = build(driver, prove_busy=True)
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
    sources = driver.find_element(By.XPATH, "//summary[.//h2[normalize-space(.)='Sources']]/parent::details")
    if not sources.get_attribute("open"):
        sources.find_element(By.TAG_NAME, "summary").click()
    oakes = next(row for row in sources.find_elements(By.TAG_NAME, "article") if "1986 CanLII 46" in row.text)
    upload(driver, "Add PDF", [pdfs[1]], oakes); idle(driver)
    wait(driver, 30).until(lambda _item: any(pdfs[1].name in row.text
        for row in sources.find_elements(By.TAG_NAME, "article") if "1986 CanLII 46" in row.text))
    profiles = profile_builds(driver, filing, output)
    return {"labels": kind_labels, "citations": labels, "table": inspect_table(table_file),
            "placeholderBook": book, "markedParagraph": 29,
            "sourceOrigins": built_sources["sourceOrigins"], "correction": correction,
            "pinpointCorrection": pinpoint, "footnoteParallel": footnote_parallel,
            "citationKeyboard": keyboard, "splitMerge": split_merge,
            "referenceLink": reference, "centering": centering,
            "activeReviewViewports": responsive, "busyBuild": busy, "profiles": profiles,
            "headers": headers, "assistantHeader": assistant,
            "manualPdfFallback": pdfs[1].name}


def build(driver: webdriver.Chrome, prove_busy: bool = False) -> dict[str, object]:
    control = driver.find_element(By.XPATH, "//button[normalize-space(.)='Build']")
    wait(driver, 30).until(lambda _item: control.is_enabled())
    completed = driver.execute_script("return window.__authoritiesSmoke.builds")
    started = driver.execute_script("return window.__authoritiesSmoke.buildStarts")
    failures = len(driver.execute_script("return window.__authoritiesSmoke.errors"))
    if prove_busy:
        merge = driver.find_element(By.XPATH, "//button[normalize-space(.)='Merge with previous']")
        assert merge.is_enabled(), "Busy proof requires an ordinarily enabled mutation."
        driver.execute_script("window.__authoritiesSmoke.gateBuild=true")
    control.click()
    busy = {}
    if prove_busy:
        wait(driver, 120).until(lambda item: item.execute_script(
            "return window.__authoritiesSmoke.releaseBuild!==null"))
        busy = {"starts": driver.execute_script("return window.__authoritiesSmoke.buildStarts") - started,
            "cancelShown": bool(driver.find_elements(By.XPATH, "//button[normalize-space(.)='Cancel']")),
            "settingsDisabled": all(not field.is_enabled() for field in driver.find_elements(
                By.XPATH, "//h2[normalize-space(.)='Build outputs']/following::select")),
            "reviewActionsDisabled": all(not button.is_enabled() for button in driver.find_elements(
                By.XPATH, "//button[normalize-space(.)='Use selection as citation' or normalize-space(.)='Use selection as pinpoint' or normalize-space(.)='Split at cursor' or normalize-space(.)='Merge with previous']"))}
        assert busy == {"starts": 1, "cancelShown": True, "settingsDisabled": True,
                        "reviewActionsDisabled": True}, busy
        driver.execute_script("window.__authoritiesSmoke.releaseBuild();window.__authoritiesSmoke.releaseBuild=null")
    wait(driver, 120).until(lambda _item: driver.execute_script(
        "return window.__authoritiesSmoke.builds") > completed)
    idle(driver)
    errors = driver.execute_script("return window.__authoritiesSmoke.errors")
    assert len(errors) == failures, {"errors": errors[failures:],
        "request": driver.execute_script("return window.__authoritiesSmoke.lastBuild")}
    assert driver.find_elements(By.CSS_SELECTOR, "button[aria-label^='Download ']"), [
        [status.text for status in driver.find_elements(By.CSS_SELECTOR, "[role='status']") if status.text],
        driver.execute_script("return window.__authoritiesSmoke.errors")]
    return busy


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


def inspect_artifacts(paths: list[Path], preview: Path) -> list[dict[str, object]]:
    result = []
    for path in paths:
        if path.suffix.lower() == ".pdf":
            with fitz.open(path) as pdf:
                text = "\n".join(page.get_text() for page in pdf)
                links = sum(len(page.get_links()) for page in pdf)
                toc = pdf.get_toc()
                assert (pdf.is_pdf and not pdf.is_encrypted and pdf.page_count > 0 and
                        len(text) > 100 and links > 0 and toc)
                pdf[0].get_pixmap(matrix=fitz.Matrix(1.2, 1.2), alpha=False).save(
                    preview.with_name(f"{preview.stem}-{path.stem}.png"))
                result.append({"file": path.name, "kind": "pdf", "pages": pdf.page_count,
                    "textCharacters": len(text), "firstPage": pdf[0].get_text().strip()[:500],
                    "links": links, "bookmarks": len(toc), "sha256": digest(path)})
        else:
            with zipfile.ZipFile(path) as package:
                assert package.testzip() is None and "word/document.xml" in package.namelist()
            document = Document(path)
            text = "\n".join([paragraph.text for paragraph in document.paragraphs] +
                [cell.text for table in document.tables for row in table.rows for cell in row.cells])
            assert len(text) > 50 and sum(citation in text for citation in REAL_CITATIONS) >= 2, text
            result.append({"file": path.name, "kind": "docx", "tables": len(document.tables),
                           "textCharacters": len(text), "sha256": digest(path)})
    return result


def profile_builds(driver: webdriver.Chrome, filing: Path, output: Path) -> dict[str, object]:
    proof = {}
    profiles = (
        ("abkb", "Alberta Court of King's Bench", "Book and Table", None, None),
        ("abca", "Alberta Court of Appeal", None, None, None),
        ("fc", "Federal Court", None, "Paper", "Respondent"),
        ("fca", "Federal Court of Appeal", None, "Electronic", "Intervener"),
    )
    for slug, court, create, medium, role in profiles:
        correction = None
        choose(driver, "Court", court); idle(driver)
        if slug == "abca":
            upload(driver, "Replace file", [filing]); idle(driver)
            wait(driver, 120).until(lambda item: filing.name in item.find_element(
                By.XPATH, "//h2[normalize-space(.)='Import and review']/parent::div").text)
            correction = consolidate_parallel(driver)
        if create:
            choose(driver, "Create", create); idle(driver)
        if medium:
            choose(driver, "Filing", medium); choose(driver, "Filed by", role); idle(driver)
        build(driver)
        request = driver.execute_script(
            "return window.__authoritiesSmoke.lastBuild||window.__authoritiesSmoke.lastPrepared")
        assert request["settings"]["profileId"] == {
            "abkb": "ab-court-of-kings-bench", "abca": "ab-court-of-appeal",
            "fc": "federal-court", "fca": "federal-court-of-appeal"}[slug], request
        if medium:
            assert (request["settings"].get("filingMedium"), request["settings"].get("bookRole")) == \
                (medium.lower(), role.lower()), request
        files = downloads(driver, output / "automatic-profiles" / slug)
        assert len(files) == (2 if slug in {"abkb", "abca"} else 1), {
            "profile": slug, "files": [path.name for path in files]}
        kinds = {path.suffix.lower() for path in files}
        assert (slug != "abca" or {".docx", ".pdf"}.issubset(kinds)) and \
            (slug == "abca" or ".pdf" in kinds), {
            "profile": slug, "files": [path.name for path in files]}
        artifacts = inspect_artifacts(files,
            output / "automatic-profiles" / slug / "first-page.png")
        if role:
            assert any(f"Filed by {role}" in str(item.get("firstPage", ""))
                       for item in artifacts), artifacts
        proof[slug] = {"request": request, "artifacts": artifacts,
                       "parallelCorrection": correction}
    return proof


def manual_book(driver: webdriver.Chrome, pdfs: list[Path], parts: dict[str, Path],
                output: Path) -> dict[str, object]:
    tab(driver, "Manual").click()
    title = wait(driver, 5).until(lambda item: item.find_element(
        By.XPATH, "//label[starts-with(normalize-space(.), 'Book title')]/input"))
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
  visibleTabs:[...document.querySelectorAll('[aria-label="Authorities sections"] [role=tab]')]
    .every(n=>{const r=n.getBoundingClientRect();return r.left>=-1&&r.right<=innerWidth+1}),
  unnamed:[...document.querySelectorAll('button,a[href],input,select,[role=textbox]')]
    .filter(n=>n.getClientRects().length && !(n.getAttribute('aria-label')||n.labels?.length||n.textContent.trim()))
    .map(n=>n.outerHTML.slice(0,120))};
""")
        metrics["visitedTabs"] = visited
        assert abs(metrics["width"] - width) <= 1 and abs(metrics["visualWidth"] - width) <= 1, metrics
        assert metrics["deviceScale"] == scale and metrics["physicalWidth"] == width * scale, metrics
        assert metrics["overflow"] <= 1 and metrics["cls"] <= 0.1, metrics
        assert metrics["selectedTabs"] == 1 and metrics["visibleTabs"] and \
            visited == ["Automatic", "Manual", "Drafts", "Settings"], metrics
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
    parser.add_argument("--artifacts", type=Path,
                        default=Path(__file__).resolve().parents[1] / ".tmp-live-qa" / "authorities-browser-proof")
    parser.add_argument("--headed", action="store_true")
    parser.add_argument("--fixtures-only", action="store_true",
                        help="Validate the local DOCX/PDF fixtures without launching Chrome.")
    args = parser.parse_args()
    standalone = urlparse(args.url).path.rstrip("/").endswith("authorities.html")
    mode = "standalone" if standalone else "beaver"
    with tempfile.TemporaryDirectory(prefix=f"authorities-{mode}-") as temporary:
        temporary_path = Path(temporary)
        run = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%S%fZ")
        output = args.artifacts.resolve() / mode / run
        output.mkdir(parents=True, exist_ok=True)
        fixture_dir = output / "inputs"
        fixture_dir.mkdir(parents=True)
        source, pdfs, parts = fixtures(fixture_dir)
        inputs = fixture_proof(source, pdfs, parts)
        if args.fixtures_only:
            print(json.dumps(inputs, indent=2))
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
            static_header = header_rect(driver)
            static_surface = workspace_rect(driver)
            keyboard_tabs(driver)
            automatic = automatic_review(driver, source, pdfs, parts["filing"], output, static_header,
                                         mode == "beaver")
            manual = manual_book(driver, pdfs, parts, output)
            viewports = viewport_proof(driver, output)
            urls = network_urls(driver)
            canlii_requests = [url for url in urls
                if (urlparse(url).hostname or "").lower().endswith("canlii.org")]
            assert not canlii_requests, canlii_requests
            severe = [entry for entry in driver.get_log("browser") if entry.get("level") == "SEVERE"
                      and "favicon.ico" not in entry.get("message", "")]
            assert not severe, severe
            result = {"schema_version": "beaver.authorities-browser-proof.v3",
                "created_at": datetime.now(timezone.utc).isoformat(), "mode": mode,
                "url": args.url, "artifacts": str(output), "cold_navigation": navigation,
                "browser_version": driver.capabilities.get("browserVersion"),
                "cold_layout_shift": cold_layout_shift,
                "static_surface": static_surface, "inputs": inputs,
                "automatic": automatic,
                "manual": manual, "viewports": viewports, "canlii_requests": 0,
                "network_requests": len(urls), "browser_severe": [],
                "elapsed_seconds": round(time.monotonic() - started, 3)}
            (output / "result.json").write_text(json.dumps(result, indent=2), encoding="utf-8")
            print(json.dumps(result, indent=2))
            return 0
        except Exception as caught:
            driver.save_screenshot(str(output / "failure.png"))
            failure = {"schema_version": "beaver.authorities-browser-proof.v3",
                "created_at": datetime.now(timezone.utc).isoformat(), "mode": mode,
                "url": args.url, "current_url": driver.current_url,
                "artifacts": str(output), "error": repr(caught),
                "browser_version": driver.capabilities.get("browserVersion"),
                "browser": driver.get_log("browser"),
                "requests": driver.execute_script(
                    "return JSON.parse(JSON.stringify(window.__authoritiesSmoke||null))"),
                "elapsed_seconds": round(time.monotonic() - started, 3)}
            (output / "failure.json").write_text(json.dumps(failure, indent=2), encoding="utf-8")
            raise
        finally:
            driver.quit()


if __name__ == "__main__":
    raise SystemExit(main())
