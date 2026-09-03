from __future__ import annotations

import argparse
import json
import tempfile
import time
from pathlib import Path

from selenium import webdriver
from selenium.webdriver import ActionChains, Keys
from selenium.webdriver.common.by import By
from selenium.common.exceptions import StaleElementReferenceException
from selenium.webdriver.chrome.service import Service
from selenium.webdriver.support.ui import WebDriverWait


def visible(driver, by: str, value: str):
    return WebDriverWait(driver, 30).until(lambda page: next(
        (node for node in page.find_elements(by, value) if node.is_displayed()), None))


def click_text(driver, text: str, root=None):
    for _attempt in range(3):
        try:
            path = f".//button[normalize-space()='{text}']"
            node = WebDriverWait(driver, 30).until(lambda _page: next(
                (item for item in root.find_elements(By.XPATH, path) if item.is_displayed()), None)) if root else \
                visible(driver, By.XPATH, f"//button[normalize-space()='{text}']")
            WebDriverWait(driver, 30).until(lambda _page: node.is_enabled())
            driver.execute_script("arguments[0].scrollIntoView({block:'center'})", node)
            return node.click()
        except StaleElementReferenceException:
            if root is not None:
                raise
    raise AssertionError(f"Could not click {text}")


def panel(driver, name: str):
    return visible(driver, By.XPATH, f"//section[header//h2[starts-with(normalize-space(),'{name}')]]")
    return visible(driver, By.XPATH, f"//section[header//h2[normalize-space()='{name}' or starts-with(normalize-space(),'{name} ·')]]")


def box(driver, node):
    value = driver.execute_script("""const r=arguments[0].getBoundingClientRect();
return {left:r.left,top:r.top,right:r.right,bottom:r.bottom,width:r.width,height:r.height,
  viewportWidth:innerWidth,viewportHeight:innerHeight};""", node)
    assert value["left"] >= -1 and value["top"] >= -1, value
    assert value["right"] <= value["viewportWidth"] + 1, value
    assert value["bottom"] <= value["viewportHeight"] + 1, value
    return value


