from __future__ import annotations

import argparse
import json
import tempfile
import time
from pathlib import Path
from urllib.error import HTTPError
from urllib.parse import urlencode, urljoin
from urllib.request import urlopen

from selenium import webdriver
from selenium.common.exceptions import StaleElementReferenceException, TimeoutException
from selenium.webdriver import ActionChains, Keys
from selenium.webdriver.chrome.service import Service
from selenium.webdriver.common.by import By
from selenium.webdriver.support.ui import WebDriverWait


def visible(driver, by: str, value: str, timeout=30):
    return WebDriverWait(driver, timeout, ignored_exceptions=(StaleElementReferenceException,)).until(lambda page: next(
        (node for node in page.find_elements(by, value)[::-1 if value == "dialog[open]" else 1]
         if node.is_displayed()), None))


def click_text(driver, text: str, root=None):
    for _attempt in range(3):
        try:
            xpath = f".//button[normalize-space()='{text}' or normalize-space(text()[last()])='{text}' or @aria-label='{text}']"
            node = WebDriverWait(driver, 30).until(lambda _page: next(
                (item for item in root.find_elements(By.XPATH, xpath) if item.is_displayed()), None)) \
                if root else visible(driver, By.XPATH, f"//button[normalize-space()='{text}' or normalize-space(text()[last()])='{text}' or @aria-label='{text}']")
            WebDriverWait(driver, 30).until(lambda _page: node.is_enabled())
            driver.execute_script("arguments[0].scrollIntoView({block:'center'})", node)
            node.click()
            return node
        except StaleElementReferenceException:
            if root is not None:
                raise
    raise AssertionError(f"Could not click {text}")


def panel(driver, name: str):
    if name in ("Labels", "Highlights"):
        if not any(node.is_displayed() for node in driver.find_elements(By.CSS_SELECTOR, "[aria-label='Label organizer']")):
            visible(driver, By.XPATH, "//*[@role='tab' and normalize-space()='Labels']").click()
        return visible(driver, By.CSS_SELECTOR, "[aria-label='Label organizer']")
    if name == "Search Saved sources":
        if not any(node.is_displayed() for node in driver.find_elements(By.CSS_SELECTOR, "section[aria-label='Search Saved sources']")):
            visible(driver, By.XPATH, "//*[@role='tab' and normalize-space()='Search']").click()
        return visible(driver, By.CSS_SELECTOR, "section[aria-label='Search Saved sources']")
    visible(driver, By.XPATH, "//*[@role='tab' and normalize-space()='Labels']").click()
    root = visible(driver, By.CSS_SELECTOR, "section[aria-label='Saved sources']")
    driver.execute_script("arguments[0].scrollIntoView({block:'start'})", root)
    return root


def history_count(driver):
    try:
        summary = panel(driver, "Search Saved sources").find_element(
            By.XPATH, ".//summary[contains(normalize-space(),'Searches')]")
        return int(summary.find_element(By.XPATH, "./span[last()]").text)
    except StaleElementReferenceException:
        return None


def box(driver, node):
    value = driver.execute_script("""const r=arguments[0].getBoundingClientRect();
return {left:r.left,top:r.top,right:r.right,bottom:r.bottom,width:r.width,height:r.height,
  viewportWidth:innerWidth,viewportHeight:innerHeight};""", node)
    assert value["left"] >= -1 and value["top"] >= -1, value
    assert value["right"] <= value["viewportWidth"] + 1, value
    assert value["bottom"] <= value["viewportHeight"] + 1, value
    return value


def check_reader_expansion(driver, reader, content, screenshot):
    before = box(driver, reader)
    content_text = content.text
    scrolls = driver.execute_script("return [arguments[0], ...arguments[0].querySelectorAll('*')].filter(n=>n.scrollTop||n.scrollLeft).map(n=>[n,n.scrollTop,n.scrollLeft])", reader)
    reader.find_element(By.CSS_SELECTOR, "button[aria-label='Expand reader']").click()
    WebDriverWait(driver, 15).until(lambda _page: reader.find_element(
        By.CSS_SELECTOR, "button[aria-label='Restore reader size']").is_displayed())
    expanded = box(driver, reader)
    assert expanded["width"] >= expanded["viewportWidth"] - 40, expanded
    assert expanded["height"] >= expanded["viewportHeight"] - 40, expanded
    assert content.is_displayed() and content.text == content_text
    driver.save_screenshot(str(screenshot))
    # WebDriver Escape may not leave browser fullscreen in headless Chromium; the
    # restore control exercises the same exit operation when that happens.
    reader.find_element(By.CSS_SELECTOR, "button[aria-label='Restore reader size']").send_keys(Keys.ESCAPE)
    try:
        WebDriverWait(driver, 2).until(lambda _page: not driver.execute_script("return !!document.fullscreenElement"))
    except TimeoutException:
        buttons = reader.find_elements(By.CSS_SELECTOR, "button[aria-label='Restore reader size']")
        if buttons:
            buttons[0].click()
    WebDriverWait(driver, 15).until(lambda _page: reader.find_element(
        By.CSS_SELECTOR, "button[aria-label='Expand reader']").is_displayed())
    restored = box(driver, reader)
    assert abs(restored["width"] - before["width"]) <= 2, (before, restored)
    assert content.is_displayed() and content.text == content_text
    for node, top, left in scrolls:
        assert abs(driver.execute_script("return arguments[0].scrollTop", node) - top) <= 2
        assert abs(driver.execute_script("return arguments[0].scrollLeft", node) - left) <= 2


def front(driver, node):
    assert driver.execute_script("""const n=arguments[0],r=n.getBoundingClientRect(),
i=Math.min(10,r.width/4,r.height/4),points=[[r.left+r.width/2,r.top+r.height/2],
[r.left+i,r.top+i],[r.right-i,r.top+i],[r.left+i,r.bottom-i],[r.right-i,r.bottom-i]];
return points.every(([x,y])=>{const top=document.elementFromPoint(x,y);return !!top&&n.contains(top)});""", node), \
        f"{node.tag_name} is behind another layer"


def api(driver, path: str):
    response = driver.execute_async_script("""const [url,done]=arguments;
fetch(url).then(async r=>done({status:r.status,body:await r.json().catch(()=>null)}))
  .catch(error=>done({status:0,error:String(error)}));""", path)
    assert response["status"] == 200, {"path": path, "response": response}
    return response["body"]


def research(driver, research_id: str):
    return api(driver, f"/api/source-workspaces/{research_id}")["state"]


def research_items(driver, research_id: str, kind: str, source_id=None):
    # Autosave can replace the revision while this local-mode assertion pages.
    # Restart its snapshot without adding harness requests to browser diagnostics.
    for _attempt in range(3):
        items, cursor = [], None
        while True:
            query = urlencode({"kind": kind, "limit": 200, **({"source_id": source_id} if source_id else {}),
                               **({"cursor": cursor} if cursor else {})})
            url = urljoin(driver.current_url, f"/api/source-workspaces/{research_id}/items?{query}")
            try:
                with urlopen(url, timeout=30) as response:
                    page = json.load(response)
            except HTTPError as error:
                if error.code == 400 and json.load(error).get("detail") == "invalid cursor":
                    break
                raise
            items.extend(item["value"] for item in page["items"])
            cursor = page.get("next_cursor")
            if not cursor:
                return items
    raise AssertionError("Research items kept changing while reading a snapshot")


def research_documents(driver):
    page = api(driver, "/api/library/files?limit=100")
    return [item["document"] for item in page.get("items", [])
            if item.get("kind") == "document" and item["document"]["filename"].endswith(".research.md")]


def create_label(driver, root, name: str, button: str):
    click_text(driver, button, root)
    field = WebDriverWait(driver, 30).until(lambda _page: next((node for node in root.find_elements(
        By.CSS_SELECTOR, "input[aria-label='Label name']") if node.is_displayed()), None))
    field.send_keys(Keys.CONTROL, "a")
    field.send_keys(name, Keys.ENTER)
    return visible(driver, By.CSS_SELECTOR, f"button[aria-label^='{name},']")


def label_row(root, name: str):
    return root.find_element(By.XPATH,
        f".//button[starts-with(@aria-label,'{name},')]/ancestor::*[@data-tree-drop-folder][1]")


