from __future__ import annotations

import argparse
import json
import tempfile
import time
from pathlib import Path
from urllib.parse import urlencode

from selenium import webdriver
from selenium.common.exceptions import StaleElementReferenceException
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
            xpath = f".//button[normalize-space()='{text}']"
            node = WebDriverWait(driver, 30).until(lambda _page: next(
                (item for item in root.find_elements(By.XPATH, xpath) if item.is_displayed()), None)) \
                if root else visible(driver, By.XPATH, f"//button[normalize-space()='{text}']")
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
            click_text(driver, "Labels")
        root = visible(driver, By.CSS_SELECTOR, "[aria-label='Label organizer']")
        click_text(driver, "Sources" if name == "Labels" else "Passages", root)
        return root
    if name == "Search Saved sources":
        if not any(node.is_displayed() for node in driver.find_elements(By.CSS_SELECTOR, "section[aria-label='Search Saved sources']")):
            click_text(driver, "Search Saved sources")
        return visible(driver, By.CSS_SELECTOR, "section[aria-label='Search Saved sources']")
    for label in ("Close labels",):
        for button in driver.find_elements(By.CSS_SELECTOR, f"button[aria-label='{label}']"):
            if button.is_displayed(): button.click()
    for button in driver.find_elements(By.XPATH, "//button[normalize-space()='Back to sources']"):
        if button.is_displayed(): button.click()
    return visible(driver, By.CSS_SELECTOR, "section[aria-label='Saved sources']")


def history_count(driver):
    try:
        summary = panel(driver, "Search Saved sources").find_element(
            By.XPATH, ".//summary[contains(normalize-space(),'Search history')]")
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
    return api(driver, f"/api/single-documents/{research_id}/research")["state"]


