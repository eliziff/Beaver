from __future__ import annotations

import argparse
import json
import tempfile
from pathlib import Path
from urllib.parse import parse_qs, urlencode, urlparse

from selenium import webdriver
from selenium.webdriver import Keys
from selenium.webdriver.chrome.service import Service
from selenium.webdriver.common.by import By
from selenium.webdriver.support.ui import WebDriverWait


EXPECTED_LABELS = {
    "source": {"Procedural fairness": "#315efb", "Scope": "#8b5cf6", "Remedy": "#e05d3d"},
    "highlight": {"Key passages": "#0f8a72", "Legal test": "#d28b16", "Application": "#c24170"},
}


def visible(driver, by: str, value: str, timeout=60):
    return WebDriverWait(driver, timeout).until(lambda page: next(
        (node for node in page.find_elements(by, value) if node.is_displayed()), None))


def labelled_button(driver, label: str):
    return WebDriverWait(driver, 60).until(lambda page: next((node for node in
        page.find_elements(By.TAG_NAME, "button") if node.is_displayed()
        and node.get_attribute("aria-label") == label), None))


def panel(driver, title: str):
    return visible(driver, By.XPATH,
        f"//section[header//h2[starts-with(normalize-space(),'{title}')]]")


def api(driver, path: str):
    result = driver.execute_async_script("""const [path,done]=arguments;
fetch(path).then(async response=>done({status:response.status,body:await response.json()}))
  .catch(error=>done({status:0,error:String(error)}));""", path)
    assert result["status"] == 200, {"path": path, "result": result}
    return result["body"]


def items(driver, document_id: str, kind: str, source_id: str | None = None):
    found, cursor = [], None
    while True:
        query = urlencode({"kind": kind, "limit": 200,
            **({"source_id": source_id} if source_id else {}), **({"cursor": cursor} if cursor else {})})
        page = api(driver, f"/api/single-documents/{document_id}/research/items?{query}")
        found.extend(row["value"] for row in page["items"])
        cursor = page.get("next_cursor")
        if not cursor:
            return found


def label_path(labels: dict, label_id: str):
    path = []
    while label_id:
        label = labels[label_id]
        path.insert(0, label)
        label_id = label.get("parentId")
    return path


def marker_colors(marker):
    return [node.get_attribute("fill").lower() for node in
        marker.find_elements(By.CSS_SELECTOR, "[data-label-layer]")]


def audit_browser(driver):
    console = [row for row in driver.get_log("browser") if row["level"] == "SEVERE"]
    requests, failures = {}, []
    for row in driver.get_log("performance"):
        event = json.loads(row["message"])["message"]
        method, params = event.get("method"), event.get("params", {})
        if method == "Network.requestWillBeSent":
            requests[params["requestId"]] = params["request"]["url"]
        elif method == "Network.responseReceived" and params["response"]["status"] >= 400:
            failures.append({"url": params["response"]["url"], "status": int(params["response"]["status"])})
        elif method == "Network.loadingFailed" and not params.get("canceled"):
            failures.append({"url": requests.get(params["requestId"], "unknown"), "error": params["errorText"]})
    return console, failures


