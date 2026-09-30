"""Check neutral Library membership and explicit research highlights in a running Beaver.

Highlight selection/shortcut reader interactions are covered by the focused
DocumentSidePanel and LegalSourceViewer tests; this browser flow verifies the
Library does not impose a workspace and that a chosen set retains typed passages.
"""
from __future__ import annotations

import argparse
import json
from contextlib import suppress
import tempfile
from functools import partial
from pathlib import Path
from urllib.parse import urljoin
from uuid import uuid4

from selenium.common.exceptions import WebDriverException
from selenium.webdriver.common.by import By
from selenium.webdriver.common.keys import Keys
from selenium.webdriver.support.ui import WebDriverWait
from browser_helpers import chrome, visible, click_text, api as request, upload as upload_text


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--url", default="http://127.0.0.1:3000/")
    parser.add_argument("--output")
    parser.add_argument("--headed", action="store_true")
    args = parser.parse_args()
    output = Path(args.output) if args.output else Path(tempfile.mkdtemp(prefix="beaver-sources-dock-"))
    output.mkdir(parents=True, exist_ok=True)
    report: dict[str, object] = {"screenshots": str(output)}

    with tempfile.TemporaryDirectory(prefix="beaver-chrome-") as profile:
        driver = chrome(Path(profile), args.headed)
        api = partial(request, driver)
        upload = partial(upload_text, driver)
        def screenshot(name):
            driver.save_screenshot(str(output / name))

        try:
            driver.set_window_size(1440, 900)

            print("Sources dock: seed a library document", flush=True)
            driver.get(urljoin(args.url, "/library"))
            visible(driver, By.CSS_SELECTOR, "main, [role='main'], body")
            filename = f"Highlight {uuid4().hex[:8]}.txt"
            document = upload(filename,
                "First passage about fairness. Second passage about remedies.")
            report["documentId"] = document["id"]

            title = "Explicit research " + document["id"][:8]
            research = api("POST", "/api/source-workspaces", {"title": title})
            research_id = research["document"]["id"]
            report["researchId"] = research_id
            print("Sources dock: choose an explicit research destination", flush=True)
            driver.get(urljoin(args.url, "/library"))
            row = WebDriverWait(driver, 30).until(lambda page: next((node for node in page.find_elements(
                By.CSS_SELECTOR, "[data-document-row]") if node.is_displayed()
                and filename in node.text), None))
            assert not row.find_elements(By.CSS_SELECTOR, "[data-label-dot]")
            row.find_element(By.XPATH, ".//button[@aria-label='More actions']").click()
            assert not driver.find_elements(By.XPATH, "//*[@role='menuitem' and normalize-space()='Label']")
            driver.find_element(By.XPATH, "//*[@role='menuitem' and normalize-space()='Add to research…']").click()
            dialog = visible(driver, By.CSS_SELECTOR, "dialog[open]")
            assert not api("GET", f"/api/source-workspaces/{research_id}")["state"]["sources"]
            dialog.find_element(By.CSS_SELECTOR, "input[aria-label='Search research sets']").send_keys(title)
            visible(driver, By.CSS_SELECTOR, f"input[aria-label='Select {title}']").click()
            WebDriverWait(driver, 30).until(lambda _: dialog.find_element(
                By.XPATH, ".//button[normalize-space()='Add']").is_enabled())
            click_text(driver, "Add", dialog)

            def collected_source():
                saved = api("GET", f"/api/source-workspaces/{research_id}")
                return next((item for item in saved["state"]["sources"].values()
                    if item.get("collected") and item["reference"]["id"] == document["id"]), None)

            source = WebDriverWait(driver, 30).until(lambda _page: collected_source())
            assert source["reference"]["versionId"] == document["current_version_id"]
            assert source["labelIds"] == []
            assert not api("GET", f"/api/source-workspaces/{research_id}/items?kind=passages")["items"]
            screenshot("01-explicit-membership.png")

            # Explicit save, not a read: default type is one ordinary Highlight.
            saved = api("GET", f"/api/source-workspaces/{research_id}")
            reader = api("GET", f"/api/single-documents/{document['id']}/reader-text?version_id={document['current_version_id']}")
            saved = api("POST", f"/api/source-workspaces/{research_id}/actions", {
                "version_id": saved["versionId"], "working_revision": saved["workingRevision"],
                "action": {"type": "passage", "sourceId": source["id"],
                    "revision": reader["revision"], "start": 0,
                    "end": len("First passage about fairness.")}})
            items = api("GET", f"/api/source-workspaces/{research_id}/items?kind=passages")["items"]
            assert len(items) == 1, items
            type_ids = items[0]["value"]["labelIds"]
            assert len(type_ids) == 1
            assert saved["state"]["labels"][type_ids[0]]["name"] == "Highlight"
            report["researchId"] = research_id
            report["highlightId"] = items[0]["value"]["receipt"]["evidence_id"]

            driver.get(urljoin(args.url, f"/sources?research_file={research_id}"))
            rail = visible(driver, By.CSS_SELECTOR, "section[aria-label='Research collection']")
            click_text(driver, "Highlight", rail)
            click_text(driver, "Highlight options", rail)
            visible(driver, By.CSS_SELECTOR, "[role='menu']")
            driver.switch_to.active_element.send_keys(Keys.ESCAPE)
            assert rail.find_element(By.CSS_SELECTOR, "input[aria-label='Filter']").is_displayed()
            tree = rail.find_element(By.CSS_SELECTOR, "[role='tree'][aria-label='Sources']")
            assert tree.is_displayed()
            assert len(tree.find_elements(By.CSS_SELECTOR, f"[role='treeitem'][aria-label='{filename}']")) == 1
            assert "Unsorted" not in tree.text and "Unclassified" not in tree.text
            screenshot("02-research-rail.png")
            print("Sources dock: workspace chat shares the research surface", flush=True)
            click_text(driver, "Chat")
            visible(driver, By.CSS_SELECTOR, "select[aria-label='Workspace chat']")
            click_text(driver, "New chat")
            chat_choice = visible(driver, By.CSS_SELECTOR, "select[aria-label='Workspace chat']")
            report["chatId"] = WebDriverWait(driver, 30).until(lambda _: chat_choice.get_attribute("value"))
            screenshot("03-workspace-chat-tabs.png")
            driver.set_window_size(1920, 1080)
            WebDriverWait(driver, 30).until(lambda page: len([node for node in page.find_elements(
                By.CSS_SELECTOR, "[data-assistant-dock]") if node.is_displayed()]) == 2)
            visible(driver, By.CSS_SELECTOR, "section[aria-label='Research collection']")
            visible(driver, By.CSS_SELECTOR, "select[aria-label='Workspace chat']")
            screenshot("04-workspace-chat-beside.png")
            # A substantial four-level draft exercises disclosure without private research or a model call.
            labels = []
            for subject in ("Fairness", "Remedies", "Procedure"):
                branch = {"id": str(uuid4()), "name": subject, "members": [], "children": []}
                labels.append(branch)
                for issue in range(1, 3):
                    child = {"id": str(uuid4()), "name": f"Issue {issue}", "members": [], "children": []}
                    branch["children"].append(child)
                    for outcome in ("Established", "Not established"):
                        result = {"id": str(uuid4()), "name": outcome, "members": [], "children": []}
                        child["children"].append(result)
                        for reason in range(1, 3):
                            result["children"].append({"id": str(uuid4()), "name": f"Reason {reason}", "members": [], "children": []})
            labels[0]["members"] = [source["id"]]
            draft = api("POST", f"/api/source-workspaces/{research_id}/labels/preview", {
                "conversationId": report["chatId"], "design": {
                    "title": "Fairness research", "sourceLabels": labels, "highlightTypes": []}})
            assert draft["proposalId"]
            driver.refresh()
            print("Sources dock: review a pending proposal without applying it", flush=True)

            def open_review():
                click_text(driver, "Review")
                dialog = visible(driver, By.CSS_SELECTOR, "dialog[open]")
                visible(driver, By.CSS_SELECTOR, "dialog[open] [role='tree'][aria-label='Sources']")
                return dialog

            dialog = open_review()
            screenshot("05-modal-organization-draft.png")
            click_text(driver, "Close", dialog)
            WebDriverWait(driver, 30).until(lambda page: not page.find_elements(By.CSS_SELECTOR, "dialog[open]"))
            assert api("GET", f"/api/source-workspaces/{research_id}")["state"]["labels"] == saved["state"]["labels"]
            dialog = open_review()
            screenshot("06-reopened-organization-draft.png")
            click_text(driver, "Collapse Fairness", dialog)
            click_text(driver, "Expand Fairness", dialog)
            deepest = labels[0]["children"][0]["children"][0]["children"][0]["id"]
            leaf = visible(driver, By.CSS_SELECTOR, f"dialog[open] [data-label-select='{deepest}']")
            driver.execute_script("arguments[0].scrollIntoView({block:'center'})", leaf)
            screenshot("07-deep-organization-branch.png")
            click_text(driver, "Accept changes", dialog)
            WebDriverWait(driver, 30).until(lambda page: not page.find_elements(By.CSS_SELECTOR, "dialog[open]"))
            accepted = api("GET", f"/api/source-workspaces/{research_id}")
            assert len(accepted["state"]["labels"]) == len(saved["state"]["labels"]) + 45
            assert accepted["state"]["labels"][deepest]["name"] == "Reason 1"
            click_text(driver, "Undo")
            WebDriverWait(driver, 30).until(lambda _: api("GET", f"/api/source-workspaces/{research_id}")["state"]["labels"] == saved["state"]["labels"])
            screenshot("08-undone-organization.png")
            report["proposalCategories"] = 45
            report["ok"] = True
        except Exception:
            with suppress(WebDriverException):
                screenshot("failure.png")
            raise
        finally:
            if report.get("chatId"):
                try:
                    api("DELETE", f"/api/chat/{report['chatId']}")
                except Exception as error:
                    report["cleanupError"] = str(error)
            for key in ("researchId", "documentId"):
                if key not in report:
                    continue
                try:
                    path = f"/api/single-documents/{report[key]}"
                    item = api("GET", path)
                    api("DELETE", path, {"expected_current_version_id": item["current_version_id"],
                        "expected_working_revision": item["current_working_revision"],
                        "expected_project_id": item.get("project_id"), "expected_folder_id": item.get("folder_id")})
                except Exception as error:
                    report["cleanupError"] = str(error)
            (output / "report.json").write_text(json.dumps(report, indent=2), encoding="utf-8")
            driver.quit()
    assert "cleanupError" not in report, report
    print(json.dumps(report, indent=2))


if __name__ == "__main__":
    main()