def research_items(driver, research_id: str, kind: str, source_id=None):
    items, cursor = [], None
    while True:
        query = urlencode({"kind": kind, "limit": 200, **({"source_id": source_id} if source_id else {}),
                           **({"cursor": cursor} if cursor else {})})
        page = api(driver, f"/api/single-documents/{research_id}/research/items?{query}")
        items.extend(item["value"] for item in page["items"])
        cursor = page.get("next_cursor")
        if not cursor:
            return items


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
  .map(({name,duration,initiatorType})=>({name,duration,initiatorType}));
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
            print("Research pilot: Sources search and workspace selection", flush=True)
            driver.get(args.url)
            visible(driver, By.CSS_SELECTOR, "button[aria-label='Expand assistant dock']").click()
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
            click_text(driver, "Close", chooser)
            click_text(driver, "New workspace", workspace)
            name = visible(driver, By.CSS_SELECTOR, "input[name='title'][placeholder='e.g. Duty of care']")
            create_dialog = name.find_element(By.XPATH, "ancestor::dialog[1]")
            assert "Library" in create_dialog.text and "Project" in create_dialog.text and "Location:" not in create_dialog.text
            click_text(driver, "Project", create_dialog)
            visible(driver, By.CSS_SELECTOR, "[role='group'][aria-label='Projects']")
            click_text(driver, "Library", create_dialog)
            name.send_keys(title)
            click_text(driver, "Create workspace", create_dialog)
            WebDriverWait(driver, 30).until(lambda page: not page.find_elements(By.CSS_SELECTOR, "input[name='title']"))
            workspace = visible(driver, By.CSS_SELECTOR, "section[aria-label='Research collection']")
            WebDriverWait(driver, 30).until(lambda _page: title in driver.find_element(By.TAG_NAME, "body").text)
            documents = [item for item in research_documents(driver) if item["id"] not in existing_research]
            assert len(documents) == 1 and documents[0]["filename"] == f"{title}.research.md", documents
            research_id = documents[0]["id"]
            initial_versions = api(driver, f"/api/single-documents/{research_id}/versions")
            assert len(initial_versions["versions"]) == 1, initial_versions
            report["noMagicWorkspace"] = True

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

            visible(driver, By.CSS_SELECTOR, "button[aria-label='Workspace options']").click()
            click_text(driver, "Workspace note", visible(driver, By.CSS_SELECTOR,
                "[role='menu'][aria-label='Workspace options']"))
            note = visible(driver, By.CSS_SELECTOR, "textarea[aria-label='Workspace note']")
            note_dialog = note.find_element(By.XPATH, "ancestor::dialog[1]")
            note.send_keys("Question presented and working theory.")
            click_text(driver, "Done", note_dialog)
            WebDriverWait(driver, 30).until(lambda _page: research(driver, research_id)["note"]
                                            == "Question presented and working theory.")

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
            click_text(driver, "View all", labels)
            create_label(driver, labels, "Remedies", "+ Add label")
            click_text(driver, "View all", labels)
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
            click_text(driver, "View all", labels)

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
            click_text(driver, "View all", labels)
            driver.save_screenshot(str(output / "10-label-tree.png"))

            # Assign an unsaved result, then work with the collection's saved source.
            click_text(driver, "Find sources")
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
            labels.find_element(By.TAG_NAME, "h2").click()
            WebDriverWait(driver, 30).until(lambda _page: research(driver, research_id)["sources"][source_id]["note"]
                                            == "Saved with outside click.")
            assert not driver.find_elements(By.CSS_SELECTOR, "[role='dialog'][aria-label='Labels and note']")
            autosaved_versions = api(driver, f"/api/single-documents/{research_id}/versions")
            assert autosaved_versions["current_version_id"] == initial_versions["current_version_id"]
            assert len(autosaved_versions["versions"]) == len(initial_versions["versions"]), autosaved_versions

            # Saved markers remain fixed while drag-and-drop adds another ontology path.
            list_panel = panel(driver, "List")
            labels = panel(driver, "Labels")
            WebDriverWait(driver, 30).until(lambda _page: list_panel.find_elements(By.CSS_SELECTOR, "button[draggable='true']"))
            source_marker = list_panel.find_element(By.CSS_SELECTOR, "button[draggable='true']")
            icon_before = source_marker.find_element(By.CSS_SELECTOR, "svg[role='group']").rect.copy()
            color_before = source_marker.find_element(By.CSS_SELECTOR, "[data-label-layer='primary']").get_attribute("fill")
            ActionChains(driver).drag_and_drop(source_marker, label_row(labels, "Remedies")).perform()
            WebDriverWait(driver, 30).until(lambda _page: len(research(driver, research_id)["sources"][source_id]["labelIds"]) == 2)
            source_marker = list_panel.find_element(By.CSS_SELECTOR, "button[draggable='true']")
            icon_after = source_marker.find_element(By.CSS_SELECTOR, "svg[role='group']")
            assert icon_after.get_attribute("aria-label")
            assert icon_after.find_element(By.CSS_SELECTOR, "[data-label-layer='primary']").get_attribute("fill") != color_before
            assert all(abs(icon_before[key] - icon_after.rect[key]) <= 1 for key in ("x", "y", "width", "height"))
            driver.save_screenshot(str(output / "12-saved-source-drop.png"))

            # At minimum width, list controls stay on one line and every menu stays above the workspace.
            panel(driver, "List")
            driver.set_window_size(600, 700)
            WebDriverWait(driver, 10).until(lambda _page: workspace.rect["width"] < 600)
            research_panels = workspace.find_element(By.CSS_SELECTOR, "section[aria-label='Saved sources']")
            assert driver.execute_script("return arguments[0].scrollWidth<=arguments[0].clientWidth+1", research_panels)
            list_panel = panel(driver, "List")
            list_panel.find_element(By.XPATH, ".//summary[starts-with(normalize-space(),'Filters')]").click()
            filters = [list_panel.find_element(By.CSS_SELECTOR, f"button[aria-label='{name}']") for name in
                       ("Filter source type", "Filter collection", "Filter year")]
            filter_boxes = [box(driver, node) for node in filters]
            assert abs(filter_boxes[0]["top"] - filter_boxes[2]["top"]) <= 1
            assert abs(filter_boxes[1]["top"] - filter_boxes[0]["top"]) <= 1
            assert all(driver.execute_script("const s=getComputedStyle(arguments[0]);return s.whiteSpace==='nowrap'&&arguments[0].scrollHeight<=arguments[0].clientHeight+1", node)
                       for node in filters)
            for index, trigger in enumerate(filters):
                label = trigger.get_attribute("aria-label")
                trigger.click()
                menu = visible(driver, By.CSS_SELECTOR, f"[role='menu'][aria-label='{label}']")
                box(driver, menu); front(driver, menu)
                if not index:
                    driver.save_screenshot(str(output / "13-narrow-list-menu.png"))
                next(node for node in menu.find_elements(By.TAG_NAME, "button") if node.is_displayed()).click()
                ActionChains(driver).send_keys(Keys.ESCAPE).perform()
            list_panel.find_element(By.CSS_SELECTOR, "button[aria-label='Sort sources']").click()
            sort_menu = visible(driver, By.CSS_SELECTOR, "[role='menu'][aria-label='Sort sources']")
            box(driver, sort_menu); front(driver, sort_menu)
            driver.save_screenshot(str(output / "13-narrow-sort-menu.png"))
            next(node for node in sort_menu.find_elements(By.TAG_NAME, "button") if "A" in node.text and "Z" in node.text).click()
            driver.save_screenshot(str(output / "14-narrow-workspace.png"))
            driver.set_window_size(1440, 900)
            WebDriverWait(driver, 10).until(lambda _page: workspace.rect["width"] > 600)

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

            search_saved.find_element(By.CSS_SELECTOR, "button[aria-label='Search target']").click()
            target_menu = visible(driver, By.CSS_SELECTOR, "[role='menu'][aria-label='Search target']")
            box(driver, target_menu); front(driver, target_menu)
            click_text(driver, "Saved passages", target_menu)
            click_text(driver, "Find passages", search_saved)
            WebDriverWait(driver, 90).until(lambda page: history_count(page) == 2)
            search_saved = panel(driver, "Search Saved sources")
            search_saved.find_element(By.CSS_SELECTOR, "button[aria-label='Search target']").click()
            click_text(driver, "Source text", visible(driver, By.CSS_SELECTOR, "[role='menu'][aria-label='Search target']"))
            click_text(driver, "Add rule", search_saved)
            rule_modal = visible(driver, By.CSS_SELECTOR, "dialog[open]")
            box(driver, rule_modal); front(driver, rule_modal)
            phrase = rule_modal.find_element(By.XPATH,
                ".//label[starts-with(normalize-space(.),'Phrase to find')]/input")
            phrase.click(); phrase.send_keys("court")
            for label, choice in (("Direction", "Before phrase"), ("Unit", "Paragraph")):
                rule_modal.find_element(By.CSS_SELECTOR, f"button[aria-label='{label}']").click()
                menu = visible(driver, By.CSS_SELECTOR, f"[role='menu'][aria-label='{label}']")
                box(driver, menu); front(driver, menu); click_text(driver, choice, menu)
            driver.save_screenshot(str(output / "15-capture-rule.png"))
            click_text(driver, "Run rules", rule_modal)
            WebDriverWait(driver, 90).until(lambda page: history_count(page) == 3)
            search_saved = panel(driver, "Search Saved sources")
            search_saved.find_element(By.CSS_SELECTOR, "button[aria-label='Conflict policy']").click()
            conflict_menu = visible(driver, By.CSS_SELECTOR, "[role='menu'][aria-label='Conflict policy']")
            box(driver, conflict_menu); front(driver, conflict_menu)
            driver.save_screenshot(str(output / "15-conflict-menu.png"))
            click_text(driver, "Keep both", conflict_menu)
            WebDriverWait(driver, 10).until(lambda _page: "Keep both" in panel(driver, "Search Saved sources")
                .find_element(By.CSS_SELECTOR, "button[aria-label='Conflict policy']").text)
            click_text(driver, "Run rules", search_saved)
            WebDriverWait(driver, 90).until(lambda page: history_count(page) == 4)
            search_saved = panel(driver, "Search Saved sources")
            history = search_saved.find_element(By.XPATH, ".//details[summary[contains(normalize-space(),'Search history')]]")
            assert not history.get_attribute("open")
            history.find_element(By.TAG_NAME, "summary").click()
            queries = WebDriverWait(driver, 10).until(lambda _page: history.find_elements(By.TAG_NAME, "details"))
            capture = next(node for node in queries
                if "court" in node.find_element(By.TAG_NAME, "summary").text.lower())
            capture.find_element(By.TAG_NAME, "summary").click()
            WebDriverWait(driver, 10).until(lambda _page:
                capture.find_elements(By.XPATH, ".//button[normalize-space()='Use these rules']"))
            click_text(driver, "Use these rules", capture)
            driver.save_screenshot(str(output / "16-search-receipts.png"))

            # A direct journal search renders its title once, not again as metadata.
            print("Research pilot: journal results and source reading", flush=True)
            click_text(driver, "Find sources")
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
            click_text(driver, "Remove source", source_details)
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
            resize = dock.find_element(By.CSS_SELECTOR, "[role='separator'][aria-label='Resize assistant dock']")
            dock_width = dock.rect["width"]
            resize.click(); resize.send_keys(Keys.ARROW_RIGHT)
            WebDriverWait(driver, 10).until(lambda _page: dock.rect["width"] < dock_width)
            resize.send_keys(Keys.ARROW_LEFT)
            WebDriverWait(driver, 10).until(lambda _page: dock.rect["width"] >= dock_width - 1)

            panel(driver, "List")
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
            assert state["note"] == "Question presented and working theory."
            driver.save_screenshot(str(output / "20-reload-restored.png"))

            drain_resources(driver)
            drain_vitals(driver)
            driver.get(args.url.rstrip("/") + "/library")
            print("Research pilot: Library preview and persisted collection", flush=True)
            visible(driver, By.CSS_SELECTOR, f"button[aria-label='View {title}.research.md']").click()
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
            driver.save_screenshot(str(output / "21-library-preview.png"))
            icon = preview.find_element(By.CSS_SELECTOR, "svg[data-file-kind='research']")
            title_slot = icon.find_element(By.XPATH, "..")
            before_title, before_icon = title_slot.rect, icon.rect
            title_text = title_slot.find_element(By.XPATH, "./span[last()]")
            metrics = driver.execute_script("const s=getComputedStyle(arguments[0]); return [s.fontSize,s.fontWeight,s.lineHeight]", title_text)
            preview.find_element(By.CSS_SELECTOR, "button[aria-label='Rename document']").click()
            name_input = preview.find_element(By.CSS_SELECTOR, "input[aria-label='Document name']")
            assert all(abs(title_slot.rect[key] - before_title[key]) <= 1 for key in ("y", "height"))
            assert abs(icon.rect["y"] - before_icon["y"]) <= 1
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
            interactive = sorted(row["duration"] for row in resources if "/api/single-documents/" in row["name"]
                                 and (row["name"].endswith("/research") or "/research/actions" in row["name"]))
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