def main() -> None:
    parser = argparse.ArgumentParser(description="Visually prove a preserved live-Luna research workspace and memo.")
    parser.add_argument("--url", required=True)
    parser.add_argument("--workspace", required=True)
    parser.add_argument("--memo", required=True)
    parser.add_argument("--output", required=True)
    parser.add_argument("--headed", action="store_true")
    args = parser.parse_args()
    base, output = args.url.rstrip("/"), Path(args.output)
    research_name = args.workspace if args.workspace.endswith(".research.md") else f"{args.workspace}.research.md"
    memo_name = args.memo if args.memo.endswith(".md") else f"{args.memo}.md"
    output.mkdir(parents=True, exist_ok=True)
    report: dict[str, object] = {"ok": False, "workspace": research_name, "memo": memo_name}
    screenshots: list[str] = []

    with tempfile.TemporaryDirectory(prefix="beaver-live-luna-chrome-") as profile:
        options = webdriver.ChromeOptions()
        if not args.headed:
            options.add_argument("--headless=new")
        options.add_argument(f"--user-data-dir={profile}")
        options.add_argument("--window-size=1440,900")
        options.set_capability("goog:loggingPrefs", {"performance": "ALL", "browser": "ALL"})
        cached = list((Path.home() / ".cache/selenium/chromedriver/win64").glob("*/chromedriver.exe"))
        service = Service(str(max(cached, key=lambda path: tuple(map(int, path.parent.name.split(".")))))) if cached else Service()
        driver = webdriver.Chrome(service=service, options=options)

        def shot(name: str):
            screenshots.append(name)
            assert driver.save_screenshot(str(output / name))

        try:
            driver.get(f"{base}/library")
            search = visible(driver, By.CSS_SELECTOR, "input[data-page-search]")
            search.send_keys(research_name)
            labelled_button(driver, f"View {research_name}").click()
            preview = visible(driver, By.CSS_SELECTOR, "dialog[open]")
            summary = visible(preview, By.CSS_SELECTOR, "[aria-label='Workspace contents']")
            open_sources = visible(preview, By.LINK_TEXT, "Open in Sources")
            document_id = parse_qs(urlparse(open_sources.get_attribute("href")).query)["research_file"][0]
            state = api(driver, f"/api/single-documents/{document_id}/research")["state"]
            labels, sources = state["labels"], list(state["sources"].values())
            passage_count = sum(source.get("passages", {}).get("count", 0) for source in sources)
            assert len(sources) >= 3 and passage_count >= 3 and state["queries"]["count"] >= 1
            assert state["note"].strip() and state["note"].strip().splitlines()[0][:100] in preview.text
            assert all(source["note"].strip() for source in sources)
            assert all(token in summary.text for token in
                (f"{len(sources)} sources", f"{passage_count} highlights", f"{state['queries']['count']} search"))
            assert len(preview.find_elements(By.CSS_SELECTOR, "[aria-label='Saved sources'] > li")) == len(sources)
            assert len(preview.find_elements(By.CSS_SELECTOR, "[aria-label='Labels'] > li")) == len(labels)
            assert not preview.find_elements(By.CSS_SELECTOR, "[aria-label='Research panels']")
            shot("00-library-workspace-preview.png")
            open_sources.click()

            labels_panel, highlights_panel = panel(driver, "Labels"), panel(driver, "Highlights")
            WebDriverWait(driver, 60).until(lambda page: args.workspace.replace(".research.md", "") in page.find_element(By.TAG_NAME, "body").text)
            by_name = {label["name"]: label for label in labels.values()}
            for scope, expected in EXPECTED_LABELS.items():
                target = labels_panel if scope == "source" else highlights_panel
                root_name, *child_names = expected
                assert by_name[root_name]["parentId"] is None
                controls = {name: next(node for node in target.find_elements(By.CSS_SELECTOR, "input[type='color']")
                    if node.get_attribute("aria-label") == f"{name} color") for name in expected}
                for name, color in expected.items():
                    assert by_name[name]["scope"] == scope and controls[name].get_attribute("value").lower() == color
                assert all(by_name[name]["parentId"] == by_name[root_name]["id"] for name in child_names)
                assert all(controls[name].rect["x"] > controls[root_name].rect["x"] for name in child_names)
            assert all(source["labelIds"] and labels[source["labelIds"][0]]["parentId"] for source in sources)
            shot("01-sources-nested-coloured-labels.png")

            evidence_by_source = {source["id"]: items(driver, document_id, "passages", source["id"])
                for source in sources}
            evidence = [entry for rows in evidence_by_source.values() for entry in rows]
            assert len([entry for entry in evidence if entry["labelIds"]]) >= 3
            nested = next((source, entry) for source in sources for entry in evidence_by_source[source["id"]]
                if entry["labelIds"] and len(label_path(labels, entry["labelIds"][0])) > 1)
            noted = next(entry for entry in evidence if entry["note"].strip())
            list_panel = panel(driver, "List")
            assert len(list_panel.find_elements(By.CSS_SELECTOR, "ol > li > details > summary")) >= 3

            def source_details(source):
                name = source["reference"].get("title") or source["reference"].get("citation") or source["reference"]["id"]
                return next(node for node in panel(driver, "List").find_elements(By.CSS_SELECTOR, "ol > li > details")
                    if name in node.find_element(By.TAG_NAME, "summary").text)

            source, passage = nested
            labelled_button(driver, "Expand List panel").click()
            details = source_details(source)
            details.find_element(By.TAG_NAME, "summary").click()
            locator = passage["receipt"]["locator"]["label"]
            source_note = source["note"].strip().splitlines()[0][:100]
            details = WebDriverWait(driver, 60).until(lambda _page: node
                if locator in (node := source_details(source)).text and source_note in node.text else None)
            source_path = label_path(labels, source["labelIds"][0])
            assert marker_colors(details.find_element(By.CSS_SELECTOR, "summary svg[role='group']"))[:len(source_path)] == [
                label["color"].lower() for label in source_path]
            passage_link = next(link for link in details.find_elements(By.TAG_NAME, "a") if link.text == locator)
            passage_marker = passage_link.find_element(By.XPATH, "../..").find_element(By.CSS_SELECTOR, "svg[role='group']")
            passage_path = label_path(labels, passage["labelIds"][0])
            assert marker_colors(passage_marker)[:len(passage_path)] == [label["color"].lower() for label in passage_path]
            noted_text = noted["note"].strip().splitlines()[0][:100]
            if noted_text not in details.text:
                noted_source = next(source for source in sources if noted in evidence_by_source[source["id"]])
                more = source_details(noted_source)
                if not more.get_attribute("open"):
                    more.find_element(By.TAG_NAME, "summary").click()
                WebDriverWait(driver, 60).until(lambda _page: noted_text in source_details(noted_source).text)
            driver.execute_script("arguments[0].scrollIntoView({block:'center'})", passage_link)
            shot("02-expanded-sources-passages-notes.png")
            labelled_button(driver, "Restore List panel").click()
            labelled_button(driver, "Expand Search Saved sources panel").click()

            history = panel(driver, "Search Saved sources").find_element(By.XPATH,
                ".//details[summary[contains(normalize-space(),'Search history')]]")
            history.find_element(By.TAG_NAME, "summary").click()
            receipt = WebDriverWait(driver, 60).until(lambda _page: next((node for node in history.find_elements(
                By.CSS_SELECTOR, "ol > li > details") if "fairness" in node.text.lower()), None))
            receipt.find_element(By.TAG_NAME, "summary").click()
            WebDriverWait(driver, 30).until(lambda _page: receipt.get_attribute("open"))
            assert any(str(row.get("input", {}).get("pattern", "")).lower() == "fairness"
                for row in items(driver, document_id, "queries"))
            driver.execute_script("arguments[0].scrollIntoView({block:'center'})", receipt)
            shot("03-saved-search-receipt.png")

            visible(driver, By.CSS_SELECTOR, "nav[aria-label='Primary'] a[href='/library']").click()
            search = visible(driver, By.CSS_SELECTOR, "input[data-page-search]")
            search.send_keys(Keys.CONTROL, "a")
            search.send_keys(memo_name)
            labelled_button(driver, f"View {memo_name}").click()
            memo = visible(driver, By.CSS_SELECTOR, "dialog[open]")
            markdown = visible(memo, By.CSS_SELECTOR, "section h1").find_element(By.XPATH, "..")
            research_link = visible(markdown, By.CSS_SELECTOR, f"a[href='/sources?research_file={document_id}']")
            citations = [link for link in markdown.find_elements(By.CSS_SELECTOR, "a[href^='/sources/view?']") if link.is_displayed()]
            assert markdown.text.strip() and research_link.is_displayed() and citations
            assert all("not-prose" in (link.get_attribute("class") or "").split() and link.text.strip() for link in citations)
            shot("04-linked-memo-markdown.png")
            driver.execute_script("arguments[0].scrollIntoView({block:'center'})", citations[0])
            shot("05-memo-citation-chips.png")

            console, network = audit_browser(driver)
            report.update({"documentId": document_id, "console": console, "network": network, "counts": {
                "sources": len(sources), "passages": len(evidence), "labels": len(labels),
                "searches": state["queries"]["count"], "citationLinks": len(citations)}})
            assert not console and not network, {"console": console, "network": network}
            report["ok"] = True
        except Exception as error:
            report.update({"ok": False, "error": f"{type(error).__name__}: {error}"})
            try:
                if "console" not in report:
                    console, network = audit_browser(driver)
                    report.update({"console": console, "network": network})
                report["url"] = driver.current_url
                driver.save_screenshot(str(output / "failure.png"))
                (output / "failure.html").write_text(driver.page_source, encoding="utf-8")
            except Exception:
                pass
            raise
        finally:
            report["screenshots"] = screenshots
            (output / "RESULTS.json").write_text(json.dumps(report, indent=2), encoding="utf-8")
            driver.quit()

    print(json.dumps(report))


if __name__ == "__main__":
    main()