def set_color(driver, field, value: str):
    hit_area = field.find_element(By.XPATH, "..")
    driver.execute_script("arguments[0].scrollIntoView({block:'nearest',inline:'nearest'})", hit_area)
    box(driver, hit_area)
    assert driver.execute_script("""const n=arguments[0],r=n.getBoundingClientRect(),
top=document.elementFromPoint(r.left+r.width/2,r.top+r.height/2);return !!top&&n.contains(top);""", hit_area), \
        "color control is behind another layer"
    driver.execute_script("""Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value')
  .set.call(arguments[0],arguments[1]);
arguments[0].dispatchEvent(new Event('input',{bubbles:true}));
arguments[0].dispatchEvent(new Event('change',{bubbles:true}));""", field, value)


def geometry(driver):
    return driver.execute_script("""return [...document.querySelectorAll(
  '[data-tree-drop-folder],button[aria-label^="Label "] svg[role="group"]')]
  .filter(n=>n.getClientRects().length).map((n,i)=>{const r=n.getBoundingClientRect(); return {
    key:n.dataset.treeDropFolder||`marker:${i}`,
    x:r.x,y:r.y,width:r.width,height:r.height};});""")


def assert_static(before, after):
    assert len(before) == len(after), (before, after)
    for left, right in zip(before, after, strict=True):
        assert left["key"] == right["key"] and all(
            abs(left[key] - right[key]) <= 1 for key in ("x", "y", "width", "height")), (left, right)


def drain_network(driver):
    responses = getattr(driver, "_beaver_responses", [])
    for entry in driver.get_log("performance"):
        event = json.loads(entry["message"])["message"]
        if event.get("method") == "Network.responseReceived":
            response = event["params"]["response"]
            responses.append({"url": response.get("url", ""), "status": int(response["status"])})
    driver._beaver_responses = responses
    return responses


def drain_resources(driver):
    resources = getattr(driver, "_beaver_resources", [])
    resources.extend(driver.execute_script("""const entries=performance.getEntriesByType('resource')
  .map(({name,duration,initiatorType,startTime,requestStart,responseStart,responseEnd})=>({
    name,duration,initiatorType,startedAt:performance.timeOrigin+startTime,
    requestStart,responseStart,responseEnd}));
performance.clearResourceTimings(); return entries;"""))
    driver._beaver_resources = resources
    return resources


def drain_vitals(driver):
    pages = getattr(driver, "_beaver_vitals", [])
    pages.append(driver.execute_script("""const value=window.__beaverVitals||{cls:0,longTasks:[]};
window.__beaverVitals={cls:0,longTasks:[]}; return value;"""))
    driver._beaver_vitals = pages
    return pages