def network_status(driver, fragment: str):
    for entry in driver.get_log("performance"):
        event = json.loads(entry["message"])["message"]
        if event.get("method") == "Network.responseReceived":
            response = event["params"]["response"]
            if fragment in response.get("url", ""):
                return int(response["status"])
    return None


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
    multi_highlight = False
    report: dict[str, object] = {"title": title, "screenshots": str(output), "failures": []}

    with tempfile.TemporaryDirectory(prefix="beaver-chrome-") as profile:
        options = webdriver.ChromeOptions()
        if not args.headed:
            options.add_argument("--headless=new")
        options.add_argument(f"--user-data-dir={profile}")
        options.add_argument("--window-size=1440,900")
        options.add_experimental_option("prefs", {"download.default_directory": str(output.resolve()),
            "download.prompt_for_download": False})
        options.set_capability("goog:loggingPrefs", {"performance": "ALL", "browser": "ALL"})
        cached = list((Path.home() / ".cache/selenium/chromedriver/win64").glob("*/chromedriver.exe"))
        service = Service(str(max(cached, key=lambda path: tuple(map(int, path.parent.name.split(".")))))) if cached else Service()
        driver = webdriver.Chrome(service=service, options=options)
        try:
            driver.get(args.url)
            visible(driver, By.CSS_SELECTOR, "button[aria-label='Expand assistant dock']").click()
            visible(driver, By.XPATH, "//*[@role='tab' and normalize-space()='Sources']").click()

            search = visible(driver, By.CSS_SELECTOR, "input[aria-label='Search sources']")
            driver.get_log("browser")  # Ignore errors from tabs restored before this isolated run.
            help_button = visible(driver, By.CSS_SELECTOR, "button[aria-label='Boolean search help']")
            help_button.click()
            help = visible(driver, By.CSS_SELECTOR, "[role='tooltip']:popover-open")
            help_box, help_anchor = box(driver, help), box(driver, help_button)
            assert abs(help_box["right"] - help_anchor["right"]) < 16, (help_box, help_anchor)
            driver.save_screenshot(str(output / "01-embedded-help.png"))
            ActionChains(driver).send_keys(Keys.ESCAPE).perform()

            click_text(driver, "Workspace")
            workspace = visible(driver, By.CSS_SELECTOR, "[role='dialog'][aria-label='Research workspace']")
            start = box(driver, workspace)
            header = workspace.find_element(By.TAG_NAME, "header")
            ActionChains(driver).drag_and_drop_by_offset(
                header.find_element(By.CSS_SELECTOR, "svg.lucide-grip-horizontal"), -48, 24).perform()
            moved = box(driver, workspace)
            assert abs(moved["left"] - start["left"]) > 20, (start, moved)
            driver.save_screenshot(str(output / "02-floating-workspace.png"))

            workspace.find_element(By.CSS_SELECTOR, "button[title='Open or create a research file']").click()
            chooser = visible(driver, By.CSS_SELECTOR, "dialog[open]")
            chooser_box = box(driver, chooser)
            click_text(driver, "New folder", chooser)
            folder_name = visible(driver, By.CSS_SELECTOR, "input[name='name']")
            folder_dialog = folder_name.find_element(By.XPATH, "ancestor::dialog")
            driver.save_screenshot(str(output / "02-new-folder.png"))
            click_text(driver, "Cancel", folder_dialog)
            click_text(driver, "New project", chooser)
            project_name = visible(driver, By.CSS_SELECTOR, "input[name='name'][placeholder='Add project name']")
            project_dialog = project_name.find_element(By.XPATH, "ancestor::dialog")
            driver.save_screenshot(str(output / "02-new-project.png"))
            project_dialog.find_element(By.CSS_SELECTOR, "button[aria-label='Close']").click()
            driver.save_screenshot(str(output / "02-file-chooser.png"))
            click_text(driver, "New workspace", chooser)
            create_name = visible(driver, By.CSS_SELECTOR, "input[name='title'][placeholder='e.g. Duty of care']")
            create_dialog = create_name.find_element(By.XPATH, "ancestor::dialog")
            assert "Save in" in create_dialog.text
            driver.save_screenshot(str(output / "02-new-workspace.png"))
            create_name.send_keys(title)
            click_text(driver, "Create workspace", create_dialog)
            WebDriverWait(driver, 30).until(lambda page: not page.find_elements(By.CSS_SELECTOR, "dialog[open]"))
            WebDriverWait(driver, 30).until(lambda page: title in workspace.text)
            research_id = driver.execute_async_script("""const title=arguments[0],done=arguments[1];
fetch('/api/library/files?q='+encodeURIComponent(title)).then(r=>r.json()).then(page=>
  done(page.items.find(x=>x.kind==='document'&&x.document.filename===title+'.research.md')?.document.id||null)
).catch(error=>done({error:String(error)}));""", title)
            assert isinstance(research_id, str), research_id

            labels_panel, list_panel = panel(driver, "Labels"), panel(driver, "List")
            ActionChains(driver).drag_and_drop(
                labels_panel.find_element(By.TAG_NAME, "header"), list_panel).perform()
            WebDriverWait(driver, 10).until(lambda page: page.find_elements(
                By.CSS_SELECTOR, "button[aria-label='Restore Labels panel']"))
            assert not driver.find_elements(By.XPATH, "//section[header//h2[normalize-space()='List']]")
            driver.save_screenshot(str(output / "03-panel-drag-expanded.png"))
            workspace.find_element(By.CSS_SELECTOR, "button[aria-label='Restore Labels panel']").click()
            WebDriverWait(driver, 10).until(lambda _page: panel(driver, "List").is_displayed())

            workspace.find_element(By.CSS_SELECTOR, "button[aria-label='Close List panel']").click()
            workspace.find_element(By.CSS_SELECTOR, "button[aria-label='Add panel to slot 2']").click()
            click_text(driver, "Expand Labels", visible(driver, By.CSS_SELECTOR, "[role='menu'][aria-label='Add panel to slot 2']"))
            WebDriverWait(driver, 10).until(lambda page: not page.find_elements(
                By.XPATH, "//section[header//h2[normalize-space()='List']]"))
            driver.save_screenshot(str(output / "03-panel-expanded.png"))
            workspace.find_element(By.CSS_SELECTOR, "button[aria-label='Restore Labels panel']").click()
            workspace.find_element(By.CSS_SELECTOR, "button[aria-label='Add panel to slot 2']").click()
            click_text(driver, "List", visible(driver, By.CSS_SELECTOR, "[role='menu'][aria-label='Add panel to slot 2']"))

            workspace.find_element(By.CSS_SELECTOR, "button[aria-label='Close Highlights panel']").click()
            add_panel = visible(driver, By.CSS_SELECTOR, "button[aria-label='Add panel to slot 3']")
            add_panel.click()
            add_menu = visible(driver, By.CSS_SELECTOR, "[role='menu'][aria-label='Add panel to slot 3']")
            box(driver, add_menu)
            driver.save_screenshot(str(output / "04-panel-picker.png"))
            click_text(driver, "Highlights", add_menu)

            labels = panel(driver, "Labels")
            click_text(driver, "+ Add label", labels)
            WebDriverWait(driver, 30).until(lambda page: panel(page, "Labels").find_element(
                By.CSS_SELECTOR, "input[aria-label='Label name']").get_attribute("value") == "New label")
            name = labels.find_element(By.CSS_SELECTOR, "input[aria-label='Label name']")
            name.send_keys(Keys.CONTROL, "a"); name.send_keys("Procedural fairness")
            click_text(driver, "Done", labels)
            click_text(driver, "+ Add label", labels)
            name = WebDriverWait(driver, 30).until(lambda _page: labels.find_element(By.CSS_SELECTOR, "input[aria-label='Label name']"))
            name.send_keys(Keys.CONTROL, "a"); name.send_keys("Remedies")
            click_text(driver, "Done", labels)
            WebDriverWait(driver, 30).until(lambda page: panel(page, "Labels").find_element(
                By.CSS_SELECTOR, "button[aria-label^='Remedies,']"))
            highlights = panel(driver, "Highlights")
            click_text(driver, "+ Add category", highlights)
            name = WebDriverWait(driver, 30).until(lambda _page: highlights.find_element(By.CSS_SELECTOR, "input[aria-label='Label name']"))
            name.send_keys(Keys.CONTROL, "a"); name.send_keys("Key passage")
            click_text(driver, "Done", highlights)
            WebDriverWait(driver, 30).until(lambda page: panel(page, "Highlights").find_element(
                By.CSS_SELECTOR, "button[aria-label^='Key passage,']"))
            driver.save_screenshot(str(output / "05-label-and-highlight-trees.png"))

            # Labels are durable editable trees, not decorative chips.
            fairness_icon = labels.find_element(By.XPATH,
                ".//button[starts-with(@aria-label,'Procedural fairness,')]/ancestor::div[@draggable='true']//label/*[name()='svg']")
            icon_before = fairness_icon.rect.copy()
            labels.find_element(By.CSS_SELECTOR, "button[aria-label='Edit Procedural fairness']").click()
            icon_editing = labels.find_element(By.CSS_SELECTOR, "input[aria-label='Procedural fairness color']").find_element(
                By.XPATH, "preceding-sibling::*[name()='svg']")
            assert all(abs(icon_editing.rect[key] - icon_before[key]) <= 1 for key in ("x", "y", "width", "height")), (
                icon_before, icon_editing.rect)
            driver.execute_script("""Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(arguments[0],'#dc2626');
arguments[0].dispatchEvent(new Event('input',{bubbles:true})); arguments[0].dispatchEvent(new Event('change',{bubbles:true}));""",
                labels.find_element(By.CSS_SELECTOR, "input[aria-label='Procedural fairness color']"))
            label_name = labels.find_element(By.CSS_SELECTOR, "input[aria-label='Label name']")
            label_name.send_keys(Keys.CONTROL, "a")
            label_name.send_keys("Duty of fairness")
            click_text(driver, "Done", labels)
            fairness = WebDriverWait(driver, 30).until(lambda _page: next((node for node in labels.find_elements(
                By.CSS_SELECTOR, "button[aria-label^='Duty of fairness,']") if node.is_displayed()), None))
            driver.execute_script("""Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(arguments[0],'#7c3aed');
arguments[0].dispatchEvent(new Event('input',{bubbles:true})); arguments[0].dispatchEvent(new Event('change',{bubbles:true}));""",
                labels.find_element(By.CSS_SELECTOR, "input[aria-label='Remedies color']"))
            fairness.click()
            click_text(driver, "+ Add label", labels)
            name = WebDriverWait(driver, 30).until(lambda _page: labels.find_element(By.CSS_SELECTOR, "input[aria-label='Label name']"))
            name.send_keys(Keys.CONTROL, "a"); name.send_keys("Hearing rights")
            click_text(driver, "Done", labels)
            WebDriverWait(driver, 30).until(lambda _page: next((node for node in labels.find_elements(
                By.CSS_SELECTOR, "button[aria-label^='Hearing rights,']") if node.is_displayed()), None))
            label_state = driver.execute_async_script("fetch('/api/single-documents/'+arguments[0]+'/research').then(r=>r.json()).then(x=>arguments[1](x.state.labels))", research_id)
            parent_id = next(id for id, item in label_state.items() if item["name"] == "Duty of fairness")
            if next(item for item in label_state.values() if item["name"] == "Hearing rights")["parentId"] != parent_id:
                report["failures"].append("Adding a label while its intended parent is selected creates another root")
            label_search = labels.find_element(By.CSS_SELECTOR, "input[aria-label='Search labels']")
            label_search.send_keys("Hearing")
            assert "Hearing rights" in labels.text and "Remedies" not in labels.text, labels.text
            label_search.send_keys(Keys.CONTROL, "a", Keys.BACKSPACE)
            labels.find_element(By.CSS_SELECTOR, "button[aria-label^='Hearing rights,']").click()
            labels.find_element(By.CSS_SELECTOR, "button[aria-label='Delete selected label']").click()
            WebDriverWait(driver, 30).until(lambda _page: "Hearing rights" not in labels.text)
            click_text(driver, "View all", labels)
            remedy_row = labels.find_element(By.XPATH, ".//button[starts-with(@aria-label,'Remedies,')]/ancestor::div[@draggable='true']")
            fairness_row = labels.find_element(By.XPATH, ".//button[starts-with(@aria-label,'Duty of fairness,')]/ancestor::div[@draggable='true']")
            ActionChains(driver).move_to_element(remedy_row).click_and_hold().move_to_element_with_offset(
                fairness_row, int(fairness_row.rect["width"] * .35), 0).release().perform()
            try:
                WebDriverWait(driver, 10).until(lambda _page: next(item for item in driver.execute_async_script(
                    "fetch('/api/single-documents/'+arguments[0]+'/research').then(r=>r.json()).then(x=>arguments[1](x.state.labels))", research_id).values()
                    if item["name"] == "Remedies")["parentId"] == parent_id)
            except Exception:
                report["failures"].append("Dragging a root label to the right side of another label does not nest it")
            click_text(driver, "View all", labels)
            click_text(driver, "+ Add label", labels)
            name = WebDriverWait(driver, 30).until(lambda _page: labels.find_element(By.CSS_SELECTOR, "input[aria-label='Label name']"))
            name.send_keys(Keys.CONTROL, "a"); name.send_keys("Questions")
            click_text(driver, "Done", labels)
            question_color = WebDriverWait(driver, 30).until(lambda _page: next(iter(labels.find_elements(
                By.CSS_SELECTOR, "input[aria-label='Questions color']")), None))
            driver.execute_script("""Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(arguments[0],'#047857');
arguments[0].dispatchEvent(new Event('input',{bubbles:true})); arguments[0].dispatchEvent(new Event('change',{bubbles:true}));""",
                question_color)
            driver.save_screenshot(str(output / "05-nested-label-drag.png"))

            driver.set_window_size(600, 700)
            WebDriverWait(driver, 10).until(lambda _page: workspace.rect["width"] < 600)
            research_panels = workspace.find_element(By.CSS_SELECTOR, "[aria-label='Research panels']")
            assert driver.execute_script("return arguments[0].scrollWidth <= arguments[0].clientWidth + 1", research_panels)
            driver.save_screenshot(str(output / "05-narrow-workspace.png"))
            driver.set_window_size(1440, 900)
            driver.execute_script("arguments[0].style.width='720px'", workspace)
            WebDriverWait(driver, 10).until(lambda _page: workspace.rect["width"] > 700)

            workspace.find_element(By.CSS_SELECTOR, "button[aria-label='Close research workspace']").click()
            search.send_keys("2016 SCC 27")
            click_text(driver, "Search")
            WebDriverWait(driver, 90).until(lambda page: page.find_elements(By.CSS_SELECTOR, "article"))
            report["searchStatus"] = network_status(driver, "/api/sources/search")
            assert report["searchStatus"] == 200, report
            focus = driver.execute_script("""const s=getComputedStyle(arguments[0].parentElement);
return {border:s.borderColor,shadow:s.boxShadow};""", search)
            assert focus["border"] not in ("rgb(37, 99, 235)", "rgb(59, 130, 246)"), focus

            label_button = visible(driver, By.XPATH,
                "(//article//button[starts-with(@aria-label,'Label ')])[1]")
            driver.execute_script("arguments[0].scrollIntoView({block:'center'})", label_button)
            label_box = box(driver, label_button)
            marker_box = box(driver, label_button.find_element(By.CSS_SELECTOR, "svg[role='group']"))
            visible(driver, By.XPATH, "(//article//button[starts-with(@aria-label,'Label ')])[1]").click()
            palette = visible(driver, By.CSS_SELECTOR, "[popover]:popover-open")
            palette_box = box(driver, palette)
            assert palette_box["right"] <= label_box["left"] + 1 or palette_box["left"] >= label_box["right"] - 1, (palette_box, label_box)
            click_text(driver, "Duty of fairness", palette)
            click_text(driver, "Remedies", palette)
            palette.find_element(By.CSS_SELECTOR, "button[aria-label='Add an extra label']").click()
            click_text(driver, "Duty of fairness", palette)
            badge_color = palette.find_element(By.CSS_SELECTOR, "input[aria-label='Badge color']")
            driver.execute_script("""Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(arguments[0],'#7c3aed');
arguments[0].dispatchEvent(new Event('input',{bubbles:true}));
arguments[0].dispatchEvent(new Event('change',{bubbles:true}));""", badge_color)
            palette.find_element(By.CSS_SELECTOR, "#research-badge").send_keys("Leading case")
            palette.find_element(By.CSS_SELECTOR, "textarea[aria-label='Item note']").send_keys(
                "Explains the framework and its application.")
            driver.save_screenshot(str(output / "06-anchored-circle-palette.png"))
            click_text(driver, "Save", palette)
            WebDriverWait(driver, 30).until(lambda page: not page.find_elements(By.CSS_SELECTOR, "[popover]:popover-open"))
            assert "Leading case" in driver.find_elements(By.CSS_SELECTOR, "article")[0].text
            saved_marker = visible(driver, By.XPATH,
                "(//article//button[starts-with(@aria-label,'Label ')])[1]/*[name()='svg' and @role='group']")
            saved_marker_box = box(driver, saved_marker)
            assert all(abs(saved_marker_box[key] - marker_box[key]) <= 1 for key in ("left", "top", "width", "height")), (
                marker_box, saved_marker_box)

            # Slot order is the display order; clearing one slot must preserve the rest.
            visible(driver, By.XPATH, "(//article//button[starts-with(@aria-label,'Label ')])[1]").click()
            palette = visible(driver, By.CSS_SELECTOR, "[popover]:popover-open")
            palette.find_element(By.CSS_SELECTOR, "button[aria-label='Extra label 1']").click()
            click_text(driver, "Set as display label", palette)
            driver.save_screenshot(str(output / "06-display-label-order.png"))
            click_text(driver, "Save", palette)
            WebDriverWait(driver, 30).until(lambda _page: not driver.find_elements(By.CSS_SELECTOR, "[popover]:popover-open"))
            state = driver.execute_async_script("fetch('/api/single-documents/'+arguments[0]+'/research').then(r=>r.json()).then(x=>arguments[1](x.state))", research_id)
            source_state = next(iter(state["sources"].values()))
            assert len(source_state["labelIds"]) == 2 and source_state["badge"] == "Leading case" and source_state["badgeColor"] == "#7c3aed", source_state
            visible(driver, By.XPATH, "(//article//button[starts-with(@aria-label,'Label ')])[1]").click()
            palette = visible(driver, By.CSS_SELECTOR, "[popover]:popover-open")
            palette.find_element(By.CSS_SELECTOR, "button[aria-label='Extra label 1']").click()
            click_text(driver, "Clear this slot", palette)
            driver.save_screenshot(str(output / "06-clear-label-slot.png"))
            click_text(driver, "Save", palette)
            try:
                WebDriverWait(driver, 10).until(lambda _page: not driver.find_elements(By.CSS_SELECTOR, "[popover]:popover-open"))
            except Exception:
                report["failures"].append("Clearing an extra source-label slot and saving leaves the palette open")
                driver.save_screenshot(str(output / "06-clear-slot-failed.png"))
                click_text(driver, "Cancel", palette)
            visible(driver, By.XPATH, "(//article//button[starts-with(@aria-label,'Label ')])[1]").click()
            visible(driver, By.CSS_SELECTOR, "[popover]:popover-open")
            ActionChains(driver).send_keys(Keys.ESCAPE).perform()
            WebDriverWait(driver, 10).until(lambda _page: not driver.find_elements(By.CSS_SELECTOR, "[popover]:popover-open"))

            click_text(driver, "Workspace")
            workspace = visible(driver, By.CSS_SELECTOR, "[role='dialog'][aria-label='Research workspace']")
            WebDriverWait(driver, 30).until(lambda page: "Leading case" in panel(page, "List").text)
            list_panel = panel(driver, "List")
            source_circle = list_panel.find_element(By.CSS_SELECTOR, "button[draggable='true']")
            source_marker = source_circle.find_element(By.CSS_SELECTOR, "[data-label-layer='primary']")
            marker_before = source_marker.rect.copy()
            color_before = source_marker.get_attribute("fill")
            target_row = panel(driver, "Labels").find_element(By.XPATH,
                ".//button[starts-with(@aria-label,'Questions,')]/ancestor::div[@draggable='true']")
            ActionChains(driver).drag_and_drop(source_circle, target_row).perform()
            try:
                WebDriverWait(driver, 10).until(lambda _page: len(next(iter(driver.execute_async_script(
                    "fetch('/api/single-documents/'+arguments[0]+'/research').then(r=>r.json()).then(x=>arguments[1](x.state.sources))", research_id).values()))["labelIds"]) == 2)
            except Exception:
                report["failures"].append("Dragging a saved source onto a label does not add that label")
            source_marker = panel(driver, "List").find_element(By.CSS_SELECTOR,
                "button[draggable='true'] [data-label-layer='primary']")
            assert source_marker.get_attribute("fill") != color_before
            assert all(abs(source_marker.rect[key] - marker_before[key]) <= 1 for key in ("x", "y", "width", "height")), (
                marker_before, source_marker.rect)
            driver.save_screenshot(str(output / "07-circle-dropped-in-folder.png"))
            highlights = panel(driver, "Highlights")
            click_text(driver, "+ Add category", highlights)
            name = WebDriverWait(driver, 30).until(lambda _page: highlights.find_element(By.CSS_SELECTOR, "input[aria-label='Label name']"))
            name.send_keys(Keys.CONTROL, "a"); name.send_keys("Contrary evidence")
            click_text(driver, "Done", highlights)
            try:
                WebDriverWait(driver, 10).until(lambda _page: "Contrary evidence" in highlights.text)
                multi_highlight = True
            except Exception:
                report["failures"].append("Adding a highlight category after source-label edits does not persist")
                driver.save_screenshot(str(output / "07-add-highlight-failed.png"))
            list_panel.find_element(By.CSS_SELECTOR, "input[aria-label='Search list']").send_keys("not-a-real-case")
            assert "0 sources" in list_panel.text
            list_panel.find_element(By.CSS_SELECTOR, "input[aria-label='Search list']").send_keys(Keys.CONTROL, "a", Keys.BACKSPACE)
            for index, selector in enumerate(("Filter source type", "Filter year", "Filter jurisdiction")):
                list_panel.find_element(By.CSS_SELECTOR, f"button[aria-label='{selector}']").click()
                menu = visible(driver, By.CSS_SELECTOR, f"[role='menu'][aria-label='{selector}']")
                if index == 0:
                    driver.save_screenshot(str(output / "07-list-filter-menu.png"))
                next(item for item in menu.find_elements(By.TAG_NAME, "button") if item.is_displayed()).click()
            assert "1 sources" in list_panel.text, list_panel.text
            list_panel.find_element(By.CSS_SELECTOR, "button[aria-label='Sort sources']").click()
            click_text(driver, "A–Z", visible(driver, By.CSS_SELECTOR, "[role='menu'][aria-label='Sort sources']"))
            driver.save_screenshot(str(output / "07-list-filters.png"))
            list_panel = panel(driver, "List")
            search_saved = panel(driver, "Search Saved sources")
            search_saved.find_element(By.CSS_SELECTOR, "button[aria-label='Search syntax']").click()
            click_text(driver, "All terms", visible(driver, By.CSS_SELECTOR, "[role='menu'][aria-label='Search syntax']"))
            search_saved.find_element(By.CSS_SELECTOR, "button[aria-label='Search target']").click()
            click_text(driver, "Saved passages", visible(driver, By.CSS_SELECTOR, "[role='menu'][aria-label='Search target']"))
            search_saved.find_element(By.CSS_SELECTOR, "button[aria-label='Search target']").click()
            click_text(driver, "Source text", visible(driver, By.CSS_SELECTOR, "[role='menu'][aria-label='Search target']"))
            search_saved.find_element(By.CSS_SELECTOR, "input[aria-label='Search saved source text']").send_keys("court")
            click_text(driver, "Find passages", search_saved)
            WebDriverWait(driver, 90).until(lambda _page: any(node.text.strip().endswith("1") for node in
                search_saved.find_elements(By.XPATH, ".//summary[contains(normalize-space(),'Search history')]")))
            click_text(driver, "Add rule", search_saved)
            rule_modal = visible(driver, By.CSS_SELECTOR, "dialog[open]")
            rule_modal.find_element(By.CSS_SELECTOR, "#research-rule-form input").send_keys("court")
            rule_modal.find_element(By.CSS_SELECTOR, "button[aria-label='Direction']").click()
            click_text(driver, "Before phrase", visible(driver, By.CSS_SELECTOR, "[role='menu'][aria-label='Direction']"))
            rule_modal.find_element(By.CSS_SELECTOR, "button[aria-label='Unit']").click()
            click_text(driver, "Paragraph", visible(driver, By.CSS_SELECTOR, "[role='menu'][aria-label='Unit']"))
            driver.save_screenshot(str(output / "08-capture-rule-modal.png"))
            click_text(driver, "Save rule", rule_modal)
            WebDriverWait(driver, 30).until(lambda _page: not driver.find_elements(By.CSS_SELECTOR, "#research-rule-form"))
            search_saved = panel(driver, "Search Saved sources")
            search_saved.find_element(By.CSS_SELECTOR, "button[aria-label='Conflict policy']").click()
            try:
                visible(driver, By.XPATH, "//*[@role='menu' and @aria-label='Conflict policy']//button[normalize-space()='Keep both']").click()
            except StaleElementReferenceException:
                pass  # React replaced the selected menu item while committing its value.
            WebDriverWait(driver, 10).until(lambda _page: "Keep both" in panel(driver, "Search Saved sources")
                .find_element(By.CSS_SELECTOR, "button[aria-label='Conflict policy']").text)
            click_text(driver, "Run rules", search_saved)
            WebDriverWait(driver, 90).until(lambda _page: any(node.text.strip().endswith("2") for node in
                search_saved.find_elements(By.XPATH, ".//summary[contains(normalize-space(),'Search history')]")))
            history = search_saved.find_element(By.XPATH,
                ".//details[summary[contains(normalize-space(),'Search history')]]")
            assert not history.get_attribute("open")
            history.find_element(By.TAG_NAME, "summary").click()
            capture = None
            for node in history.find_elements(By.TAG_NAME, "details"):
                node.find_element(By.TAG_NAME, "summary").click()
                if node.find_elements(By.XPATH, ".//button[normalize-space()='Use these rules']"):
                    capture = node
                    break
                node.find_element(By.TAG_NAME, "summary").click()
            assert capture is not None
            click_text(driver, "Use these rules", capture)
            assert "court" in search_saved.text
            driver.save_screenshot(str(output / "08-list-and-search-receipt.png"))

            workspace.find_element(By.CSS_SELECTOR, "button[aria-label='Close research workspace']").click()
            visible(driver, By.XPATH, "(//article//a[normalize-space()='View'])[1]").click()
            reader = visible(driver, By.CSS_SELECTOR, "section[data-legal-block]")
            panel(driver, "Labels")
            WebDriverWait(driver, 30).until(lambda _page: title in driver.find_element(By.TAG_NAME, "body").text)
            driver.execute_script("arguments[0].scrollIntoView({block:'center'})", reader)
            selected = driver.execute_script("""const root=arguments[0],w=document.createTreeWalker(root,NodeFilter.SHOW_TEXT);
let n; while(n=w.nextNode()){if(n.data.trim().length>35)break;} if(!n)return false;
const start=n.data.search(/\S/u),r=document.createRange(); r.setStart(n,Math.max(0,start));
r.setEnd(n,Math.min(n.length,Math.max(0,start)+35)); const s=getSelection(); s.removeAllRanges(); s.addRange(r);
root.dispatchEvent(new PointerEvent('pointerup',{bubbles:true})); return s.toString();""", reader)
            assert selected, selected
            visible(driver, By.XPATH, "//button[normalize-space()='Save highlight']").click()
            palette = visible(driver, By.CSS_SELECTOR, "[popover]:popover-open")
            passage_palette_box = box(driver, palette)
            driver.save_screenshot(str(output / "09-passage-palette.png"))
            click_text(driver, "Key passage", palette)
            if multi_highlight:
                palette.find_element(By.CSS_SELECTOR, "button[aria-label='Add an extra label']").click()
                click_text(driver, "Contrary evidence", palette)
            palette.find_element(By.CSS_SELECTOR, "textarea[aria-label='Item note']").send_keys("Passage-level analysis.")
            click_text(driver, "Save", palette)
            WebDriverWait(driver, 30).until(lambda page: page.find_elements(By.CSS_SELECTOR, "[data-qspan]"))
            assert driver.execute_script("return getSelection().isCollapsed"), "selection remained active after save"
            driver.save_screenshot(str(output / "10-reader-dock-highlight.png"))

            title_marker = visible(driver, By.XPATH, "//header//button[starts-with(@aria-label,'Label R. v. Testroete')]")
            title_marker.click()
            title_palette = visible(driver, By.CSS_SELECTOR, "[popover]:popover-open")
            box(driver, title_palette)
            driver.save_screenshot(str(output / "11-title-palette.png"))
            ActionChains(driver).send_keys(Keys.ESCAPE).perform()
            WebDriverWait(driver, 10).until(lambda page: not page.find_elements(By.CSS_SELECTOR, "[popover]:popover-open"))
            assert driver.execute_script("return document.activeElement === arguments[0]", title_marker)
            assert panel(driver, "Labels").is_displayed(), "Escape closed the research dock"

            saved_highlight = WebDriverWait(driver, 30).until(lambda _page: next((node for node in
                reader.find_elements(By.CSS_SELECTOR, "[data-research-evidence]") if node.is_displayed()), None))
            saved_highlight.click()
            saved_palette = visible(driver, By.CSS_SELECTOR, "[popover]:popover-open")
            assert saved_palette.find_element(By.CSS_SELECTOR, "button[aria-label='Display label']").text.startswith("Key passage")
            assert saved_palette.find_element(By.CSS_SELECTOR, "textarea[aria-label='Item note']").get_attribute("value") == "Passage-level analysis."
            if multi_highlight:
                saved_palette.find_element(By.CSS_SELECTOR, "button[aria-label='Extra label 1']").click()
                click_text(driver, "Set as display label", saved_palette)
                click_text(driver, "Save", saved_palette)
                WebDriverWait(driver, 30).until(lambda _page: not driver.find_elements(By.CSS_SELECTOR, "[popover]:popover-open"))
                saved_highlight = WebDriverWait(driver, 30).until(lambda _page: next((node for node in
                    reader.find_elements(By.CSS_SELECTOR, "[data-research-evidence]") if node.is_displayed()), None))
                saved_highlight.click()
                saved_palette = visible(driver, By.CSS_SELECTOR, "[popover]:popover-open")
                assert saved_palette.find_element(By.CSS_SELECTOR, "button[aria-label='Display label']").text.startswith("Contrary evidence")
            driver.save_screenshot(str(output / "12-saved-highlight-palette.png"))
            ActionChains(driver).send_keys(Keys.ESCAPE).perform()

            dock = visible(driver, By.CSS_SELECTOR, "[aria-label='Assistant dock']")
            resize = dock.find_element(By.CSS_SELECTOR, "[role='separator'][aria-label='Resize assistant dock']")
            dock_width = dock.rect["width"]
            resize.click()
            resize.send_keys(Keys.ARROW_RIGHT)
            WebDriverWait(driver, 10).until(lambda _page: dock.rect["width"] < dock_width)
            resize.send_keys(Keys.ARROW_LEFT)
            WebDriverWait(driver, 10).until(lambda _page: dock.rect["width"] >= dock_width - 1)

            # Panel layout preferences and file contents both survive a hard reload.
            dock.find_element(By.CSS_SELECTOR, "button[aria-label='Close Search Saved sources panel']").click()
            driver.refresh()
            visible(driver, By.CSS_SELECTOR, "section[data-legal-block]")
            if driver.find_elements(By.CSS_SELECTOR, "button[aria-label='Expand assistant dock']"):
                visible(driver, By.CSS_SELECTOR, "button[aria-label='Expand assistant dock']").click()
            WebDriverWait(driver, 30).until(lambda _page: title in driver.find_element(By.TAG_NAME, "body").text)
            assert not driver.find_elements(By.XPATH, "//section[header//h2[normalize-space()='Search Saved sources']]")
            driver.find_element(By.CSS_SELECTOR, "button[aria-label='Add panel to slot 4']").click()
            click_text(driver, "Search Saved sources", visible(driver, By.CSS_SELECTOR, "[role='menu'][aria-label='Add panel to slot 4']"))
            state = driver.execute_async_script("fetch('/api/single-documents/'+arguments[0]+'/research').then(r=>r.json()).then(x=>arguments[1](x.state))", research_id)
            assert len(state["queries"]) == 2, state
            evidence_state = next(item for item in state["evidence"].values() if item["note"] == "Passage-level analysis.")
            assert len(evidence_state["labelIds"]) == (2 if multi_highlight else 1) and evidence_state["note"] == "Passage-level analysis.", evidence_state
            driver.save_screenshot(str(output / "13-reload-restored.png"))

            driver.get(args.url.rstrip("/") + "/library")
            visible(driver, By.CSS_SELECTOR, f"button[aria-label='View {title}.research.md']").click()
            preview = visible(driver, By.CSS_SELECTOR, f"[role='dialog'][aria-label='{title}.research.md']")
            WebDriverWait(driver, 30).until(lambda _page: "Duty of fairness" in preview.text and "R. v. Testroete" in preview.text)
            assert not preview.find_elements(By.CSS_SELECTOR, "[aria-label='Research panels']")
            driver.save_screenshot(str(output / "14-library-research-preview.png"))
            preview.find_element(By.LINK_TEXT, "Open in Sources").click()
            WebDriverWait(driver, 30).until(lambda _page: research_id in driver.current_url and title in driver.find_element(By.TAG_NAME, "body").text)
            driver.save_screenshot(str(output / "15-library-open-in-sources.png"))
            driver.back(); driver.back()
            visible(driver, By.CSS_SELECTOR, "section[data-legal-block]")

            driver.set_window_size(900, 700)
            compact_dock = visible(driver, By.CSS_SELECTOR, "[aria-label='Assistant dock']")
            compact_box = box(driver, compact_dock)
            assert driver.execute_script("return arguments[0].scrollWidth <= arguments[0].clientWidth + 1", compact_dock)
            driver.save_screenshot(str(output / "14-compact-reader-dock.png"))
            driver.set_window_size(1440, 900)
            WebDriverWait(driver, 10).until(lambda _page: driver.get_window_size()["width"] >= 1400)

            research_id = driver.execute_async_script("""const title=arguments[0],done=arguments[1];
fetch('/api/library/files?q='+encodeURIComponent(title)).then(r=>r.json()).then(page=>
  done(page.items.find(x=>x.kind==='document'&&x.document.filename===title+'.research.md')?.document.id||null)
).catch(error=>done({error:String(error)}));""", title)
            assert isinstance(research_id, str), research_id
            severe = [entry for entry in driver.get_log("browser") if entry["level"] == "SEVERE"]
            assert not severe, {"console": severe, "url": driver.current_url,
                "researchDocument": research_id}
            report.update({"ok": True, "researchDocument": research_id,
                "overlay": moved, "chooser": chooser_box, "palette": palette_box,
                "passagePalette": passage_palette_box, "selectedPassage": selected})
            (output / "RESULTS.json").write_text(json.dumps(report, indent=2), encoding="utf-8")
            print(json.dumps(report))
        except Exception:
            driver.save_screenshot(str(output / "failure.png"))
            (output / "failure.html").write_text(driver.page_source, encoding="utf-8")
            raise
        finally:
            if research_id:
                driver.execute_async_script("""const id=arguments[0],done=arguments[1];
fetch('/api/single-documents/'+encodeURIComponent(id),{method:'DELETE'})
  .then(()=>done(true)).catch(()=>done(false));""", research_id)
            driver.quit()


if __name__ == "__main__":
    main()
