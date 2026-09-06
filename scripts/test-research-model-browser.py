"""Inspect a real model's saved research through Beaver's ordinary UI."""
import argparse
import json
import runpy
import tempfile
from pathlib import Path

from selenium.webdriver.common.by import By
from selenium.webdriver.support.wait import WebDriverWait

chrome = runpy.run_path(str(Path(__file__).with_name("test-authorities-browser.py")))["chrome"]


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--url", default="http://127.0.0.1:3001")
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    args.output.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix="beaver-model-browser-") as profile:
        driver = chrome(Path(profile), False)
        wait = WebDriverWait(driver, 60)

        def visible(selector):
            return wait.until(lambda page: next((node for node in page.find_elements(
                By.CSS_SELECTOR, selector) if node.is_displayed()), None))

        def get(path):
            result = driver.execute_async_script("""const [path,done]=arguments;
fetch(path).then(async r=>done({status:r.status,value:await r.json()})).catch(e=>done({error:String(e)}));""", path)
            assert result.get("status") == 200, result
            return result["value"]

        try:
            driver.set_window_size(1600, 1000)
            driver.get(args.url + "/library")
            print("Live research UI: Library preview", flush=True)
            visible("button[aria-label='View Luna fairness pilot.research.md']").click()
            dialog = visible("dialog[open]")
            visible("[aria-label='Workspace contents']")
            driver.save_screenshot(str(args.output / "01-model-library-preview.png"))
            files = get("/api/library/files?limit=100")
            research_doc = next(item["document"] for item in files["items"] if item.get("kind") == "document"
                and item["document"]["filename"] == "Luna fairness pilot.research.md")
            state = get(f"/api/source-workspaces/{research_doc['id']}")["state"]
            assert len(state["sources"]) >= 3 and len(state["labels"]) >= 6
            assert all(source["note"] and source["labelIds"] for source in state["sources"].values())
            dialog.find_element(By.LINK_TEXT, "Open in Sources").click()
            visible("section[aria-label='Research collection']")
            visible("section[aria-label='Saved sources'] button[aria-label^='Passages in ']")
            assert not driver.find_elements(By.CSS_SELECTOR, "dialog[open]")
            driver.save_screenshot(str(args.output / "02-model-collection.png"))

            print("Live research UI: collection and source reader", flush=True)
            source = next(iter(state["sources"].values()))
            title = source["reference"].get("title") or source["reference"].get("citation") or source["reference"]["id"]
            collection = visible("section[aria-label='Saved sources']")
            next(button for button in collection.find_elements(By.TAG_NAME, "button") if button.text == title).click()
            visible("section[data-legal-block]")
            visible("section[aria-label='Saved sources'] button[aria-current='true']")
            driver.save_screenshot(str(args.output / "03-model-case-reader.png"))
            visible("section[aria-label='Saved sources'] button[aria-label^='Passages in ']").click()
            wait.until(lambda page: "Loading passages" not in collection.text)
            driver.save_screenshot(str(args.output / "04-model-saved-passages.png"))

            print("Live research UI: memo and citation chips", flush=True)
            driver.get(args.url + "/library")
            visible("button[aria-label='View Luna fairness pilot memo.md']").click()
            memo = visible("dialog[open]")
            chips = wait.until(lambda page: memo.find_elements(By.CSS_SELECTOR, "a[href^='/sources/view?']"))
            assert len(chips) >= 3
            driver.save_screenshot(str(args.output / "05-model-cited-memo.png"))
            chips[0].click()
            visible("section[data-legal-block]")
            driver.save_screenshot(str(args.output / "06-memo-citation-destination.png"))
            errors = [row for row in driver.get_log("browser") if row["level"] == "SEVERE"]
            assert not errors, errors
            report = {"sources": len(state["sources"]), "labels": len(state["labels"]),
                "savedQueries": state["queries"]["count"], "memoCitations": len(chips), "consoleErrors": errors}
            (args.output / "RESULTS.json").write_text(json.dumps(report, indent=2), encoding="utf-8")
            print(json.dumps(report), flush=True)
        except Exception:
            driver.save_screenshot(str(args.output / "failure.png"))
            (args.output / "failure.html").write_text(driver.page_source, encoding="utf-8")
            raise
        finally:
            driver.quit()


if __name__ == "__main__":
    main()