def network_status(driver, fragment: str):
    return next((item["status"] for item in reversed(drain_network(driver))
                 if fragment in item["url"]), None)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--url", default="http://127.0.0.1:3000/")
    parser.add_argument("--output")
    parser.add_argument("--headed", action="store_true")
    parser.add_argument("--dock-layout-only", action="store_true")
    args = parser.parse_args()
    output = Path(args.output) if args.output else Path(tempfile.mkdtemp(prefix="beaver-research-pilot-"))
    output.mkdir(parents=True, exist_ok=True)
    title = f"Research pilot {int(time.time())}"
    research_id = None
    report: dict[str, object] = {"title": title, "screenshots": str(output)}

    with tempfile.TemporaryDirectory(prefix="beaver-chrome-") as profile:
        options = webdriver.ChromeOptions()
        if not args.headed:
            options.add_argument("--headless=new")
        options.add_argument(f"--user-data-dir={profile}")
        options.add_argument("--window-size=1440,900")
        options.set_capability("goog:loggingPrefs", {"performance": "ALL", "browser": "ALL"})
        cached = list((Path.home() / ".cache/selenium/chromedriver/win64").glob("*/chromedriver.exe"))
        service = Service(str(max(cached, key=lambda path: tuple(map(int, path.parent.name.split(".")))))) \
            if cached else Service()
        driver = webdriver.Chrome(service=service, options=options)
        driver.execute_cdp_cmd("Page.addScriptToEvaluateOnNewDocument", {"source": """
window.__beaverVitals={cls:0,longTasks:[],shifts:[]};
try{new PerformanceObserver(list=>list.getEntries().forEach(e=>{
if(!e.hadRecentInput){window.__beaverVitals.cls+=e.value;
(window.__beaverVitals.shifts??=[]).push({value:e.value,time:e.startTime,url:location.href,
  sources:e.sources?.map(s=>({tag:s.node?.tagName,label:s.node?.getAttribute?.('aria-label'),
    className:s.node?.className,before:s.previousRect,after:s.currentRect}))});}
})).observe({type:'layout-shift',buffered:true})}catch{}
try{new PerformanceObserver(list=>list.getEntries().forEach(e=>window.__beaverVitals.longTasks.push(e.duration)))
  .observe({type:'longtask',buffered:true})}catch{}
"""})
        cleanup = None
        try:
            print("Research pilot: standalone workspace layout", flush=True)
            driver.get(urljoin(args.url, "/sources"))
            visible(driver, By.CSS_SELECTOR, "button[aria-label='Open research workspace']").click()
            workspace_dock = visible(driver, By.CSS_SELECTOR, "[data-assistant-dock][aria-hidden='false']")
            assert not driver.find_elements(By.XPATH, "//button[normalize-space()='Find sources']")
            rail = workspace_dock.find_element(By.CSS_SELECTOR, "[data-tabs-rail]")
            assert rail.text == "Workspaces", rail.text
            assert not workspace_dock.find_elements(By.TAG_NAME, "h2")
            driver.save_screenshot(str(output / "00-workspace-empty.png"))
            click_text(driver, "Open", workspace_dock)
            workspace_picker = visible(driver, By.CSS_SELECTOR, "dialog[open]")
            assert workspace_picker.find_element(By.XPATH, ".//*[@role='tab' and normalize-space()='Projects']").is_displayed()
            new_workspace = workspace_picker.find_element(By.XPATH, ".//button[normalize-space()='New workspace']")
            new_project = workspace_picker.find_element(By.XPATH, ".//button[normalize-space()='New project']")
            assert new_workspace.rect["x"] > new_project.rect["x"] + new_project.rect["width"]
            driver.save_screenshot(str(output / "00-workspace-picker.png"))
            click_text(driver, "Close", workspace_picker)
            print("Research pilot: Sources search and workspace selection", flush=True)
            driver.get(args.url)
            visible(driver, By.CSS_SELECTOR, "button[aria-label='Expand assistant dock']").click()
            # Protect rendered geometry: responsive UI edits must never turn the
            # right-hand dock into a bottom sheet or an overlay that blocks chat.
            for viewport_width in (1440, 1280, 1279, 1024, 600, 390):
                driver.execute_cdp_cmd("Emulation.setDeviceMetricsOverride", {
                    "width": viewport_width, "height": 800,
                    "deviceScaleFactor": 1, "mobile": False,
                })
                dock = visible(driver, By.CSS_SELECTOR, "[data-assistant-dock][aria-hidden='false']")
                bounds = box(driver, dock)
                surface = box(driver, dock.find_element(By.XPATH, ".."))
                assert 0 <= bounds["top"] - surface["top"] <= 16, ("Dock must start at the surface top", bounds, surface)
                assert bounds["height"] >= surface["height"] - 32, ("Dock must span the surface height", bounds, surface)
                assert 0 <= surface["right"] - bounds["right"] <= 16, ("Dock must stay on the right", bounds, surface)
                assert bounds["left"] >= 32, ("Dock must leave space on its left", bounds)
                draft = visible(driver, By.CSS_SELECTOR, "textarea")
                draft_bounds = box(driver, draft)
                assert draft_bounds["right"] <= bounds["left"], ("Chat and dock must not overlap", draft_bounds, bounds)
                assert draft_bounds["width"] > 60, ("Chat must retain usable space", draft_bounds)
                draft.click()
                draft.send_keys("Concurrent draft")
                assert driver.execute_script("return document.activeElement === arguments[0]", draft), "Dock stole chat focus"
                assert draft.get_attribute("value") == "Concurrent draft"
                assert dock.is_displayed(), "Writing in chat closed the dock"
                front(driver, draft)
                draft.clear()
                dock_tabs = dock.find_element(By.CSS_SELECTOR, "[role='tablist']")
                if bounds["width"] >= 500:
                    assert driver.execute_script("return arguments[0].scrollWidth <= arguments[0].clientWidth + 1", dock_tabs), "Dock tabs clipped despite available width"
                dock_tabs.find_element(By.XPATH, ".//*[@role='tab'][.//span[normalize-space()='Workflows']]").click()
                visible(driver, By.CSS_SELECTOR, "input[aria-label='Search workflows']")
                driver.save_screenshot(str(output / f"00-workflows-dock-{viewport_width}.png"))
                if viewport_width == 1280:
                    visible(driver, By.CSS_SELECTOR, "button[aria-label='Info about Research a legal issue']").click()
                    workflow_info = visible(driver, By.CSS_SELECTOR, "dialog[open]")
                    driver.save_screenshot(str(output / "00-workflow-info.png"))
                    workflow_info.find_element(By.CSS_SELECTOR, "button[aria-label='Close']").click()

                library_tab = dock_tabs.find_element(By.XPATH, ".//*[@role='tab'][.//span[normalize-space()='Library']]")
                library_tab.click()
                assert not dock.find_elements(By.CSS_SELECTOR, "button[aria-label='Expand reader']")
                directory = dock.find_element(By.CSS_SELECTOR, ".document-directory")
                file_tabs = directory.find_elements(By.CSS_SELECTOR, "[role='tab']")
                assert len({round(tab.rect["y"]) for tab in file_tabs}) == 1, "Library tabs wrapped"
                driver.save_screenshot(str(output / f"00-library-dock-{viewport_width}.png"))
                dock_tabs.find_element(By.XPATH, ".//*[@role='tab'][.//span[normalize-space()='Sources']]").click()
                categories = dock.find_element(By.CSS_SELECTOR, "[aria-label='Source category']")
                assert len({round(tab.rect["y"]) for tab in categories.find_elements(By.CSS_SELECTOR, "[role='tab']")}) == 1, "Source categories wrapped"
                driver.save_screenshot(str(output / f"00-dock-{viewport_width}.png"))
            driver.execute_cdp_cmd("Emulation.clearDeviceMetricsOverride", {})
            print("Dock geometry passed at desktop, breakpoint, tablet, and phone widths", flush=True)
            if args.dock_layout_only:
                return
            visible(driver, By.XPATH, "//*[@role='tab' and normalize-space()='Sources']").click()
            driver.save_screenshot(str(output / "00-sources-open.png"))
            driver.get_log("browser")  # Ignore restored-tab errors before this isolated run.
            existing_research = {item["id"] for item in research_documents(driver)}

            search = visible(driver, By.CSS_SELECTOR, "input[aria-label='Search sources']")
            help_button = visible(driver, By.CSS_SELECTOR, "button[aria-label='Boolean search help']")
            help_button.click()
            help_popover = visible(driver, By.CSS_SELECTOR, "[role='tooltip']:popover-open")
            help_box, help_anchor = box(driver, help_popover), box(driver, help_button)
            front(driver, help_popover)
            assert abs(help_box["right"] - help_anchor["right"]) < 16, (help_box, help_anchor)
            driver.save_screenshot(str(output / "01-help.png"))
            ActionChains(driver).send_keys(Keys.ESCAPE).perform()

            # An unsaved result opens Workspace but never invents a destination.
            click_text(driver, "Cases")
            search.send_keys("2016 SCC 27")
            click_text(driver, "Search")
            article = visible(driver, By.CSS_SELECTOR, "article", 90)
            case_title = article.find_element(By.TAG_NAME, "h3").text
            report["searchStatus"] = network_status(driver, "/api/sources/search")
            assert report["searchStatus"] == 200, report
            focus = driver.execute_script("""const s=getComputedStyle(arguments[0].parentElement);
return {border:s.borderColor,shadow:s.boxShadow};""", search)
            assert focus["border"] not in ("rgb(37, 99, 235)", "rgb(59, 130, 246)"), focus
            marker = article.find_element(By.CSS_SELECTOR, "button[aria-label^='Label ']")
            ActionChains(driver).move_to_element(marker).click_and_hold().move_by_offset(28, 12).release().perform()
            assert {item["id"] for item in research_documents(driver)} == existing_research, "Dragging an unsaved result created a workspace"
            workspace = visible(driver, By.CSS_SELECTOR, "section[aria-label='Research collection']")
            assert "Open" in workspace.text and "New workspace" in workspace.text
            assert {item["id"] for item in research_documents(driver)} == existing_research, "Opening Workspace created a research document"
            driver.save_screenshot(str(output / "02-explicit-workspace-choice.png"))

            click_text(driver, "Open", workspace)
            chooser = visible(driver, By.CSS_SELECTOR, "dialog[open]")
            box(driver, chooser); front(driver, chooser)
            assert "Library" in chooser.text and "Projects" in chooser.text
            assert not chooser.find_elements(By.CSS_SELECTOR, "input[name='title']")
            driver.save_screenshot(str(output / "03-open-workspace.png"))
            click_text(driver, "New workspace", chooser)
            name = visible(driver, By.CSS_SELECTOR, "input[aria-label='Workspace name']")
            assert name.find_element(By.XPATH, "ancestor::dialog[1]") == chooser, "New workspace replaced the directory"
            name.send_keys("Cancelled workspace", Keys.ESCAPE)
            assert chooser.is_displayed(), "Cancelling a name closed the directory"
            assert not chooser.find_elements(By.CSS_SELECTOR, "input[aria-label='Workspace name']")
            click_text(driver, "New workspace", chooser)
            name = visible(driver, By.CSS_SELECTOR, "input[aria-label='Workspace name']")
            name.send_keys(title)
            driver.save_screenshot(str(output / "03a-inline-workspace-name.png"))
            name.send_keys(Keys.ENTER)
            selected = visible(driver, By.CSS_SELECTOR, f"input[aria-label='Select {title}']")
            assert selected.is_selected(), "New workspace must be selected in its directory"
            click_text(driver, "Open", chooser)
            WebDriverWait(driver, 30).until(lambda page: not page.find_elements(By.CSS_SELECTOR, "dialog[open]"))
            workspace = visible(driver, By.CSS_SELECTOR, "section[aria-label='Research collection']")
            WebDriverWait(driver, 30).until(lambda _page: title in driver.find_element(By.TAG_NAME, "body").text)
            documents = [item for item in research_documents(driver) if item["id"] not in existing_research]
            assert len(documents) == 1 and documents[0]["filename"] == f"{title}.research.md", documents
            research_id = documents[0]["id"]
            initial_versions = api(driver, f"/api/single-documents/{research_id}/versions")
            assert len(initial_versions["versions"]) == 1, initial_versions
            report["noMagicWorkspace"] = True

            workspace = visible(driver, By.CSS_SELECTOR, "section[aria-label='Research collection']")
            moved = box(driver, workspace)
            front(driver, workspace)
            driver.save_screenshot(str(output / "04-collection.png"))

            visible(driver, By.CSS_SELECTOR, "button[aria-label='Workspace options']").click()
            options_menu = visible(driver, By.CSS_SELECTOR, "[role='menu'][aria-label='Workspace options']")
            box(driver, options_menu); front(driver, options_menu)
            driver.save_screenshot(str(output / "04-workspace-options.png"))
            click_text(driver, "Rename", options_menu)
            rename_field = visible(driver, By.CSS_SELECTOR, "input[name='title']")
            rename_dialog = rename_field.find_element(By.XPATH, "ancestor::dialog[1]")
            title = f"{title} verified"
            rename_field.send_keys(Keys.CONTROL, "a"); rename_field.send_keys(title)
            click_text(driver, "Rename", rename_dialog)
            WebDriverWait(driver, 30).until(lambda _page: title in driver.find_element(By.TAG_NAME, "body").text)
            WebDriverWait(driver, 30).until(lambda _page: any(
                item["filename"] == f"{title}.research.md" for item in research_documents(driver)))
            report["title"] = title

            visible(driver, By.XPATH, "//*[@role='tab' and normalize-space()='Memo']").click()
            note = visible(driver, By.CSS_SELECTOR, "[contenteditable='true'][aria-label='Workspace memo']")
            note.send_keys("Question presented and working theory.")
            WebDriverWait(driver, 30).until(lambda _page: research(driver, research_id)["note"]
                                            == "Question presented and working theory.")
            visible(driver, By.XPATH, "//*[@role='tab' and normalize-space()='Labels']").click()

            visible(driver, By.CSS_SELECTOR, "button[aria-label='Workspace options']").click()
            options_menu = visible(driver, By.CSS_SELECTOR, "[role='menu'][aria-label='Workspace options']")
            click_text(driver, "Open another", options_menu)
            chooser = visible(driver, By.CSS_SELECTOR, "dialog[open]")
            chooser_box = box(driver, chooser); front(driver, chooser)
            click_text(driver, "New folder", chooser)
            folder_dialog = visible(driver, By.CSS_SELECTOR, "input[name='name']").find_element(By.XPATH, "ancestor::dialog[1]")
            driver.save_screenshot(str(output / "05-new-folder.png"))
            click_text(driver, "Cancel", folder_dialog)
            chooser = visible(driver, By.CSS_SELECTOR, "dialog[open]")
            click_text(driver, "New project", chooser)
            project_dialog = visible(driver, By.CSS_SELECTOR,
                "input[name='name'][placeholder='Add project name']").find_element(By.XPATH, "ancestor::dialog[1]")
            driver.save_screenshot(str(output / "06-new-project.png"))
            project_dialog.find_element(By.CSS_SELECTOR, "button[aria-label='Close']").click()
            chooser = visible(driver, By.CSS_SELECTOR, "dialog[open]")
            click_text(driver, "Close", chooser)

            labels = panel(driver, "Labels")
            print("Research pilot: label hierarchy, drag-and-drop and colours", flush=True)
            create_label(driver, labels, "Procedural fairness", "+ Add label")
            click_text(driver, "All sources", labels)
            create_label(driver, labels, "Remedies", "+ Add label")
            click_text(driver, "All sources", labels)
            create_label(driver, labels, "Questions", "+ Add label")
            highlights = panel(driver, "Highlights")
            create_label(driver, highlights, "Key passage", "+ Add category")
            create_label(driver, highlights, "Contrary evidence", "+ Add category")
            labels = panel(driver, "Labels")

            labels.find_element(By.CSS_SELECTOR, "button[aria-label='Edit Procedural fairness']").click()
            rename = labels.find_element(By.CSS_SELECTOR, "input[aria-label='Label name']")
            rename.send_keys(Keys.CONTROL, "a"); rename.send_keys("Duty of fairness", Keys.ENTER)
            visible(driver, By.CSS_SELECTOR, "button[aria-label^='Duty of fairness,']").click()
            create_label(driver, labels, "Hearing rights", "+ Add label")
            click_text(driver, "All sources", labels)

            labels_state = research(driver, research_id)["labels"]
            ids = {item["name"]: key for key, item in labels_state.items()}
            assert labels_state[ids["Hearing rights"]]["parentId"] == ids["Duty of fairness"]

            # Reorder, nest, outdent to root (with a visible root cue), then restore the hierarchy.
            question, duty = label_row(labels, "Questions"), label_row(labels, "Duty of fairness")
            ActionChains(driver).move_to_element(question.find_element(By.CSS_SELECTOR,
                "svg.lucide-grip-vertical")).click_and_hold().move_to_element_with_offset(
                duty, -int(duty.rect["width"] * .4), -int(duty.rect["height"] * .2)).release().perform()
            WebDriverWait(driver, 20).until(lambda _page: (state := research(driver, research_id))["labels"]
                [ids["Questions"]]["order"] < state["labels"][ids["Duty of fairness"]]["order"])
            remedy, duty = label_row(labels, "Remedies"), label_row(labels, "Duty of fairness")
            ActionChains(driver).move_to_element(remedy.find_element(By.CSS_SELECTOR,
                "svg.lucide-grip-vertical")).click_and_hold().move_to_element_with_offset(
                duty, int(duty.rect["width"] * .35), 0).release().perform()
            WebDriverWait(driver, 20).until(lambda _page: research(driver, research_id)["labels"][ids["Remedies"]]["parentId"]
                                            == ids["Duty of fairness"])
            root_drop = visible(driver, By.CSS_SELECTOR, "[data-tree-drop-root]")
            WebDriverWait(driver, 10).until(lambda _page: root_drop.is_enabled())
            remedy = label_row(labels, "Remedies")
            remedy_grip = remedy.find_element(By.CSS_SELECTOR, "svg.lucide-grip-vertical")
            ActionChains(driver).move_to_element(remedy_grip).click_and_hold().move_by_offset(
                8, 0).pause(.1).move_to_element(root_drop).move_by_offset(1, 0).pause(.4).release().perform()
            WebDriverWait(driver, 20).until(lambda _page: research(driver, research_id)["labels"][ids["Remedies"]]["parentId"] is None)
            remedy, duty = label_row(labels, "Remedies"), label_row(labels, "Duty of fairness")
            ActionChains(driver).move_to_element(remedy.find_element(By.CSS_SELECTOR,
                "svg.lucide-grip-vertical")).click_and_hold().move_to_element_with_offset(
                duty, int(duty.rect["width"] * .35), 0).release().perform()
            WebDriverWait(driver, 20).until(lambda _page: research(driver, research_id)["labels"][ids["Remedies"]]["parentId"]
                                            == ids["Duty of fairness"])
            remedy = label_row(labels, "Remedies")
            driver.execute_script("""const [source,target]=arguments,data=new DataTransfer();
data.setData('application/x-beaver-research-label',source.dataset.treeDropFolder);
source.dispatchEvent(new DragEvent('dragstart',{bubbles:true,cancelable:true,dataTransfer:data}));
target.dispatchEvent(new DragEvent('dragover',{bubbles:true,cancelable:true,dataTransfer:data}));""", remedy, root_drop)
            WebDriverWait(driver, 10).until(lambda _page: root_drop.text == "Move to top level")
            box(driver, root_drop)
            driver.save_screenshot(str(output / "09-label-root-drop-cue.png"))
            driver.execute_script("arguments[0].dispatchEvent(new DragEvent('dragend',{bubbles:true}));", remedy)

            keyboard_row = label_row(labels, "Remedies")
            keyboard = keyboard_row.get_attribute("tabindex") == "0"
            if keyboard:
                driver.execute_script("arguments[0].focus()", keyboard_row)
                ActionChains(driver).key_down(Keys.ALT).send_keys(Keys.ARROW_UP).key_up(Keys.ALT).perform()
                WebDriverWait(driver, 20).until(lambda _page: (state := research(driver, research_id))["labels"]
                    [ids["Remedies"]]["order"] < state["labels"][ids["Hearing rights"]]["order"])
                keyboard_row = label_row(labels, "Remedies")
                driver.execute_script("arguments[0].focus()", keyboard_row)
                ActionChains(driver).key_down(Keys.ALT).send_keys(Keys.ARROW_DOWN).key_up(Keys.ALT).perform()
                WebDriverWait(driver, 20).until(lambda _page: (state := research(driver, research_id))["labels"]
                    [ids["Remedies"]]["order"] > state["labels"][ids["Hearing rights"]]["order"])
                keyboard_row = label_row(labels, "Remedies")
                driver.execute_script("arguments[0].focus()", keyboard_row)
                ActionChains(driver).key_down(Keys.ALT).send_keys(Keys.ARROW_LEFT).key_up(Keys.ALT).perform()
                WebDriverWait(driver, 20).until(lambda _page: research(driver, research_id)["labels"]
                    [ids["Remedies"]]["parentId"] is None)
                keyboard_row = label_row(labels, "Remedies")
                driver.execute_script("arguments[0].focus()", keyboard_row)
                ActionChains(driver).key_down(Keys.ALT).send_keys(Keys.ARROW_RIGHT).key_up(Keys.ALT).perform()
                WebDriverWait(driver, 20).until(lambda _page: research(driver, research_id)["labels"]
                    [ids["Remedies"]]["parentId"] == ids["Duty of fairness"])
            report["labelKeyboardMoveExercised"] = keyboard

            # Every folder keeps its geometry while selection and durable colours change.
            stable = geometry(driver)
            labels.find_element(By.CSS_SELECTOR, "button[aria-label^='Duty of fairness,']").click()
            assert_static(stable, geometry(driver))
            for label_name, color in (("Duty of fairness", "#dc2626"), ("Remedies", "#7c3aed"),
                                      ("Questions", "#047857"), ("Hearing rights", "#2563eb")):
                field = labels.find_element(By.CSS_SELECTOR, f"input[aria-label='{label_name} color']")
                driver.execute_script("arguments[0].scrollIntoView({block:'nearest'})", field)
                stable = geometry(driver)
                set_color(driver, field, color)
                WebDriverWait(driver, 20).until(lambda _page, key=ids[label_name], value=color:
                    research(driver, research_id)["labels"][key]["color"] == value)
                assert_static(stable, geometry(driver))
            click_text(driver, "All sources", labels)
            driver.save_screenshot(str(output / "10-label-tree.png"))

            # Assign an unsaved result, then work with the collection's saved source.
            visible(driver, By.CSS_SELECTOR, "button[aria-label='Close workspace']").click()
            article = visible(driver, By.CSS_SELECTOR, "article")
            marker = article.find_element(By.CSS_SELECTOR, "button[aria-label^='Label ']")
            started = time.perf_counter()
            marker.click()
            palette = visible(driver, By.CSS_SELECTOR, "[role='dialog'][aria-label='Labels and note']")
            click_text(driver, "Duty of fairness", palette)
            click_text(driver, "Done", palette)
            WebDriverWait(driver, 30).until(lambda _page: len(research(driver, research_id)["sources"]) == 1)
            source_drag_ms = round((time.perf_counter() - started) * 1000, 1)
            state = research(driver, research_id)
            source_id, source_state = next(iter(state["sources"].items()))
            assert source_state["labelIds"] == [ids["Duty of fairness"]], source_state
            visible(driver, By.CSS_SELECTOR, "button[aria-label='Open research workspace']").click()
            visible(driver, By.CSS_SELECTOR, "a[aria-label='Open full research view']").click()
            workspace = visible(driver, By.CSS_SELECTOR, "section[aria-label='Research collection']")
            list_panel = panel(driver, "List")
            article = list_panel
            labels = panel(driver, "Labels")
            driver.save_screenshot(str(output / "11-saved-source.png"))
            article = panel(driver, "List")

            # Autosave notes on all three close paths and prove colour/selection never moves UI.
            print("Research pilot: source labels and autosave", flush=True)
            stable = geometry(driver)
            marker = article.find_element(By.CSS_SELECTOR, "button[aria-label^='Label ']")
            marker_color = marker.find_element(By.CSS_SELECTOR, "[data-label-layer='primary']").get_attribute("fill")
            marker.click()
            palette = visible(driver, By.CSS_SELECTOR, "[role='dialog'][aria-label='Labels and note']")
            palette_box = box(driver, palette); front(driver, palette)
            click_text(driver, "Questions", palette)
            badge_color = palette.find_element(By.CSS_SELECTOR, "input[aria-label='Badge color']")
            set_color(driver, badge_color, "#7c3aed")
            palette.find_element(By.CSS_SELECTOR, "#research-badge").send_keys("Leading case")
            palette.find_element(By.CSS_SELECTOR, "textarea[aria-label='Item note']").send_keys("Saved with Done.")
            driver.save_screenshot(str(output / "11-source-palette.png"))
            click_text(driver, "Done", palette)
            WebDriverWait(driver, 30).until(lambda _page: research(driver, research_id)["sources"][source_id]["note"]
                                            == "Saved with Done.")
            assert_static(stable, geometry(driver))
            marker = article.find_element(By.CSS_SELECTOR, "button[aria-label^='Label ']")
            assert marker.find_element(By.CSS_SELECTOR, "[data-label-layer='primary']").get_attribute("fill") != marker_color

            marker.click()
            palette = visible(driver, By.CSS_SELECTOR, "[role='dialog'][aria-label='Labels and note']")
            note = palette.find_element(By.CSS_SELECTOR, "textarea[aria-label='Item note']")
            note.send_keys(Keys.CONTROL, "a"); note.send_keys("Saved with Escape.")
            ActionChains(driver).send_keys(Keys.ESCAPE).perform()
            WebDriverWait(driver, 30).until(lambda _page: research(driver, research_id)["sources"][source_id]["note"]
                                            == "Saved with Escape.")
            marker = article.find_element(By.CSS_SELECTOR, "button[aria-label^='Label ']")
            marker.click()
            palette = visible(driver, By.CSS_SELECTOR, "[role='dialog'][aria-label='Labels and note']")
            note = palette.find_element(By.CSS_SELECTOR, "textarea[aria-label='Item note']")
            note.send_keys(Keys.CONTROL, "a"); note.send_keys("Saved with outside click.")
            visible(driver, By.CSS_SELECTOR, "button[aria-label='Open research workspace']").click()
            WebDriverWait(driver, 30).until(lambda _page: research(driver, research_id)["sources"][source_id]["note"]
                                            == "Saved with outside click.")
            assert not driver.find_elements(By.CSS_SELECTOR, "[role='dialog'][aria-label='Labels and note']")
            autosaved_versions = api(driver, f"/api/single-documents/{research_id}/versions")
            assert autosaved_versions["current_version_id"] == initial_versions["current_version_id"]
            assert len(autosaved_versions["versions"]) == len(initial_versions["versions"]), autosaved_versions

            # Saved markers remain fixed while drag-and-drop adds another ontology path.
            list_panel = panel(driver, "List")
            WebDriverWait(driver, 30).until(lambda _page: list_panel.find_elements(By.CSS_SELECTOR, "button[draggable='true']"))
            source_marker = list_panel.find_element(By.CSS_SELECTOR, "button[draggable='true']")
            icon_before = source_marker.find_element(By.CSS_SELECTOR, "svg[role='group']").rect.copy()
            color_before = source_marker.find_element(By.CSS_SELECTOR, "[data-label-layer='primary']").get_attribute("fill")
            driver.execute_script("""window.__dragProof=[];
for(const type of ['dragstart','dragenter','drop','dragend'])document.addEventListener(type,e=>{
window.__dragProof.push({type,types:[...e.dataTransfer.types],target:e.target.tagName,
label:e.target.closest('[data-tree-drop-folder]')?.dataset.treeDropFolder,
effect:e.dataTransfer.dropEffect});},true);""")
            ActionChains(driver).move_to_element(source_marker).click_and_hold().move_by_offset(12, 0).perform()
            labels = visible(driver, By.CSS_SELECTOR, "[aria-label='Label organizer']")
            ActionChains(driver).move_to_element(label_row(labels, "Remedies")).pause(0.5).move_by_offset(1, 0).pause(0.2).release().perform()
            (output / "source-drag.json").write_text(json.dumps(driver.execute_script("return window.__dragProof")), encoding="utf-8")
            WebDriverWait(driver, 30).until(lambda _page: len(research(driver, research_id)["sources"][source_id]["labelIds"]) == 2)
            list_panel = panel(driver, "List")
            source_marker = list_panel.find_element(By.CSS_SELECTOR, "button[draggable='true']")
            icon_after = source_marker.find_element(By.CSS_SELECTOR, "svg[role='group']")
            assert icon_after.get_attribute("aria-label")
            assert icon_after.find_element(By.CSS_SELECTOR, "[data-label-layer='primary']").get_attribute("fill") != color_before
            assert all(abs(icon_before[key] - icon_after.rect[key]) <= 1 for key in ("x", "y", "width", "height"))
            driver.save_screenshot(str(output / "12-saved-source-drop.png"))

            # At minimum width, list controls stay on one line and every menu stays above the workspace.
            panel(driver, "List")
            driver.set_window_size(600, 700)
            WebDriverWait(driver, 10).until(lambda page: page.execute_script(
                "return document.querySelector(\"section[aria-label='Research collection']\")?.getBoundingClientRect().width < 600"))
            workspace = visible(driver, By.CSS_SELECTOR, "section[aria-label='Research collection']")
            research_panels = workspace.find_element(By.CSS_SELECTOR, "section[aria-label='Saved sources']")
            assert driver.execute_script("return arguments[0].scrollWidth<=arguments[0].clientWidth+1", research_panels)
            list_panel = panel(driver, "List")
            search_box = list_panel.find_element(By.CSS_SELECTOR, "input[aria-label='Search list']")
            options = list_panel.find_element(By.CSS_SELECTOR, "button[aria-label='List options']")
            assert abs(box(driver, search_box)["top"] - box(driver, options)["top"]) <= 1, "List controls wrapped"
            options.click()
            menu = visible(driver, By.CSS_SELECTOR, "[role='menu'][aria-label='List options']")
            box(driver, menu); front(driver, menu)
            driver.save_screenshot(str(output / "13-narrow-list-menu.png"))
            next(node for node in menu.find_elements(By.TAG_NAME, "button") if "A" in node.text and "Z" in node.text).click()
            driver.save_screenshot(str(output / "14-narrow-workspace.png"))
            driver.set_window_size(1440, 900)
            WebDriverWait(driver, 10).until(lambda _page: workspace.rect["width"] >= 300)

            search_saved = panel(driver, "Search Saved sources")
            print("Research pilot: saved-source search and capture rules", flush=True)
            search_saved.find_element(By.CSS_SELECTOR, "button[aria-label='Search syntax']").click()
            syntax_menu = visible(driver, By.CSS_SELECTOR, "[role='menu'][aria-label='Search syntax']")
            box(driver, syntax_menu); front(driver, syntax_menu)
            click_text(driver, "All terms", syntax_menu)
            target_button = search_saved.find_element(By.CSS_SELECTOR, "button[aria-label='Search target']")
            assert "Source text" in target_button.text
            search_saved.find_element(By.CSS_SELECTOR, "input[aria-label='Search saved source text']").send_keys("court")
            click_text(driver, "Find passages", search_saved)
            WebDriverWait(driver, 90).until(lambda page: history_count(page) == 1)
            search_saved = panel(driver, "Search Saved sources")

            # Matched passages can be selected in place and saved under a passage category.
            saved_sources = visible(driver, By.CSS_SELECTOR, "section[aria-label='Saved sources']")
            first_match = WebDriverWait(driver, 30).until(lambda _page: next((node for node in saved_sources.find_elements(
                By.CSS_SELECTOR, "input[aria-label^='Select ']") if node.is_displayed()), None))
            first_match.click()
            click_text(driver, "Save selected passages", saved_sources)
            save_menu = visible(driver, By.CSS_SELECTOR, "[role='menu'][aria-label='Save selected passages']")
            box(driver, save_menu); front(driver, save_menu)
            driver.save_screenshot(str(output / "15-save-matches.png"))
            click_text(driver, "Save as Key passage", save_menu)
            key_passage = next(key for key, item in research(driver, research_id)["labels"].items() if item["name"] == "Key passage")
            WebDriverWait(driver, 30).until(lambda _page: any((source.get("passages") or {}).get("labelCounts", {}).get(key_passage)
                for source in research(driver, research_id)["sources"].values()))

            search_saved.find_element(By.CSS_SELECTOR, "button[aria-label='Search target']").click()
            target_menu = visible(driver, By.CSS_SELECTOR, "[role='menu'][aria-label='Search target']")
            box(driver, target_menu); front(driver, target_menu)
            click_text(driver, "Saved passages", target_menu)
            click_text(driver, "Find passages", search_saved)
            WebDriverWait(driver, 90).until(lambda page: history_count(page) == 2)
            search_saved = panel(driver, "Search Saved sources")
            search_saved.find_element(By.CSS_SELECTOR, "button[aria-label='Search target']").click()
            click_text(driver, "Source text", visible(driver, By.CSS_SELECTOR, "[role='menu'][aria-label='Search target']"))
            search_saved.find_element(By.CSS_SELECTOR, "button[aria-label='Search syntax']").click()
            click_text(driver, "Exact", visible(driver, By.CSS_SELECTOR, "[role='menu'][aria-label='Search syntax']"))
            search_saved.find_element(By.CSS_SELECTOR, "button[aria-label='Passage extent']").click()
            extent_menu = visible(driver, By.CSS_SELECTOR, "[role='menu'][aria-label='Passage extent']")
            box(driver, extent_menu); front(driver, extent_menu)
            driver.save_screenshot(str(output / "15-passage-extent.png"))
            click_text(driver, "Paragraph before", extent_menu)
            phrase = search_saved.find_element(By.CSS_SELECTOR, "input[aria-label='Search saved source text']")
            phrase.send_keys(Keys.CONTROL, "a"); phrase.send_keys("court")
            click_text(driver, "Find passages", search_saved)
            WebDriverWait(driver, 90).until(lambda page: history_count(page) == 3)
            search_saved = panel(driver, "Search Saved sources")
            history = search_saved.find_element(By.XPATH, ".//details[summary[contains(normalize-space(),'Searches')]]")
            assert not history.get_attribute("open")
            history.find_element(By.TAG_NAME, "summary").click()
            queries = WebDriverWait(driver, 10).until(lambda _page: history.find_elements(By.TAG_NAME, "details"))
            capture = next(node for node in queries
                if "court" in node.find_element(By.TAG_NAME, "summary").text.lower())
            capture.find_element(By.TAG_NAME, "summary").click()
            WebDriverWait(driver, 10).until(lambda _page:
                capture.find_elements(By.XPATH, ".//button[normalize-space()='Run again']"))
            click_text(driver, "Run again", capture)
            WebDriverWait(driver, 90).until(lambda page: history_count(page) == 4)
            driver.save_screenshot(str(output / "16-search-receipts.png"))

            # A direct journal search renders its title once, not again as metadata.
            print("Research pilot: journal results and source reading", flush=True)
            visible(driver, By.CSS_SELECTOR, "button[aria-label='Collapse workspace']").click()
            click_text(driver, "Journals")
            search = visible(driver, By.CSS_SELECTOR, "input[aria-label='Search sources']")
            search.send_keys(Keys.CONTROL, "a"); search.send_keys("administrative law")
            search_count = sum("/api/sources/search" in row["url"] for row in drain_network(driver))
            click_text(driver, "Search")
            WebDriverWait(driver, 90).until(lambda _page: sum("/api/sources/search" in row["url"]
                for row in drain_network(driver)) > search_count)
            journal = WebDriverWait(driver, 90).until(lambda page: next((node for node in
                page.find_elements(By.CSS_SELECTOR, "article") if node.is_displayed()
                and case_title not in node.text), None))
            journal_title = journal.find_element(By.TAG_NAME, "h3").text.strip()
            assert journal_title and journal.text.count(journal_title) == 1, journal.text
            report["journalTitle"] = journal_title
            driver.save_screenshot(str(output / "17-journal-title-once.png"))

            click_text(driver, "Cases")
            search = visible(driver, By.CSS_SELECTOR, "input[aria-label='Search sources']")
            search.send_keys(Keys.CONTROL, "a"); search.send_keys("2016 SCC 27")
            search_count = sum("/api/sources/search" in row["url"] for row in drain_network(driver))
            click_text(driver, "Search")
            WebDriverWait(driver, 90).until(lambda _page: sum("/api/sources/search" in row["url"]
                for row in drain_network(driver)) > search_count)
            case = WebDriverWait(driver, 30).until(lambda page: next(
                (node for node in page.find_elements(By.CSS_SELECTOR, "article") if case_title in node.text), None))
            visible(driver, By.CSS_SELECTOR, "button[aria-label='Open research workspace']").click()
            list_panel = panel(driver, "List")
            click_text(driver, case_title, list_panel)
            reader = visible(driver, By.CSS_SELECTOR, "section[data-legal-block]", 90)
            reader_pane = visible(driver, By.CSS_SELECTOR, "section[aria-label='Source reader']")
            check_reader_expansion(driver, reader_pane.find_element(By.CSS_SELECTOR, "[data-reader-view]"),
                reader, output / "17a-source-expanded.png")
            workspace_dock = visible(driver, By.CSS_SELECTOR, "[data-assistant-dock]")
            assert reader_pane.rect["x"] + reader_pane.rect["width"] <= workspace_dock.rect["x"] + 1, \
                "Source text must be left of the workspace dock"
            assert workspace_dock.find_element(By.CSS_SELECTOR, "section[aria-label='Research collection']")
            panel(driver, "Labels")
            WebDriverWait(driver, 30).until(lambda _page: title in driver.find_element(By.TAG_NAME, "body").text)
            driver.execute_script("arguments[0].scrollIntoView({block:'center'})", reader)
            selected = driver.execute_script("""const root=arguments[0],w=document.createTreeWalker(root,NodeFilter.SHOW_TEXT);
let n; while(n=w.nextNode()){if(n.data.trim().length>3)break;} if(!n)return '';
const start=n.data.search(/\S/u),r=document.createRange(); r.setStart(n,Math.max(0,start));
r.setEnd(n,Math.min(n.length,Math.max(0,start)+35)); const s=getSelection(); s.removeAllRanges(); s.addRange(r);
const text=s.toString(); root.dispatchEvent(new PointerEvent('pointerup',{bubbles:true})); return text;""", reader)
            assert selected.strip()
            visible(driver, By.XPATH, "//button[normalize-space()='Save highlight']").click()
            palette = visible(driver, By.CSS_SELECTOR, "[role='dialog'][aria-label='Labels and note']")
            passage_palette_box = box(driver, palette); front(driver, palette)
            click_text(driver, "Key passage", palette)
            palette.find_element(By.CSS_SELECTOR, "button[aria-label='Add label assignment']").click()
            click_text(driver, "Contrary evidence", palette)
            palette.find_element(By.CSS_SELECTOR, "textarea[aria-label='Item note']").send_keys("Passage-level analysis.")
            driver.save_screenshot(str(output / "18-passage-palette.png"))
            click_text(driver, "Done", palette)
            WebDriverWait(driver, 30).until(lambda _page: any(item["note"] == "Passage-level analysis."
                and len(item["labelIds"]) == 2
                for item in research_items(driver, research_id, "passages", source_id)))
            assert driver.execute_script("return getSelection().isCollapsed")

            # Destructive workspace edits always explain their cascade and require confirmation.
            list_panel = panel(driver, "List")
            source_details = list_panel.find_element(By.CSS_SELECTOR, "button[draggable='true']").find_element(
                By.XPATH, "ancestor::details")
            if not source_details.get_attribute("open"):
                source_details.find_element(By.CSS_SELECTOR, "summary > button").click()
                WebDriverWait(driver, 10).until(lambda _page: source_details.get_attribute("open"))
            ActionChains(driver).move_to_element(source_details.find_element(By.TAG_NAME, "summary")).perform()
            options = source_details.find_element(By.CSS_SELECTOR, "summary button[aria-label$=' options']")
            driver.execute_script("arguments[0].click()", options)
            click_text(driver, "Remove source", visible(driver, By.CSS_SELECTOR, "[role='menu'][aria-label$=' options']"))
            confirmation = visible(driver, By.CSS_SELECTOR, "[role='alertdialog']")
            box(driver, confirmation); front(driver, confirmation)
            evidence_count = len(research_items(driver, research_id, "passages", source_id))
            assert case_title in confirmation.text and f"{evidence_count} saved passage" in confirmation.text
            driver.save_screenshot(str(output / "19-remove-confirmation.png"))
            click_text(driver, "Cancel", confirmation)
            WebDriverWait(driver, 10).until(lambda _page: not driver.find_elements(By.CSS_SELECTOR, "[role='alertdialog']"))
            assert source_id in research(driver, research_id)["sources"]

            title_marker = next(node for node in driver.find_elements(By.CSS_SELECTOR,
                "header button[aria-label^='Label ']") if case_title in node.get_attribute("aria-label"))
            title_marker.click()
            title_palette = visible(driver, By.CSS_SELECTOR, "[role='dialog'][aria-label='Labels and note']")
            box(driver, title_palette); front(driver, title_palette)
            ActionChains(driver).send_keys(Keys.ESCAPE).perform()
            WebDriverWait(driver, 10).until(lambda _page: not driver.find_elements(
                By.CSS_SELECTOR, "[role='dialog'][aria-label='Labels and note']"))
            assert driver.execute_script("return document.activeElement===arguments[0]", title_marker)
            assert panel(driver, "Labels").is_displayed(), "Escape closed the research dock"
            driver.save_screenshot(str(output / "19-reader-highlight.png"))

            dock = visible(driver, By.CSS_SELECTOR, "[data-assistant-dock]")
            resize = dock.find_element(By.CSS_SELECTOR, "[role='separator'][aria-label='Resize workspace']")
            dock_width = dock.rect["width"]
            resize.click(); resize.send_keys(Keys.ARROW_RIGHT)
            WebDriverWait(driver, 10).until(lambda _page: dock.rect["width"] < dock_width)
            resize.send_keys(Keys.ARROW_LEFT)
            WebDriverWait(driver, 10).until(lambda _page: dock.rect["width"] >= dock_width - 1)

            driver.set_window_size(600, 800)
            list_panel = panel(driver, "List")
            click_text(driver, case_title, list_panel)
            reader_bounds = box(driver, visible(driver, By.CSS_SELECTOR, "section[aria-label='Source reader']"))
            workspace_bounds = box(driver, visible(driver, By.CSS_SELECTOR, "[data-assistant-dock][aria-hidden='false']"))
            assert reader_bounds["right"] <= workspace_bounds["left"], "Reading must leave the workspace alongside the source"
            assert driver.execute_script("return arguments[0].scrollWidth <= arguments[0].clientWidth + 1", list_panel), "Saved passages must fit the narrow workspace"
            driver.save_screenshot(str(output / "19a-narrow-reader.png"))
            driver.set_window_size(1440, 900)

            print("Research pilot: formatted memo, source citation, and passage drop", flush=True)
            list_panel = panel(driver, "List")
            cite = list_panel.find_element(By.CSS_SELECTOR, "button[aria-label^='Cite ']")
            ActionChains(driver).move_to_element(cite.find_element(By.XPATH, "ancestor::summary[1]")).perform()
            driver.execute_script("arguments[0].click()", cite)
            memo = visible(driver, By.CSS_SELECTOR, "section[aria-label='Workspace memo']")
            editor = memo.find_element(By.CSS_SELECTOR, "[contenteditable='true']")
            editor.click(); editor.send_keys(Keys.CONTROL, Keys.END); editor.send_keys(Keys.ENTER)
            editor.send_keys(Keys.CONTROL, "b"); editor.send_keys("Holding")
            editor.send_keys(Keys.CONTROL, "b"); editor.send_keys(" supports ")
            editor.send_keys(Keys.CONTROL, "i"); editor.send_keys("fairness")
            editor.send_keys(Keys.CONTROL, "i"); editor.send_keys(" and ")
            editor.send_keys(Keys.CONTROL, "u"); editor.send_keys("a remedy")
            editor.send_keys(Keys.CONTROL, "u"); editor.send_keys(". "); editor.send_keys(Keys.ENTER)
            drop_target = editor.find_elements(By.TAG_NAME, "p")[-1]
            WebDriverWait(driver, 15).until(lambda _page: len(editor.find_elements(By.CSS_SELECTOR, "[data-citation-ref]")) >= 1)
            saved_passage = research_items(driver, research_id, "passages", source_id)[0]
            driver.execute_script("""
                const target = arguments[0], transfer = new DataTransfer();
                transfer.setData('application/x-beaver-research-passage', JSON.stringify(arguments[1]));
                const rect = target.getBoundingClientRect();
                target.dispatchEvent(new DragEvent('drop', {bubbles: true, cancelable: true,
                    dataTransfer: transfer, clientX: rect.x + 5, clientY: rect.y + 5}));
            """, drop_target, saved_passage)
            WebDriverWait(driver, 15).until(lambda _page: len(editor.find_elements(By.CSS_SELECTOR, "[data-citation-ref]")) >= 2)
            memo.find_element(By.CSS_SELECTOR, "button[aria-label='Table']").click()
            click_text(driver, "Insert table", visible(driver, By.CSS_SELECTOR, "[role='menu'][aria-label='Table']"))
            cells = editor.find_elements(By.CSS_SELECTOR, "th")
            cells[0].click(); cells[0].send_keys("Issue")
            cells[1].click(); cells[1].send_keys("Result")
            WebDriverWait(driver, 30).until(lambda _page: "evidence_id=" in research(driver, research_id)["note"]
                and "Result" in research(driver, research_id)["note"])
            memo_markdown = research(driver, research_id)["note"]
            assert all(text in memo_markdown for text in ("**Holding**", "*fairness*", "++a remedy++", "/sources/view?", "|")), memo_markdown
            assert len([item for item in research_documents(driver) if item["id"] not in existing_research]) == 1
            driver.save_screenshot(str(output / "19b-formatted-memo.png"))
            visible(driver, By.XPATH, "//*[@role='tab' and normalize-space()='Labels']").click()
            drain_resources(driver)
            drain_vitals(driver)
            driver.refresh()
            visible(driver, By.CSS_SELECTOR, "section[aria-label='Research collection']", 90)
            WebDriverWait(driver, 30).until(lambda _page: title in driver.find_element(By.TAG_NAME, "body").text)
            assert not any(node.is_displayed() for node in driver.find_elements(
                By.CSS_SELECTOR, "section[aria-label='Search Saved sources']"))
            panel(driver, "Search Saved sources")
            state = research(driver, research_id)
            queries = research_items(driver, research_id, "queries")
            passages = research_items(driver, research_id, "passages", source_id)
            assert "evidence" not in state
            assert state["queries"]["count"] == len(queries) == 4, (state["queries"], queries)
            assert state["sources"][source_id]["passages"]["count"] == len(passages) >= 1
            assert any(item["note"] == "Passage-level analysis." and len(item["labelIds"]) == 2
                       for item in passages), passages
            assert state["sources"][source_id]["note"] == "Saved with outside click."
            assert state["note"] == memo_markdown
            visible(driver, By.XPATH, "//*[@role='tab' and normalize-space()='Memo']").click()
            restored_memo = visible(driver, By.CSS_SELECTOR, "[contenteditable='true'][aria-label='Workspace memo']")
            assert len(restored_memo.find_elements(By.CSS_SELECTOR, "[data-citation-ref]")) >= 2
            assert all(restored_memo.find_elements(By.CSS_SELECTOR, selector) for selector in ("strong", "em", "u", "table"))
            visible(driver, By.XPATH, "//*[@role='tab' and normalize-space()='Labels']").click()
            driver.save_screenshot(str(output / "20-reload-restored.png"))

            drain_resources(driver)
            drain_vitals(driver)
            driver.get(args.url.rstrip("/") + "/library")
            print("Research pilot: Library preview and persisted collection", flush=True)
            view_button = visible(driver, By.CSS_SELECTOR, f"button[aria-label='View {title}.research.md']")
            assert driver.execute_script("return getComputedStyle(arguments[0]).color === 'rgb(255, 255, 255)'", view_button)
            assert driver.execute_script("return [...document.querySelectorAll('[data-page-search]')].every(input => input.autocomplete === 'off')")
            assert driver.execute_script("""return [...document.querySelectorAll('.document-metadata')].filter(e=>e.getBoundingClientRect().width).every(e=>getComputedStyle(e).textAlign==='center')""")
            driver.save_screenshot(str(output / "20a-library-columns.png"))
            view_button.click()
            preview = visible(driver, By.CSS_SELECTOR, "dialog[open]")
            assert title in preview.text
            box(driver, preview); front(driver, preview)
            expected = ("Duty of fairness", "Remedies", "Hearing rights", "Questions", case_title,
                        "Saved with outside click.")
            WebDriverWait(driver, 30).until(lambda _page: all(value in preview.text for value in expected))
            contents = preview.find_element(By.CSS_SELECTOR, "[aria-label='Workspace contents']").text
            highlight_count = f"{len(passages)} highlight{'' if len(passages) == 1 else 's'}"
            assert all(value in contents for value in ("1 source", highlight_count, "6 labels", "4 searches")), contents
            label_list = preview.find_element(By.CSS_SELECTOR, "ul[aria-label='Labels']")
            duty = label_list.find_element(By.XPATH, ".//span[normalize-space()='Duty of fairness']/ancestor::li[1]")
            for child in ("Remedies", "Hearing rights"):
                nested = label_list.find_element(By.XPATH, f".//span[normalize-space()='{child}']/ancestor::li[1]")
                assert driver.execute_script("return parseFloat(getComputedStyle(arguments[0]).paddingInlineStart)"
                    " > parseFloat(getComputedStyle(arguments[1]).paddingInlineStart)", nested, duty)
            preview.find_element(By.CSS_SELECTOR, "ul[aria-label='Saved sources']")
            assert not preview.find_elements(By.TAG_NAME, "blockquote")
            assert "Passage-level analysis." not in preview.text
            assert not preview.find_elements(By.CSS_SELECTOR, "[aria-label='Research panels']")
            details_toggle = preview.find_element(By.CSS_SELECTOR, "button[aria-controls='document-details']")
            details = preview.find_element(By.ID, "document-details")
            assert details.is_displayed(), "Document metadata should be visible beside the preview"
            driver.save_screenshot(str(output / "21c-library-details.png"))
            driver.execute_cdp_cmd("Emulation.setDeviceMetricsOverride", {
                "width": 390, "height": 800, "deviceScaleFactor": 1, "mobile": False,
            })
            assert not details.is_displayed(), "Narrow previews initially collapse metadata"
            visible(driver, By.CSS_SELECTOR, "button[aria-controls='document-details']").click()
            assert details.is_displayed()
            details_toggle.click()
            assert not details.is_displayed()
            driver.save_screenshot(str(output / "21d-library-details-narrow.png"))
            driver.execute_cdp_cmd("Emulation.setDeviceMetricsOverride", {
                "width": 1440, "height": 1000, "deviceScaleFactor": 1, "mobile": False,
            })
            assert details.is_displayed(), "Wide previews retain visible metadata"
            driver.save_screenshot(str(output / "21-library-preview.png"))
            check_reader_expansion(driver, preview, preview.find_element(By.CSS_SELECTOR, "[aria-label='Workspace contents']"),
                output / "21b-library-expanded.png")
            heading = driver.find_element(By.ID, preview.get_attribute("aria-labelledby"))
            title_text = heading.find_element(By.XPATH, f".//span[not(*) and normalize-space()='{title}']")
            title_slot = title_text.find_element(By.XPATH, "..")
            before_title = title_slot.rect
            metrics = driver.execute_script("const s=getComputedStyle(arguments[0]); return [s.fontSize,s.fontWeight,s.lineHeight]", title_text)
            preview.find_element(By.CSS_SELECTOR, "button[aria-label='Rename document']").click()
            name_input = preview.find_element(By.CSS_SELECTOR, "input[aria-label='Document name']")
            assert all(abs(title_slot.rect[key] - before_title[key]) <= 1 for key in ("y", "height"))
            assert driver.execute_script("return arguments[0].scrollLeft", name_input) <= 1
            assert driver.execute_script("const s=getComputedStyle(arguments[0]); return [s.fontSize,s.fontWeight,s.lineHeight]", name_input) == metrics
            driver.save_screenshot(str(output / "21a-library-rename.png"))
            name_input.send_keys(Keys.ESCAPE)
            assert preview.is_displayed() and not preview.find_elements(By.CSS_SELECTOR, "input[aria-label='Document name']")
            drain_resources(driver)
            drain_vitals(driver)
            preview.find_element(By.LINK_TEXT, "Open in Sources").click()
            WebDriverWait(driver, 30).until(lambda _page: research_id in driver.current_url and title in driver.find_element(By.TAG_NAME, "body").text)
            driver.save_screenshot(str(output / "22-open-in-sources.png"))
            drain_resources(driver)

            resources = drain_resources(driver)
            vitals = drain_vitals(driver)
            interactive = sorted(row["duration"] for row in resources if "/api/source-workspaces/" in row["name"])
            assert interactive, "No research resource timings captured"
            budget_ms = 2000
            (output / "timings.json").write_text(json.dumps(resources, indent=2), encoding="utf-8")
            assert max(interactive) <= budget_ms, {"budgetMs": budget_ms, "durations": interactive}
            severe = [entry for entry in driver.get_log("browser") if entry["level"] == "SEVERE"]
            assert not severe, {"console": severe, "url": driver.current_url}
            failed_requests = [item for item in drain_network(driver)
                               if "/api/" in item["url"] and item["status"] >= 400]
            assert not failed_requests, {"failedRequests": failed_requests}
            cls = [page["cls"] for page in vitals]
            long_tasks = [duration for page in vitals for duration in page["longTasks"]]
            (output / "vitals.json").write_text(json.dumps(vitals, indent=2), encoding="utf-8")
            assert max(cls, default=0) <= .1, {"layoutShifts": cls}
            assert max(long_tasks, default=0) <= 1000, {"longTasks": long_tasks}
            report.update({"ok": True, "researchDocument": research_id, "overlay": moved,
                "chooser": chooser_box, "palette": palette_box, "passagePalette": passage_palette_box,
                "selectedPassage": selected, "sourceDropMs": source_drag_ms,
                "performance": {"budgetMs": budget_ms, "count": len(interactive), "maxMs": round(max(interactive), 1),
                    "p95Ms": round(interactive[min(len(interactive) - 1, int(len(interactive) * .95))], 1),
                    "maxCls": round(max(cls, default=0), 4), "longTaskCount": len(long_tasks),
                    "maxLongTaskMs": round(max(long_tasks, default=0), 1)}})
        except Exception as error:
            driver.save_screenshot(str(output / "failure.png"))
            (output / "failure.html").write_text(driver.page_source, encoding="utf-8")
            (output / "failure-browser.json").write_text(json.dumps({
                "url": driver.current_url, "console": driver.get_log("browser"),
            }, indent=2), encoding="utf-8")
            (output / "timings.json").write_text(json.dumps(drain_resources(driver), indent=2), encoding="utf-8")
            (output / "RESULTS.json").write_text(json.dumps({**report, "ok": False,
                "error": str(error), "url": driver.current_url}, indent=2), encoding="utf-8")
            raise
        finally:
            try:
                if research_id:
                    cleanup = driver.execute_async_script("""const id=arguments[0],done=arguments[1],
url='/api/single-documents/'+encodeURIComponent(id);
fetch(url).then(async current=>{if(!current.ok)return {read:current.status}; const document=await current.json();
const removed=await fetch(url,{method:'DELETE',headers:{'Content-Type':'application/json'},body:JSON.stringify({
  expected_current_version_id:document.current_version_id,
  expected_working_revision:document.current_working_revision,
  expected_project_id:document.project_id,expected_folder_id:document.folder_id??null})});
const verified=await fetch(url); return {delete:removed.status,verify:verified.status};})
  .then(done).catch(error=>done({error:String(error)}));""", research_id)
            finally:
                driver.quit()

    assert cleanup and cleanup.get("delete") in (200, 204) and cleanup.get("verify") == 404, cleanup
    report["cleanup"] = cleanup
    (output / "RESULTS.json").write_text(json.dumps(report, indent=2), encoding="utf-8")
    print(json.dumps(report))


if __name__ == "__main__":
    main()
